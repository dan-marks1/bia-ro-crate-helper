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
const graphViewport = document.querySelector('#graphViewport');
const graphSummary = document.querySelector('#graphSummary');

const VALIDATOR_VERSION = '0.3.1';
const ROC_VALIDATOR_VERSION = '0.8.1';
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const RO_CRATE_CONTEXT_URL = 'https://w3id.org/ro/crate/1.1/context';
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
let graphCamera = { scale: 1, x: 0, y: 0 };

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

function graphKind(entity) {
  const typeText = entityTypeList(entity).join(' ').toLowerCase();
  if (entity?.['@id'] === './' || typeText.includes('study')) return 'study';
  if (typeText.includes('dataset')) return 'dataset';
  if (typeText.includes('biosample')) return 'biosample';
  if (typeText.includes('protocol')) return 'protocol';
  if (typeText.includes('channel') || typeText.includes('signal')) return 'channel';
  if (typeText.includes('file')) return 'file';
  return 'other';
}

function entityReferences(value, found = new Set(), isRoot = true) {
  if (Array.isArray(value)) {
    value.forEach(item => entityReferences(item, found, false));
  } else if (value && typeof value === 'object') {
    if (!isRoot && typeof value['@id'] === 'string') found.add(value['@id']);
    Object.entries(value).forEach(([key, item]) => {
      if (key !== '@id') entityReferences(item, found, false);
    });
  }
  return found;
}

