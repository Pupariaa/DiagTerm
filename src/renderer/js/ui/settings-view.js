import { escapeHtml, debounce } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { onEvent } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { getSetting, getDefault, setSetting, allSettings, replaceSettings, resetSettings } from '../core/settings.js';
import { loadStore, saveStore, getStore } from '../core/store.js';
import { confirmDialog, toast } from '../core/dialogs.js';
import { listCommands, bindingFor, keyFromEvent, runCommand } from '../core/commands.js';
import { beep } from '../features/notify.js';
import { openMacrosEditor, openTriggersEditor, openHighlightsEditor, openCustomDecodersEditor } from '../features/editors.js';
import { openWorkspaces } from '../features/workspaces.js';
import { SETTINGS_SCHEMA } from './settings-schema.js';
import { icon } from './icons.js';

const EXPORTED_STORES = ['macros', 'triggers', 'highlights', 'decoders-custom', 'workspaces', 'filesend-options', 'flash-profiles', 'flash-state'];
const MONO_FONTS = ["Consolas, 'Cascadia Mono', Monaco, monospace", "'Cascadia Code', Consolas, monospace", "'JetBrains Mono', Consolas, monospace", "'Fira Code', Consolas, monospace", "'Source Code Pro', Consolas, monospace", "'Courier New', monospace", "'Lucida Console', monospace", 'monospace'];

let root;
let current = 'general';
let query = '';
let capturing = null;

function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function visible(field) {
    if (!field.when) return true;
    return Object.entries(field.when).every(([k, v]) => getSetting(k) === v);
}

function fieldMatches(field, cat) {
    if (!query) return true;
    const q = query.toLowerCase();
    return [t(field.label), field.label, field.help ? t(field.help) : '', field.key, t(cat.title)].some(s => s && s.toLowerCase().includes(q));
}

function controlHtml(field) {
    const value = getSetting(field.key);
    const k = escapeHtml(field.key);
    switch (field.type) {
        case 'bool':
            return `<label class="switch"><input type="checkbox" data-key="${k}" ${value ? 'checked' : ''}><span class="slider"></span></label>`;
        case 'select':
            return `<select class="input" data-key="${k}" ${field.numeric ? 'data-numeric' : ''}>${field.options.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHtml(t(l))}</option>`).join('')}</select>`;
        case 'number': {
            const list = field.datalist ? `<datalist id="dl-${k}">${field.datalist.map(v => `<option value="${v}">`).join('')}</datalist>` : '';
            return `<div class="input-unit"><input class="input num" type="number" data-key="${k}" value="${escapeHtml(value ?? '')}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} step="${field.step || 1}" ${field.datalist ? `list="dl-${k}"` : ''}>${field.unit ? `<span class="unit">${escapeHtml(field.unit)}</span>` : ''}</div>${list}`;
        }
        case 'range':
            return `<div class="range-row"><input type="range" data-key="${k}" min="${field.min}" max="${field.max}" step="${field.step}" value="${escapeHtml(value ?? 0)}"><span class="range-value">${Math.round((value || 0) * 100)}%</span></div>`;
        case 'text':
            return `<input class="input" type="text" data-key="${k}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(field.placeholder ? t(field.placeholder) : '')}">`;
        case 'font':
            return `<input class="input" type="text" data-key="${k}" value="${escapeHtml(value ?? '')}" list="dl-fonts"><datalist id="dl-fonts">${MONO_FONTS.map(f => `<option value="${escapeHtml(f)}">`).join('')}</datalist><div class="font-preview" style="font-family:${escapeHtml(value || 'monospace')}">0x1F 0xA5 ABCDEF abcdef 0123456789 {}[]()&lt;&gt; =&gt; |l1I O0</div>`;
        case 'color':
            return `<div class="color-row"><input type="color" data-key="${k}" value="${escapeHtml(value || '#4ec9b0')}"><input class="input sm mono" type="text" data-key="${k}" data-color-text value="${escapeHtml(value || '')}" placeholder="${field.allowEmpty ? escapeHtml(t('theme')) : ''}">${field.allowEmpty ? `<button class="tb-btn" data-clear="${k}">${escapeHtml(t('Clear'))}</button>` : ''}</div>`;
        case 'folder':
            return `<div class="folder-row"><input class="input" type="text" data-key="${k}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(field.placeholder ? t(field.placeholder) : '')}"><button class="btn sm" data-browse="${k}">${escapeHtml(t('Browse...'))}</button>${value ? `<button class="btn sm" data-openfolder="${k}">${icon('folder', 14)}</button>` : ''}</div>`;
        case 'lines':
            return `<textarea class="input mono" rows="${Math.max(4, (value || []).length + 1)}" data-key="${k}" data-lines spellcheck="false">${escapeHtml((value || []).join('\n'))}</textarea>`;
        case 'filters':
            return filtersHtml(value || []);
        default:
            return '';
    }
}

