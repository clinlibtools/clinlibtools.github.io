/**
 * Interactive review UI for MeSH term changes.
 * Renders change cards and a live diff preview of the strategy.
 */

import { resolveTermUIs, fetchTreeContext, checkHasChildren, fetchTermDetails, fetchCategoryChildren, lookupTermHistory } from './api.js';
import { validateSyntax, validateTermExistence } from './validator.js';

/**
 * @typedef {Object} Decision
 * @property {boolean} accepted
 * @property {string|null} selectedReplacement - Chosen replacement name (if multiple)
 * @property {boolean} keepOld - Keep original term alongside replacement (default true)
 */

/** @type {Map<string, Decision>} keyed by term (lowercase) */
let decisions = new Map();
let currentParsedLines = [];
let currentChanges = new Map();
let onDecisionChange = null;
let currentSuggestions = new Map();
/** @type {{ name: string, relatedTo: string }[]} terms the user chose to add */
let addedTerms = [];
/** @type {Set<number>} line numbers the user manually marked for removal */
let removedLines = new Set();
/** @type {Map<number, string>} line number → edited content */
let lineEdits = new Map();
/** @type {{ afterLineNum: number, content: string }[]} user-inserted lines (shown after the given original lineNum) */
let insertedLines = [];
/** @type {Map<string, string>} term name (lowercase) → MeSH UI for linking */
let knownUIs = new Map();
/** @type {Set<string>} terms (lowercase) we've already checked via API */
let checkedTerms = new Set();
/** @type {Map<number, {severity: string, message: string}[]>} line number → validation issues */
let validationsByLine = new Map();
/** @type {{ term: string, termKey: string, lineNums: number[] }[]} terms not found in vocabulary */
let currentNotFound = [];
/** @type {string|null} year filter used for queries */
let currentYearFilter = null;
/** @type {Function|null} recheck callback provided by app.js */
let onRecheckTerms = null;
/** @type {string|null} currently displayed detail panel term (lowercase) */
let detailPanelTerm = null;
/** @type {boolean} whether detail panel is pinned */
let detailPanelPinned = false;
/** @type {number|null} debounce timer for clearing detail panel */
let detailPanelDebounce = null;
/** @type {{ termName: string, tree: object }|null} cached tree data for current panel */
let currentTreeData = null;

const MESH_BROWSER_UI = 'https://meshb.nlm.nih.gov/record/ui?ui=';
const MESH_BROWSER_SEARCH = 'https://id.nlm.nih.gov/mesh/?label=';
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
const CLICK_HINT = IS_MAC ? '\u2318+click to view in MeSH Browser' : 'Ctrl+click to view in MeSH Browser';

/**
 * Initialize the review UI.
 * @param {import('./parser.js').ParsedLine[]} parsedLines
 * @param {Map<string, import('./api.js').Change[]>} changes
 * @param {Function} onUpdate - Callback when decisions change
 * @param {Map<string, any[]>} [suggestions] - Related new terms from Add Report
 * @param {object} [opts]
 * @param {string|null} [opts.yearFilter] - Year filter for API queries
 * @param {Function}    [opts.recheckFn]  - async fn(newTerms, yearFilter) => { changes, suggestions }
 */
export function renderReview(parsedLines, changes, onUpdate, suggestions, opts) {
  currentParsedLines = parsedLines;
  currentChanges = changes;
  onDecisionChange = onUpdate;
  currentSuggestions = suggestions || new Map();
  decisions = new Map();
  addedTerms = [];
  removedLines = new Set();
  lineEdits = new Map();
  insertedLines = [];
  knownUIs = new Map();
  currentYearFilter = opts?.yearFilter || null;
  onRecheckTerms = opts?.recheckFn || null;
  detailPanelTerm = null;
  detailPanelPinned = false;
  detailPanelDebounce = null;
  currentTreeData = null;
  showDetailPlaceholder();

  // Build validation lookup by line number (syntax issues only)
  validationsByLine = new Map();
  if (opts?.validations) {
    for (const v of opts.validations) {
      if (!validationsByLine.has(v.lineNum)) validationsByLine.set(v.lineNum, []);
      validationsByLine.get(v.lineNum).push({ severity: v.severity, message: v.message });
    }
  }

  // Store not-found terms for problem cards
  currentNotFound = opts?.notFoundTerms || [];

  // Record which terms have already been checked
  checkedTerms = new Set(parsedLines.filter(l => l.type === 'mesh' && l.term).map(l => l.term.toLowerCase()));

  // Collect known UIs from change data
  for (const [, changeList] of changes) {
    for (const change of changeList) {
      for (const r of change.replacements || []) {
        if (r.ui) knownUIs.set(r.name.toLowerCase(), r.ui);
      }
    }
  }
  // Collect UIs from suggestions (including resolved UIs for original terms)
  if (suggestions) {
    if (suggestions._resolvedUIs) {
      for (const [termLower, ui] of suggestions._resolvedUIs) {
        knownUIs.set(termLower, ui);
      }
    }
    for (const [, newTerms] of suggestions) {
      for (const nt of newTerms) {
        if (nt.ui) knownUIs.set(nt.name.toLowerCase(), nt.ui);
      }
    }
  }

  // Group changes by term and deduplicate replacements
  const grouped = groupChanges(changes);

  // Set default decisions (all accepted, first replacement selected)
  for (const [termKey, group] of grouped) {
    const firstReplacement = group.replacements.length > 0 ? group.replacements[0].name : null;
    decisions.set(termKey, { accepted: true, selectedReplacement: firstReplacement, keepOld: true });
  }

  renderChangeCards(grouped);
  renderNotFoundCards();
  renderSuggestions(currentSuggestions);
  renderPreview();

  // Resolve UIs for original strategy terms in background (for ctrl+click linking)
  const meshTermNames = parsedLines.filter(l => l.type === 'mesh' && l.term).map(l => l.term);
  if (meshTermNames.length > 0) {
    resolveTermUIs(meshTermNames).then(termUIs => {
      for (const [termLower, ui] of termUIs) {
        knownUIs.set(termLower, ui);
      }
      // Re-render preview so links use direct UIs
      renderPreview();
      // Validate qualifiers now that UIs are resolved
      validateQualifiers();
    }).catch(() => {});
  }
}

/**
 * Get current decisions map.
 */
export function getDecisions() {
  return new Map(decisions);
}

/**
 * Get list of new terms the user chose to add.
 */
export function getAddedTerms() {
  return [...addedTerms];
}

/**
 * Get set of line numbers the user manually removed.
 */
export function getRemovedLines() {
  return new Set(removedLines);
}

/**
 * Get map of user edits to existing lines.
 */
export function getLineEdits() {
  return new Map(lineEdits);
}

/**
 * Get user-inserted lines.
 */
export function getInsertedLines() {
  return [...insertedLines];
}

/**
 * Group all changes for a term, deduplicating replacement options.
 */
function groupChanges(changes) {
  const grouped = new Map();

  for (const [termKey, changeList] of changes) {
    const types = new Set();
    const replacements = [];
    const seenReplacements = new Set();
    let latestYear = '0';
    const notes = [];

    for (const change of changeList) {
      types.add(change.type);
      if (change.year > latestYear) latestYear = change.year;
      if (change.note) notes.push(change.note);

      for (const r of change.replacements || []) {
        if (!seenReplacements.has(r.name.toLowerCase())) {
          seenReplacements.add(r.name.toLowerCase());
          replacements.push(r);
        }
      }
    }

    // Pick the most significant type for the badge
    let primaryType = 'replaced';
    if (types.has('deleted') && replacements.length === 0) primaryType = 'deleted';
    else if (types.has('replaced')) primaryType = 'replaced';
    else if (types.has('merged')) primaryType = 'merged';
    else if (types.has('renamed')) primaryType = 'renamed';

    // Find the original term name with original casing from the parsed lines
    const originalTerm = findOriginalTerm(termKey) || changeList[0].originalTerm;

    grouped.set(termKey, { originalTerm, primaryType, types: [...types], replacements, year: latestYear, notes });
  }

  return grouped;
}

function findOriginalTerm(termKeyLower) {
  for (const line of currentParsedLines) {
    if (line.type === 'mesh' && line.term && line.term.toLowerCase() === termKeyLower) {
      return line.term;
    }
  }
  return null;
}

