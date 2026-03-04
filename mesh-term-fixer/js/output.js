/**
 * Generate the updated search strategy text based on all user edits.
 */

/**
 * @param {import('./parser.js').ParsedLine[]} parsedLines
 * @param {Map<string, import('./reviewer.js').Decision>} decisions
 * @param {Map<string, import('./api.js').Change[]>} changes
 * @param {{ name: string, relatedTo: string }[]} [addedTerms]
 * @param {Set<number>} [removedLineNums]
 * @param {Map<number, string>} [lineEdits]
 * @param {{ lineNum: number, content: string }[]} [insertedLines]
 * @returns {string}
 */
export function generateOutput(parsedLines, decisions, changes, addedTerms, removedLineNums, lineEdits, insertedLines) {
  const removed = removedLineNums || new Set();
  const edits = lineEdits || new Map();
  const inserted = insertedLines || [];

  // Build a lookup: afterLineNum → [inserted lines in order]
  const insertionsAfter = new Map();
  for (const ins of inserted) {
    if (!insertionsAfter.has(ins.afterLineNum)) insertionsAfter.set(ins.afterLineNum, []);
    insertionsAfter.get(ins.afterLineNum).push(ins);
  }

  const contentLines = [];

  // Insertions before all original lines (afterLineNum === 0)
  for (const ins of (insertionsAfter.get(0) || [])) {
    if (ins.content.trim()) contentLines.push(ins.content);
  }

  for (const line of parsedLines) {
    if (removed.has(line.lineNum)) continue;

    // Check for user edits first
    if (edits.has(line.lineNum)) {
      contentLines.push(edits.get(line.lineNum));
    } else if (line.type === 'mesh' && line.term) {
      const termKey = line.term.toLowerCase();
      const decision = decisions.get(termKey);

      if (decision && decision.accepted) {
        const isDeleteOnly = changes.has(termKey) &&
          changes.get(termKey).every(c => c.type === 'deleted') &&
          !decision.selectedReplacement;

        if (isDeleteOnly) {
          // skip — but still emit insertions after this line below
        } else if (decision.selectedReplacement) {
          contentLines.push(line.raw.replace(line.term, decision.selectedReplacement));
        } else {
          contentLines.push(line.raw);
        }
      } else {
        contentLines.push(line.raw);
      }
    } else {
      contentLines.push(line.raw);
    }

    // Emit lines inserted after this original line
    for (const ins of (insertionsAfter.get(line.lineNum) || [])) {
      if (ins.content.trim()) contentLines.push(ins.content);
    }
  }

  // Append added new terms (from suggestions)
  if (addedTerms && addedTerms.length > 0) {
    for (const at of addedTerms) {
      contentLines.push(`${at.name}/`);
    }
  }

  // Number all lines sequentially
  return contentLines.map((content, i) => {
    const num = String(i + 1).padStart(6);
    return `${num} ${content}`;
  }).join('\n');
}