function filtersHtml(list) {
    return `
        <div class="filters-editor">
            <table class="table compact">
                <thead><tr><th>VID</th><th>PID</th><th>${escapeHtml(t('Serial prefix'))}</th><th>${escapeHtml(t('Manufacturer contains'))}</th><th></th></tr></thead>
                <tbody>
                    ${list.map((f, i) => `
                        <tr data-fi="${i}">
                            <td><input class="input sm mono" data-f="vid" value="${escapeHtml(f.vid || '')}" placeholder="303A"></td>
                            <td><input class="input sm mono" data-f="pid" value="${escapeHtml(f.pid || '')}" placeholder="1001"></td>
                            <td><input class="input sm" data-f="serialPrefix" value="${escapeHtml(f.serialPrefix || '')}"></td>
                            <td><input class="input sm" data-f="manufacturer" value="${escapeHtml(f.manufacturer || '')}"></td>
                            <td><button class="tb-btn icon-only" data-fdel="${i}">${icon('trash', 14)}</button></td>
                        </tr>`).join('')}
                </tbody>
            </table>
            <button class="btn sm" data-fadd>${icon('plus', 14)}<span>${escapeHtml(t('Add filter'))}</span></button>
            ${list.length ? '' : `<span class="dim small">${escapeHtml(t('No filter: every new port is flashed in production mode'))}</span>`}
        </div>`;
}

function rowHtml(field) {
    const value = getSetting(field.key);
    const def = getDefault(field.key);
    const modified = def !== undefined && !sameValue(value, def);
    const wide = ['lines', 'filters', 'font'].includes(field.type);
    return `
        <div class="set-row ${wide ? 'wide' : ''} ${modified ? 'modified' : ''} ${visible(field) ? '' : 'hidden'}" data-row="${escapeHtml(field.key)}">
            <div class="set-label">
                <div class="set-title">${escapeHtml(t(field.label))}${field.advanced ? ` <span class="badge">${escapeHtml(t('advanced'))}</span>` : ''}</div>
                ${field.help ? `<div class="set-help">${escapeHtml(t(field.help))}</div>` : ''}
                <div class="set-key">${escapeHtml(field.key)}</div>
            </div>
            <div class="set-control">${controlHtml(field)}</div>
            <button class="tb-btn icon-only set-reset" data-reset="${escapeHtml(field.key)}" title="${escapeHtml(t('Reset to default'))}" ${modified ? '' : 'disabled'}>${icon('reset', 14)}</button>
        </div>`;
}

function actionsHtml(cat) {
    if (!cat.actions || !cat.actions.length) return '';
    return `<div class="set-actions">${cat.actions.map(a => `<button class="btn" data-action="${a.id}">${escapeHtml(t(a.label))}</button>`).join('')}</div>`;
}

