// The server remains the authority for capability, preset and submission checks.
const REQUIRED = new Set(['pc-ept', 'gltf', '3d-tiles']);
const FILE_OPTIONS = new Set(['align', 'cameras', 'boundary', 'geo', 'gcp', 'image-groups', 'input', 'output', 'project-path']);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
export function taskOptionDomain(spec) {
  let domain = spec.domain;
  if (typeof domain === 'string') {
    try { domain = JSON.parse(domain); } catch {
      const text = domain.trim().toLowerCase();
      if (/^positive (?:integer|int|float|number)$/.test(text)) return { min: 0, minExclusive: true };
      if (/^non[- ]?negative (?:integer|int|float|number)$/.test(text)) return { min: 0 };
      const bound = text.match(/^(?:int|integer|float|number|x)\s*(>=|>|<=|<)\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/);
      if (bound && Number.isFinite(Number(bound[2]))) return bound[1].startsWith('>') ? { min: Number(bound[2]), minExclusive: bound[1] === '>' } : { max: Number(bound[2]), maxExclusive: bound[1] === '<' };
      const range = text.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(<=|<)\s*(?:x|int|integer|float|number)\s*(<=|<)\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/);
      if (range && Number(range[1]) <= Number(range[4])) return { min: Number(range[1]), max: Number(range[4]), minExclusive: range[2] === '<', maxExclusive: range[3] === '<' };
      return null;
    }
  }
  if (Array.isArray(domain)) return domain.length <= 1000 && domain.every(scalar) ? { values: domain } : null;
  if (domain && typeof domain === 'object') return { ...(Number.isFinite(domain.min) ? { min: domain.min } : {}), ...(Number.isFinite(domain.max) ? { max: domain.max } : {}) };
  return null;
}
export function taskOptionRestriction(spec) {
  if (REQUIRED.has(spec.name)) return 'Required for Viewer outputs; enabled automatically.';
  if (FILE_OPTIONS.has(spec.name) || (spec.type === 'string' && /\b(?:file|directory|folder|path)\b/i.test(`${spec.domain || ''} ${spec.help || ''}`))) return 'This input needs a registered file or boundary workflow; arbitrary paths are not supported here.';
  if (!['bool', 'int', 'float', 'string'].includes(spec.type)) return 'This node option type is not supported by this editor.';
  return null;
}
export function parseTaskOption(spec, raw) {
  if (taskOptionRestriction(spec)) throw new Error(taskOptionRestriction(spec));
  let value = raw;
  if (spec.type === 'bool') {
    if (raw === true || raw === 'true') value = true;
    else if (raw === false || raw === 'false') value = false;
    else throw new Error('Choose enabled or disabled.');
  } else if (spec.type === 'int' || spec.type === 'float') {
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) throw new Error('Enter a number.');
    value = Number(raw);
    if (!Number.isFinite(value) || (spec.type === 'int' && !Number.isSafeInteger(value))) throw new Error(spec.type === 'int' ? 'Enter a whole number.' : 'Enter a finite number.');
  } else if (typeof raw !== 'string' || raw.length > 4000) throw new Error('Enter text of at most 4,000 characters.');
  const domain = taskOptionDomain(spec);
  if (domain?.values && !domain.values.includes(value)) throw new Error('Choose one of the node’s supported values.');
  if (typeof value === 'number' && ((domain?.min !== undefined && value < domain.min) || (domain?.max !== undefined && value > domain.max))) throw new Error('Value is outside the node’s supported range.');
  if (typeof value === 'number' && ((domain?.minExclusive && value === domain.min) || (domain?.maxExclusive && value === domain.max))) throw new Error('Value is outside the node’s supported range.');
  return value;
}
export function createTaskOptionsModel({ provider = null, presetOptions = {} } = {}) {
  let specs = [], inherited = {}, overrides = new Map(), identity;
  function update({ provider: nextProvider = null, presetOptions: nextPreset = {} } = {}) {
    const nextIdentity = JSON.stringify([nextProvider?.id, nextProvider?.capabilityFingerprint, nextProvider?.capabilities?.options, nextPreset]);
    if (nextIdentity === identity) return false;
    identity = nextIdentity; overrides = new Map();
    const names = new Set();
    specs = (Array.isArray(nextProvider?.capabilities?.options) ? nextProvider.capabilities.options : []).slice(0, 1000).filter(spec => {
      if (!spec || typeof spec.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(spec.name) || names.has(spec.name)) return false;
      names.add(spec.name); return true;
    });
    inherited = nextPreset && !Array.isArray(nextPreset) && typeof nextPreset === 'object' ? { ...nextPreset } : {};
    return true;
  }
  update({ provider, presetOptions });
  function setOverride(name, value) {
    const spec = specs.find(item => item.name === name);
    if (!spec) throw new Error('This option is not available on the selected node.');
    if (taskOptionRestriction(spec)) throw new Error(taskOptionRestriction(spec));
    if (value === undefined) overrides.delete(name); else overrides.set(name, value);
  }
  function validate() {
    const errors = [];
    if (overrides.size > 200) errors.push({ name: '', message: 'Use at most 200 task overrides.' });
    for (const [name, raw] of overrides) { try { parseTaskOption(specs.find(item => item.name === name), raw); } catch (error) { errors.push({ name, message: error.message }); } }
    return { valid: errors.length === 0, errors };
  }
  function getOptions() {
    const checked = validate();
    if (!checked.valid) throw new Error(checked.errors.map(error => `${error.name}: ${error.message}`).join('\n'));
    const result = Object.fromEntries([...overrides].map(([name, value]) => [name, parseTaskOption(specs.find(item => item.name === name), value)]));
    if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw new Error('Task options exceed the request size limit.');
    return result;
  }
  return { update, setOverride, validate, getOptions, entries: () => specs.map(spec => ({ spec, restriction: taskOptionRestriction(spec), inherited: REQUIRED.has(spec.name) ? true : Object.hasOwn(inherited, spec.name) ? inherited[spec.name] : spec.value, inheritedFrom: REQUIRED.has(spec.name) ? 'Viewer requirement' : Object.hasOwn(inherited, spec.name) ? 'Preset' : 'Node default', overridden: overrides.has(spec.name), value: overrides.has(spec.name) ? overrides.get(spec.name) : undefined })) };
}