function renderGraph() {
  if (!graphViewport || !graphSummary) return;
  const entities = graphOf();
  if (!entities.length) {
    graphSummary.textContent = 'Load a crate to view its entities and links.';
    graphViewport.innerHTML = '<div class="graph-empty">The structure graph will appear here after you open a crate.</div>';
    document.querySelector('#exportGraphButton').disabled = true;
    return;
  }
  const byId = new Map(entities.filter(entity => typeof entity?.['@id'] === 'string').map(entity => [entity['@id'], entity]));
  const root = entities.find(entity => graphKind(entity) === 'study') || entities[0];
  const links = [];
  const inbound = new Set();
  const dangling = [];
  for (const entity of entities) {
    const sourceId = entity?.['@id'];
    if (!sourceId) continue;
    for (const targetId of entityReferences(entity)) {
      if (targetId === sourceId) continue;
      if (byId.has(targetId)) {
        links.push({ sourceId, targetId });
        inbound.add(targetId);
      } else if (!/^(https?:|urn:)/i.test(targetId)) dangling.push({ sourceId, targetId });
    }
  }
  const primary = entities.filter(entity => entity !== root && ['biosample', 'protocol'].includes(graphKind(entity)));
  const channels = entities.filter(entity => entity !== root && graphKind(entity) === 'channel');
  const datasets = entities.filter(entity => entity !== root && graphKind(entity) === 'dataset');
  const tail = entities.filter(entity => entity !== root && graphKind(entity) !== 'dataset' && !primary.includes(entity) && !channels.includes(entity));
  // Keep the overview hierarchical, but wrap large categories instead of
  // squeezing dozens of labels into a single row (which made real crates unreadable).
  const chunk = (items, size = 10) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
  const tiers = [[root], datasets, primary, ...chunk(channels), ...chunk(tail)].filter(row => row.length);
  const rowGap = 82;
  const tierY = tiers.map((_, index) => 76 + index * rowGap);
  const tierStep = tiers.map(row => row.length <= 1 ? 0 : row.length > 8 ? 170 : row.length > 5 ? 180 : 196);
  const widths = tiers.map((row, index) => row.length <= 1 ? 0 : (row.length - 1) * tierStep[index]);
  const width = Math.max(1100, ...widths) + 160;
  const height = Math.max(460, tierY[tiers.length - 1] + 78);
  const positions = new Map();
  tiers.forEach((row, tierIndex) => {
    const step = tierStep[tierIndex] || 1;
    const rowWidth = Math.max(0, row.length - 1) * step;
    const startX = (width - rowWidth) / 2;
    row.forEach((entity, itemIndex) => positions.set(entity['@id'], { x: startX + itemIndex * step, y: tierY[tierIndex], entity, tier: tierIndex }));
  });
  const edgeMarkup = links.map(({ sourceId, targetId }) => {
    const from = positions.get(sourceId);
    const to = positions.get(targetId);
    if (!from || !to) return '';
    const direction = to.y >= from.y ? 1 : -1;
    const y1 = from.y + direction * 15;
    const y2 = to.y - direction * 15;
    return `<path class="graph-edge" d="M ${from.x} ${y1} C ${from.x} ${(y1 + y2) / 2}, ${to.x} ${(y1 + y2) / 2}, ${to.x} ${y2}" marker-end="url(#arrow)"/>`;
  }).join('');
  const danglingMarkup = dangling.map(({ sourceId, targetId }, index) => {
    const from = positions.get(sourceId);
    if (!from) return '';
    const x = from.x + 31 + (index % 3) * 7;
    const y = from.y + 24 + (index % 3) * 4;
    return `<path class="graph-dangling-edge" d="M ${from.x + 8} ${from.y + 8} Q ${x - 8} ${y - 6}, ${x} ${y}"><title>Unresolved link to ${esc(targetId)}</title></path><circle class="dangling-point" cx="${x}" cy="${y}" r="7"><title>Unresolved link to ${esc(targetId)}</title></circle>`;
  }).join('');
  const nodesMarkup = [...positions.entries()].map(([id, pos]) => {
    const kind = graphKind(pos.entity);
    const orphan = id !== root?.['@id'] && !inbound.has(id);
    const label = nameOf(pos.entity);
    const title = `${label} · ${id}`;
    const shortLabel = label.length > 28 ? `${label.slice(0, 26)}…` : label;
    const shape = kind === 'study'
      ? `<path class="node-shape" d="M 0 -19 L 5 -7 L 18 -6 L 8 2 L 11 16 L 0 9 L -11 16 L -8 2 L -18 -6 L -5 -7 Z"/>`
      : kind === 'dataset'
        ? '<rect class="node-shape" x="-22" y="-13" width="44" height="26" rx="5"/>'
        : kind === 'file' || kind === 'other'
          ? '<circle class="node-shape" r="10"/>'
          : '<circle class="node-shape" r="14"/>';
    return `<g class="graph-node ${kind}${orphan ? ' orphan-node' : ''}" data-entity="${esc(id)}" role="button" tabindex="0" aria-label="Open ${esc(title)}"><title>${esc(title)}</title><text class="node-label" x="0" y="-22" text-anchor="middle">${esc(shortLabel)}</text>${shape}<text class="node-id" x="0" y="30" text-anchor="middle">${esc(id.length > 22 ? `${id.slice(0, 20)}…` : id)}</text></g>`;
  }).join('');
  graphSummary.textContent = `${entities.length} entities · ${links.length} links${dangling.length ? ` · ${dangling.length} unresolved link${dangling.length === 1 ? '' : 's'}` : ''}`;
  graphViewport.innerHTML = `<svg id="crateGraph" class="crate-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="RO-Crate entity relationship graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#aab3b8"/></marker></defs><g id="graphTransform">${edgeMarkup}${danglingMarkup}${nodesMarkup}</g></svg>`;
  document.querySelector('#exportGraphButton').disabled = false;
  applyGraphCamera();
  graphViewport.querySelectorAll('[data-entity]').forEach(node => {
    const jump = () => jumpToEntity(node.dataset.entity);
    node.addEventListener('click', jump);
    node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
  });
}

function applyGraphCamera() {
  const group = graphViewport.querySelector('#graphTransform');
  if (group) group.setAttribute('transform', `translate(${graphCamera.x} ${graphCamera.y}) scale(${graphCamera.scale})`);
}

function zoomGraph(factor, anchorX, anchorY) {
  const svg = graphViewport.querySelector('svg');
  if (!svg) return;
  const { width, height } = svg.viewBox.baseVal;
  const ax = anchorX ?? width / 2;
  const ay = anchorY ?? height / 2;
  const scale = Math.max(0.25, Math.min(6, graphCamera.scale * factor));
  const worldX = (ax - graphCamera.x) / graphCamera.scale;
  const worldY = (ay - graphCamera.y) / graphCamera.scale;
  graphCamera = { scale, x: ax - worldX * scale, y: ay - worldY * scale };
  applyGraphCamera();
}