function renderChangeCards(grouped) {
  const container = document.getElementById('change-cards');
  container.innerHTML = '';

  if (grouped.size === 0 && currentNotFound.length === 0) {
    container.innerHTML = '<div class="no-changes">All MeSH terms are current. No changes needed.</div>';
    return;
  }

  for (const [termKey, group] of grouped) {
    const card = document.createElement('div');
    card.className = `change-card change-${group.primaryType}`;
    card.dataset.termKey = termKey;

    const decision = decisions.get(termKey);

    let replacementHTML = '';
    if (group.replacements.length === 0) {
      replacementHTML = '<div class="replacement-warning">No direct replacement available. Line will be commented out if accepted.</div>';
    } else if (group.replacements.length === 1) {
      const r = group.replacements[0];
      replacementHTML = `<div class="replacement-single">
        <span class="arrow">&rarr;</span>
        <a class="new-term mesh-link" href="${meshURL(r.name)}" target="_blank">${escapeHTML(r.name)}</a>
      </div>`;
    } else {
      replacementHTML = '<div class="replacement-options">' +
        group.replacements.map((r, i) => `
          <label class="replacement-option">
            <input type="radio" name="repl-${termKey}" value="${escapeHTML(r.name)}"
              ${decision.selectedReplacement === r.name ? 'checked' : ''}>
            <span class="arrow">&rarr;</span>
            <a class="new-term mesh-link" href="${meshURL(r.name)}" target="_blank">${escapeHTML(r.name)}</a>
          </label>
        `).join('') + '</div>';
    }

    card.innerHTML = `
      <div class="card-header">
        <span class="badge badge-${group.primaryType}">${group.primaryType}</span>
        <span class="card-year">${group.year}</span>
        <label class="accept-toggle">
          <input type="checkbox" ${decision.accepted ? 'checked' : ''} data-term-key="${termKey}">
          <span class="toggle-label">${decision.accepted ? 'Accepted' : 'Rejected'}</span>
        </label>
      </div>
      <div class="card-body">
        <div class="old-term">${escapeHTML(group.originalTerm)}</div>
        ${replacementHTML}
        ${group.replacements.length > 0 ? `<label class="keep-old-toggle">
            <input type="checkbox" class="keep-old-checkbox" data-term-key="${termKey}" ${decision.keepOld ? 'checked' : ''}>
            <span class="keep-old-label">Keep old term too</span>
          </label>` : ''}
        ${group.notes.length > 0 ? `<div class="card-note">${escapeHTML(group.notes[0])}</div>` : ''}
      </div>
    `;

    // Hover/click on old-term → detail panel
    const oldTermEl = card.querySelector('.old-term');
    oldTermEl.style.cursor = 'pointer';
    addInfoHover(oldTermEl, group.originalTerm);

    // Hover/click on new-term (replacement) → detail panel
    for (const link of card.querySelectorAll('.new-term')) {
      const replacementName = link.textContent.trim();
      link.addEventListener('click', (e) => {
        e.preventDefault();
      });
      addInfoHover(link, replacementName);
    }

    // Event: accept/reject toggle
    card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      const d = decisions.get(termKey);
      d.accepted = e.target.checked;
      e.target.nextElementSibling.textContent = d.accepted ? 'Accepted' : 'Rejected';
      card.classList.toggle('rejected', !d.accepted);
      renderPreview();
      if (onDecisionChange) onDecisionChange();
    });

    // Event: replacement radio buttons
    const radios = card.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      radio.addEventListener('change', (e) => {
        decisions.get(termKey).selectedReplacement = e.target.value;
        renderPreview();
        if (onDecisionChange) onDecisionChange();
      });
    }

    // Event: keep-old toggle
    const keepOldCheckbox = card.querySelector('.keep-old-checkbox');
    if (keepOldCheckbox) {
      keepOldCheckbox.addEventListener('change', (e) => {
        decisions.get(termKey).keepOld = e.target.checked;
        renderPreview();
        if (onDecisionChange) onDecisionChange();
      });
    }

    // Highlight corresponding preview lines on hover
    addCardHighlight(card, findLineNumsForTerm(termKey));

    container.appendChild(card);
  }
}

function renderNotFoundCards() {
  const container = document.getElementById('change-cards');
  // Append after existing change cards (don't clear — renderChangeCards already ran)

  // Collect not-found term names for history lookup
  const nfTermNames = currentNotFound.map(nf => nf.term);

  for (const nf of currentNotFound) {
    const card = document.createElement('div');
    card.className = 'change-card change-notfound';
    card.dataset.termKey = nf.termKey;

    card.innerHTML = `
      <div class="card-header">
        <span class="badge badge-notfound">not found</span>
      </div>
      <div class="card-body">
        <div class="old-term">${escapeHTML(nf.term)}</div>
        <div class="card-note notfound-history">Checking history\u2026</div>
      </div>
    `;

    // Hover/click on old-term → detail panel
    const nfOldTermEl = card.querySelector('.old-term');
    nfOldTermEl.style.cursor = 'pointer';
    addInfoHover(nfOldTermEl, nf.term);

    // Highlight corresponding preview lines on hover
    addCardHighlight(card, nf.lineNums);

    container.appendChild(card);
  }

  // Look up historical changes for all not-found terms
  if (nfTermNames.length > 0) {
    lookupTermHistory(nfTermNames).then(historyMap => {
      for (const nf of currentNotFound) {
        const card = container.querySelector(`.change-card[data-term-key="${nf.termKey}"]`);
        if (!card) continue;
        const noteEl = card.querySelector('.notfound-history');
        if (!noteEl) continue;

        const history = historyMap.get(nf.termKey);
        if (history && history.length > 0) {
          // Sort by year descending to show most recent change first
          history.sort((a, b) => (b.year || '').localeCompare(a.year || ''));
          const latest = history[0];
          let msg = `This term was ${latest.type} in ${latest.year}`;
          if (latest.replacements && latest.replacements.length > 0) {
            const names = latest.replacements.map(r => r.name).join(', ');
            msg += ` \u2192 ${names}`;
          }
          msg += '. It is no longer in the current MeSH vocabulary.';
          noteEl.textContent = msg;
        } else {
          noteEl.textContent = 'This term was not found in the current MeSH vocabulary or in historical change records. Check for typos.';
        }
      }
    }).catch(() => {
      // On failure, fall back to generic message
      for (const noteEl of container.querySelectorAll('.notfound-history')) {
        if (noteEl.textContent === 'Checking history\u2026') {
          noteEl.textContent = 'This term was not found in the current MeSH vocabulary. Check for typos or use a valid term.';
        }
      }
    });
  }
}

/**
 * Add hover handlers to a card element to highlight corresponding preview lines.
 * @param {HTMLElement} el - The card/suggestion element
 * @param {number[]} lineNums - Original line numbers to highlight
 */
function addCardHighlight(el, lineNums) {
  el.addEventListener('mouseenter', () => {
    for (const ln of lineNums) {
      const targets = document.querySelectorAll(`[data-line-ref="${ln}"]`);
      targets.forEach(t => t.classList.add('preview-highlight'));
    }
  });
  el.addEventListener('mouseleave', () => {
    document.querySelectorAll('.preview-highlight').forEach(t => t.classList.remove('preview-highlight'));
  });
}

/**
 * Find all original line numbers for a given term key (lowercase).
 */
function findLineNumsForTerm(termKeyLower) {
  return currentParsedLines
    .filter(l => l.type === 'mesh' && l.term && l.term.toLowerCase() === termKeyLower)
    .map(l => l.lineNum);
}

