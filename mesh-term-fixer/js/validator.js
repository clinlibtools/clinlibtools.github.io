/**
 * Ovid MEDLINE strategy syntax validator.
 * Returns arrays of { lineNum, severity: 'error'|'warning', message }.
 */

// Valid Ovid MEDLINE subheading qualifiers (two-letter codes)
const VALID_SUBHEADINGS = new Set([
  'aa', 'ab', 'ad', 'ae', 'ag', 'ah', 'ai', 'an', 'ao',
  'bi', 'bl', 'bs',
  'cf', 'ch', 'ci', 'cl', 'cn', 'co', 'cr', 'cs', 'ct',
  'de', 'df', 'dg', 'di', 'dk', 'dm', 'du', 'dt',
  'ec', 'ed', 'eh', 'em', 'en', 'ep', 'eq', 'es', 'et',
  'ge', 'gd',
  'hi', 'hp',
  'im', 'in', 'ip', 'is',
  'lj',
  'ma', 'me', 'mi', 'mo', 'mt',
  'nu',
  'og', 'or',
  'pa', 'pc', 'pd', 'pe', 'ph', 'pk', 'po', 'pp', 'ps', 'px', 'py',
  'ra', 're', 'rh', 'ri',
  'sc', 'sd', 'se', 'si', 'sl', 'sn', 'st', 'su', 'sd', 'sy',
  'td', 'th', 'to', 'tr', 'tu', 'tx',
  'ul', 'ur', 'us', 'ut',
  've', 'vi',
]);

/**
 * Run local syntax checks on parsed lines (no API needed).
 * @param {import('./parser.js').ParsedLine[]} parsedLines
 * @returns {{ lineNum: number, severity: string, message: string }[]}
 */
export function validateSyntax(parsedLines) {
  const issues = [];
  const lineNums = new Set(parsedLines.map(l => l.lineNum));

  for (const line of parsedLines) {
    // 1. Unbalanced parentheses (ignore inside quotes)
    const stripped = stripQuoted(line.raw);
    const openCount = (stripped.match(/\(/g) || []).length;
    const closeCount = (stripped.match(/\)/g) || []).length;
    if (openCount !== closeCount) {
      issues.push({
        lineNum: line.lineNum,
        severity: 'error',
        message: `Unbalanced parentheses: ${openCount} opening, ${closeCount} closing`,
      });
    }

    // 2. Unclosed quotes
    const quoteCount = (line.raw.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      issues.push({
        lineNum: line.lineNum,
        severity: 'error',
        message: 'Unclosed double quote',
      });
    }

    // 3. Invalid subheading codes (mesh lines only)
    if (line.type === 'mesh' && line.subheading) {
      const codes = line.subheading.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
      for (const code of codes) {
        if (code && !VALID_SUBHEADINGS.has(code)) {
          issues.push({
            lineNum: line.lineNum,
            severity: 'warning',
            message: `Invalid subheading qualifier: "${code}"`,
          });
        }
      }
    }

    // 4. Invalid line references in combination lines
    if (line.type === 'combination') {
      const refs = extractLineRefs(line.raw);
      for (const ref of refs) {
        if (!lineNums.has(ref)) {
          issues.push({
            lineNum: line.lineNum,
            severity: 'error',
            message: `References non-existent line ${ref}`,
          });
        }
      }
    }

    // 5. adj without number (textword lines)
    if (line.type === 'textword' && /\badj\b(?!\d)/i.test(line.raw)) {
      issues.push({
        lineNum: line.lineNum,
        severity: 'warning',
        message: '"adj" without a number defaults to adj1 — was this intentional?',
      });
    }
  }

  return issues;
}

/**
 * Check that MeSH terms actually exist in the current vocabulary.
 * Terms already in changeMap are handled by change cards, so skip those.
 * Returns objects with term info for rendering as problem cards.
 * @param {import('./parser.js').ParsedLine[]} parsedLines
 * @param {Map<string, string>} resolvedUIs - term lowercase → MeSH UI
 * @param {Map<string, any[]>} changeMap - term lowercase → changes
 * @returns {{ term: string, termKey: string, lineNums: number[] }[]}
 */
export function validateTermExistence(parsedLines, resolvedUIs, changeMap) {
  const notFound = new Map(); // termKey → { term, lineNums }

  for (const line of parsedLines) {
    if (line.type !== 'mesh' || !line.term) continue;

    const termLower = line.term.toLowerCase();

    // Skip if already handled by change cards
    if (changeMap && changeMap.has(termLower)) continue;

    // Skip if resolved to a valid UI
    if (resolvedUIs && resolvedUIs.has(termLower)) continue;

    if (!notFound.has(termLower)) {
      notFound.set(termLower, { term: line.term, termKey: termLower, lineNums: [] });
    }
    notFound.get(termLower).lineNums.push(line.lineNum);
  }

  return [...notFound.values()];
}

/**
 * Strip quoted strings from text so we can count parentheses outside quotes.
 */
function stripQuoted(text) {
  return text.replace(/"[^"]*"/g, '');
}

/**
 * Extract referenced line numbers from a combination line.
 * Handles: "1 or 2 or 3", "or/1-5", "and/1,3,5", "or/1-3,5,7-9"
 */
function extractLineRefs(raw) {
  const refs = new Set();

  // Pattern: "or/1-5" or "and/1,3,5-7"
  const slashMatch = raw.match(/(?:or|and|not)\/([\d,\-\s]+)/i);
  if (slashMatch) {
    parseRefList(slashMatch[1], refs);
    return refs;
  }

  // Pattern: "1 or 2 or 3 and 4"
  const nums = raw.match(/\d+/g);
  if (nums) {
    for (const n of nums) {
      refs.add(parseInt(n, 10));
    }
  }

  return refs;
}

/**
 * Parse a comma/hyphen-separated list of line references: "1-5,7,9-11"
 */
function parseRefList(text, refs) {
  const parts = text.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        refs.add(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) refs.add(num);
    }
  }
}