async function exportGraphPng() {
  const svg = graphViewport.querySelector('svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  const group = clone.querySelector('#graphTransform');
  group?.removeAttribute('transform');
  const { width, height } = svg.viewBox.baseVal;
  const pixelScale = Math.min(3, 10000 / Math.max(width, height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', Math.round(width * pixelScale));
  clone.setAttribute('height', Math.round(height * pixelScale));
  const svgStyles = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  svgStyles.textContent = '.graph-edge{fill:none;stroke:#c4cbd0;stroke-width:1.6}.graph-dangling-edge{fill:none;stroke:#d53e39;stroke-width:2;stroke-dasharray:5 3}.dangling-point{fill:#fff;stroke:#d53e39;stroke-width:2;stroke-dasharray:3 2}.graph-node .node-shape{stroke-width:2}.graph-node.study .node-shape{fill:#3f73b5}.graph-node.dataset .node-shape{fill:#117991}.graph-node.biosample .node-shape{fill:#25985a}.graph-node.protocol .node-shape{fill:#8140da}.graph-node.channel .node-shape{fill:#12988b}.graph-node.file .node-shape,.graph-node.other .node-shape{fill:#758084}.graph-node.orphan-node .node-shape{stroke:#e5a12b;stroke-dasharray:5 3}.node-label{fill:#2b3438;font:600 11px Arial,sans-serif}.node-id{fill:#69757b;font:8px monospace}';
  clone.insertBefore(svgStyles, clone.firstChild);
  const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The graph image could not be rendered for export.'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * pixelScale);
    canvas.height = Math.round(height * pixelScale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png'));
    const pngUrl = URL.createObjectURL(png);
    const link = document.createElement('a');
    link.href = pngUrl;
    link.download = `${(currentName || 'ro-crate').replace(/[^a-z0-9-_]+/gi, '-')}-structure.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    document.querySelector('#graphActionStatus').textContent = 'PNG exported';
  } catch (error) {
    document.querySelector('#graphActionStatus').textContent = error.message;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function jumpToEntity(id) {
  const bounds = findObjectBounds(editor.value, id);
  if (!bounds) return;
  const line = editor.value.slice(0, bounds.idAt).split('\n').length;
  const rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.25;
  editor.scrollTop = Math.max(0, (line - 4) * rowHeight);
  const start = editor.value.lastIndexOf('\n', bounds.idAt) + 1;
  const end = editor.value.indexOf('\n', bounds.idAt);
  editor.focus();
  editor.setSelectionRange(start, end < 0 ? editor.value.length : end);
  cursorPosition.textContent = `Entity ${id} · line ${line}`;
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
  graphCamera = { scale: 1, x: 0, y: 0 };
  editor.value = JSON.stringify(crate, null, 2);
  editor.disabled = false;
  editorEmpty.hidden = true;
  downloadButton.disabled = false;
  editorSubhead.textContent = isDemo ? 'Demo metadata · not a reference example' : (text ? 'file_list.tsv loaded' : 'file_list.tsv not found');
  loadStatus.textContent = isDemo ? 'Demo crate loaded locally · run the official validator to see its findings.' : `${name} selected locally${text ? ' · file_list.tsv found' : ' · file_list.tsv not found'}`;
  jsonStatus.textContent = 'JSON parsed';
  renderLineNumbers();
  renderGraph();
  renderIssues();
  updateDirty(false);
  setStatus('Crate ready. Run validation when you are ready.');
}

function updateDirty(dirty) {
  editState.classList.toggle('dirty', dirty);
  editState.textContent = dirty ? '● Unsaved edit' : '● Up to date';
}

function findObjectBounds(text, id) {
  const needle = `"@id": ${JSON.stringify(id)}`;
  const idAt = text.indexOf(needle);
  if (idAt < 0) return null;
  let start = text.lastIndexOf('{', idAt);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return { start, end: i + 1, idAt };
  }
  return { start, end: text.length, idAt };
}

function propertyOffset(text, property, start = 0, end = text.length) {
  if (!property) return -1;
  const needle = `"${String(property)}"`;
  let offset = start;
  while (offset < end) {
    const found = text.indexOf(needle, offset);
    if (found < 0 || found >= end) return -1;
    let cursor = found + needle.length;
    while (/\s/.test(text[cursor] || '') && cursor < end) cursor += 1;
    if (text[cursor] === ':') return found;
    offset = found + 1;
  }
  return -1;
}

function locateIssueOffset(issue) {
  const text = editor.value;
  if (issue.line > 0) return text.split('\n').slice(0, issue.line - 1).join('\n').length;
  const contextTerm = /(?:@context\s+term:\s*|JSON-LD context term\s+["'`])([^\s"'`]+)/i.exec(`${issue.location} ${issue.message}`)?.[1];
  if (contextTerm) {
    const contextStart = text.indexOf('"@context"');
    const graphStart = text.indexOf('"@graph"', Math.max(0, contextStart));
    const contextEnd = graphStart < 0 ? text.length : graphStart;
    const termAt = propertyOffset(text, contextTerm, Math.max(0, contextStart), contextEnd);
    if (termAt >= 0) return termAt;
    if (contextStart >= 0) return contextStart;
  }
  const entityBounds = issue.entityId ? findObjectBounds(text, issue.entityId) : null;
  if (entityBounds) {
    const propAt = propertyOffset(text, issue.property, entityBounds.start, entityBounds.end);
    return propAt >= 0 ? propAt : entityBounds.idAt;
  }
  const propAt = propertyOffset(text, issue.property);
  if (propAt >= 0) return propAt;
  return 0;
}

function updateLineForIssue(issue) {
  return editor.value.slice(0, locateIssueOffset(issue)).split('\n').length;
}

function renderLineNumbers() {
  const count = Math.max(1, editor.value.split('\n').length);
  const lineIssues = new Map();
  currentIssues.forEach(issue => {
    const line = updateLineForIssue(issue);
    if (line > 0 && line <= count) {
      if (!lineIssues.has(line)) lineIssues.set(line, []);
      lineIssues.get(line).push(issue);
    }
  });
  lineNumbers.innerHTML = Array.from({ length: count }, (_, index) => {
    const line = index + 1;
    const issues = lineIssues.get(line) || [];
    const marker = issues.length
      ? `<span class="line-issue-mark ${esc(issues[0].severity)}" tabindex="0" role="img" aria-label="${esc(issues.map(issue => issue.message).join('; '))}" title="${esc(issues.map(issue => `${issue.severity.toUpperCase()}: ${issue.message}`).join('\n'))}">!</span>`
      : '<span class="line-issue-mark empty"></span>';
    return `<div class="line-row">${marker}<span class="line-number">${line}</span></div>`;
  }).join('');
  lineNumbers.scrollTop = editor.scrollTop;
  renderHighlights();
}

function renderHighlights() {
  const ordered = [...currentIssues].sort((a, b) => Number(a.id === selectedIssueId) - Number(b.id === selectedIssueId));
  issueHighlights.innerHTML = ordered.map(issue => {
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

  const fix = document.querySelector('#fixSuggestion');
  fix.innerHTML = `<strong>Suggested next step</strong><p>${esc(suggestedFix(issue, target))}</p>`;

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

function suggestedFix(issue, entity) {
  const message = issue.message || '';
  const contextTerm = /Invalid JSON-LD context term ['"`]([^'"`]+)['"`]/i.exec(message)?.[1];
  if (contextTerm) {
    return `In the @context, add an explicit @id mapping for “${contextTerm}”. If this is the schema.org property, change its definition to { "@id": "schema:${contextTerm}", "@container": "@set" }. Check the intended vocabulary before saving; the validator message is a guide, not an automatic edit.`;
  }
  if (/missing|required/i.test(message) && issue.property) {
    const hasReference = Boolean(matchingReference(entity));
    return `Add “${issue.property}” to ${entity ? `the entity ${entity['@id']}` : 'the relevant entity'} and supply the correct value for this study. ${hasReference ? 'A similar entity in your passing reference may provide a suitable pattern; review the reference suggestion below.' : 'A passing crate from the same study can help you choose the correct value.'} This helper does not invent identifiers, dates, or scientific metadata.`;
  }
  if (/dataset-satisfaction|profile/i.test(message)) {
    return 'Review the dataset’s linked BioSample and protocol entities against the profile named in the finding. Add or correct the relationships only when they reflect the actual study; inspect the highlighted dataset entity and compare with a passing crate if available.';
  }
  if (/no image files|image files/i.test(message)) {
    return 'Check that file_list.tsv contains the dataset’s image files and that the dataset links to those files. If the crate intentionally contains no images, review whether the selected BIA profile is appropriate.';
  }
  if (/unknown property|not declared/i.test(message)) {
    return `Check the spelling and vocabulary mapping for “${issue.property || 'this property'}”. If the field is intentional, add or use the correct term mapping in @context; otherwise rename it to the intended RO-Crate/schema.org property.`;
  }
  if (issue.severity === 'info') return 'This is an informational validator note. Review the highlighted entity and use it as a metadata quality suggestion; it may not require a change.';
  return 'Review the highlighted JSON location and the validator message. Correct the metadata only when the proposed change matches the study; a passing crate from the same study can provide a useful example.';
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
  renderGraph();
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
    renderGraph();
  } catch {
    jsonStatus.textContent = 'Invalid JSON';
    graphSummary.textContent = 'Fix the JSON syntax to update the structure graph.';
  }
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      if (typeof window.loadPyodide !== 'function') throw new Error('The browser Python runtime did not load. Check your network and reload this page.');
      setStatus('Loading the browser Python runtime and BIA validator. The first run can take a little while.', 'loading');
      const pyodide = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
      await pyodide.loadPackage('micropip');
      // Load compiled/runtime packages from Pyodide's WebAssembly package index.
      await pyodide.loadPackage([
        'pandas', 'pydantic', 'pyparsing', 'requests', 'pyyaml',
        'platformdirs', 'click', 'cachetools', 'lxml'
      ]);
      await pyodide.runPythonAsync(`
import micropip

# Install the runtime dependency tree explicitly. roc-validator's wheel also
# declares typos, a spell-check utility with no WebAssembly wheel. Its Python
# validator code does not import typos, so skip only automatic resolution for
# roc-validator and install its actual runtime dependencies here.
await micropip.install("rdflib==7.6.0")
await micropip.install("PyLD==2.0.4")
await micropip.install("rich==13.9.4")
await micropip.install("typer==0.24.1")
await micropip.install("toml>=0.10.2,<1.0")
await micropip.install("colorlog>=6.9,<7.0")
await micropip.install("enum-tools>=0.12,<0.13")
await micropip.install("InquirerPy>=0.3.4,<0.4.0")
await micropip.install("pyshacl>=0.26")
await micropip.install("requests-cache>=1.2,<2.0")
await micropip.install("rich-click>=1.8,<2.0")
await micropip.install("roc-validator==${ROC_VALIDATOR_VERSION}", deps=False)
await micropip.install("bia-ro-crate-validator==${VALIDATOR_VERSION}", deps=False)
`);
      return pyodide;
    })().catch(error => {
      pyodidePromise = null;
      throw error;
    });
  }
  return pyodidePromise;
}

function formatValidationError(error) {
  const message = String(error?.message || error || '').trim();
  const pythonErrors = [...message.matchAll(/(?:ModuleNotFoundError|ImportError|ValueError|RuntimeError):[^\n]*/g)];
  if (pythonErrors.length) return pythonErrors[pythonErrors.length - 1][0];
  return message.split('\n').map(line => line.trim()).filter(Boolean).at(-1) || 'Unknown error';
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
  const validationMetadata = JSON.parse(editor.value);
  const contexts = Array.isArray(validationMetadata['@context'])
    ? validationMetadata['@context']
    : [validationMetadata['@context']];
  if (contexts.includes(RO_CRATE_CONTEXT_URL)) {
    setStatus('Loading the RO-Crate context for local validation…', 'loading');
    const response = await fetch(RO_CRATE_CONTEXT_URL);
    if (!response.ok) throw new Error(`Could not load the RO-Crate 1.1 context (HTTP ${response.status}).`);
    const contextDocument = await response.json();
    if (!contextDocument?.['@context']) throw new Error('The RO-Crate context response was not valid JSON-LD.');
    validationMetadata['@context'] = contexts.map(context =>
      context === RO_CRATE_CONTEXT_URL ? contextDocument['@context'] : context
    );
  }
  const data = new TextEncoder().encode(JSON.stringify(validationMetadata));
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
import ast
from pathlib import Path
from rocrate_validator import models, services
from bia_ro_crate.core.parser.ro_crate_parser import ROCrateParser
from bia_ro_crate.validator.validation import _report_issues

# The BIA validator's internal RO-Crate profile pass defaults to REQUIRED
# severity. Raise that setting to OPTIONAL for this review tool so recommended
# findings are included. Keep the original ValidationSettings class intact;
# the validator uses it again when it starts the profile checks.
_bia_helper_original_validate = services.validate
def _bia_helper_all_severities(settings, *args, **kwargs):
    settings.requirement_severity = models.Severity.OPTIONAL
    return _bia_helper_original_validate(settings, *args, **kwargs)

services.validate = _bia_helper_all_severities
_bia_helper_unhandled_error = None
try:
    parser = ROCrateParser(Path(${JSON.stringify(crateRoot)}))
    try:
        parser.parse()
        parser.result
    except ExceptionGroup:
        # Expected validation errors are collected on parser.issues and are
        # included in the report below.
        pass
    except Exception as error:
        _bia_helper_unhandled_error = error
    report = _report_issues(parser)
    if _bia_helper_unhandled_error is not None:
        error = _bia_helper_unhandled_error
        detail = error.args[0] if error.args and isinstance(error.args[0], str) else str(error).splitlines()[0]
        term = None
        if getattr(error, "code", None) == "invalid IRI mapping":
            try:
                details = error.details
                if isinstance(details, str):
                    details = ast.literal_eval(details)
                term = details.get("term") if isinstance(details, dict) else None
            except (ValueError, SyntaxError, AttributeError, TypeError):
                pass
        if term:
            message = f"Invalid JSON-LD context term '{term}': this term definition must include an @id mapping. For example, use @id 'schema:{term}' if that is the intended property."
            location = f"At JSON-LD @context term: {term}"
        else:
            message = f"The validator stopped before completing: {type(error).__name__}: {detail}"
            location = "Validation did not complete"
        report["issues"].setdefault("ERROR", []).append({
            "message": message,
            "severity": 40,
            "location_description": location,
        })
        report["highest_error_level"] = "ERROR"
        report["validation_completed"] = False
finally:
    services.validate = _bia_helper_original_validate
json.dumps(report, default=str)
`);
    const report = JSON.parse(reportText);
    if (!report?.issues || typeof report.issues !== 'object') {
      throw new Error('The validator returned an unexpected report; validation did not complete.');
    }
    currentIssues = normalizeReport(report);
    validationIsCurrent = true;
    selectedIssueId = null;
    renderIssues();
    if (report.validation_completed === false) {
      jsonStatus.textContent = 'Validation stopped early';
      setStatus(`Validation stopped early · ${currentIssues.length} issue${currentIssues.length === 1 ? '' : 's'} found before it stopped.`, 'error');
    } else {
      jsonStatus.textContent = 'JSON parsed · official validation complete';
      setStatus(currentIssues.length ? `Official validation complete · ${currentIssues.length} finding${currentIssues.length === 1 ? '' : 's'}.` : 'Official validation complete · no findings reported.', 'success');
    }
  } catch (error) {
    validationIsCurrent = false;
    jsonStatus.textContent = 'Validator could not run';
    setStatus(`Could not run the official validator: ${formatValidationError(error)} Check your connection and try again.`, 'error');
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
    setStatus('Crate loaded. Starting official validation automatically…', 'loading');
    await runOfficialValidation();
  } catch (error) {
    crate = null;
    editor.value = await metadata.text();
    editor.disabled = false;
    editorEmpty.hidden = true;
    downloadButton.disabled = false;
    currentIssues = [];
    renderGraph();
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
document.querySelector('#zoomInButton').addEventListener('click', () => zoomGraph(1.25));
document.querySelector('#zoomOutButton').addEventListener('click', () => zoomGraph(0.8));
document.querySelector('#resetGraphButton').addEventListener('click', () => {
  graphCamera = { scale: 1, x: 0, y: 0 };
  applyGraphCamera();
});
document.querySelector('#exportGraphButton').addEventListener('click', exportGraphPng);
let graphDrag = null;
graphViewport.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest?.('.graph-node')) return;
  const svg = event.target.closest?.('#crateGraph');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  graphDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cameraX: graphCamera.x, cameraY: graphCamera.y, ratioX: viewBox.width / rect.width, ratioY: viewBox.height / rect.height };
  svg.setPointerCapture(event.pointerId);
  graphViewport.classList.add('dragging');
});
graphViewport.addEventListener('pointermove', event => {
  if (!graphDrag || graphDrag.pointerId !== event.pointerId) return;
  graphCamera.x = graphDrag.cameraX + (event.clientX - graphDrag.x) * graphDrag.ratioX;
  graphCamera.y = graphDrag.cameraY + (event.clientY - graphDrag.y) * graphDrag.ratioY;
  applyGraphCamera();
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  graphViewport.addEventListener(eventName, event => {
    if (graphDrag?.pointerId === event.pointerId) graphDrag = null;
    graphViewport.classList.remove('dragging');
  });
}
graphViewport.addEventListener('wheel', event => {
  const svg = graphViewport.querySelector('svg');
  if (!svg) return;
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  const anchorX = (event.clientX - rect.left) * viewBox.width / rect.width;
  const anchorY = (event.clientY - rect.top) * viewBox.height / rect.height;
  zoomGraph(event.deltaY < 0 ? 1.12 : 0.89, anchorX, anchorY);
}, { passive: false });
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