function renderSuggestions(suggestions) {
  const container = document.getElementById('suggestions-panel');
  if (!container) return;
  container.innerHTML = '';

  if (suggestions.size === 0) {
    container.style.display = 'none';
    return;
  }

  // Build a set of exploded strategy terms (lowercase) for coverage checks
  const explodedTerms = new Set(
    currentParsedLines
      .filter(l => l.type === 'mesh' && l.exploded && l.term)
      .map(l => l.term.toLowerCase())
  );

  // Invert the map: group by suggested term name, collecting all related strategy terms
  const bySuggestion = new Map(); // suggestionName -> { nt, relatedTerms: string[], coveredBy: string[] }
  for (const [termKey, newTerms] of suggestions) {
    const originalTerm = findOriginalTerm(termKey) || termKey;
    for (const nt of newTerms) {
      const key = nt.name.toLowerCase();
      if (!bySuggestion.has(key)) {
        bySuggestion.set(key, { nt, relatedTerms: [], coveredBy: [] });
      }
      const entry = bySuggestion.get(key);
      if (!entry.relatedTerms.includes(originalTerm)) {
        entry.relatedTerms.push(originalTerm);
      }
      // If this is a child of an exploded strategy term, it's already covered
      if (nt.relationship === 'child' && explodedTerms.has(termKey)) {
        if (!entry.coveredBy.includes(originalTerm)) {
          entry.coveredBy.push(originalTerm);
        }
      }
    }
  }

  container.style.display = 'block';
  const heading = document.createElement('div');
  heading.className = 'suggestions-heading';
  heading.innerHTML = `<strong>Related new MeSH terms (added since 2023)</strong>
    <span class="suggestions-note">These are newly added MeSH terms that share a parent with terms in your strategy. Siblings under broad categories may not be closely related — check the shared parent shown on each suggestion.</span>`;
  container.appendChild(heading);

  for (const [, { nt, relatedTerms, coveredBy }] of bySuggestion) {
    const isAdded = addedTerms.some(a => a.name === nt.name);

    const item = document.createElement('div');
    item.className = 'suggestion-group' + (isAdded ? ' suggestion-added' : '');

    const relatedLabel = document.createElement('div');
    relatedLabel.className = 'suggestion-parent';
    const relationWord = nt.relationship === 'child' ? 'Child of' : 'Sibling of';
    relatedLabel.appendChild(document.createTextNode(relationWord + ': '));
    relatedTerms.forEach((t, i) => {
      if (i > 0) relatedLabel.appendChild(document.createTextNode(', '));
      const termLink = document.createElement('a');
      termLink.className = 'mesh-link';
      termLink.style.fontWeight = '600';
      termLink.textContent = t;
      termLink.href = meshURL(t);
      termLink.target = '_blank';
      termLink.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      addInfoHover(termLink, t);
      relatedLabel.appendChild(termLink);
    });
    if (nt.relationship !== 'child' && nt.parentLabel) {
      relatedLabel.appendChild(document.createTextNode(' (under '));
      const parentLink = document.createElement('a');
      parentLink.className = 'mesh-link';
      parentLink.textContent = nt.parentLabel;
      parentLink.href = meshURL(nt.parentLabel);
      parentLink.target = '_blank';
      parentLink.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      addInfoHover(parentLink, nt.parentLabel);
      relatedLabel.appendChild(parentLink);
      relatedLabel.appendChild(document.createTextNode(')'));
    }
    item.appendChild(relatedLabel);

    const row = document.createElement('div');
    row.className = 'suggestion-item';

    const btn = document.createElement('button');
    btn.className = isAdded ? 'btn-suggestion btn-suggestion-remove' : 'btn-suggestion btn-suggestion-add';
    btn.textContent = isAdded ? 'Remove' : 'Add';
    btn.addEventListener('click', () => {
      const idx = addedTerms.findIndex(a => a.name === nt.name);
      if (idx >= 0) {
        addedTerms.splice(idx, 1);
      } else {
        addedTerms.push({ name: nt.name, relatedTo: relatedTerms.join(', ') });
      }
      renderSuggestions(currentSuggestions);
      renderPreview();
      if (onDecisionChange) onDecisionChange();
    });

    const info = document.createElement('span');
    info.className = 'suggestion-info';

    const badge = document.createElement('span');
    badge.className = 'badge badge-new';
    badge.textContent = `new ${nt.year}`;

    const termLink = document.createElement('a');
    termLink.className = 'suggestion-term mesh-link';
    termLink.textContent = nt.name;
    termLink.href = meshURL(nt.name);
    termLink.target = '_blank';
    termLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    addInfoHover(termLink, nt.name);

    info.appendChild(badge);
    info.appendChild(document.createTextNode(' '));
    info.appendChild(termLink);

    if (nt.entryTerms && nt.entryTerms !== '[null]') {
      const entry = document.createElement('span');
      entry.className = 'suggestion-entry';
      entry.textContent = ` (${nt.entryTerms.split('|').slice(0, 3).join(', ')})`;
      info.appendChild(entry);
    }

    row.appendChild(btn);
    row.appendChild(info);
    item.appendChild(row);

    // Show coverage note if this term is a child of an exploded strategy term
    if (coveredBy.length > 0) {
      const coverNote = document.createElement('div');
      coverNote.className = 'suggestion-covered';
      coverNote.textContent = `Already covered by exp ${coveredBy.join(', ')}`;
      item.appendChild(coverNote);
    }

    // Highlight corresponding preview lines on hover
    const relatedLineNums = relatedTerms.flatMap(t => findLineNumsForTerm(t.toLowerCase()));
    addCardHighlight(item, relatedLineNums);

    container.appendChild(item);
  }
}

function renderPreview() {
  const container = document.getElementById('strategy-preview');
  container.innerHTML = '';

  // Build a lookup: afterLineNum → [inserted lines in order]
  const insertionsAfter = new Map();
  for (const ins of insertedLines) {
    if (!insertionsAfter.has(ins.afterLineNum)) insertionsAfter.set(ins.afterLineNum, []);
    insertionsAfter.get(ins.afterLineNum).push(ins);
  }

  let displayNum = 1;

  // Render insertions before all original lines (afterLineNum === 0)
  for (const ins of (insertionsAfter.get(0) || [])) {
    container.appendChild(makeLine(displayNum++, ins.content, 'added', { editable: true, insertedRef: ins }));
  }

  for (const line of currentParsedLines) {
    const isManuallyRemoved = removedLines.has(line.lineNum);
    const isMesh = line.type === 'mesh' && line.term;
    const hasEdit = lineEdits.has(line.lineNum);
    const effective = getEffectiveContent(line);
    const display = hasEdit ? lineEdits.get(line.lineNum) : effective;
    const changed = display !== line.raw; // differs from original input

    const lineWarnings = validationsByLine.get(line.lineNum) || [];

    if (isManuallyRemoved) {
      // Skip removed lines entirely
    } else if (changed) {
      // Show current version in green (editable), no removed line
      container.appendChild(makeLine(displayNum++, display, 'added', {
        removable: isMesh ? line.lineNum : null,
        editable: true,
        lineRef: line.lineNum,
        warnings: lineWarnings,
      }));
    } else {
      // Unchanged — show as-is, editable
      const muted = line.type === 'combination' || line.type === 'other';
      container.appendChild(makeLine(displayNum++, display, muted ? 'muted' : 'unchanged', {
        removable: isMesh ? line.lineNum : null,
        editable: true,
        lineRef: line.lineNum,
        warnings: lineWarnings,
      }));
    }

    // When keepOld is true and accepted with a replacement, add the new term line
    if (!isManuallyRemoved && isMesh) {
      const termKey = line.term.toLowerCase();
      const decision = decisions.get(termKey);
      if (decision && decision.accepted && decision.keepOld && decision.selectedReplacement) {
        const newLine = line.raw.replace(line.term, decision.selectedReplacement);
        container.appendChild(makeLine(displayNum++, newLine, 'added', {}));
      }
    }

    // Render any lines inserted after this original line
    for (const ins of (insertionsAfter.get(line.lineNum) || [])) {
      container.appendChild(makeLine(displayNum++, ins.content, 'added', { editable: true, insertedRef: ins }));
    }
  }

  // Added terms from suggestions
  if (addedTerms.length > 0) {
    addedTerms.forEach((at, i) => {
      container.appendChild(makeLine(displayNum++, `${at.name}/`, 'added', { editable: true, addedTermIndex: i }));
    });
  }

  // "Add line" button
  const addLineBtn = document.createElement('button');
  addLineBtn.className = 'btn-add-line';
  addLineBtn.textContent = '+ Add line';
  addLineBtn.addEventListener('click', () => {
    const lastOrigNum = currentParsedLines.length > 0
      ? currentParsedLines[currentParsedLines.length - 1].lineNum : 0;
    insertedLines.push({ afterLineNum: lastOrigNum, content: '' });
    renderPreview();
    const editables = container.querySelectorAll('.line-content[contenteditable]');
    if (editables.length) editables[editables.length - 1].focus();
  });
  container.appendChild(addLineBtn);
}

/**
 * Append validation annotation divs for a given line number.
 */
function appendValidationAnnotations(container, lineNum) {
  const issues = validationsByLine.get(lineNum);
  if (!issues || issues.length === 0) return;
  for (const issue of issues) {
    const ann = document.createElement('div');
    ann.className = issue.severity === 'error' ? 'validation-error' : 'validation-warning';
    ann.textContent = issue.message;
    container.appendChild(ann);
  }
}