function shortcutsHtml() {
    const cmds = listCommands().filter(c => !c.hidden).slice().sort((a, b) => (a.category || '').localeCompare(b.category || '') || String(typeof a.title === 'function' ? a.title() : a.title).localeCompare(String(typeof b.title === 'function' ? b.title() : b.title)));
    const usage = new Map();
    for (const c of cmds) {
        const b = bindingFor(c.id);
        if (!b) continue;
        usage.set(b, (usage.get(b) || 0) + 1);
    }
    const overrides = getSetting('shortcuts', {}) || {};
    const q = query.toLowerCase();
    const groups = new Map();
    for (const c of cmds) {
        const title = t(typeof c.title === 'function' ? c.title() : c.title);
        const binding = bindingFor(c.id);
        if (q && !title.toLowerCase().includes(q) && !binding.toLowerCase().includes(q) && !c.id.includes(q)) continue;
        const cat = t(c.category || 'General');
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push({ c, title, binding });
    }
    return `
        <p class="dim">${escapeHtml(t('Click a shortcut to change it, then press the new key combination. Escape cancels, Backspace removes the shortcut. Macros keys (F1-F12) are configured in the macro editor.'))}</p>
        ${Array.from(groups.entries()).map(([cat, list]) => `
            <h3 class="set-group">${escapeHtml(cat)}</h3>
            <div class="shortcut-list">
                ${list.map(({ c, title, binding }) => `
                    <div class="shortcut-row ${binding && usage.get(binding) > 1 ? 'conflict' : ''}">
                        <span class="shortcut-title">${escapeHtml(title)}</span>
                        <button class="kbd-btn ${capturing === c.id ? 'capturing' : ''}" data-shortcut="${escapeHtml(c.id)}" data-keycapture>${capturing === c.id ? escapeHtml(t('Press keys...')) : binding ? `<kbd>${escapeHtml(binding)}</kbd>` : `<span class="dim">${escapeHtml(t('None'))}</span>`}</button>
                        ${binding && usage.get(binding) > 1 ? `<span class="err small">${escapeHtml(t('Conflict'))}</span>` : ''}
                        <button class="tb-btn icon-only" data-shortcut-reset="${escapeHtml(c.id)}" title="${escapeHtml(t('Reset to default'))}" ${Object.prototype.hasOwnProperty.call(overrides, c.id) ? '' : 'disabled'}>${icon('reset', 14)}</button>
                    </div>`).join('')}
            </div>`).join('')}
        <div class="set-actions"><button class="btn" data-action="shortcuts-reset">${escapeHtml(t('Reset all shortcuts'))}</button></div>`;
}

function dataHtml() {
    const count = (name) => (getStore(name, []) || []).length;
    const card = (id, title, desc, n) => `
        <div class="data-card">
            <div><b>${escapeHtml(t(title))}</b> <span class="badge">${n}</span><div class="dim small">${escapeHtml(t(desc))}</div></div>
            <button class="btn" data-action="${id}">${escapeHtml(t('Edit...'))}</button>
        </div>`;
    return `
        <div class="data-cards">
            ${card('edit-macros', 'Macros', 'Saved commands, sequences with waits, F-key bindings and periodic sending', count('macros'))}
            ${card('edit-triggers', 'Triggers', 'Regular expressions that run actions when matching data is received', count('triggers'))}
            ${card('edit-highlights', 'Highlights', 'Coloring rules applied to the terminal', count('highlights'))}
            ${card('edit-decoders', 'Custom decoders', 'Frame definitions for proprietary binary protocols', count('decoders-custom'))}
            ${card('edit-workspaces', 'Workspaces', 'Saved sets of tabs, ports and layouts', count('workspaces'))}
        </div>
        <h3 class="set-group">${escapeHtml(t('Backup'))}</h3>
        <p class="dim">${escapeHtml(t('Export or import all settings together with macros, triggers, highlights, decoders, workspaces and flash profiles.'))}</p>
        <div class="set-actions">
            <button class="btn" data-action="export-all">${icon('download', 14)}<span>${escapeHtml(t('Export everything...'))}</span></button>
            <button class="btn" data-action="import-all">${icon('upload', 14)}<span>${escapeHtml(t('Import...'))}</span></button>
            <button class="btn" data-action="data-folder">${icon('folder', 14)}<span>${escapeHtml(t('Open data folder'))}</span></button>
        </div>`;
}

function categoryBody(cat) {
    if (cat.custom === 'shortcuts') return shortcutsHtml();
    if (cat.custom === 'data') return dataHtml();
    return `
        ${cat.description ? `<p class="dim">${escapeHtml(t(cat.description))}</p>` : ''}
        <div class="set-rows">${cat.fields.map(rowHtml).join('')}</div>
        ${actionsHtml(cat)}`;
}

