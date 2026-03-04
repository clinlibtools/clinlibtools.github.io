/**
 * Main application controller.
 * Wires together parser, API client, reviewer, and output modules.
 */

import { parseStrategy } from './parser.js';
import { checkTerms, findRelatedNewTerms } from './api.js';
import { renderReview, getDecisions, getAddedTerms, getRemovedLines, getLineEdits, getInsertedLines } from './reviewer.js';
import { generateOutput } from './output.js';
import { validateSyntax, validateTermExistence } from './validator.js';

// State
let parsedResult = null;
let changesMap = null;

// DOM elements
const screens = {
  input: document.getElementById('screen-input'),
  loading: document.getElementById('screen-loading'),
  review: document.getElementById('screen-review'),
};

const strategyInput = document.getElementById('strategy-input');
const yearFilter = document.getElementById('year-filter');
const btnCheck = document.getElementById('btn-check');
const btnBackInput = document.getElementById('btn-back-input');
const btnCopy = document.getElementById('btn-copy');
const loadingMessage = document.getElementById('loading-message');
const reviewSummary = document.getElementById('review-summary');
const errorBanner = document.getElementById('error-banner');
const copyFeedback = document.getElementById('copy-feedback');
const btnExample = document.getElementById('btn-example');

const EXAMPLE_STRATEGY = `1.    exp Cyclophilin D/
2.    (cyclophilin* or CypD).tw.
3.    exp Peripheral Arterial Disease/
4.    (peripheral adj3 (arter* or vascul*)).tw,kw.
5.    exp Phaeophyta/
6.    Arteriosclerosis Obliterans/
7.    Intermittent Claudication/
8.    1 or 2 or 3 or 4 or 5 or 6 or 7`;

// Load example strategy (auto-checks)
btnExample.addEventListener('click', () => {
  strategyInput.value = EXAMPLE_STRATEGY;
  btnCheck.disabled = false;
  runCheck();
});

// Screen management
function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('active', key === name);
  }
  hideError();
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('visible');
}

function hideError() {
  errorBanner.classList.remove('visible');
}

// Enable check button when textarea has content
strategyInput.addEventListener('input', () => {
  btnCheck.disabled = !strategyInput.value.trim();
});

// Auto-check on paste
strategyInput.addEventListener('paste', () => {
  // Use setTimeout so the pasted value is in the textarea
  setTimeout(() => {
    if (strategyInput.value.trim()) {
      btnCheck.disabled = false;
      runCheck();
    }
  }, 0);
});

// Manual check button
btnCheck.addEventListener('click', () => runCheck());

async function runCheck() {
  const text = strategyInput.value.trim();
  if (!text) return;

  // Parse
  parsedResult = parseStrategy(text);

  if (parsedResult.meshTerms.length === 0) {
    showError('No MeSH heading lines found. Make sure your strategy uses Ovid MEDLINE syntax (lines with terms ending in /).');
    return;
  }

  // Show loading
  showScreen('loading');
  loadingMessage.textContent = `Checking ${parsedResult.meshTerms.length} term${parsedResult.meshTerms.length === 1 ? '' : 's'} against NLM databases...`;

  try {
    const year = yearFilter.value || null;
    const [changes, suggestions] = await Promise.all([
      checkTerms(parsedResult.meshTerms, year),
      findRelatedNewTerms(parsedResult.meshTerms, year),
    ]);
    changesMap = changes;

    // Run syntax validation (local, no API)
    const syntaxIssues = validateSyntax(parsedResult.lines);

    // Check term existence (post-API) — returns not-found terms for problem cards
    const resolvedUIs = suggestions._resolvedUIs || new Map();
    const notFoundTerms = validateTermExistence(parsedResult.lines, resolvedUIs, changes);

    // Show review
    showScreen('review');

    const changeCount = changesMap.size;
    const suggestionCount = suggestions.size;
    const termCount = parsedResult.meshTerms.length;
    let summary = changeCount === 0
      ? `Checked ${termCount} terms — all current.`
      : `Found changes for ${changeCount} of ${termCount} MeSH terms.`;
    if (suggestionCount > 0) {
      summary += ` ${suggestionCount} term${suggestionCount === 1 ? ' has' : 's have'} related new headings to review.`;
    }
    if (notFoundTerms.length > 0) {
      summary += ` ${notFoundTerms.length} term${notFoundTerms.length === 1 ? '' : 's'} not found in vocabulary.`;
    }
    if (syntaxIssues.length > 0) {
      const errCount = syntaxIssues.filter(v => v.severity === 'error').length;
      const warnCount = syntaxIssues.filter(v => v.severity === 'warning').length;
      const parts = [];
      if (errCount > 0) parts.push(`${errCount} error${errCount === 1 ? '' : 's'}`);
      if (warnCount > 0) parts.push(`${warnCount} warning${warnCount === 1 ? '' : 's'}`);
      summary += ` Syntax: ${parts.join(', ')}.`;
    }
    reviewSummary.textContent = summary;

    renderReview(parsedResult.lines, changesMap, () => {}, suggestions, {
      yearFilter: year,
      validations: syntaxIssues,
      notFoundTerms,
      recheckFn: async (newTerms, yearFilter) => {
        const [changes, suggestions] = await Promise.all([
          checkTerms(newTerms, yearFilter),
          findRelatedNewTerms(newTerms, yearFilter),
        ]);
        return { changes, suggestions };
      },
    });
  } catch (err) {
    showScreen('input');
    showError(`Failed to check terms: ${err.message}. Please try again.`);
  }
}

// Navigation
btnBackInput.addEventListener('click', () => showScreen('input'));

// Copy updated strategy to clipboard
btnCopy.addEventListener('click', async () => {
  const decisions = getDecisions();
  const added = getAddedTerms();
  const removed = getRemovedLines();
  const edits = getLineEdits();
  const inserted = getInsertedLines();
  const output = generateOutput(parsedResult.lines, decisions, changesMap, added, removed, edits, inserted);

  try {
    await navigator.clipboard.writeText(output);
  } catch {
    // Fallback: create a temporary textarea
    const tmp = document.createElement('textarea');
    tmp.value = output;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
  }
  copyFeedback.classList.add('visible');
  setTimeout(() => copyFeedback.classList.remove('visible'), 2000);
});