/**
 * Build a single preview line element.
 * @param {number} lineNum
 * @param {string} content
 * @param {string} style - 'removed' | 'added' | 'unchanged' | 'muted'
 * @param {object} opts
 * @param {number|null} [opts.removable] - show remove/restore button for this lineNum
 * @param {boolean}     [opts.editable]  - make content editable
 * @param {number|null} [opts.lineRef]   - existing line number (for tracking edits on blur)
 * @param {object|null} [opts.insertedRef] - reference to an inserted-line object
 */
function makeLine(lineNum, content, style, opts) {
  opts = opts || {};
  const lineEl = document.createElement('div');
  lineEl.className = `preview-line diff-line-${style}`;

  // Tag with original line number for highlight targeting
  if (opts.lineRef != null) {
    lineEl.dataset.lineRef = opts.lineRef;
  }

  // Action button column
  if (opts.removable != null) {
    const btn = document.createElement('button');
    btn.className = 'btn-line-action btn-line-remove';
    btn.textContent = '−';
    btn.title = 'Remove this line';
    btn.addEventListener('click', () => {
      removedLines.add(opts.removable);
      renderPreview();
      if (onDecisionChange) onDecisionChange();
    });
    lineEl.appendChild(btn);
  } else if (opts.insertedRef) {
    const btn = document.createElement('button');
    btn.className = 'btn-line-action btn-line-remove';
    btn.textContent = '×';
    btn.title = 'Delete this line';
    btn.style.opacity = '1';
    btn.addEventListener('click', () => {
      const idx = insertedLines.indexOf(opts.insertedRef);
      if (idx >= 0) insertedLines.splice(idx, 1);
      renderPreview();
      if (onDecisionChange) onDecisionChange();
    });
    lineEl.appendChild(btn);
  } else if (opts.addedTermIndex != null) {
    const btn = document.createElement('button');
    btn.className = 'btn-line-action btn-line-remove';
    btn.textContent = '×';
    btn.title = 'Delete this line';
    btn.style.opacity = '1';
    btn.addEventListener('click', () => {
      addedTerms.splice(opts.addedTermIndex, 1);
      renderPreview();
      if (onDecisionChange) onDecisionChange();
    });
    lineEl.appendChild(btn);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'btn-line-spacer';
    lineEl.appendChild(spacer);
  }

  // Line number
  const numSpan = document.createElement('span');
  numSpan.className = 'line-num';
  numSpan.textContent = String(lineNum).padStart(3);

  // Content
  const contentSpan = document.createElement('span');
  contentSpan.className = 'line-content';
  contentSpan.textContent = content;

  if (opts.editable) {
    contentSpan.contentEditable = 'true';
    contentSpan.spellcheck = false;

    contentSpan.addEventListener('blur', () => {
      // Skip if Enter already handled the commit and re-render
      if (contentSpan._skipBlurRender) {
        delete contentSpan._skipBlurRender;
        recheckNewTerms();
        return;
      }
      const newText = contentSpan.textContent.trim();
      if (opts.insertedRef) {
        opts.insertedRef.content = newText;
      } else if (opts.addedTermIndex != null) {
        addedTerms[opts.addedTermIndex].name = newText.replace(/\/$/, '');
      } else if (opts.lineRef != null) {
        const origLine = currentParsedLines.find(l => l.lineNum === opts.lineRef);
        const effective = origLine ? getEffectiveContent(origLine) : '';
        if (newText !== effective) {
          lineEdits.set(opts.lineRef, newText);
        } else {
          lineEdits.delete(opts.lineRef);
        }
      }
      // Re-render to show diff if content changed
      renderPreview();
      // Check any new MeSH terms introduced by this edit
      recheckNewTerms();
    });

    contentSpan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();

        // Commit current edit inline (without triggering blur's re-render)
        const newText = contentSpan.textContent.trim();
        if (opts.insertedRef) {
          opts.insertedRef.content = newText;
        } else if (opts.addedTermIndex != null) {
          addedTerms[opts.addedTermIndex].name = newText.replace(/\/$/, '');
        } else if (opts.lineRef != null) {
          const origLine = currentParsedLines.find(l => l.lineNum === opts.lineRef);
          const effective = origLine ? getEffectiveContent(origLine) : '';
          if (newText !== effective) {
            lineEdits.set(opts.lineRef, newText);
          } else {
            lineEdits.delete(opts.lineRef);
          }
        }

        // Determine where to insert the new line
        // For an original line: afterLineNum = that line's lineNum
        // For an inserted line: same afterLineNum, placed right after it in the array
        const parentLineNum = opts.insertedRef
          ? opts.insertedRef.afterLineNum
          : (opts.lineRef != null ? opts.lineRef : currentParsedLines[currentParsedLines.length - 1]?.lineNum || 0);

        const ins = { afterLineNum: parentLineNum, content: '' };

        if (opts.insertedRef) {
          // Insert right after the current inserted line in the array
          const idx = insertedLines.indexOf(opts.insertedRef);
          insertedLines.splice(idx + 1, 0, ins);
        } else {
          // Insert at the start of the group for this afterLineNum
          // (right after the original line, before any existing insertions)
          const firstIdx = insertedLines.findIndex(i => i.afterLineNum === parentLineNum);
          if (firstIdx >= 0) {
            insertedLines.splice(firstIdx, 0, ins);
          } else {
            insertedLines.push(ins);
          }
        }

        // Flag to suppress blur's re-render since we're about to render ourselves
        contentSpan._skipBlurRender = true;

        renderPreview();

        // Focus the newly created empty line
        const container = document.getElementById('strategy-preview');
        const allEditables = container.querySelectorAll('.line-content[contenteditable]');
        for (const el of allEditables) {
          if (el.textContent === '' && el.closest('.diff-line-added')) {
            el.focus();
            break;
          }
        }
      }

      if (e.key === 'Backspace' && contentSpan.textContent.trim() === '') {
        e.preventDefault();
        contentSpan._skipBlurRender = true;

        if (opts.insertedRef) {
          const idx = insertedLines.indexOf(opts.insertedRef);
          if (idx >= 0) insertedLines.splice(idx, 1);
        } else if (opts.addedTermIndex != null) {
          addedTerms.splice(opts.addedTermIndex, 1);
        } else if (opts.lineRef != null) {
          removedLines.add(opts.lineRef);
        }

        renderPreview();
        if (onDecisionChange) onDecisionChange();

        // Focus the previous editable line
        const container = document.getElementById('strategy-preview');
        const allEditables = [...container.querySelectorAll('.line-content[contenteditable]')];
        if (allEditables.length) allEditables[allEditables.length - 1].focus();
      }
    });
  }

  // Tree icon button on MeSH lines (only on non-removed lines)
  const meshTermMatch = content.match(/^(?:exp\s+)?\*?(.+?)\//);
  if (meshTermMatch && style !== 'removed') {
    const treeBtn = document.createElement('button');
    treeBtn.className = 'btn-tree-icon';
    treeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L3 6h3v2H3l-1 1v1h4v4h2v-4h4v-1l-1-1h-3V6h3L8 1z"/></svg>';
    treeBtn.title = 'Explore MeSH tree';
    const previewTermName = meshTermMatch[1].trim();
    treeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDetailPanel(previewTermName, { pin: true, showTree: true });
    });
    lineEl.appendChild(treeBtn);
  }

  lineEl.appendChild(numSpan);
  lineEl.appendChild(contentSpan);

  // Warning indicator at end of line
  if (opts.warnings && opts.warnings.length > 0) {
    const warn = document.createElement('span');
    warn.className = 'line-warning-icon';
    warn.textContent = '\u26A0';
    const tipText = opts.warnings.map(w => w.message).join('; ');
    warn.addEventListener('mouseenter', () => {
      let tip = document.querySelector('.line-warning-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'line-warning-tooltip';
        document.body.appendChild(tip);
      }
      tip.textContent = tipText;
      tip.style.display = 'block';
      const rect = warn.getBoundingClientRect();
      // Position below the icon, shifted left so it doesn't overflow the viewport
      const tipWidth = tip.offsetWidth;
      let left = rect.left + rect.width / 2 - tipWidth / 2;
      if (left + tipWidth > window.innerWidth - 8) left = window.innerWidth - tipWidth - 8;
      if (left < 8) left = 8;
      tip.style.left = left + 'px';
      tip.style.top = (rect.bottom + 6) + 'px';
    });
    warn.addEventListener('mouseleave', () => {
      const tip = document.querySelector('.line-warning-tooltip');
      if (tip) tip.style.display = 'none';
    });
    lineEl.appendChild(warn);
  }

  return lineEl;
}