function render() {
    if (!root) return;
    const navScroll = root.querySelector('.settings-content') ? root.querySelector('.settings-content').scrollTop : 0;
    const nav = SETTINGS_SCHEMA.map(cat => {
        const hits = query && cat.fields ? cat.fields.filter(f => fieldMatches(f, cat)).length : 0;
        return `<button class="settings-nav-item ${!query && current === cat.id ? 'active' : ''} ${query && cat.fields && !hits ? 'dim' : ''}" data-cat="${cat.id}">${icon(cat.icon || 'gear', 15)}<span>${escapeHtml(t(cat.title))}</span>${hits ? `<span class="badge">${hits}</span>` : ''}</button>`;
    }).join('');
    let content;
    if (query) {
        const parts = [];
        for (const cat of SETTINGS_SCHEMA) {
            if (cat.custom === 'shortcuts') {
                const html = shortcutsHtml();
                if (html.includes('shortcut-row')) parts.push(`<h2 class="set-cat-title">${escapeHtml(t(cat.title))}</h2>${html}`);
                continue;
            }
            if (!cat.fields) continue;
            const fields = cat.fields.filter(f => fieldMatches(f, cat));
            if (!fields.length) continue;
            parts.push(`<h2 class="set-cat-title">${escapeHtml(t(cat.title))}</h2><div class="set-rows">${fields.map(rowHtml).join('')}</div>`);
        }
        content = parts.length ? parts.join('') : `<div class="dim empty">${escapeHtml(t('No setting matches "{q}"', { q: query }))}</div>`;
    } else {
        const cat = SETTINGS_SCHEMA.find(c => c.id === current) || SETTINGS_SCHEMA[0];
        content = `
            <div class="set-cat-header">
                <h2 class="set-cat-title">${escapeHtml(t(cat.title))}</h2>
                ${cat.fields ? `<button class="btn sm" data-action="reset-category" data-cat-reset="${cat.id}">${escapeHtml(t('Reset this section'))}</button>` : ''}
            </div>
            ${categoryBody(cat)}`;
    }
    const searchFocused = document.activeElement && document.activeElement.classList.contains('settings-search');
    const caret = searchFocused ? document.activeElement.selectionStart : null;
    root.innerHTML = `
        <div class="settings-view">
            <aside class="settings-nav">
                <div class="settings-search-wrap">${icon('search', 14)}<input class="input settings-search" type="text" placeholder="${escapeHtml(t('Search settings'))}" value="${escapeHtml(query)}"></div>
                <nav>${nav}</nav>
                <div class="settings-nav-footer">
                    <button class="btn sm" data-action="export-settings">${escapeHtml(t('Export settings'))}</button>
                    <button class="btn sm" data-action="import-settings">${escapeHtml(t('Import settings'))}</button>
                    <button class="btn sm btn-danger" data-action="reset-all">${escapeHtml(t('Reset all'))}</button>
                </div>
            </aside>
            <main class="settings-content">${content}</main>
        </div>`;
    const contentEl = root.querySelector('.settings-content');
    contentEl.scrollTop = navScroll;
    if (searchFocused) {
        const input = root.querySelector('.settings-search');
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
    }
}

function fieldFor(key) {
    for (const cat of SETTINGS_SCHEMA) {
        if (!cat.fields) continue;
        const f = cat.fields.find(x => x.key === key);
        if (f) return f;
    }
    return null;
}

function parseValue(field, target) {
    switch (field.type) {
        case 'bool': return target.checked;
        case 'number': {
            const v = parseFloat(target.value);
            if (Number.isNaN(v)) return getDefault(field.key);
            let out = v;
            if (field.min !== undefined) out = Math.max(field.min, out);
            if (field.max !== undefined) out = Math.min(field.max, out);
            return out;
        }
        case 'range': return parseFloat(target.value);
        case 'select': return field.numeric ? parseFloat(target.value) : target.value;
        case 'lines': return target.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        case 'color': {
            const v = target.value.trim();
            if (!v) return field.allowEmpty ? '' : getDefault(field.key);
            return /^#[0-9a-f]{3,8}$/i.test(v) ? v : getSetting(field.key);
        }
        default: return target.value;
    }
}

async function commit(key, value, { rerender = true } = {}) {
    const field = fieldFor(key);
    await setSetting(key, value);
    if (field && field.reload) {
        const ok = await confirmDialog(t('Reload the interface now to apply this change? Open ports stay connected.'), { okLabel: t('Reload') });
        if (ok) invoke('app:reload');
    }
    if (rerender) render();
}

async function saveFilters(mutator) {
    const list = JSON.parse(JSON.stringify(getSetting('flash.productionFilters', []) || []));
    mutator(list);
    await setSetting('flash.productionFilters', list);
    render();
}

