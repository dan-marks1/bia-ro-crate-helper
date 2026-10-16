const folderInput = document.querySelector('#folderInput');
const referenceInput = document.querySelector('#referenceInput');
const editor = document.querySelector('#jsonEditor');
const issueList = document.querySelector('#issueList');
const issueCount = document.querySelector('#issueCount');
const loadStatus = document.querySelector('#loadStatus');
const editorSubhead = document.querySelector('#editorSubhead');
const editState = document.querySelector('#editState');
const downloadButton = document.querySelector('#downloadButton');
const editorEmpty = document.querySelector('#editorEmpty');
const cursorPosition = document.querySelector('#cursorPosition');
const jsonStatus = document.querySelector('#jsonStatus');
const lineNumbers = document.querySelector('#lineNumbers');
const issueHighlights = document.querySelector('#issueHighlights');
const undoButton = document.querySelector('#undoButton');
const refreshButton = document.querySelector('#refreshButton');
const validatorStatus = document.querySelector('#validatorStatus');
const severityFilter = document.querySelector('#severityFilter');
const referenceStatus = document.querySelector('#referenceStatus');
const editDialog = document.querySelector('#editDialog');
const entityDraft = document.querySelector('#entityDraft');

const VALIDATOR_VERSION = '0.3.1';
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const crateRoot = '/home/pyodide/bia-helper-crate';

let crate = null;
let fileListText = '';
let fileListPath = 'file_list.tsv';
let currentName = '';
let currentIssues = [];
let selectedIssueId = null;
let referenceCrate = null;
let history = [];
let pyodidePromise = null;
let validationIsCurrent = false;
let dialogEntityId = null;
let dialogEditsWholeCrate = false;
let debounceTimer = null;

const demoCrate = {
  '@context': {
    '@vocab': 'https://schema.org/',
    bia: 'https://www.ebi.ac.uk/bioimage-archive/',
    Dataset: 'https://schema.org/Dataset'
  },
  '@graph': [
    {
      '@id': './',
      '@type': ['Dataset', 'bia:Study'],
      name: 'Example multiplexed spatial omics dataset',
      description: 'Example crate used to demonstrate guided metadata review.',
      datePublished: '2026-08-19',
      hasPart: [{ '@id': '#Metadata-study' }, { '@id': '#Images-codex' }]
    },
    { '@id': '#Metadata-study', '@type': ['Dataset', 'bia:Dataset'], name: 'Study metadata' },
    { '@id': '#Images-codex', '@type': ['Dataset', 'bia:Dataset'], name: 'CODEX images', description: 'Multiplexed CODEX images from the study.' }
  ]
};

const demoFileList = 'path\tname\nmetadata/summary.txt\tStudy summary\n';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function setStatus(message, kind = '') {
  validatorStatus.textContent = message;
  validatorStatus.className = `validator-status ${kind}`.trim();
}

function graphOf(data = crate) {
  return Array.isArray(data?.['@graph']) ? data['@graph'] : [];
}