/** Get the effective (post-auto-replacement) content for a line, ignoring manual edits */
function getEffectiveContent(line) {
  if (line.type === 'mesh' && line.term) {
    const termKey = line.term.toLowerCase();
    const decision = decisions.get(termKey);
    if (decision && decision.accepted && decision.selectedReplacement) {
      // When keepOld is true, the original line stays unchanged
      // (the new term line is added separately in renderPreview/generateOutput)
      if (decision.keepOld) return line.raw;
      return line.raw.replace(line.term, decision.selectedReplacement);
    }
  }
  return line.raw;
}

/**
 * Extract MeSH terms from all current content (edited lines, inserted lines).
 * Returns only terms not yet checked.
 */
function getUncheckedTerms() {
  const meshPattern = /^(?:exp\s+)?\*?(.+?)\/(.*)$/;
  const allTerms = new Set();

  // From edited existing lines
  for (const [, content] of lineEdits) {
    const m = content.match(meshPattern);
    if (m) allTerms.add(m[1].trim().replace(/^"|"$/g, ''));
  }

  // From inserted lines
  for (const ins of insertedLines) {
    const m = ins.content.match(meshPattern);
    if (m) allTerms.add(m[1].trim().replace(/^"|"$/g, ''));
  }

  // From added terms (suggestions)
  for (const at of addedTerms) {
    const m = `${at.name}/`.match(meshPattern);
    if (m) allTerms.add(m[1].trim().replace(/^"|"$/g, ''));
  }

  // Filter to only unchecked
  return [...allTerms].filter(t => !checkedTerms.has(t.toLowerCase()));
}

/**
 * Build a synthetic parsedLines array reflecting current edits and insertions.
 */
function buildCurrentParsedLines() {
  const meshPattern = /^(exp\s+)?(\*)?(.+?)\/(.*)$/;
  const lines = currentParsedLines.map(line => {
    if (lineEdits.has(line.lineNum)) {
      const content = lineEdits.get(line.lineNum);
      const m = content.match(meshPattern);
      if (m) {
        return {
          ...line,
          raw: content,
          type: 'mesh',
          exploded: !!m[1],
          focused: !!m[2],
          term: m[3].trim().replace(/^"|"$/g, ''),
          subheading: m[4].trim() || null,
        };
      }
      return { ...line, raw: content, type: 'other', term: undefined };
    }
    return line;
  });

  // Add inserted lines
  for (const ins of insertedLines) {
    if (!ins.content.trim()) continue;
    const m = ins.content.match(meshPattern);
    if (m) {
      lines.push({
        lineNum: ins.afterLineNum + 0.5,
        raw: ins.content,
        type: 'mesh',
        exploded: !!m[1],
        focused: !!m[2],
        term: m[3].trim().replace(/^"|"$/g, ''),
        subheading: m[4].trim() || null,
      });
    }
  }

  // Add terms from suggestions
  for (const at of addedTerms) {
    const content = `${at.name}/`;
    const m = content.match(meshPattern);
    if (m) {
      lines.push({
        lineNum: 99999 + lines.length,
        raw: content,
        type: 'mesh',
        exploded: false,
        focused: false,
        term: m[3].trim().replace(/^"|"$/g, ''),
        subheading: m[4].trim() || null,
      });
    }
  }

  return lines;
}

/**
 * Re-run syntax validation using current edited line content.
 */
function revalidateSyntax() {
  const editedLines = buildCurrentParsedLines();
  const syntaxIssues = validateSyntax(editedLines);

  // Rebuild validationsByLine with fresh syntax issues only
  validationsByLine = new Map();
  for (const v of syntaxIssues) {
    if (!validationsByLine.has(v.lineNum)) validationsByLine.set(v.lineNum, []);
    validationsByLine.get(v.lineNum).push({ severity: v.severity, message: v.message });
  }
}

/**
 * Check that qualifiers used on MeSH lines are allowable for the descriptor.
 * Fetches term details (cached) and compares used qualifiers against allowable ones.
 */
async function validateQualifiers() {
  const editedLines = buildCurrentParsedLines();
  const meshLinesWithQualifiers = editedLines.filter(
    l => l.type === 'mesh' && l.term && l.subheading
  );
  if (meshLinesWithQualifiers.length === 0) return;

  // Deduplicate terms to minimize API calls
  const termLines = new Map(); // termLower → [lines]
  for (const line of meshLinesWithQualifiers) {
    const key = line.term.toLowerCase();
    if (!termLines.has(key)) termLines.set(key, []);
    termLines.get(key).push(line);
  }

  // Resolve UIs for terms we need to check
  const termsToResolve = [...termLines.keys()].filter(t => !knownUIs.has(t));
  if (termsToResolve.length > 0) {
    const resolved = await resolveTermUIs(termsToResolve.map(t => {
      // Use original casing from the first line
      return termLines.get(t)[0].term;
    }));
    for (const [t, ui] of resolved) knownUIs.set(t, ui);
  }

  // Fetch details and validate qualifiers
  const detailsPromises = [];
  for (const [termLower] of termLines) {
    const ui = knownUIs.get(termLower);
    if (!ui) continue;
    detailsPromises.push(
      fetchTermDetails(ui).then(details => ({ termLower, details })).catch(() => null)
    );
  }

  const results = await Promise.all(detailsPromises);
  let changed = false;

  for (const result of results) {
    if (!result || !result.details || !result.details.qualifiers) continue;
    const { termLower, details } = result;
    const allowable = new Set(details.qualifiers.map(q => q.abbr));
    if (allowable.size === 0) continue; // No qualifier data available

    for (const line of termLines.get(termLower)) {
      const codes = line.subheading.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
      for (const code of codes) {
        if (!allowable.has(code)) {
          const qualLabel = details.qualifiers.find(q => q.abbr === code);
          const msg = `Qualifier "/${code}" is not allowable for ${line.term}`;
          if (!validationsByLine.has(line.lineNum)) validationsByLine.set(line.lineNum, []);
          // Avoid duplicates
          const existing = validationsByLine.get(line.lineNum);
          if (!existing.some(v => v.message === msg)) {
            existing.push({ severity: 'warning', message: msg });
            changed = true;
          }
        }
      }
    }
  }

  if (changed) renderPreview();
}

/**
 * Re-run all validations on current state, check new terms via API if needed.
 * Called on every blur from an editable line.
 */
async function recheckNewTerms() {
  // Always re-run syntax validation
  revalidateSyntax();

  // Always re-check term existence against what we already know
  const editedParsedLines = buildCurrentParsedLines();
  currentNotFound = validateTermExistence(editedParsedLines, knownUIs, currentChanges);

  // Re-render cards and preview with current state
  const allGrouped = groupChanges(currentChanges);
  renderChangeCards(allGrouped);
  renderNotFoundCards();
  renderSuggestions(currentSuggestions);
  renderPreview();

  // Then check any genuinely new terms via API
  if (!onRecheckTerms) return;

  const newTerms = getUncheckedTerms();
  if (newTerms.length === 0) return;

  // Show spinner in suggestions area
  const panel = document.getElementById('suggestions-panel');
  if (panel) {
    panel.style.display = 'block';
    const spinnerDiv = document.createElement('div');
    spinnerDiv.className = 'recheck-spinner';
    spinnerDiv.innerHTML = '<div class="spinner spinner-small"></div> Checking new terms...';
    panel.insertBefore(spinnerDiv, panel.firstChild);
  }

  try {
    const result = await onRecheckTerms(newTerms, currentYearFilter);

    // Mark these terms as checked
    for (const t of newTerms) checkedTerms.add(t.toLowerCase());

    // Merge new changes into currentChanges
    if (result.changes) {
      for (const [termKey, changeList] of result.changes) {
        if (!currentChanges.has(termKey)) {
          currentChanges.set(termKey, changeList);
        } else {
          currentChanges.get(termKey).push(...changeList);
        }
        // Auto-accept new changes
        if (!decisions.has(termKey)) {
          const grouped = groupChanges(new Map([[termKey, changeList]]));
          const group = grouped.get(termKey);
          if (group) {
            decisions.set(termKey, {
              accepted: true,
              selectedReplacement: group.replacements.length > 0 ? group.replacements[0].name : null,
            });
          }
        }
      }
      // Collect new UIs
      for (const [, changeList] of result.changes) {
        for (const change of changeList) {
          for (const r of change.replacements || []) {
            if (r.ui) knownUIs.set(r.name.toLowerCase(), r.ui);
          }
        }
      }
    }

    // Merge new suggestions
    if (result.suggestions) {
      if (result.suggestions._resolvedUIs) {
        for (const [termLower, ui] of result.suggestions._resolvedUIs) {
          knownUIs.set(termLower, ui);
        }
      }
      for (const [termKey, newTermsList] of result.suggestions) {
        if (!currentSuggestions.has(termKey)) {
          currentSuggestions.set(termKey, newTermsList);
        } else {
          const existing = currentSuggestions.get(termKey);
          for (const nt of newTermsList) {
            if (!existing.some(e => e.name === nt.name)) existing.push(nt);
          }
        }
        for (const nt of newTermsList) {
          if (nt.ui) knownUIs.set(nt.name.toLowerCase(), nt.ui);
        }
      }
    }

    // Re-run existence check now that we have new resolved UIs
    currentNotFound = validateTermExistence(buildCurrentParsedLines(), knownUIs, currentChanges);

    // Re-render everything with updated data
    const updatedGrouped = groupChanges(currentChanges);
    renderChangeCards(updatedGrouped);
    renderNotFoundCards();
    renderSuggestions(currentSuggestions);
    renderPreview();
  } catch (err) {
    console.warn('Recheck failed:', err);
  } finally {
    // Remove spinner
    const spinner = document.querySelector('.recheck-spinner');
    if (spinner) spinner.remove();
  }

  // Validate qualifiers asynchronously (uses cached term details when available)
  validateQualifiers();
}

