const folderInput = document.querySelector('#folderInput');
const demoButton = document.querySelector('#demoButton');
const editorDemoButton = document.querySelector('#editorDemoButton');
const editor = document.querySelector('#jsonEditor');
const issueList = document.querySelector('#issueList');
const issueCount = document.querySelector('#issueCount');
const loadStatus = document.querySelector('#loadStatus');
const editorSubhead = document.querySelector('#editorSubhead');
const editState = document.querySelector('#editState');
const downloadButton = document.querySelector('#downloadButton');
const editorEmpty = document.querySelector('#editorEmpty');
const demoNotice = document.querySelector('#demoNotice');
const cursorPosition = document.querySelector('#cursorPosition');
const jsonStatus = document.querySelector('#jsonStatus');
const lineHighlight = document.querySelector('#lineHighlight');
const lineNumbers = document.querySelector('#lineNumbers');
const undoButton = document.querySelector('#undoButton');

let crate = null;
let currentName = '';
let currentIssues = [];
let selectedIssueId = null;
let isDemo = false;
let history = [];
let debounceTimer = null;

const demoCrate = {
  "@context": {
    "@vocab": "https://schema.org/",
    "bia": "https://www.ebi.ac.uk/bioimage-archive/",
    "Dataset": "https://schema.org/Dataset"
  },
  "@graph": [
    {
      "@id": "./",
      "@type": ["Dataset", "bia:Study"],
      "name": "Example multiplexed spatial omics dataset",
      "description": "Example crate used to demonstrate guided metadata review.",
      "datePublished": "2026-08-19",
      "hasPart": [{"@id": "#Metadata-study"}, {"@id": "#Images-codex"}]
    },
    {
      "@id": "#Metadata-study",
      "@type": ["Dataset", "bia:Dataset"],
      "name": "Study metadata"
    },
    {
      "@id": "#Images-codex",
      "@type": ["Dataset", "bia:Dataset"],
      "name": "CODEX images",
      "description": "Multiplexed CODEX images from the study."
    }
  ]
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function entityTypes(entity) {
  const types = entity?.['@type'];
  return Array.isArray(types) ? types : (types ? [types] : []);
}

function rootEntity(data) {
  const graph = Array.isArray(data?.['@graph']) ? data['@graph'] : [];
  return graph.find(node => node && node['@id'] === './') || graph.find(node => entityTypes(node).some(type => /Study$/.test(type)));
}

function makeIssue({id, severity, rule, message, entityId = '', property = '', suggestion = '', fix = ''}) {
  return {id, severity, rule, message, entityId, property, suggestion, fix};
}

function runLocalChecks(data) {
  const graph = Array.isArray(data?.['@graph']) ? data['@graph'] : [];
  if (!graph.length) {
    return [makeIssue({id:'missing-graph',severity:'error',rule:'structure',message:'The JSON does not contain a non-empty @graph array.',suggestion:'A BIA RO-Crate metadata document needs an @graph array containing its entities.'})];
  }
  const issues = [];
  const root = rootEntity(data);
  if (!root) issues.push(makeIssue({id:'root-entity',severity:'error',rule:'structure',message:'Could not find a root entity with @id "./" or a Study type.',suggestion:'Check that the crate includes its root study entity.'}));
  else if (!root.keywords || (Array.isArray(root.keywords) && root.keywords.length === 0)) {
    issues.push(makeIssue({id:`${root['@id']}-keywords`,severity:'info',rule:'recommended-property',message:'The study is missing the recommended property "keywords".',entityId:root['@id'],property:'keywords',suggestion:'Add relevant terms that help colleagues discover this study.',fix:'keywords'}));
  }

  for (const node of graph) {
    if (!node || typeof node !== 'object') continue;
    const types = entityTypes(node);
    if (node !== root && types.some(type => type === 'Dataset' || type.endsWith(':Dataset')) && !node.description) {
      issues.push(makeIssue({id:`${node['@id']}-description`,severity:'info',rule:'recommended-property',message:'This dataset is missing the recommended property "description".',entityId:node['@id'],property:'description',suggestion:'Briefly describe what data or files this dataset contains.',fix:'description'}));
    }
  }

  const ids = new Set();
  for (const node of graph) {
    if (!node || typeof node !== 'object' || !node['@id']) continue;
    if (ids.has(node['@id'])) issues.push(makeIssue({id:`duplicate-${node['@id']}`,severity:'error',rule:'duplicate-id',message:`The entity ID "${node['@id']}" appears more than once.`,entityId:node['@id'],suggestion:'Give each graph entity a unique @id.'}));
    ids.add(node['@id']);
  }
  const dangling = new Set();
  function findLocalRefs(value) {
    if (Array.isArray(value)) return value.forEach(findLocalRefs);
    if (!value || typeof value !== 'object') return;
    if (typeof value['@id'] === 'string' && value['@id'].startsWith('#') && !ids.has(value['@id'])) dangling.add(value['@id']);
    Object.values(value).forEach(findLocalRefs);
  }
  graph.forEach(findLocalRefs);
  for (const id of dangling) issues.push(makeIssue({id:`dangling-${id}`,severity:'error',rule:'dangling-reference',message:`The local reference "${id}" does not match an entity in @graph.`,entityId:id,suggestion:'Check the referenced @id for a typo or add the missing entity.'}));
  return issues;
}

function setCrate(data, name, {demo = false, hasFileList = false} = {}) {
  crate = data;
  currentName = name;
  isDemo = demo;
  history = [];
  undoButton.disabled = true;
  selectedIssueId = null;
  editor.value = JSON.stringify(crate, null, 2);
  renderLineNumbers();
  editor.disabled = false;
  editorEmpty.hidden = true;
  downloadButton.disabled = false;
  editorSubhead.textContent = demo ? 'Illustrative demo metadata' : (hasFileList ? 'file_list.tsv loaded' : 'file_list.tsv not found');
  loadStatus.textContent = demo ? 'Demo crate loaded · try selecting a finding.' : `${name} loaded in this browser${hasFileList ? ' · file_list.tsv found' : ' · file_list.tsv not found'}`;
  jsonStatus.textContent = 'JSON parsed';
  demoNotice.hidden = !demo;
  updateChecks();
  updateDirty(false);
}

function updateChecks() {
  try {
    crate = JSON.parse(editor.value);
    currentIssues = runLocalChecks(crate);
    jsonStatus.textContent = 'JSON parsed · local checks complete';
  } catch (error) {
    currentIssues = [makeIssue({id:'invalid-json',severity:'error',rule:'json-syntax',message:'The JSON cannot be parsed.',suggestion:'Fix the syntax error before applying metadata suggestions.'})];
    jsonStatus.textContent = 'Invalid JSON';
  }
  renderIssues();
}

function renderLineNumbers() {
  const count = Math.max(1, editor.value.split('\n').length);
  lineNumbers.textContent = Array.from({length:count}, (_, index) => index + 1).join('\n');
  lineNumbers.scrollTop = editor.scrollTop;
}

function renderIssues() {
  issueCount.textContent = currentIssues.length;
  if (!currentIssues.length) {
    issueList.innerHTML = '<div class="empty-state"><span class="empty-icon">✓</span><strong>No issues found by local checks</strong><span>Run the BIA validator for an authoritative result.</span></div>';
    return;
  }
  issueList.innerHTML = currentIssues.map(issue => `
    <button class="issue-card ${issue.id === selectedIssueId ? 'active' : ''}" data-issue="${esc(issue.id)}" type="button">
      <span class="severity ${esc(issue.severity)}">${esc(issue.severity)}</span>
      <span class="issue-main"><span class="issue-title">${esc(issue.message)}</span><span class="issue-meta"><span>local-check</span><span>·</span><span>${esc(issue.rule)}</span></span>${issue.entityId ? `<span class="issue-anchor">${esc(issue.entityId)}</span>` : ''}</span>
      <span class="issue-chevron">›</span>
    </button>`).join('');
  issueList.querySelectorAll('[data-issue]').forEach(button => button.addEventListener('click', () => selectIssue(button.dataset.issue)));
}

function locateIssue(issue) {
  const text = editor.value;
  let offset = 0;
  if (issue.entityId) {
    const needle = `"@id": ${JSON.stringify(issue.entityId)}`;
    const at = text.indexOf(needle);
    if (at >= 0) offset = at;
    else {
      const fallback = text.indexOf(JSON.stringify(issue.entityId));
      if (fallback >= 0) offset = fallback;
    }
  }
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', offset);
  editor.focus();
  editor.setSelectionRange(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.25;
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  cursorPosition.textContent = `Line ${line}${issue.property ? ` · suggested property: ${issue.property}` : ''}`;
}

function selectIssue(id) {
  selectedIssueId = id;
  renderIssues();
  const issue = currentIssues.find(item => item.id === id);
  if (!issue) return;
  locateIssue(issue);
  if (issue.fix) showSuggestion(issue);
}

function showSuggestion(issue) {
  const accepted = window.confirm(`${issue.suggestion}\n\nWould you like to add "${issue.property}" now? You can undo the change.`);
  if (!accepted) return;
  const value = window.prompt(issue.property === 'keywords' ? 'Enter keywords separated by commas:' : 'Enter a short description:');
  if (value === null || !value.trim()) return;
  history.push(editor.value);
  undoButton.disabled = false;
  const graph = crate?.['@graph'] || [];
  const target = graph.find(node => node && node['@id'] === issue.entityId);
  if (!target || Object.prototype.hasOwnProperty.call(target, issue.property)) {
    history.pop();
    window.alert('This finding no longer matches the current JSON. Run the local checks again.');
    return;
  }
  target[issue.property] = issue.property === 'keywords' ? value.split(',').map(term => term.trim()).filter(Boolean) : value.trim();
  editor.value = JSON.stringify(crate, null, 2);
  renderLineNumbers();
  updateChecks();
  selectedIssueId = null;
  updateDirty(true);
  cursorPosition.textContent = `Added ${issue.property} to ${issue.entityId}`;
}

function updateDirty(dirty) {
  editState.classList.toggle('dirty', dirty);
  editState.textContent = dirty ? '● Unsaved edit' : '● Up to date';
}

async function openFolder(files) {
  const allFiles = [...files];
  const metadata = allFiles.find(file => file.name === 'ro-crate-metadata.json');
  const fileList = allFiles.find(file => file.name === 'file_list.tsv');
  if (!metadata) {
    loadStatus.textContent = 'Could not find ro-crate-metadata.json in that folder.';
    return;
  }
  try {
    const raw = await metadata.text();
    const data = JSON.parse(raw);
    setCrate(data, metadata.webkitRelativePath?.split('/')[0] || metadata.name, {hasFileList:!!fileList});
  } catch (error) {
    crate = null;
    currentName = metadata.name;
    editor.value = await metadata.text();
    renderLineNumbers();
    editor.disabled = false;
    editorEmpty.hidden = true;
    downloadButton.disabled = false;
    currentIssues = [makeIssue({id:'invalid-json',severity:'error',rule:'json-syntax',message:'ro-crate-metadata.json is not valid JSON.',suggestion:'Correct the syntax before using metadata suggestions.'})];
    issueList.innerHTML = '';
    renderIssues();
    editorSubhead.textContent = 'JSON syntax needs attention';
    loadStatus.textContent = 'Metadata file opened, but JSON parsing failed.';
    jsonStatus.textContent = 'Invalid JSON';
    demoNotice.hidden = true;
  }
}

folderInput.addEventListener('change', event => {
  if (event.target.files?.length) openFolder(event.target.files);
});
function loadDemo() {
  setCrate(JSON.parse(JSON.stringify(demoCrate)), 'Example study', {demo:true,hasFileList:true});
}
demoButton.addEventListener('click', loadDemo);
editorDemoButton.addEventListener('click', loadDemo);
document.querySelector('#refreshButton').addEventListener('click', updateChecks);
editor.addEventListener('input', () => {
  updateDirty(true);
  renderLineNumbers();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(updateChecks, 350);
});
editor.addEventListener('scroll', () => { lineNumbers.scrollTop = editor.scrollTop; });
downloadButton.addEventListener('click', () => {
  const blob = new Blob([editor.value.endsWith('\n') ? editor.value : `${editor.value}\n`], {type:'application/ld+json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ro-crate-metadata.json';
  link.click();
  URL.revokeObjectURL(url);
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && history.length) {
    event.preventDefault();
    undoLastFix();
  }
});
function undoLastFix() {
  if (!history.length) return;
  editor.value = history.pop();
  undoButton.disabled = history.length === 0;
  renderLineNumbers();
  updateChecks();
  updateDirty(true);
  cursorPosition.textContent = 'Last suggestion undone';
}
undoButton.addEventListener('click', undoLastFix);
