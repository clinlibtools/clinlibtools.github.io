/**
 * NLM Socrata API client for MeSH AMP change reports.
 * Queries Replace, Preferred Term Update, Delete, and Merge endpoints.
 */

// Cache with 1-hour TTL in localStorage
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const { data, exp } = JSON.parse(raw);
    if (Date.now() > exp) {
      localStorage.removeItem(key);
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, exp: Date.now() + CACHE_TTL }));
  } catch { /* storage full — ignore */ }
}

const BASE_URL = 'https://datadiscovery.nlm.nih.gov/resource';

const ENDPOINTS = {
  replace: { id: '7vzs-mg28', termField: 'replaced_name' },
  preferredTerm: { id: 'ipap-cksm', termField: 'replaced_value' },
  delete: { id: 'czsr-ugu4', termField: 'deleted_term' },
  merge: { id: '5bhp-bdab', termField: 'to_merge' },
};

const BATCH_SIZE = 30; // Max terms per query to stay within URL length limits

/**
 * @typedef {Object} Change
 * @property {string} type - "replaced" | "renamed" | "deleted" | "merged"
 * @property {string} year
 * @property {string} [note]
 * @property {{ name: string, ui: string }[]} [replacements]
 */

/**
 * Check a list of MeSH terms against all NLM AMP change reports.
 * @param {string[]} meshTerms - Unique MeSH term names
 * @param {string|null} yearFilter - Filter to a specific year, or null for all
 * @returns {Promise<Map<string, Change[]>>} Map from original term (lowercase) to changes
 */
export async function checkTerms(meshTerms, yearFilter) {
  if (meshTerms.length === 0) return new Map();

  // Split terms into batches
  const batches = [];
  for (let i = 0; i < meshTerms.length; i += BATCH_SIZE) {
    batches.push(meshTerms.slice(i, i + BATCH_SIZE));
  }

  // Query all endpoints for all batches in parallel
  const allPromises = [];
  for (const batch of batches) {
    for (const [key, endpoint] of Object.entries(ENDPOINTS)) {
      allPromises.push(
        queryEndpoint(key, endpoint, batch, yearFilter)
          .then(results => ({ key, results }))
          .catch(err => ({ key, results: [], error: err.message }))
      );
    }
  }

  const responses = await Promise.all(allPromises);

  // Consolidate into a single map
  const changeMap = new Map();
  const errors = [];

  for (const { key, results, error } of responses) {
    if (error) {
      errors.push({ endpoint: key, error });
      continue;
    }
    for (const record of results) {
      const change = normalizeRecord(key, record);
      if (!change) continue;

      const termKey = change.originalTerm.toLowerCase();
      if (!changeMap.has(termKey)) {
        changeMap.set(termKey, []);
      }
      changeMap.get(termKey).push(change);
    }
  }

  if (errors.length > 0) {
    console.warn('Some API endpoints failed:', errors);
  }

  return changeMap;
}

const MESH_SPARQL = 'https://id.nlm.nih.gov/mesh/sparql';
const MESH_LOOKUP = 'https://id.nlm.nih.gov/mesh/lookup/descriptor';
const ADD_REPORT_ID = 'aq5t-7aga';

/**
 * Find related new MeSH terms by querying the MeSH tree hierarchy via SPARQL.
 * For each term in the strategy, finds siblings (terms sharing a parent),
 * then filters to only those that appear in the Add Report (newly added).
 *
 * @param {string[]} meshTerms - Existing MeSH terms from the strategy
 * @param {string|null} yearFilter
 * @returns {Promise<Map<string, NewTermSuggestion[]>>}
 */