function openInNewTab(url) {
  const w = window.open(url, '_blank', 'noopener');
  if (w) w.focus();
}

function meshURL(termName) {
  const ui = knownUIs.get(termName.toLowerCase());
  if (ui) return MESH_BROWSER_UI + encodeURIComponent(ui);
  // Fallback: try to resolve the UI on the fly and return a search URL
  return MESH_BROWSER_SEARCH + encodeURIComponent(termName);
}

/**
 * Show placeholder text in the detail panel.
 */
function showDetailPlaceholder() {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  panel.className = 'detail-panel';
  panel.innerHTML = '<div class="tree-placeholder">Hover a MeSH term to see details.\nClick to pin and explore its tree hierarchy.</div>';

  // Keep panel visible when hovering over it
  panel.onmouseenter = () => {
    if (detailPanelDebounce) { clearTimeout(detailPanelDebounce); detailPanelDebounce = null; }
  };
  panel.onmouseleave = () => {
    if (!detailPanelPinned && detailPanelTerm) {
      detailPanelDebounce = setTimeout(() => {
        closeDetailPanel();
        detailPanelDebounce = null;
      }, 150);
    }
  };
}

/**
 * Show the unified detail panel for a term.
 * @param {string} termName
 * @param {{ pin?: boolean, showTree?: boolean }} opts
 */
async function showDetailPanel(termName, opts = {}) {
  if (window.innerWidth < 768) return;

  const termKey = termName.toLowerCase();
  const pin = !!opts.pin;
  const showTree = !!opts.showTree;

  // If already showing this term unpinned (hover) and not requesting tree, skip
  if (detailPanelTerm === termKey && !pin && !showTree) return;

  detailPanelTerm = termKey;
  if (pin) detailPanelPinned = true;

  const panel = document.getElementById('detail-panel');
  if (!panel) return;

  panel.className = 'detail-panel' + (detailPanelPinned ? ' detail-pinned' : '');

  // Show loading state
  panel.innerHTML = `
    <div class="detail-info">
      <div class="info-panel-header">
        <span class="info-panel-name">${escapeHTML(termName)}</span>
        <div class="info-panel-actions">
          <button class="btn-info-close" title="Close">&times;</button>
        </div>
      </div>
      <div style="text-align:center;padding:1rem;color:var(--text-muted);">
        <div class="spinner spinner-small"></div> Loading...
      </div>
    </div>
  `;
  panel.querySelector('.btn-info-close').addEventListener('click', closeDetailPanel);

  // Keep panel visible when hovering over it
  panel.onmouseenter = () => {
    if (detailPanelDebounce) { clearTimeout(detailPanelDebounce); detailPanelDebounce = null; }
  };
  panel.onmouseleave = () => {
    if (!detailPanelPinned && detailPanelTerm) {
      detailPanelDebounce = setTimeout(() => {
        closeDetailPanel();
        detailPanelDebounce = null;
      }, 150);
    }
  };

  // Resolve UI
  let ui = knownUIs.get(termKey);
  if (!ui) {
    try {
      const resolved = await resolveTermUIs([termName]);
      ui = resolved.get(termKey);
      if (ui) knownUIs.set(termKey, ui);
    } catch { /* ignore */ }
  }

  if (detailPanelTerm !== termKey) return;

  if (!ui) {
    panel.querySelector('.detail-info').innerHTML = `
      <div class="info-panel-header">
        <span class="info-panel-name">${escapeHTML(termName)}</span>
        <div class="info-panel-actions">
          <button class="btn-info-close" title="Close">&times;</button>
        </div>
      </div>
      <div style="color:var(--text-muted);padding:0.5rem 0;">Could not resolve term.</div>
    `;
    panel.querySelector('.btn-info-close').addEventListener('click', closeDetailPanel);
    return;
  }

  // Fetch info details
  const details = await fetchTermDetails(ui);
  if (detailPanelTerm !== termKey) return;

  renderDetailContent(panel, termName, ui, details, { showTree });
}

/**
 * Close (unpin) the detail panel and show placeholder.
 */
function closeDetailPanel() {
  detailPanelTerm = null;
  detailPanelPinned = false;
  currentTreeData = null;
  showDetailPlaceholder();
}

/**
 * Re-render the current tree section in the detail panel (e.g. after adding/removing a term).
 */
function refreshTreePanel() {
  if (!currentTreeData || !detailPanelPinned) return;
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  const treeSection = panel.querySelector('.detail-tree');
  if (!treeSection) return;
  // Re-render tree section in place
  const newTreeSection = document.createElement('div');
  newTreeSection.className = 'detail-tree';
  renderTreeContent(newTreeSection, currentTreeData.termName, currentTreeData.tree);
  treeSection.replaceWith(newTreeSection);
}

/**
 * Render tree content inside the panel.
 */
async function renderTreeContent(panel, termName, tree) {
  // Build set of strategy terms (lowercase) for in-strategy indicator
  const strategyTerms = new Set(
    currentParsedLines
      .filter(l => l.type === 'mesh' && l.term)
      .map(l => l.term.toLowerCase())
  );

  panel.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'tree-header';
  header.innerHTML = `<span class="tree-header-title" title="${escapeHTML(termName)}">Tree: ${escapeHTML(termName)}</span>`;
  panel.appendChild(header);

  if (!tree.self) {
    const msg = document.createElement('div');
    msg.style.color = 'var(--text-muted)';
    msg.textContent = 'No tree data available.';
    panel.appendChild(msg);
    return;
  }

  const container = document.createElement('div');
  container.className = 'tree-section';

  // Collect all UIs shown at sibling level + self + children to exclude from ancestor expansion
  const renderedUIs = new Set(tree.siblings.map(s => s.ui));
  for (const c of tree.children) renderedUIs.add(c.ui);
  for (const a of tree.ancestors) renderedUIs.add(a.ui);

  // Ancestors — expandable unless synthetic category entries
  for (let i = 0; i < tree.ancestors.length; i++) {
    const a = tree.ancestors[i];
    container.appendChild(makeTreeNode(a, 'ancestor', i, strategyTerms, null, true, renderedUIs));
  }

  // Siblings (including self) at ancestor depth — show a window around self
  const siblingDepth = tree.ancestors.length;
  const selfIdx = tree.siblings.findIndex(s => s.ui === tree.self.ui);
  const MAX_NEARBY = 3;
  const startIdx = Math.max(0, selfIdx - MAX_NEARBY);
  const endIdx = Math.min(tree.siblings.length, selfIdx + MAX_NEARBY + 1);
  const hiddenAbove = startIdx;
  const hiddenBelow = tree.siblings.length - endIdx;

  // Prefetch which visible siblings have children
  const visibleSiblings = tree.siblings.slice(startIdx, endIdx);
  const siblingUIs = visibleSiblings.filter(s => s.ui !== tree.self.ui).map(s => s.ui);
  const siblingHasChildren = siblingUIs.length > 0
    ? await checkHasChildren(siblingUIs)
    : new Set();

  const hiddenAboveSiblings = tree.siblings.slice(0, startIdx);
  const hiddenBelowSiblings = tree.siblings.slice(endIdx);

  if (hiddenAbove > 0) {
    const more = document.createElement('div');
    more.className = 'tree-node tree-node-more tree-node-expandable';
    more.style.paddingLeft = (siblingDepth * 1 + 0.3) + 'rem';
    more.textContent = `\u2026 ${hiddenAbove} more sibling${hiddenAbove > 1 ? 's' : ''}`;
    more.addEventListener('click', async () => {
      more.textContent = 'Loading\u2026';
      const extraUIs = hiddenAboveSiblings.map(s => s.ui);
      const extraHasChildren = extraUIs.length > 0 ? await checkHasChildren(extraUIs) : new Set();
      const fragment = document.createDocumentFragment();
      for (const s of hiddenAboveSiblings) {
        fragment.appendChild(makeTreeNode(s, 'sibling', siblingDepth, strategyTerms, null, extraHasChildren.has(s.ui)));
      }
      more.replaceWith(fragment);
    });
    container.appendChild(more);
  }

  for (const s of visibleSiblings) {
    const isSelf = s.ui === tree.self.ui;
    const preloadChildren = isSelf ? tree.children : null;
    // Self is expandable if it has children; siblings use prefetched data
    const canExpand = isSelf ? tree.children.length > 0 : siblingHasChildren.has(s.ui);
    container.appendChild(makeTreeNode(s, isSelf ? 'self' : 'sibling', siblingDepth, strategyTerms, preloadChildren, canExpand));
  }

  if (hiddenBelow > 0) {
    const more = document.createElement('div');
    more.className = 'tree-node tree-node-more tree-node-expandable';
    more.style.paddingLeft = (siblingDepth * 1 + 0.3) + 'rem';
    more.textContent = `\u2026 ${hiddenBelow} more sibling${hiddenBelow > 1 ? 's' : ''}`;
    more.addEventListener('click', async () => {
      more.textContent = 'Loading\u2026';
      const extraUIs = hiddenBelowSiblings.map(s => s.ui);
      const extraHasChildren = extraUIs.length > 0 ? await checkHasChildren(extraUIs) : new Set();
      const fragment = document.createDocumentFragment();
      for (const s of hiddenBelowSiblings) {
        fragment.appendChild(makeTreeNode(s, 'sibling', siblingDepth, strategyTerms, null, extraHasChildren.has(s.ui)));
      }
      more.replaceWith(fragment);
    });
    container.appendChild(more);
  }

  panel.appendChild(container);
}

