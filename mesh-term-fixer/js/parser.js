/**
 * Ovid MEDLINE search strategy parser.
 * Extracts MeSH heading terms from strategy lines.
 */

/**
 * @typedef {Object} ParsedLine
 * @property {number} lineNum - Original line number from the strategy
 * @property {string} raw - Original line content (without leading line number)
 * @property {string} type - "mesh" | "textword" | "combination" | "other"
 * @property {boolean} [exploded] - Whether the term uses exp (explode)
 * @property {boolean} [focused] - Whether the term uses * (focus)
 * @property {string} [term] - Extracted MeSH term name
 * @property {string} [subheading] - Subheading qualifier(s) after /
 */

// Field tags: .tw. .mp. .tw,kw. etc. — one or more comma-separated tags between dots
const TEXT_FIELD_TAGS = /\.\s*(tw|mp|ab|ti|kw|pt|sh|fs|nm|hw|ot|rn|rx|px|xs|ox|fx)(,(tw|mp|ab|ti|kw|pt|sh|fs|nm|hw|ot|rn|rx|px|xs|ox|fx))*\s*\./i;

// Combination: "1 or 2 or 3", "5 and 6", "or/1-21", "and/5,6,7"
const COMBINATION_PATTERN = /^\s*((\d+\s+(or|and|not)\s+)+\d+|(or|and|not)\/[\d,\- ]+)\s*$/i;

const LIMIT_PATTERN = /^limit\s+/i;

/**
 * Parse an Ovid MEDLINE search strategy string.
 * Handles both newline-separated and single-line pasted strategies.
 * @param {string} text - The full strategy text
 * @returns {{ lines: ParsedLine[], meshTerms: string[] }}
 */
export function parseStrategy(text) {
  // First, try splitting on newlines
  let rawLines = text.split(/\r?\n/).filter(l => l.trim() !== '');

  // If we got very few lines but the text is long, it was probably pasted as a
  // single line. Try splitting on line number boundaries: look for patterns like
  // "14." or "14 " preceded by content that isn't just the start of the string.
  if (rawLines.length <= 2 && text.length > 200) {
    rawLines = splitOnLineNumbers(text);
  }

  const lines = [];
  const meshTermSet = new Set();

  for (const rawLine of rawLines) {
    // Match line number prefix: optional whitespace, digits, optional period, whitespace, then content
    const lineMatch = rawLine.match(/^\s*(\d+)\.?\s+(.+)$/);
    if (!lineMatch) {
      continue;
    }

    const lineNum = parseInt(lineMatch[1], 10);
    const content = lineMatch[2].trim();

    const parsed = classifyLine(lineNum, content);
    lines.push(parsed);

    if (parsed.type === 'mesh' && parsed.term) {
      meshTermSet.add(parsed.term);
    }
  }

  return { lines, meshTerms: [...meshTermSet] };
}

/**
 * Split a single-line pasted strategy into individual lines
 * by detecting line number boundaries.
 */
function splitOnLineNumbers(text) {
  const parts = [];
  const regex = /(\d{1,3})\.\s+/g;
  let match;

  const positions = [];
  while ((match = regex.exec(text)) !== null) {
    positions.push(match.index);
  }

  if (positions.length === 0) {
    return [text];
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : text.length;
    const segment = text.substring(start, end).trim();
    if (segment) parts.push(segment);
  }

  return parts;
}

/**
 * Classify a single line of an Ovid strategy.
 */
function classifyLine(lineNum, content) {
  // Check for text word / field-tagged searches first
  if (TEXT_FIELD_TAGS.test(content)) {
    return { lineNum, raw: content, type: 'textword' };
  }

  // Check for combination lines (e.g., "1 or 2 or 3", "5 and 6", "or/1-21")
  if (COMBINATION_PATTERN.test(content)) {
    return { lineNum, raw: content, type: 'combination' };
  }

  // Check for limit lines
  if (LIMIT_PATTERN.test(content)) {
    return { lineNum, raw: content, type: 'other' };
  }

  // Check for MeSH heading lines — these contain a / that's part of MeSH syntax
  // Patterns: exp Term/, Term/, exp Term/subheading, *Term/, exp *Term/su1, su2
  const meshMatch = content.match(/^(exp\s+)?(\*)?(.+?)\/(.*)$/);
  if (meshMatch) {
    const exploded = !!meshMatch[1];
    const focused = !!meshMatch[2];
    const term = meshMatch[3].trim().replace(/^"|"$/g, '');
    const subheadingRaw = meshMatch[4].trim();
    const subheading = subheadingRaw || null;

    return { lineNum, raw: content, type: 'mesh', exploded, focused, term, subheading };
  }

  // Anything else
  return { lineNum, raw: content, type: 'other' };
}