export function mountTaskOptions({ container, provider = null, presetOptions = {} }) {
  const model = createTaskOptionsModel({ provider, presetOptions }), document = container.ownerDocument;
  const root = document.createElement('details'); root.className = 'task-options-editor';
  const summary = document.createElement('summary'); summary.textContent = 'Advanced processing options'; root.append(summary);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search options'; search.setAttribute('aria-label', 'Search processing options'); root.append(search);
  const help = document.createElement('p'); help.className = 'form-note'; help.textContent = 'Leave options inherited to use the preset or node defaults. Overrides apply only to this task; the server validates the final settings.'; root.append(help);
  const list = document.createElement('div'); list.className = 'task-options-list'; root.append(list);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); root.append(status); container.append(root);
  let rows = [], disposed = false, disabled = false;
  function filter() { const query = search.value.toLowerCase().trim(); for (const row of rows) row.element.hidden = !row.search.includes(query); }
  function render() {
    list.replaceChildren(); rows = []; status.textContent = '';
    for (const entry of model.entries()) {
      const { spec } = entry, row = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = spec.name; row.append(legend);
      const info = document.createElement('p'); info.className = 'form-note'; info.textContent = `${entry.inheritedFrom}: ${entry.inherited === undefined || entry.inherited === null ? 'not specified' : String(entry.inherited)}. ${spec.help || ''}`; row.append(info);
      const mode = document.createElement('select'); mode.setAttribute('aria-label', `${spec.name} value source`);
      for (const [value, text] of [['inherit', 'Use inherited value'], ['override', 'Override for this task']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; mode.append(option); }
      mode.value = entry.overridden ? 'override' : 'inherit'; mode.disabled = disabled || Boolean(entry.restriction); row.append(mode);
      const domain = taskOptionDomain(spec), choices = spec.type === 'bool' ? [true, false] : domain?.values;
      const control = document.createElement(choices ? 'select' : 'input'); control.setAttribute('aria-label', `${spec.name} override`);
      if (choices) for (const choice of choices) { const option = document.createElement('option'); option.value = String(choice); option.textContent = spec.type === 'bool' ? choice ? 'Enabled' : 'Disabled' : String(choice); control.append(option); }
      else { control.type = ['int','float'].includes(spec.type) ? 'number' : 'text'; if (control.type === 'number') { control.step = spec.type === 'int' ? '1' : 'any'; if (domain?.min !== undefined) control.min = String(domain.min); if (domain?.max !== undefined) control.max = String(domain.max); } else control.maxLength = 4000; }
      control.value = String(entry.overridden ? entry.value : entry.inherited ?? ''); control.disabled = disabled || !entry.overridden || Boolean(entry.restriction); row.append(control);
      if (entry.restriction) { const note = document.createElement('p'); note.className = 'form-note'; note.textContent = entry.restriction; row.append(note); }
      function save() { model.setOverride(spec.name, mode.value === 'override' ? control.value : undefined); control.disabled = mode.value !== 'override'; status.textContent = ''; }
      mode.addEventListener('change', save); control.addEventListener('input', save); control.addEventListener('change', save);
      rows.push({ element: row, search: `${spec.name} ${spec.help || ''}`.toLowerCase() }); list.append(row);
    }
    if (!rows.length) status.textContent = 'Select a node with available processing capabilities.';
    filter();
  }
  search.addEventListener('input', filter); render();
  return { getOptions: model.getOptions, validate() { const result = model.validate(); status.textContent = result.errors.map(error => `${error.name}: ${error.message}`).join(' '); return result; }, update(next) { if (!disposed && model.update(next)) render(); }, setDisabled(value) { if (!disposed) { disabled = Boolean(value); search.disabled = disabled; render(); } }, dispose() { disposed = true; root.remove(); } };
}