/**
 * @param {object} entry - { label, ui, treeNum }
 * @param {string} rel - 'ancestor' | 'self' | 'sibling' | 'child'
 * @param {number} depth
 * @param {Set<string>} strategyTerms
 * @param {object[]|null} preloadChildren - pre-fetched children to show expanded
 * @param {boolean} canExpand - whether this node has children (show toggle)
 * @param {Set<string>|null} excludeUIs - UIs to skip when expanding (already visible in tree)
 */
function makeTreeNode(entry, rel, depth, strategyTerms, preloadChildren, canExpand, excludeUIs) {
  // Default: expandable unless explicitly false
  const expandable = canExpand !== false;

  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node-wrapper';

  const node = document.createElement('div');
  node.className = 'tree-node';
  if (rel === 'self') node.classList.add('tree-node-self');
  else if (rel === 'ancestor') node.classList.add('tree-node-ancestor');
  else if (rel === 'child' || rel === 'sibling') node.classList.add('tree-node-' + rel);

  const inStrategy = strategyTerms.has(entry.label.toLowerCase());
  if (inStrategy) {
    node.classList.add('tree-node-in-strategy');
  }

  // Indent via padding
  node.style.paddingLeft = (depth * 1 + 0.3) + 'rem';

  const isAdded = addedTerms.some(a => a.name === entry.label);

  // Add/remove button (not for terms already in strategy or category labels)
  if (!inStrategy && !entry.isCategory) {
    const addBtn = document.createElement('button');
    addBtn.className = isAdded ? 'btn-tree-add btn-tree-added' : 'btn-tree-add';
    addBtn.textContent = isAdded ? '−' : '+';
    addBtn.title = isAdded ? 'Remove from strategy' : 'Add to strategy';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = addedTerms.findIndex(a => a.name === entry.label);
      if (idx >= 0) {
        addedTerms.splice(idx, 1);
        addBtn.className = 'btn-tree-add';
        addBtn.textContent = '+';
        addBtn.title = 'Add to strategy';
      } else {
        addedTerms.push({ name: entry.label, relatedTo: detailPanelTerm || '' });
        addBtn.className = 'btn-tree-add btn-tree-added';
        addBtn.textContent = '−';
        addBtn.title = 'Remove from strategy';
      }
      renderPreview();
      renderSuggestions(currentSuggestions);
      if (onDecisionChange) onDecisionChange();
    });
    node.appendChild(addBtn);
  }

  // Expand/collapse toggle (only if expandable)
  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  if (expandable) {
    toggle.textContent = '\u25B6'; // ▶ collapsed
  } else {
    toggle.textContent = '\u00B7'; // middle dot for leaf
    toggle.classList.add('tree-toggle-leaf');
  }
  node.appendChild(toggle);

  const label = document.createElement('span');
  label.className = 'tree-node-label';
  label.textContent = entry.label;
  if (!entry.isCategory) {
    addInfoHover(label, entry.label);
  }
  node.appendChild(label);

  const treeNumSpan = document.createElement('span');
  treeNumSpan.className = 'tree-node-num';
  treeNumSpan.textContent = entry.treeNum;
  node.appendChild(treeNumSpan);

  // Refocus button (not on self or category entries)
  if (rel !== 'self' && !entry.isCategory) {
    const refocusBtn = document.createElement('button');
    refocusBtn.className = 'btn-tree-refocus';
    refocusBtn.title = 'Focus tree on this term';
    refocusBtn.innerHTML = '\u21BB'; // ↻
    refocusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDetailPanel(entry.label, { pin: true, showTree: true });
    });
    node.appendChild(refocusBtn);
  }

  wrapper.appendChild(node);

  if (!expandable) return wrapper;

  // Children container (hidden until expanded)
  const childContainer = document.createElement('div');
  childContainer.className = 'tree-children';
  childContainer.style.display = 'none';

  let expanded = !!preloadChildren;
  let loaded = !!preloadChildren;

  // Pre-populate if children provided
  if (preloadChildren && preloadChildren.length > 0) {
    childContainer.style.display = 'block';
    toggle.textContent = '\u25BC'; // ▼
    toggle.classList.add('tree-toggle-expanded');
    // Prefetch which children have their own children
    const childUIs = preloadChildren.map(c => c.ui);
    checkHasChildren(childUIs).then(hasChildrenSet => {
      for (const c of preloadChildren) {
        childContainer.appendChild(makeTreeNode(c, 'child', depth + 1, strategyTerms, null, hasChildrenSet.has(c.ui)));
      }
    });
  }

  // Click label or toggle to expand/collapse
  const handleToggle = async () => {
    if (expanded) {
      childContainer.style.display = 'none';
      toggle.textContent = '\u25B6'; // ▶
      toggle.classList.remove('tree-toggle-expanded');
      expanded = false;
      return;
    }

    expanded = true;
    toggle.textContent = '\u25BC'; // ▼
    toggle.classList.add('tree-toggle-expanded');
    childContainer.style.display = 'block';

    if (loaded) return;

    // Show loading
    childContainer.innerHTML = '<div class="tree-node tree-node-more" style="padding-left:' + ((depth + 1) * 1 + 0.3) + 'rem">Loading\u2026</div>';

    let filteredChildren;

    if (entry.isCategory) {
      // Category nodes (e.g. "E") — fetch top-level descriptors under this letter
      const catLetter = entry.treeNum; // e.g. "E"
      const catChildren = await fetchCategoryChildren(catLetter);
      loaded = true;
      childContainer.innerHTML = '';
      filteredChildren = excludeUIs
        ? catChildren.filter(c => !excludeUIs.has(c.ui))
        : catChildren;
    } else {
      let ui = knownUIs.get(entry.label.toLowerCase());
      if (!ui) {
        try {
          const resolved = await resolveTermUIs([entry.label]);
          ui = resolved.get(entry.label.toLowerCase());
          if (ui) knownUIs.set(entry.label.toLowerCase(), ui);
        } catch { /* ignore */ }
      }

      if (!ui) {
        childContainer.innerHTML = '<div class="tree-node tree-node-more" style="padding-left:' + ((depth + 1) * 1 + 0.3) + 'rem">Could not resolve term</div>';
        return;
      }

      const tree = await fetchTreeContext(ui);
      loaded = true;
      childContainer.innerHTML = '';

      filteredChildren = excludeUIs
        ? tree.children.filter(c => !excludeUIs.has(c.ui))
        : (tree.children || []);
    }

    if (filteredChildren.length === 0) {
      toggle.textContent = '\u00B7';
      toggle.classList.add('tree-toggle-leaf');
      toggle.classList.remove('tree-toggle-expanded');
      childContainer.style.display = 'none';
      expanded = false;
      return;
    }

    // Prefetch which children have their own children
    const childUIs = filteredChildren.map(c => c.ui);
    const hasChildrenSet = await checkHasChildren(childUIs);

    for (const c of filteredChildren) {
      childContainer.appendChild(makeTreeNode(c, 'child', depth + 1, strategyTerms, null, hasChildrenSet.has(c.ui)));
    }
  };

  toggle.addEventListener('click', (e) => { e.stopPropagation(); handleToggle(); });
  label.addEventListener('click', handleToggle);

  wrapper.appendChild(childContainer);
  return wrapper;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Info Hover / Click ──────────────────────────────────────────────