export async function findRelatedNewTerms(meshTerms, yearFilter) {
  if (meshTerms.length === 0) return new Map();

  // Step 1: Resolve term names to MeSH UIs via lookup API
  const termUIs = await resolveTermUIs(meshTerms);
  const resolvedTerms = [...termUIs.entries()]; // [[termLower, UI], ...]
  if (resolvedTerms.length === 0) {
    const empty = new Map();
    empty._resolvedUIs = termUIs;
    return empty;
  }

  // Step 2: SPARQL — find siblings and children in parallel
  const [siblings, children] = await Promise.all([
    findSiblings(resolvedTerms, meshTerms),
    findChildren(resolvedTerms, meshTerms),
  ]);

  // Merge siblings and children into one map
  const related = new Map();
  for (const [termKey, list] of siblings) {
    if (!related.has(termKey)) related.set(termKey, []);
    related.get(termKey).push(...list);
  }
  for (const [termKey, list] of children) {
    if (!related.has(termKey)) related.set(termKey, []);
    const existing = related.get(termKey);
    for (const item of list) {
      if (!existing.some(s => s.siblingLabel === item.siblingLabel)) {
        existing.push(item);
      }
    }
  }

  if (related.size === 0) {
    const empty = new Map();
    empty._resolvedUIs = termUIs;
    return empty;
  }

  // Step 3: Cross-reference with the Add Report to find only newly added ones
  const suggestions = await filterToNewlyAdded(related, yearFilter);

  // Attach resolved UIs so callers can use them for linking original terms
  suggestions._resolvedUIs = termUIs;

  return suggestions;
}

/**
 * Resolve term names to MeSH descriptor UIs.
 */