function declaredFileListPath(data) {
  const fileList = (Array.isArray(data?.['@graph']) ? data['@graph'] : []).find(entity => {
    const types = Array.isArray(entity?.['@type']) ? entity['@type'] : [entity?.['@type']];
    return types.some(type => String(type || '').split(/[:/#]/).pop() === 'FileList');
  });
  const id = String(fileList?.['@id'] || 'file_list.tsv');
  const relative = /^[a-z]+:\/\//i.test(id) ? (id.split('/').slice(-1)[0] || 'file_list.tsv') : id;
  const safePath = decodeURIComponent(relative).split('/').filter(part => part && part !== '.' && part !== '..').join('/');
  return safePath || 'file_list.tsv';
}

function entityTypeList(entity) {
  const type = entity?.['@type'];
  return (Array.isArray(type) ? type : type ? [type] : []).map(String).sort();
}

function nameOf(entity) {
  const value = entity?.name;
  return Array.isArray(value) ? value.join(', ') : String(value ?? entity?.['@id'] ?? 'Unnamed entity');
}

function loadCrate(data, name, text = '', isDemo = false) {
  crate = data;
  fileListText = text;
  fileListPath = declaredFileListPath(data);
  currentName = name;
  history = [];
  undoButton.disabled = true;
  selectedIssueId = null;
  currentIssues = [];
  validationIsCurrent = false;
  editor.value = JSON.stringify(crate, null, 2);
  editor.disabled = false;
  editorEmpty.hidden = true;
  downloadButton.disabled = false;
  editorSubhead.textContent = isDemo ? 'Demo metadata · not a reference example' : (text ? 'file_list.tsv loaded' : 'file_list.tsv not found');
  loadStatus.textContent = isDemo ? 'Demo crate loaded locally · run the official validator to see its findings.' : `${name} selected locally${text ? ' · file_list.tsv found' : ' · file_list.tsv not found'}`;
  jsonStatus.textContent = 'JSON parsed';
  renderLineNumbers();
  renderIssues();
  updateDirty(false);
  setStatus('Crate ready. Choose Run validator to start the official BIA checks.');
}

function updateDirty(dirty) {
  editState.classList.toggle('dirty', dirty);
  editState.textContent = dirty ? '● Unsaved edit' : '● Up to date';
}

function updateLineForIssue(issue) {
  const text = editor.value;
  if (issue.line && issue.line > 0) return issue.line;
  let offset = 0;
  if (issue.entityId) {
    const idNeedle = `"@id": ${JSON.stringify(issue.entityId)}`;
    const idPosition = text.indexOf(idNeedle);
    if (idPosition >= 0) offset = idPosition;
    else {
      const looseId = text.indexOf(JSON.stringify(issue.entityId));
      if (looseId >= 0) offset = looseId;
    }
  }
  if (issue.property) {
    const propertyNeedle = `"${issue.property}"`;
    const propertyPosition = text.indexOf(propertyNeedle, offset);
    if (propertyPosition >= 0) offset = propertyPosition;
  }
  return text.slice(0, offset).split('\n').length;
}

function renderLineNumbers() {
  const count = Math.max(1, editor.value.split('\n').length);
  const lineIssues = new Map();
  currentIssues.forEach(issue => {
    const line = updateLineForIssue(issue);
    if (line > 0 && line <= count) lineIssues.set(line, issue.severity);
  });
  lineNumbers.textContent = Array.from({ length: count }, (_, index) => {
    const line = index + 1;
    const marker = lineIssues.has(line) ? '● ' : '  ';
    return `${marker}${line}`;
  }).join('\n');
  lineNumbers.scrollTop = editor.scrollTop;
  renderHighlights();
}

function renderHighlights() {
  issueHighlights.innerHTML = currentIssues.map(issue => {
    const line = updateLineForIssue(issue);
    if (!line) return '';
    const active = issue.id === selectedIssueId ? ' active' : '';
    return `<div class="issue-highlight ${esc(issue.severity)}${active}" data-line="${line}" style="top:${(line - 1) * 19.25}px"></div>`;
  }).join('');
  issueHighlights.style.transform = `translateY(${-editor.scrollTop}px)`;
}

function severityName(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('critical')) return 'critical';
  if (text.includes('error') || text === '40') return 'error';
  if (text.includes('warn') || text === '30') return 'warning';
  return 'info';
}

function guessProperty(message) {
  const patterns = [
    /(?:property|field|term)\s+["'`]([^"'`]+)["'`]/i,
    /(?:missing|requires|required)\s+["'`]([^"'`]+)["'`]/i
  ];
  for (const pattern of patterns) {
    const match = String(message || '').match(pattern);
    if (match) return match[1];
  }
  return '';
}

function guessEntityId(location, message) {
  const combined = `${location || ''} ${message || ''}`;
  const candidates = graphOf().map(entity => entity?.['@id']).filter(Boolean).sort((a, b) => b.length - a.length);
  return candidates.find(id => combined.includes(id)) || '';
}

function normalizeReport(report) {
  const issues = [];
  const grouped = report?.issues && typeof report.issues === 'object' ? report.issues : {};
  for (const [level, entries] of Object.entries(grouped)) {
    for (const raw of Array.isArray(entries) ? entries : []) {
      const message = String(raw.message || raw.description || 'Validator finding');
      const location = String(raw.location_description || raw.location || '');
      const severity = severityName(raw.severity || level);
      const issue = {
        id: `validator-${issues.length}`,
        severity,
        rule: 'BIA RO-Crate validator',
        message,
        location,
        entityId: guessEntityId(location, message),
        property: guessProperty(`${location} ${message}`),
        line: Number(raw.line || 0)
      };
      issues.push(issue);
    }
  }
  return issues;
}

function visibleIssues() {
  const filter = severityFilter.value;
  return currentIssues.filter(issue => filter === 'all' || issue.severity === filter || (filter === 'error' && issue.severity === 'critical'));
}

function renderIssues() {
  const issues = visibleIssues();
  issueCount.textContent = currentIssues.length;
  if (!currentIssues.length) {
    issueList.innerHTML = `<div class="empty-state"><span class="empty-icon">${validationIsCurrent ? '✓' : '○'}</span><strong>${validationIsCurrent ? 'No findings reported' : 'Your findings will appear here'}</strong><span>${validationIsCurrent ? 'The official validator reported no issues.' : 'Run validation to see official findings.'}</span></div>`;
    renderLineNumbers();
    return;
  }
  if (!issues.length) {
    issueList.innerHTML = '<div class="empty-state"><span class="empty-icon">⌕</span><strong>No findings in this filter</strong><span>Choose another severity to view the rest.</span></div>';
    renderLineNumbers();
    return;
  }
  issueList.innerHTML = issues.map(issue => `
    <button class="issue-card ${issue.id === selectedIssueId ? 'active' : ''}" data-issue="${esc(issue.id)}" type="button">
      <span class="severity ${esc(issue.severity)}">${esc(issue.severity)}</span>
      <span class="issue-main"><span class="issue-title">${esc(issue.message)}</span><span class="issue-meta"><span>official validator</span><span>·</span><span>${esc(issue.rule)}</span></span>${issue.entityId ? `<span class="issue-anchor">${esc(issue.entityId)}</span>` : (issue.location ? `<span class="issue-anchor">${esc(issue.location)}</span>` : '')}</span>
      <span class="issue-chevron">›</span>
    </button>`).join('');
  issueList.querySelectorAll('[data-issue]').forEach(button => button.addEventListener('click', () => selectIssue(button.dataset.issue)));
  renderLineNumbers();
}

function selectIssue(id) {
  selectedIssueId = id;
  const issue = currentIssues.find(item => item.id === id);
  renderIssues();
  if (!issue) return;
  const line = updateLineForIssue(issue);
  const rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.25;
  const offset = Math.max(0, (line - 4) * rowHeight);
  editor.scrollTop = offset;
  renderHighlights();
  const lineStart = editor.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  const lineEnd = editor.value.indexOf('\n', lineStart);
  editor.focus();
  editor.setSelectionRange(lineStart, lineEnd < 0 ? editor.value.length : lineEnd);
  cursorPosition.textContent = `Line ${line}${issue.property ? ` · possible property: ${issue.property}` : ''}`;
  openEditDialog(issue);
}

function matchingReference(entity) {
  if (!referenceCrate || !entity) return null;
  const wanted = entityTypeList(entity);
  if (!wanted.length) return null;
  return (referenceCrate['@graph'] || []).find(candidate => {
    const candidateTypes = entityTypeList(candidate);
    return candidateTypes.length && wanted.some(type => candidateTypes.includes(type));
  }) || null;
}

function openEditDialog(issue) {
  const target = graphOf().find(entity => entity?.['@id'] === issue.entityId);
  dialogEntityId = target?.['@id'] || null;
  dialogEditsWholeCrate = !target;
  document.querySelector('#dialogTitle').textContent = issue.property ? `Review “${issue.property}” finding` : 'Review validator finding';
  document.querySelector('#dialogMessage').textContent = issue.message;
  document.querySelector('#dialogLocation').textContent = issue.location || (issue.entityId ? `Entity: ${issue.entityId}` : 'Location not identified automatically; review the metadata below.');
  entityDraft.value = JSON.stringify(target || crate, null, 2);

  const suggestion = document.querySelector('#referenceSuggestion');
  const reference = matchingReference(target);
  if (reference) {
    const missingKeys = Object.keys(reference).filter(key => key !== '@id' && !Object.prototype.hasOwnProperty.call(target, key));
    suggestion.hidden = false;
    suggestion.innerHTML = `<strong>Similar entity in your passing reference</strong><span>${esc(nameOf(reference))}</span>${missingKeys.length ? `<p>Missing fields available to copy: ${missingKeys.map(esc).join(', ')}</p><button class="button button-outline button-small" id="copyReferenceFields" type="button">Copy missing fields into draft</button>` : '<p>The matching entity has no additional fields to copy.</p>'}`;
    const copyButton = suggestion.querySelector('#copyReferenceFields');
    copyButton?.addEventListener('click', () => {
      try {
        const draft = JSON.parse(entityDraft.value);
        for (const key of missingKeys) draft[key] = reference[key];
        entityDraft.value = JSON.stringify(draft, null, 2);
      } catch { /* The draft remains editable and the save action reports parse errors. */ }
    });
  } else {
    suggestion.hidden = true;
    suggestion.innerHTML = '';
  }
  editDialog.showModal();
}

function applyEntityDraft() {
  let draft;
  try {
    draft = JSON.parse(entityDraft.value);
  } catch (error) {
    window.alert(`The edit is not valid JSON: ${error.message}`);
    return false;
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    window.alert('Enter a JSON object to save this edit.');
    return false;
  }
  history.push(editor.value);
  undoButton.disabled = false;
  if (dialogEditsWholeCrate) {
    crate = draft;
  } else {
    const graph = graphOf();
    const index = graph.findIndex(entity => entity?.['@id'] === dialogEntityId);
    if (index < 0) {
      history.pop();
      window.alert('This entity is no longer present. Run validation again before editing.');
      return false;
    }
    graph[index] = draft;
  }
  editor.value = JSON.stringify(crate, null, 2);
  renderLineNumbers();
  updateDirty(true);
  validationIsCurrent = false;
  jsonStatus.textContent = 'Edited · run validation again';
  setStatus('Metadata changed. Run the validator again to refresh these findings.', 'loading');
  updateLocalParseStatus();
  cursorPosition.textContent = `Saved edit${dialogEntityId ? ` to ${dialogEntityId}` : ''}`;
  editDialog.close('save');
  return true;
}

function updateLocalParseStatus() {
  try {
    crate = JSON.parse(editor.value);
    jsonStatus.textContent = validationIsCurrent ? 'JSON parsed · validation current' : 'JSON parsed · validation may be out of date';
  } catch {
    jsonStatus.textContent = 'Invalid JSON';
  }
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      if (typeof window.loadPyodide !== 'function') throw new Error('The browser Python runtime did not load. Check your network and reload this page.');
      setStatus('Loading the browser Python runtime and BIA validator. The first run can take a little while.', 'loading');
      const pyodide = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
      await pyodide.runPythonAsync(`import micropip\nawait micropip.install("bia-ro-crate-validator==${VALIDATOR_VERSION}")`);
      return pyodide;
    })().catch(error => {
      pyodidePromise = null;
      throw error;
    });
  }
  return pyodidePromise;
}

function safeRelativePath(file) {
  let path = file.webkitRelativePath || file.name;
  const topFolder = file.webkitRelativePath?.split('/')[0];
  if (topFolder && path.startsWith(`${topFolder}/`)) path = path.slice(topFolder.length + 1);
  return path.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
}

async function writeCrateFiles(pyodide) {
  pyodide.FS.mkdirTree(crateRoot);
  try { pyodide.FS.unlink(`${crateRoot}/ro-crate-metadata.json`); } catch { /* No earlier run to clear. */ }
  try { pyodide.FS.unlink(`${crateRoot}/${fileListPath}`); } catch { /* No earlier run to clear. */ }
  const data = new TextEncoder().encode(editor.value);
  pyodide.FS.writeFile(`${crateRoot}/ro-crate-metadata.json`, data);
  if (fileListText) {
    const listDirectory = fileListPath.split('/').slice(0, -1).join('/');
    if (listDirectory) pyodide.FS.mkdirTree(`${crateRoot}/${listDirectory}`);
    pyodide.FS.writeFile(`${crateRoot}/${fileListPath}`, new TextEncoder().encode(fileListText));
  }
}

async function runOfficialValidation() {
  if (!crate) {
    setStatus('Open an RO-Crate folder before running validation.', 'error');
    return;
  }
  try {
    crate = JSON.parse(editor.value);
  } catch (error) {
    setStatus(`Fix the JSON syntax before validation: ${error.message}`, 'error');
    jsonStatus.textContent = 'Invalid JSON';
    return;
  }
  refreshButton.disabled = true;
  refreshButton.classList.add('spinning');
  setStatus('Preparing the local crate for the official BIA validator…', 'loading');
  try {
    const pyodide = await getPyodide();
    setStatus('Running the official BIA RO-Crate validator in this browser…', 'loading');
    await writeCrateFiles(pyodide);
    const reportText = await pyodide.runPythonAsync(`
import json
from pathlib import Path
from bia_ro_crate.validator import bia_roc_validation
report = bia_roc_validation(Path(${JSON.stringify(crateRoot)}), "report")
json.dumps(report, default=str)
`);
    const report = JSON.parse(reportText);
    currentIssues = normalizeReport(report);
    validationIsCurrent = true;
    selectedIssueId = null;
    renderIssues();
    jsonStatus.textContent = 'JSON parsed · official validation complete';
    setStatus(currentIssues.length ? `Official validation complete · ${currentIssues.length} finding${currentIssues.length === 1 ? '' : 's'}.` : 'Official validation complete · no findings reported.', 'success');
  } catch (error) {
    validationIsCurrent = false;
    jsonStatus.textContent = 'Validator could not run';
    setStatus(`Could not run the official validator: ${error.message || error}. Check your connection and try again.`, 'error');
    console.error(error);
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('spinning');
  }
}

function readMetadataFile(files) {
  return [...files].find(file => file.name === 'ro-crate-metadata.json');
}

async function openFolder(files) {
  const allFiles = [...files];
  const metadata = readMetadataFile(allFiles);
  if (!metadata) {
    loadStatus.textContent = 'Could not find ro-crate-metadata.json in that folder.';
    return;
  }
  try {
    const raw = await metadata.text();
    const data = JSON.parse(raw);
    const fileList = allFiles.find(file => file.name.toLowerCase() === 'file_list.tsv');
    loadCrate(data, metadata.webkitRelativePath?.split('/')[0] || metadata.name, fileList ? await fileList.text() : '');
  } catch (error) {
    crate = null;
    editor.value = await metadata.text();
    editor.disabled = false;
    editorEmpty.hidden = true;
    downloadButton.disabled = false;
    currentIssues = [];
    renderIssues();
    editorSubhead.textContent = 'JSON syntax needs attention';
    loadStatus.textContent = 'Metadata file opened, but JSON parsing failed.';
    jsonStatus.textContent = 'Invalid JSON';
    setStatus(`Correct the JSON syntax before validation: ${error.message}`, 'error');
  }
}

async function openReference(files) {
  const metadata = readMetadataFile(files);
  if (!metadata) {
    referenceStatus.textContent = 'Reference folder did not contain ro-crate-metadata.json';
    return;
  }
  try {
    const data = JSON.parse(await metadata.text());
    if (!Array.isArray(data?.['@graph'])) throw new Error('Metadata has no @graph array.');
    referenceCrate = data;
    referenceStatus.textContent = `${metadata.webkitRelativePath?.split('/')[0] || 'Passing crate'} · ${data['@graph'].length} entities loaded locally`;
    if (selectedIssueId) {
      const issue = currentIssues.find(item => item.id === selectedIssueId);
      if (issue) openEditDialog(issue);
    }
  } catch (error) {
    referenceCrate = null;
    referenceStatus.textContent = `Could not load reference: ${error.message}`;
  }
}

function loadDemo() {
  referenceCrate = null;
  referenceStatus.textContent = 'No reference loaded';
  loadCrate(JSON.parse(JSON.stringify(demoCrate)), 'Example study', demoFileList, true);
  fileListPath = 'file_list.tsv';
}

function undoLastEdit() {
  if (!history.length) return;
  editor.value = history.pop();
  undoButton.disabled = history.length === 0;
  try { crate = JSON.parse(editor.value); } catch { crate = null; }
  renderLineNumbers();
  updateDirty(true);
  validationIsCurrent = false;
  updateLocalParseStatus();
  setStatus('Last edit undone. Run the validator again to refresh the findings.', 'loading');
}

folderInput.addEventListener('change', event => { if (event.target.files?.length) openFolder(event.target.files); });
referenceInput.addEventListener('change', event => { if (event.target.files?.length) openReference(event.target.files); });
document.querySelector('#demoButton').addEventListener('click', loadDemo);
document.querySelector('#editorDemoButton').addEventListener('click', loadDemo);
refreshButton.addEventListener('click', runOfficialValidation);
severityFilter.addEventListener('change', renderIssues);
editor.addEventListener('input', () => {
  updateDirty(true);
  renderLineNumbers();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    updateLocalParseStatus();
    validationIsCurrent = false;
    setStatus('Metadata changed. Run the validator again to refresh its findings.', 'loading');
  }, 250);
});
editor.addEventListener('scroll', () => {
  lineNumbers.scrollTop = editor.scrollTop;
  renderHighlights();
});
document.querySelector('#editDialog form').addEventListener('submit', event => {
  if (event.submitter?.id === 'saveEntityButton') {
    event.preventDefault();
    applyEntityDraft();
  }
});
downloadButton.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(editor.value);
    const blob = new Blob([`${JSON.stringify(parsed, null, 2)}\n`], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ro-crate-metadata.json';
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(`The JSON cannot be downloaded until it parses correctly: ${error.message}`);
  }
});
undoButton.addEventListener('click', undoLastEdit);
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && history.length && !editDialog.open) {
    event.preventDefault();
    undoLastEdit();
  }
});