/**
 * Add detail-panel hover/click handlers to an element representing a MeSH term.
 * @param {HTMLElement} element
 * @param {string} termName
 */
function addInfoHover(element, termName) {
  element.addEventListener('mouseenter', () => {
    if (detailPanelPinned) return;
    if (detailPanelDebounce) { clearTimeout(detailPanelDebounce); detailPanelDebounce = null; }
    showDetailPanel(termName, { pin: false, showTree: false });
  });
  element.addEventListener('mouseleave', () => {
    if (detailPanelPinned) return;
    detailPanelDebounce = setTimeout(() => {
      closeDetailPanel();
      detailPanelDebounce = null;
    }, 150);
  });
  element.addEventListener('click', (e) => {
    // Don't interfere with ctrl/cmd+click (open in browser)
    if (e.ctrlKey || e.metaKey) return;
    const termKey = termName.toLowerCase();
    if (detailPanelPinned && detailPanelTerm === termKey) {
      // Unpin
      closeDetailPanel();
    } else {
      // Pin to this term with tree
      if (detailPanelDebounce) { clearTimeout(detailPanelDebounce); detailPanelDebounce = null; }
      showDetailPanel(termName, { pin: true, showTree: true });
    }
  });
}

/**
 * Render unified detail panel content: info section at top, optionally tree below.
 */
function renderDetailContent(panel, termName, ui, details, opts = {}) {
  panel.className = 'detail-panel' + (detailPanelPinned ? ' detail-pinned' : '');
  panel.innerHTML = '';

  // Keep panel visible when hovering over it
  panel.onmouseenter = () => {
    if (detailPanelDebounce) { clearTimeout(detailPanelDebounce); detailPanelDebounce = null; }
  };
  panel.onmouseleave = () => {
    if (!detailPanelPinned && detailPanelTerm) {
      detailPanelDebounce = setTimeout(() => {
        closeDetailPanel();
        detailPanelDebounce = null;
      }, 150);
    }
  };

  // ── Info section ──
  const infoSection = document.createElement('div');
  infoSection.className = 'detail-info';

  // Header
  const header = document.createElement('div');
  header.className = 'info-panel-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'info-panel-name';
  nameSpan.textContent = termName;
  header.appendChild(nameSpan);

  const actions = document.createElement('div');
  actions.className = 'info-panel-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-info-close';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', closeDetailPanel);
  actions.appendChild(closeBtn);
  header.appendChild(actions);
  infoSection.appendChild(header);

  // UI + date introduced
  const uiDiv = document.createElement('div');
  uiDiv.className = 'info-panel-ui';
  const uiLink = document.createElement('a');
  uiLink.href = `https://meshb.nlm.nih.gov/record/ui?ui=${encodeURIComponent(ui)}`;
  uiLink.target = '_blank';
  uiLink.textContent = ui;
  uiLink.style.color = 'inherit';
  uiDiv.appendChild(uiLink);
  if (details.dateIntroduced) {
    uiDiv.appendChild(document.createTextNode(` \u00B7 introduced ${details.dateIntroduced}`));
  }
  infoSection.appendChild(uiDiv);

  // Divider
  const hr = document.createElement('hr');
  hr.className = 'info-panel-divider';
  infoSection.appendChild(hr);

  let hasContent = false;

  // Scope note
  if (details.scopeNote) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const scope = document.createElement('div');
    scope.className = 'info-panel-scope';
    scope.textContent = details.scopeNote;
    section.appendChild(scope);
    infoSection.appendChild(section);
  }

  // Annotation (indexing guidance)
  if (details.annotation) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Indexing Note';
    section.appendChild(label);
    const note = document.createElement('div');
    note.className = 'info-panel-annotation';
    note.textContent = details.annotation;
    section.appendChild(note);
    infoSection.appendChild(section);
  }

  // Public MeSH Note
  if (details.publicMeSHNote) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Public MeSH Note';
    section.appendChild(label);
    const note = document.createElement('div');
    note.className = 'info-panel-annotation';
    note.textContent = details.publicMeSHNote;
    section.appendChild(note);
    infoSection.appendChild(section);
  }

  // History Note
  if (details.historyNote) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'History Note';
    section.appendChild(label);
    const note = document.createElement('div');
    note.className = 'info-panel-annotation';
    note.textContent = details.historyNote;
    section.appendChild(note);
    infoSection.appendChild(section);
  }

  // Entry terms (synonyms)
  if (details.entryTerms.length > 0) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Synonyms';
    section.appendChild(label);
    const entry = document.createElement('div');
    entry.className = 'info-panel-entry';
    entry.textContent = details.entryTerms.join(', ');
    section.appendChild(entry);
    infoSection.appendChild(section);
  }

  // Previous indexing
  if (details.previousIndexing.length > 0) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Previous Indexing';
    section.appendChild(label);
    const prev = document.createElement('div');
    prev.className = 'info-panel-entry';
    prev.textContent = details.previousIndexing.join('; ');
    section.appendChild(prev);
    infoSection.appendChild(section);
  }

  // Pharmacological actions
  if (details.pharmacologicalActions.length > 0) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Pharmacological Actions';
    section.appendChild(label);
    const pharma = document.createElement('div');
    pharma.className = 'info-panel-entry';
    pharma.textContent = details.pharmacologicalActions.join(', ');
    section.appendChild(pharma);
    infoSection.appendChild(section);
  }

  // Qualifiers
  if (details.qualifiers.length > 0) {
    hasContent = true;
    const section = document.createElement('div');
    section.className = 'info-panel-section';
    const label = document.createElement('div');
    label.className = 'info-panel-section-label';
    label.textContent = 'Qualifiers';
    section.appendChild(label);
    const badgesDiv = document.createElement('div');
    const tooltip = document.createElement('div');
    tooltip.className = 'info-qualifier-tooltip';
    tooltip.textContent = '\u00A0';
    for (const q of details.qualifiers) {
      const badge = document.createElement('span');
      badge.className = 'info-qualifier';
      badge.textContent = q.abbr;
      badge.addEventListener('mouseenter', () => {
        tooltip.textContent = `${q.abbr} = ${q.label}`;
        tooltip.style.display = 'block';
      });
      badge.addEventListener('mouseleave', () => {
        tooltip.textContent = '\u00A0';
      });
      badgesDiv.appendChild(badge);
    }
    section.appendChild(tooltip);
    section.appendChild(badgesDiv);
    infoSection.appendChild(section);
  }

  if (!hasContent) {
    const msg = document.createElement('div');
    msg.style.color = 'var(--text-muted)';
    msg.style.padding = '0.5rem 0';
    msg.textContent = 'No additional details available.';
    infoSection.appendChild(msg);
  }

  panel.appendChild(infoSection);

  // ── Tree section (only when pinned with showTree) ──
  if (opts.showTree) {
    const treeDivider = document.createElement('hr');
    treeDivider.className = 'info-panel-divider';
    panel.appendChild(treeDivider);

    const treeSection = document.createElement('div');
    treeSection.className = 'detail-tree';
    treeSection.innerHTML = '<div class="tree-loading"><div class="spinner spinner-small"></div> Loading tree...</div>';
    panel.appendChild(treeSection);

    // Fetch tree in background
    (async () => {
      const termKey = termName.toLowerCase();
      const tree = await fetchTreeContext(ui);
      if (detailPanelTerm !== termKey) return;
      currentTreeData = { termName, tree };
      renderTreeContent(treeSection, termName, tree);
    })();
  }
}