export async function resolveTermUIs(meshTerms) {
  const termUIs = new Map();

  const lookups = meshTerms.map(async (term) => {
    const cacheKey = `mesh-fixer:lookup:${term.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      if (cached) termUIs.set(term.toLowerCase(), cached);
      return;
    }

    try {
      const url = `${MESH_LOOKUP}?label=${encodeURIComponent(term)}&match=exact&limit=1`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data.length > 0) {
        const ui = data[0].resource.split('/').pop(); // e.g. "D007383"
        termUIs.set(term.toLowerCase(), ui);
        cacheSet(cacheKey, ui);
      } else {
        cacheSet(cacheKey, null);
      }
    } catch { /* skip failed lookups */ }
  });

  await Promise.all(lookups);
  return termUIs;
}

/**
 * SPARQL query: find siblings for resolved terms.
 * Only considers parents at tree depth >= 3 to avoid overly broad categories.
 */
async function findSiblings(resolvedTerms, originalTerms) {
  const values = resolvedTerms.map(([, ui]) => `mesh:${ui}`).join(' ');
  const existingUpper = new Set(originalTerms.map(t => t.toUpperCase()));

  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX mesh: <http://id.nlm.nih.gov/mesh/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?termLabel ?parentLabel ?sibling ?siblingLabel ?parentTreeNum WHERE {
      VALUES ?term { ${values} }
      ?term meshv:broaderDescriptor ?parent .
      ?term rdfs:label ?termLabel .
      ?parent rdfs:label ?parentLabel .
      ?parent meshv:treeNumber ?parentTreeNum .
      ?sibling meshv:broaderDescriptor ?parent .
      ?sibling rdfs:label ?siblingLabel .
      FILTER(?sibling != ?term)
    }
    LIMIT 500
  `;

  const cacheKey = `mesh-fixer:sparql:siblings:${values}`;
  const cached = cacheGet(cacheKey);
  let data;

  if (cached !== undefined) {
    data = cached;
  } else {
    try {
      const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON&limit=500`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`SPARQL ${res.status}`);
      data = await res.json();
      cacheSet(cacheKey, data);
    } catch (err) {
      console.warn('SPARQL siblings query failed:', err);
      return new Map();
    }
  }

  // Group siblings by the strategy term they relate to
  // Filter out parents with tree depth < 3 (too broad)
  const siblings = new Map(); // termLabel (lower) -> [{ siblingLabel, siblingUI, parentLabel }]

  for (const b of data.results.bindings) {
    const treeNum = b.parentTreeNum.value;
    const depth = treeNum.split('.').length;
    if (depth < 3) continue; // Skip broad parents like "Signs and Symptoms"

    const termKey = b.termLabel.value.toLowerCase();
    const siblingLabel = b.siblingLabel.value;
    const siblingUI = b.sibling.value.split('/').pop();

    // Skip if already in strategy
    if (existingUpper.has(siblingLabel.toUpperCase())) continue;

    if (!siblings.has(termKey)) siblings.set(termKey, []);
    const list = siblings.get(termKey);
    if (!list.some(s => s.siblingLabel === siblingLabel)) {
      list.push({
        siblingLabel,
        siblingUI,
        parentLabel: b.parentLabel.value,
        relationship: 'sibling',
      });
    }
  }

  return siblings;
}

/**
 * SPARQL query: find children (narrower descriptors) for resolved terms.
 * These represent cases where a broad term has been narrowed by adding
 * a more specific subcategory.
 */
async function findChildren(resolvedTerms, originalTerms) {
  const values = resolvedTerms.map(([, ui]) => `mesh:${ui}`).join(' ');
  const existingUpper = new Set(originalTerms.map(t => t.toUpperCase()));

  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX mesh: <http://id.nlm.nih.gov/mesh/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?termLabel ?child ?childLabel WHERE {
      VALUES ?term { ${values} }
      ?term rdfs:label ?termLabel .
      ?child meshv:broaderDescriptor ?term .
      ?child rdfs:label ?childLabel .
    }
    LIMIT 500
  `;

  const cacheKey = `mesh-fixer:sparql:children:${values}`;
  const cached = cacheGet(cacheKey);
  let data;

  if (cached !== undefined) {
    data = cached;
  } else {
    try {
      const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON&limit=500`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`SPARQL ${res.status}`);
      data = await res.json();
      cacheSet(cacheKey, data);
    } catch (err) {
      console.warn('SPARQL children query failed:', err);
      return new Map();
    }
  }

  const children = new Map();

  for (const b of data.results.bindings) {
    const termKey = b.termLabel.value.toLowerCase();
    const childLabel = b.childLabel.value;
    const childUI = b.child.value.split('/').pop();

    if (existingUpper.has(childLabel.toUpperCase())) continue;

    if (!children.has(termKey)) children.set(termKey, []);
    const list = children.get(termKey);
    if (!list.some(s => s.siblingLabel === childLabel)) {
      list.push({
        siblingLabel: childLabel,
        siblingUI: childUI,
        parentLabel: b.termLabel.value,
        relationship: 'child',
      });
    }
  }

  return children;
}

/**
 * Filter siblings/children to only those that appear in the Add Report (newly added).
 */
async function filterToNewlyAdded(siblings, yearFilter) {
  // Collect all unique sibling names to check against Add Report
  const allSiblingNames = new Set();
  for (const [, list] of siblings) {
    for (const s of list) allSiblingNames.add(s.siblingLabel);
  }

  if (allSiblingNames.size === 0) return new Map();

  // Query Add Report for these terms
  const names = [...allSiblingNames];
  const batches = [];
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    batches.push(names.slice(i, i + BATCH_SIZE));
  }

  const addedSet = new Map(); // name (upper) -> { year, ui, entryTerms }

  for (const batch of batches) {
    const inClause = batch.map(n => `'${escapeSoQL(n.toUpperCase())}'`).join(',');
    let where = `preferred_term_field='MH' AND upper(preferred_term) in(${inClause})`;
    if (yearFilter) where += ` AND year='${yearFilter}'`;

    const url = `${BASE_URL}/${ADD_REPORT_ID}.json?$where=${encodeURIComponent(where)}&$limit=5000`;
    const cacheKey = `mesh-fixer:add-check:${yearFilter || 'all'}:${url}`;
    const cached = cacheGet(cacheKey);

    let data;
    if (cached !== undefined) {
      data = cached;
    } else {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        data = await res.json();
        cacheSet(cacheKey, data);
      } catch { continue; }
    }

    for (const record of data) {
      addedSet.set(record.preferred_term.toUpperCase(), {
        year: record.year,
        ui: record.ui,
        entryTerms: record.entry_terms || '',
      });
    }
  }

  // Build final suggestions: only siblings that are in the Add Report
  const suggestions = new Map();

  for (const [termKey, list] of siblings) {
    for (const s of list) {
      const added = addedSet.get(s.siblingLabel.toUpperCase());
      if (!added) continue; // Not newly added, skip

      if (!suggestions.has(termKey)) suggestions.set(termKey, []);
      suggestions.get(termKey).push({
        name: s.siblingLabel,
        ui: added.ui || s.siblingUI,
        year: added.year,
        treeNumbers: '',
        entryTerms: added.entryTerms,
        parentLabel: s.parentLabel,
        relationship: s.relationship || 'sibling',
      });
    }
  }

  return suggestions;
}

/**
 * Fetch tree context (ancestors, self, siblings, children) for a MeSH descriptor.
 * @param {string} ui - MeSH descriptor UI (e.g. "D007383")
 * @returns {Promise<{ ancestors: Array, self: object, siblings: Array, children: Array }>}
 */
export async function fetchTreeContext(ui) {
  const cacheKey = `mesh-fixer:tree:v2:${ui}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX mesh: <http://id.nlm.nih.gov/mesh/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?rel ?descriptor ?label ?treeNum WHERE {
      VALUES ?term { mesh:${ui} }
      {
        ?term meshv:broaderDescriptor+ ?descriptor .
        ?descriptor rdfs:label ?label .
        ?descriptor meshv:treeNumber ?treeNum .
        BIND("ancestor" AS ?rel)
      } UNION {
        ?term rdfs:label ?label .
        ?term meshv:treeNumber ?treeNum .
        BIND(?term AS ?descriptor)
        BIND("self" AS ?rel)
      } UNION {
        ?term meshv:broaderDescriptor ?parent .
        ?sibling meshv:broaderDescriptor ?parent .
        ?sibling rdfs:label ?label .
        ?sibling meshv:treeNumber ?treeNum .
        BIND(?sibling AS ?descriptor)
        BIND("sibling" AS ?rel)
      } UNION {
        ?child meshv:broaderDescriptor ?term .
        ?child rdfs:label ?label .
        ?child meshv:treeNumber ?treeNum .
        BIND(?child AS ?descriptor)
        BIND("child" AS ?rel)
      }
    }
    LIMIT 500
  `;

  try {
    const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON&limit=500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    const data = await res.json();
    const result = processTreeResults(data, ui);
    if (result.self) {
      // Fill in any missing ancestors using tree number hierarchy
      await fillMissingAncestors(result);
      cacheSet(cacheKey, result);
    }
    return result;
  } catch (err) {
    console.warn('SPARQL tree context query failed:', err);
    return { ancestors: [], self: null, siblings: [], children: [] };
  }
}

/**
 * Process SPARQL tree results: group by rel, pick the coherent branch
 * matching the self tree number.
 */
function processTreeResults(data, ui) {
  const byRel = { ancestor: [], self: [], sibling: [], child: [] };

  for (const b of data.results.bindings) {
    const rel = b.rel.value;
    const descUI = b.descriptor.value.split('/').pop();
    // treeNum comes as a URI like http://id.nlm.nih.gov/mesh/C14.907.137.126
    const rawTreeNum = b.treeNum.value;
    const treeNum = rawTreeNum.includes('/') ? rawTreeNum.split('/').pop() : rawTreeNum;
    const entry = {
      label: b.label.value,
      ui: descUI,
      treeNum,
    };
    if (byRel[rel]) byRel[rel].push(entry);
  }

  // Pick the self tree number to use as the reference branch
  const selfEntry = byRel.self.length > 0 ? byRel.self[0] : null;
  if (!selfEntry) return { ancestors: [], self: null, siblings: [], children: [] };

  const selfTreeNum = selfEntry.treeNum;
  const selfParts = selfTreeNum.split('.');

  // Filter ancestors to only those on the same branch (their treeNum is a prefix of self's)
  const ancestors = [];
  const seenAncestors = new Set();
  for (const a of byRel.ancestor) {
    if (seenAncestors.has(a.ui)) continue;
    // Ancestor's tree number should be a prefix of self's tree number
    if (selfTreeNum.startsWith(a.treeNum) || selfTreeNum.startsWith(a.treeNum + '.')) {
      seenAncestors.add(a.ui);
      ancestors.push(a);
    }
  }
  // Sort ancestors by tree number length then alphabetically (shallowest first)
  ancestors.sort((a, b) => a.treeNum.length - b.treeNum.length || a.treeNum.localeCompare(b.treeNum));

  // Deduplicate siblings by UI, include self among siblings for display
  const siblingMap = new Map();
  for (const s of byRel.sibling) {
    if (!siblingMap.has(s.ui)) siblingMap.set(s.ui, s);
  }
  // Include self in siblings list
  siblingMap.set(selfEntry.ui, selfEntry);
  const siblings = [...siblingMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  // Deduplicate children by UI
  const childMap = new Map();
  for (const c of byRel.child) {
    if (!childMap.has(c.ui)) childMap.set(c.ui, c);
  }
  const children = [...childMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  return { ancestors, self: selfEntry, siblings, children };
}

// MeSH top-level category labels (not real descriptors, just organizational labels)
const MESH_CATEGORIES = {
  A: 'Anatomy', B: 'Organisms', C: 'Diseases',
  D: 'Chemicals and Drugs', E: 'Analytical, Diagnostic and Therapeutic Techniques, and Equipment',
  F: 'Psychiatry and Psychology', G: 'Phenomena and Processes',
  H: 'Disciplines and Occupations', I: 'Anthropology, Education, Sociology, and Social Phenomena',
  J: 'Technology, Industry, and Agriculture', K: 'Humanities',
  L: 'Information Science', M: 'Named Groups', N: 'Health Care',
  V: 'Publication Characteristics', Z: 'Geographicals',
};

/**
 * Compute all ancestor tree numbers from a self tree number.
 * E.g. "C14.907.137" → ["C", "C14", "C14.907"]
 *      "B01" → ["B"]
 */
function computeAncestorTreeNums(selfTreeNum) {
  const parts = selfTreeNum.split('.');
  const result = [];
  // Extract root letter category (e.g. "B" from "B01", "C" from "C14")
  const match = parts[0].match(/^([A-Z]+)/);
  if (match && match[1] !== parts[0]) {
    result.push(match[1]);
  }
  // Build up dot-separated prefixes (excluding self)
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('.'));
  }
  return result;
}

/**
 * After processTreeResults, check if ancestors are complete based on tree numbers.
 * If any ancestor levels are missing, fetch them via a supplementary SPARQL query.
 */
async function fillMissingAncestors(result) {
  if (!result.self) return;
  const expected = computeAncestorTreeNums(result.self.treeNum);
  if (expected.length === 0) return;

  const existingTreeNums = new Set(result.ancestors.map(a => a.treeNum));
  const missing = expected.filter(tn => !existingTreeNums.has(tn));
  if (missing.length === 0) return;

  // Separate root category letters (not real descriptors) from real tree numbers
  const rootLetters = missing.filter(tn => /^[A-Z]+$/.test(tn));
  const realTreeNums = missing.filter(tn => !/^[A-Z]+$/.test(tn));

  // Add synthetic entries for root category letters
  for (const letter of rootLetters) {
    const label = MESH_CATEGORIES[letter] || `Category ${letter}`;
    result.ancestors.push({ label, ui: `cat-${letter}`, treeNum: letter, isCategory: true });
  }

  // Fetch descriptors for real missing tree numbers
  if (realTreeNums.length > 0) {
    const treeNumURIs = realTreeNums.map(tn => `<http://id.nlm.nih.gov/mesh/${tn}>`).join(' ');
    const query = `
      PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

      SELECT DISTINCT ?descriptor ?label ?treeNum WHERE {
        VALUES ?treeNum { ${treeNumURIs} }
        ?descriptor meshv:treeNumber ?treeNum .
        ?descriptor rdfs:label ?label .
      }
    `;

    try {
      const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const seenUIs = new Set(result.ancestors.map(a => a.ui));

      for (const b of data.results.bindings) {
        const descUI = b.descriptor.value.split('/').pop();
        if (seenUIs.has(descUI)) continue;
        const rawTreeNum = b.treeNum.value;
        const treeNum = rawTreeNum.includes('/') ? rawTreeNum.split('/').pop() : rawTreeNum;
        seenUIs.add(descUI);
        result.ancestors.push({ label: b.label.value, ui: descUI, treeNum });
      }
    } catch (err) {
      console.warn('Supplementary ancestor fetch failed:', err);
    }
  }

  // Re-sort ancestors by tree number length then alphabetically (shallowest first)
  result.ancestors.sort((a, b) => a.treeNum.length - b.treeNum.length || a.treeNum.localeCompare(b.treeNum));
}

/**
 * Check which of the given MeSH descriptor UIs have at least one child.
 * @param {string[]} uis - MeSH descriptor UIs (e.g. ["D007383", "D058729"])
 * @returns {Promise<Set<string>>} Set of UIs that have children
 */
export async function checkHasChildren(uis) {
  if (uis.length === 0) return new Set();

  const cacheKey = `mesh-fixer:haschildren:${uis.sort().join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return new Set(cached);

  const values = uis.map(ui => `mesh:${ui}`).join(' ');
  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX mesh: <http://id.nlm.nih.gov/mesh/>

    SELECT DISTINCT ?parent WHERE {
      VALUES ?parent { ${values} }
      ?child meshv:broaderDescriptor ?parent .
    }
  `;

  try {
    const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    const data = await res.json();
    const parentUIs = data.results.bindings.map(b => b.parent.value.split('/').pop());
    cacheSet(cacheKey, parentUIs);
    return new Set(parentUIs);
  } catch (err) {
    console.warn('SPARQL hasChildren query failed:', err);
    return new Set(uis); // assume all have children on error
  }
}

/**
 * Fetch top-level descriptors under a MeSH category letter (e.g. "E" → E01, E02, …).
 * @param {string} letter - Single category letter
 * @returns {Promise<{ label: string, ui: string, treeNum: string }[]>}
 */
export async function fetchCategoryChildren(letter) {
  const cacheKey = `mesh-fixer:catchildren:${letter}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?descriptor ?label ?treeNum WHERE {
      ?descriptor meshv:treeNumber ?treeNum .
      ?descriptor rdfs:label ?label .
      FILTER(REGEX(STR(?treeNum), "/${letter}[0-9]+$"))
    }
    ORDER BY ?treeNum
  `;

  try {
    const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON&limit=500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    const data = await res.json();
    const seen = new Map();
    for (const b of data.results.bindings) {
      const ui = b.descriptor.value.split('/').pop();
      if (seen.has(ui)) continue;
      const treeNum = b.treeNum.value.includes('/') ? b.treeNum.value.split('/').pop() : b.treeNum.value;
      seen.set(ui, { label: b.label.value, ui, treeNum });
    }
    const children = [...seen.values()];
    children.sort((a, b) => a.treeNum.localeCompare(b.treeNum));
    cacheSet(cacheKey, children);
    return children;
  } catch (err) {
    console.warn('SPARQL category children query failed:', err);
    return [];
  }
}

/**
 * Fetch detailed info for a MeSH descriptor: scope note, entry terms, qualifiers.
 * @param {string} ui - MeSH descriptor UI (e.g. "D058729")
 * @returns {Promise<{ scopeNote: string|null, entryTerms: string[], qualifiers: {label: string, abbr: string}[] }>}
 */
export async function fetchTermDetails(ui) {
  const cacheKey = `mesh-fixer:details:${ui}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const query = `
    PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
    PREFIX mesh: <http://id.nlm.nih.gov/mesh/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT ?scopeNote ?entryTerm ?qualifierLabel ?qualifierAbbr
           ?annotation ?previousIndexing ?pharmaLabel ?treeNum ?dateIntroduced WHERE {
      VALUES ?d { mesh:${ui} }
      OPTIONAL {
        ?d meshv:preferredConcept ?pc .
        ?pc meshv:scopeNote ?scopeNote .
      }
      OPTIONAL {
        ?d meshv:preferredConcept ?pc2 .
        ?pc2 meshv:term ?termRes .
        ?termRes meshv:prefLabel ?entryTerm .
      }
      OPTIONAL {
        ?d meshv:allowableQualifier ?aq .
        ?aq rdfs:label ?qualifierLabel .
        ?aq meshv:preferredTerm ?aqTerm .
        ?aqTerm meshv:abbreviation ?qualifierAbbr .
      }
      OPTIONAL { ?d meshv:annotation ?annotation . }
      OPTIONAL { ?d meshv:previousIndexing ?previousIndexing . }
      OPTIONAL {
        ?d meshv:pharmacologicalAction ?pa .
        ?pa rdfs:label ?pharmaLabel .
      }
      OPTIONAL { ?d meshv:treeNumber ?treeNum . }
      OPTIONAL { ?d meshv:dateIntroduced ?dateIntroduced . }
    }
    LIMIT 1000
  `;

  try {
    const url = `${MESH_SPARQL}?query=${encodeURIComponent(query)}&format=JSON&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    const data = await res.json();

    // Deduplicate
    let scopeNote = null;
    let annotation = null;
    let dateIntroduced = null;
    const entryTermSet = new Set();
    const qualifierMap = new Map();
    const previousIndexingSet = new Set();
    const pharmaSet = new Set();
    const treeNumSet = new Set();

    for (const b of data.results.bindings) {
      if (b.scopeNote && !scopeNote) scopeNote = b.scopeNote.value;
      if (b.annotation && !annotation) annotation = b.annotation.value;
      if (b.dateIntroduced && !dateIntroduced) dateIntroduced = b.dateIntroduced.value;
      if (b.entryTerm) entryTermSet.add(b.entryTerm.value);
      if (b.qualifierAbbr && b.qualifierLabel) {
        const abbr = b.qualifierAbbr.value.toLowerCase();
        qualifierMap.set(abbr, {
          label: b.qualifierLabel.value,
          abbr,
        });
      }
      if (b.previousIndexing) previousIndexingSet.add(b.previousIndexing.value);
      if (b.pharmaLabel) pharmaSet.add(b.pharmaLabel.value);
      if (b.treeNum) {
        const raw = b.treeNum.value;
        treeNumSet.add(raw.includes('/') ? raw.split('/').pop() : raw);
      }
    }

    const result = {
      scopeNote,
      annotation,
      dateIntroduced: dateIntroduced ? dateIntroduced.split('T')[0] : null,
      entryTerms: [...entryTermSet].sort(),
      qualifiers: [...qualifierMap.values()].sort((a, b) => a.abbr.localeCompare(b.abbr)),
      previousIndexing: [...previousIndexingSet].sort(),
      pharmacologicalActions: [...pharmaSet].sort(),
      treeNumbers: [...treeNumSet].sort(),
    };

    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('SPARQL term details query failed:', err);
    return { scopeNote: null, annotation: null, dateIntroduced: null, entryTerms: [], qualifiers: [], previousIndexing: [], pharmacologicalActions: [], treeNumbers: [] };
  }
}

/**
 * Clear all mesh-fixer cache entries from localStorage.
 * Run from console: meshFixerClearCache()
 */
export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('mesh-fixer:')) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
  console.log(`Cleared ${keys.length} mesh-fixer cache entries.`);
}

// Expose on window for console access
window.meshFixerClearCache = clearCache;

export { ENDPOINTS };

async function queryEndpoint(key, endpoint, terms, yearFilter) {
  const upperTerms = terms.map(t => `'${escapeSoQL(t.toUpperCase())}'`).join(',');
  let where = `upper(${endpoint.termField}) in(${upperTerms})`;

  if (key === 'preferredTerm') {
    where += ` AND updated_field='MH'`;
  }
  if (yearFilter) {
    where += ` AND year='${yearFilter}'`;
  }

  const url = `${BASE_URL}/${endpoint.id}.json?$where=${encodeURIComponent(where)}&$limit=5000`;

  // Check cache
  const cacheKey = `mesh-fixer:${endpoint.id}:${yearFilter || 'all'}:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  cacheSet(cacheKey, data);
  return data;
}

function escapeSoQL(str) {
  return str.replace(/'/g, "''");
}

function normalizeRecord(endpointKey, record) {
  switch (endpointKey) {
    case 'replace':
      return {
        type: 'replaced',
        originalTerm: record.replaced_name,
        year: record.year,
        note: record.note || '',
        replacements: [{
          name: record.replacement_name,
          ui: record.replacement_option_ui,
        }],
      };

    case 'preferredTerm':
      return {
        type: 'renamed',
        originalTerm: record.replaced_value,
        year: record.year,
        note: record.notes || '',
        replacements: [{
          name: record.replacement_value,
          ui: record.ui,
        }],
      };

    case 'delete':
      return {
        type: 'deleted',
        originalTerm: record.deleted_term,
        year: record.year,
        note: '',
        replacements: [],
      };

    case 'merge':
      return {
        type: 'merged',
        originalTerm: record.to_merge,
        year: record.year,
        note: '',
        replacements: [{
          name: record.merge,
          ui: record.replacement_option_ui,
        }],
      };

    default:
      return null;
  }
}