async function exportBundle(includeStores) {
    const bundle = { app: 'DiagTerm', kind: includeStores ? 'full' : 'settings', exportedAt: new Date().toISOString(), settings: allSettings() };
    if (includeStores) {
        bundle.stores = {};
        for (const name of EXPORTED_STORES) bundle.stores[name] = await loadStore(name, null);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await invoke('files:save-text', JSON.stringify(bundle, null, 2), 'json', includeStores ? `diagterm-backup-${stamp}.json` : `diagterm-settings-${stamp}.json`);
    if (res && res.success) toast(t('Exported to {file}', { file: res.filePath }), { type: 'success' });
}

async function importBundle() {
    const file = await invoke('files:select-file', [{ name: 'JSON', extensions: ['json'] }]);
    if (!file) return;
    const res = await invoke('files:read-text', file);
    if (!res.success) {
        toast(res.error || t('Unable to read file'), { type: 'error' });
        return;
    }
    let data;
    try {
        data = JSON.parse(res.content);
    } catch (error) {
        toast(t('Invalid JSON file'), { type: 'error' });
        return;
    }
    const settings = data.settings || (data.general || data.serial ? data : null);
    const stores = data.stores || null;
    const parts = [];
    if (settings) parts.push(t('settings'));
    if (stores) parts.push(Object.keys(stores).filter(k => stores[k] !== null).join(', '));
    if (!parts.length) {
        toast(t('Nothing to import in this file'), { type: 'error' });
        return;
    }
    const ok = await confirmDialog(t('Import {parts}? Current values will be replaced.', { parts: parts.join(', ') }), { okLabel: t('Import') });
    if (!ok) return;
    if (settings) await replaceSettings(settings);
    if (stores) {
        for (const [name, value] of Object.entries(stores)) {
            if (value === null || !EXPORTED_STORES.includes(name)) continue;
            saveStore(name, value);
        }
    }
    toast(t('Import complete'), { type: 'success' });
    const reload = await confirmDialog(t('Reload the interface to apply every imported value?'), { okLabel: t('Reload') });
    if (reload) invoke('app:reload');
    else render();
}

async function runAction(id, btn) {
    switch (id) {
        case 'open-log-folder': {
            const folder = await invoke('logger:folder');
            if (folder) invoke('files:open-path', folder);
            break;
        }
        case 'board-manager': runCommand('flash.board-manager'); break;
        case 'boards-update':
            btn.disabled = true;
            toast(t('Checking board packages...'));
            await invoke('boards:update-now');
            btn.disabled = false;
            toast(t('Board packages are up to date'), { type: 'success' });
            break;
        case 'test-sound': beep({ frequency: 880, duration: 150 }); break;
        case 'devtools': invoke('app:toggle-devtools'); break;
        case 'reload': invoke('app:reload'); break;
        case 'data-folder': {
            const paths = await invoke('app:paths');
            invoke('files:open-path', paths.data);
            break;
        }
        case 'reset-category': {
            const cat = btn.dataset.catReset;
            const ok = await confirmDialog(t('Reset "{name}" to default values?', { name: t((SETTINGS_SCHEMA.find(c => c.id === cat) || {}).title || cat) }), { danger: true, okLabel: t('Reset') });
            if (!ok) return;
            await resetSettings(cat);
            render();
            break;
        }
        case 'reset-all': {
            const ok = await confirmDialog(t('Reset every setting to its default value? Macros, triggers and workspaces are kept.'), { danger: true, okLabel: t('Reset all') });
            if (!ok) return;
            await resetSettings();
            render();
            break;
        }
        case 'shortcuts-reset': {
            const ok = await confirmDialog(t('Restore every default shortcut?'), { okLabel: t('Reset') });
            if (!ok) return;
            await setSetting('shortcuts', {});
            render();
            break;
        }
        case 'export-settings': exportBundle(false); break;
        case 'export-all': exportBundle(true); break;
        case 'import-settings':
        case 'import-all': importBundle(); break;
        case 'edit-macros': openMacrosEditor(); break;
        case 'edit-triggers': openTriggersEditor(); break;
        case 'edit-highlights': openHighlightsEditor(); break;
        case 'edit-decoders': openCustomDecodersEditor(); break;
        case 'edit-workspaces': openWorkspaces(); break;
        default: break;
    }
}

async function setShortcut(id, combo) {
    const overrides = { ...(getSetting('shortcuts', {}) || {}) };
    const cmd = listCommands().find(c => c.id === id);
    if (combo === null) delete overrides[id];
    else if (cmd && (cmd.key || '') === combo) delete overrides[id];
    else overrides[id] = combo;
    await setSetting('shortcuts', overrides);
}

export function openSettingsCategory(id) {
    current = id;
    query = '';
    render();
}

export function initSettingsView(host) {
    root = host;
    const rangeCommit = debounce((key, value) => commit(key, value, { rerender: false }), 200);
    const textCommit = debounce((key, value) => commit(key, value, { rerender: false }), 500);
    root.addEventListener('input', (e) => {
        const target = e.target;
        if (target.classList.contains('settings-search')) {
            query = target.value.trim();
            render();
            return;
        }
        const key = target.dataset.key;
        if (!key) return;
        const field = fieldFor(key);
        if (!field) return;
        if (field.type === 'range') {
            const label = target.parentElement.querySelector('.range-value');
            if (label) label.textContent = `${Math.round(parseFloat(target.value) * 100)}%`;
            rangeCommit(key, parseValue(field, target));
        } else if (field.type === 'font') {
            const preview = target.parentElement.querySelector('.font-preview');
            if (preview) preview.style.fontFamily = target.value;
            textCommit(key, target.value);
        } else if (field.type === 'color' && target.type === 'color') {
            const text = target.parentElement.querySelector('[data-color-text]');
            if (text) text.value = target.value;
            rangeCommit(key, target.value);
        }
    });
    root.addEventListener('change', (e) => {
        const target = e.target;
        const fi = target.closest('[data-fi]');
        if (fi && target.dataset.f) {
            const idx = parseInt(fi.dataset.fi, 10);
            saveFilters(list => { if (list[idx]) list[idx][target.dataset.f] = target.value.trim(); });
            return;
        }
        const key = target.dataset.key;
        if (!key) return;
        const field = fieldFor(key);
        if (!field || field.type === 'range') return;
        commit(key, parseValue(field, target));
    });
    root.addEventListener('click', async (e) => {
        const nav = e.target.closest('[data-cat]');
        if (nav) {
            current = nav.dataset.cat;
            query = '';
            render();
            root.querySelector('.settings-content').scrollTop = 0;
            return;
        }
        const reset = e.target.closest('[data-reset]');
        if (reset) {
            await commit(reset.dataset.reset, JSON.parse(JSON.stringify(getDefault(reset.dataset.reset))));
            return;
        }
        const clear = e.target.closest('[data-clear]');
        if (clear) {
            await commit(clear.dataset.clear, '');
            return;
        }
        const browse = e.target.closest('[data-browse]');
        if (browse) {
            const folder = await invoke('files:select-folder', getSetting(browse.dataset.browse) || undefined);
            if (folder) await commit(browse.dataset.browse, folder);
            return;
        }
        const openFolder = e.target.closest('[data-openfolder]');
        if (openFolder) {
            invoke('files:open-path', getSetting(openFolder.dataset.openfolder));
            return;
        }
        if (e.target.closest('[data-fadd]')) {
            saveFilters(list => list.push({ vid: '', pid: '', serialPrefix: '', manufacturer: '' }));
            return;
        }
        const fdel = e.target.closest('[data-fdel]');
        if (fdel) {
            const idx = parseInt(fdel.dataset.fdel, 10);
            saveFilters(list => list.splice(idx, 1));
            return;
        }
        const sc = e.target.closest('[data-shortcut]');
        if (sc) {
            capturing = sc.dataset.shortcut;
            render();
            const btn = root.querySelector(`[data-shortcut="${CSS.escape(capturing)}"]`);
            if (btn) btn.focus();
            return;
        }
        const scr = e.target.closest('[data-shortcut-reset]');
        if (scr) {
            await setShortcut(scr.dataset.shortcutReset, null);
            render();
            return;
        }
        const action = e.target.closest('[data-action]');
        if (action) runAction(action.dataset.action, action);
    });
    root.addEventListener('keydown', async (e) => {
        if (!capturing) return;
        const btn = e.target.closest('[data-shortcut]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            capturing = null;
            render();
            return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
            const id = capturing;
            capturing = null;
            await setShortcut(id, '');
            render();
            return;
        }
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        const combo = keyFromEvent(e);
        const id = capturing;
        capturing = null;
        await setShortcut(id, combo);
        render();
    }, true);
    root.addEventListener('focusout', (e) => {
        if (capturing && e.target.closest && e.target.closest('[data-shortcut]')) {
            setTimeout(() => {
                if (capturing && !root.contains(document.activeElement)) {
                    capturing = null;
                    render();
                }
            }, 0);
        }
    });
    onEvent('settings:changed', (keyPath) => {
        if (!root.offsetParent) return;
        const active = document.activeElement;
        if (active && root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'checkbox') return;
        if (keyPath === '*' || keyPath) render();
    });
    render();
    Promise.all(EXPORTED_STORES.map(name => loadStore(name, null))).then(() => render()).catch(() => { });
}

export function refreshSettingsView() {
    render();
}
