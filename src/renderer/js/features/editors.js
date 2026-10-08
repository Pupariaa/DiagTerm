import { openModal, toast, confirmDialog } from '../core/dialogs.js';
import { escapeHtml, options, uid } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { keyFromEvent } from '../core/commands.js';
import { getStore, saveStore } from '../core/store.js';
import { parseHexString, toHex } from '../core/format.js';
import { t } from '../core/i18n.js';
import { getMacros, saveMacros, defaultMacro, runMacro } from './macros.js';
import { getTriggers, saveTriggers, defaultTrigger, testTrigger, triggerHits } from './triggers.js';
import { getHighlightRules, saveHighlightRules, compileRule } from './highlight.js';
import { VARIABLE_HELP, buildPayload } from './payload.js';
import { CHECKSUMS, checksumBytes } from '../lib/checksums.js';
import { FIELD_TYPES, decodeCustom } from '../lib/decoders.js';
import { activeSession } from '../serial/sessions.js';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function listEditor({ title, width = 980, items, save, label, sublabel, create, renderForm, selectedId, exportName, extraButtons = [] }) {
    let list = clone(items);
    let selected = selectedId || (list[0] && list[0].id) || null;
    let dirty = false;
    const modal = openModal({
        title,
        width,
        className: 'editor-modal',
        body: `
            <div class="editor">
                <div class="editor-list">
                    <div class="editor-list-actions">
                        <button class="btn sm" data-e="add">${escapeHtml(t('Add'))}</button>
                        <button class="btn sm" data-e="dup">${escapeHtml(t('Duplicate'))}</button>
                        <button class="btn sm btn-danger" data-e="del">${escapeHtml(t('Delete'))}</button>
                    </div>
                    <div class="editor-items"></div>
                    <div class="editor-list-actions">
                        <button class="btn sm" data-e="up">${escapeHtml(t('Up'))}</button>
                        <button class="btn sm" data-e="down">${escapeHtml(t('Down'))}</button>
                        <button class="btn sm" data-e="import">${escapeHtml(t('Import'))}</button>
                        <button class="btn sm" data-e="export">${escapeHtml(t('Export'))}</button>
                    </div>
                </div>
                <div class="editor-form"></div>
            </div>`,
        buttons: [
            ...extraButtons.map(b => ({ ...b, left: true, keepOpen: true, action: () => b.action(list.find(i => i.id === selected), list) })),
            { label: t('Cancel') },
            {
                label: t('Save'), primary: true, action: () => {
                    save(list);
                    dirty = false;
                }
            }
        ]
    });
    const itemsEl = modal.body.querySelector('.editor-items');
    const formEl = modal.body.querySelector('.editor-form');

    const renderList = () => {
        itemsEl.innerHTML = list.map(item => `
            <div class="editor-item ${item.id === selected ? 'sel' : ''} ${item.enabled === false ? 'disabled' : ''}" data-id="${escapeHtml(item.id)}">
                <div class="ei-label">${escapeHtml(label(item) || t('(unnamed)'))}</div>
                <div class="ei-sub dim">${escapeHtml(sublabel ? sublabel(item) : '')}</div>
            </div>`).join('') || `<div class="dim pad">${escapeHtml(t('Empty. Click Add.'))}</div>`;
    };
    const renderSelected = () => {
        const item = list.find(i => i.id === selected);
        formEl.innerHTML = '';
        if (!item) {
            formEl.innerHTML = `<div class="dim pad">${escapeHtml(t('Select or add an item.'))}</div>`;
            return;
        }
        renderForm(item, formEl, () => {
            dirty = true;
            renderList();
        });
    };
    itemsEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-id]');
        if (!row) return;
        selected = row.dataset.id;
        renderList();
        renderSelected();
    });
    modal.body.querySelector('.editor-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-e]');
        if (!btn) return;
        const idx = list.findIndex(i => i.id === selected);
        switch (btn.dataset.e) {
            case 'add': {
                const item = create();
                list.splice(idx + 1, 0, item);
                selected = item.id;
                break;
            }
            case 'dup': {
                if (idx < 0) return;
                const copy = { ...clone(list[idx]), id: uid(), name: `${list[idx].name || ''} (copy)` };
                if ('key' in copy) copy.key = '';
                list.splice(idx + 1, 0, copy);
                selected = copy.id;
                break;
            }
            case 'del': {
                if (idx < 0) return;
                if (!await confirmDialog(t('Delete "{name}"?', { name: label(list[idx]) }), { danger: true, okLabel: t('Delete') })) return;
                list.splice(idx, 1);
                selected = list[Math.min(idx, list.length - 1)] ? list[Math.min(idx, list.length - 1)].id : null;
                break;
            }
            case 'up':
                if (idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
                break;
            case 'down':
                if (idx >= 0 && idx < list.length - 1) [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
                break;
            case 'export':
                await invoke('files:save-text', JSON.stringify(list, null, 2), 'json', exportName);
                return;
            case 'import': {
                const file = await invoke('files:select-file', [{ name: 'JSON', extensions: ['json'] }]);
                if (!file) return;
                const res = await invoke('files:read-text', file);
                if (!res.success) return;
                try {
                    const imported = JSON.parse(res.content);
                    if (!Array.isArray(imported)) throw new Error('Expected an array');
                    for (const item of imported) list.push({ ...item, id: uid() });
                    toast(t('Imported {n} items', { n: imported.length }), { type: 'success' });
                } catch (error) {
                    toast(error.message, { type: 'error' });
                    return;
                }
                break;
            }
            default: return;
        }
        dirty = true;
        renderList();
        renderSelected();
    });
    renderList();
    renderSelected();
    return { modal, isDirty: () => dirty };
}

function bindForm(container, item, onChange, map = {}) {
    container.addEventListener('input', handler);
    container.addEventListener('change', handler);
    function handler(e) {
        const target = e.target;
        const path = target.dataset.p;
        if (!path) return;
        let value;
        if (target.type === 'checkbox') value = target.checked;
        else if (target.type === 'number') value = target.value === '' ? 0 : parseFloat(target.value);
        else value = target.value;
        if (map[path]) value = map[path](value);
        const parts = path.split('.');
        let node = item;
        for (let i = 0; i < parts.length - 1; i++) {
            if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
            node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = value;
        onChange(path, value);
    }
}

function keyCaptureInput(path, value) {
    return `<input class="input key-capture" data-p="${path}" data-keycapture value="${escapeHtml(value || '')}" placeholder="${escapeHtml(t('Press a key (F1-F12, Ctrl+...)'))}" readonly>`;
}

function attachKeyCapture(container) {
    for (const input of container.querySelectorAll('.key-capture')) {
        input.addEventListener('keydown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Escape') {
                input.value = '';
            } else {
                const combo = keyFromEvent(e);
                if (!combo || ['Ctrl', 'Alt', 'Shift', 'Ctrl+Shift', 'Ctrl+Alt'].includes(combo)) return;
                input.value = combo;
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }
}

export function openMacrosEditor(selectedId) {
    const lineEndings = [['none', t('None')], ['NL', 'LF'], ['CR', 'CR'], ['CRNL', 'CRLF'], ['NLCR', 'LFCR']];
    listEditor({
        title: t('Macros'),
        items: getMacros(),
        save: saveMacros,
        selectedId,
        exportName: 'diagterm-macros.json',
        label: m => m.name,
        sublabel: m => `${m.key ? m.key + ' - ' : ''}${m.steps && m.steps.length ? t('{n} steps', { n: m.steps.length }) : (m.payload || '').slice(0, 30)}${m.repeatMs > 0 ? ` - ${m.repeatMs}ms` : ''}`,
        create: defaultMacro,
        extraButtons: [{
            label: t('Run on active tab'), action: (item) => {
                if (!item) return;
                const s = activeSession();
                if (!s) return;
                runMacro(item, s);
            }
        }],
        renderForm: (m, container, onChange) => {
            const renderSteps = () => (m.steps || []).map((st, i) => `
                <tr data-i="${i}">
                    <td>${i + 1}</td>
                    <td><input class="input sm" data-s="payload" value="${escapeHtml(st.payload || '')}"></td>
                    <td><select class="input sm" data-s="mode">${options([['text', t('Text')], ['hex', 'HEX']], st.mode || 'text')}</select></td>
                    <td><select class="input sm" data-s="lineEnding">${options(lineEndings, st.lineEnding !== undefined ? st.lineEnding : m.lineEnding)}</select></td>
                    <td><input class="input xs" type="number" min="0" data-s="delayMs" value="${st.delayMs || 0}"></td>
                    <td><input class="input sm" data-s="waitFor" value="${escapeHtml(st.waitFor || '')}" placeholder="regex"></td>
                    <td><input class="input xs" type="number" min="10" data-s="waitTimeoutMs" value="${st.waitTimeoutMs || 2000}"></td>
                    <td><select class="input sm" data-s="onTimeout">${options([['abort', t('Abort')], ['continue', t('Continue')]], st.onTimeout || 'abort')}</select></td>
                    <td><button class="icon-btn" data-step-del="${i}">&times;</button></td>
                </tr>`).join('');
            container.innerHTML = `
                <div class="form-grid wide">
                    <label>${escapeHtml(t('Name'))}</label><input class="input" data-p="name" value="${escapeHtml(m.name)}">
                    <label>${escapeHtml(t('Shortcut'))}</label>${keyCaptureInput('key', m.key)}
                    <label>${escapeHtml(t('Group'))}</label><input class="input" data-p="group" value="${escapeHtml(m.group || '')}">
                    <label>${escapeHtml(t('Color'))}</label><div class="inline"><input type="color" data-p="color" value="${m.color || '#3794ff'}"><label class="chk"><input type="checkbox" data-p="showInBar" ${m.showInBar !== false ? 'checked' : ''}> ${escapeHtml(t('Show in macro bar'))}</label></div>
                    <label>${escapeHtml(t('Format'))}</label>
                    <div class="inline">
                        <select class="input sm" data-p="mode">${options([['text', t('Text')], ['hex', 'HEX']], m.mode)}</select>
                        <select class="input sm" data-p="lineEnding">${options(lineEndings, m.lineEnding)}</select>
                        <label class="chk"><input type="checkbox" data-p="escapes" ${m.escapes ? 'checked' : ''}> ${escapeHtml(t('Escapes (\\n, \\x1B...)'))}</label>
                    </div>
                    <label>${escapeHtml(t('Payload'))}</label><textarea class="input mono" rows="3" data-p="payload">${escapeHtml(m.payload || '')}</textarea>
                    <label>${escapeHtml(t('Preview'))}</label><div class="mono macro-preview dim"></div>
                    <label>${escapeHtml(t('Repeat every (ms)'))}</label><div class="inline"><input class="input xs" type="number" min="0" data-p="repeatMs" value="${m.repeatMs || 0}"><span class="dim">${escapeHtml(t('0 = run once. Clicking again stops the periodic send.'))}</span></div>
                </div>
                <div class="form-sep">${escapeHtml(t('Sequence (optional, replaces the payload above)'))}</div>
                <table class="grid-table steps">
                    <tr><th>#</th><th>${escapeHtml(t('Payload'))}</th><th>${escapeHtml(t('Format'))}</th><th>${escapeHtml(t('Ending'))}</th><th>${escapeHtml(t('Delay before'))}</th><th>${escapeHtml(t('Wait for RX'))}</th><th>${escapeHtml(t('Timeout'))}</th><th>${escapeHtml(t('If no reply'))}</th><th></th></tr>
                    <tbody class="steps-body">${renderSteps()}</tbody>
                </table>
                <button class="btn sm" data-step-add>${escapeHtml(t('Add step'))}</button>
                <details class="help"><summary>${escapeHtml(t('Variables'))}</summary>
                    <table class="kv">${VARIABLE_HELP.map(([k, d]) => `<tr><th class="mono">${escapeHtml(k)}</th><td>${escapeHtml(t(d))}</td></tr>`).join('')}</table>
                </details>`;
            const preview = container.querySelector('.macro-preview');
            const updatePreview = () => {
                try {
                    const bytes = buildPayload(m.payload || '', { mode: m.mode, escapes: m.escapes, lineEnding: m.mode === 'hex' ? 'none' : m.lineEnding, counterKey: '__preview' });
                    preview.textContent = `${toHex(bytes)}  (${bytes.length} B)`;
                    preview.classList.remove('err');
                } catch (error) {
                    preview.textContent = error.message;
                    preview.classList.add('err');
                }
            };
            updatePreview();
            bindForm(container, m, () => {
                updatePreview();
                onChange();
            });
            attachKeyCapture(container);
            const stepsBody = container.querySelector('.steps-body');
            stepsBody.addEventListener('change', (e) => {
                const row = e.target.closest('[data-i]');
                const key = e.target.dataset.s;
                if (!row || !key) return;
                const step = m.steps[parseInt(row.dataset.i, 10)];
                step[key] = e.target.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value;
                onChange();
            });
            container.addEventListener('click', (e) => {
                if (e.target.closest('[data-step-add]')) {
                    m.steps = m.steps || [];
                    m.steps.push({ payload: '', mode: m.mode, lineEnding: m.lineEnding, delayMs: 0, waitFor: '', waitTimeoutMs: 2000, onTimeout: 'abort' });
                    stepsBody.innerHTML = renderSteps();
                    onChange();
                }
                const del = e.target.closest('[data-step-del]');
                if (del) {
                    m.steps.splice(parseInt(del.dataset.stepDel, 10), 1);
                    stepsBody.innerHTML = renderSteps();
                    onChange();
                }
            });
        }
    });
}

export function openTriggersEditor(selectedId) {
    listEditor({
        title: t('Triggers and alerts'),
        items: getTriggers(),
        save: saveTriggers,
        selectedId,
        exportName: 'diagterm-triggers.json',
        label: tr => tr.name,
        sublabel: tr => `${tr.direction} - ${tr.matchType}: ${tr.pattern}${triggerHits(tr.id) ? ` - ${triggerHits(tr.id)} ${t('hits')}` : ''}`,
        create: defaultTrigger,
        renderForm: (tr, container, onChange) => {
            const a = tr.actions;
            a.reply = a.reply || { enabled: false, payload: '', mode: 'text', lineEnding: 'NL', delayMs: 0 };
            const macros = getMacros();
            container.innerHTML = `
                <div class="form-grid wide">
                    <label>${escapeHtml(t('Name'))}</label><div class="inline"><input class="input" data-p="name" value="${escapeHtml(tr.name)}"><label class="chk"><input type="checkbox" data-p="enabled" ${tr.enabled !== false ? 'checked' : ''}> ${escapeHtml(t('Enabled'))}</label></div>
                    <label>${escapeHtml(t('Match'))}</label>
                    <div class="inline">
                        <select class="input sm" data-p="matchType">${options([['contains', t('Contains')], ['starts', t('Starts with')], ['exact', t('Exact')], ['regex', t('Regex')], ['hex', t('Hex bytes')]], tr.matchType)}</select>
                        <label class="chk"><input type="checkbox" data-p="caseSensitive" ${tr.caseSensitive ? 'checked' : ''}> ${escapeHtml(t('Case sensitive'))}</label>
                    </div>
                    <label>${escapeHtml(t('Pattern'))}</label><input class="input mono" data-p="pattern" value="${escapeHtml(tr.pattern)}">
                    <label>${escapeHtml(t('Direction'))}</label><select class="input sm" data-p="direction">${options([['RX', 'RX'], ['TX', 'TX'], ['any', t('Both')]], tr.direction)}</select>
                    <label>${escapeHtml(t('Ports'))}</label><input class="input" data-p="portFilter" value="${escapeHtml(tr.portFilter || '')}" placeholder="${escapeHtml(t('All ports (or regex, e.g. COM1[0-9])'))}">
                    <label>${escapeHtml(t('Cooldown (ms)'))}</label><input class="input xs" type="number" min="0" data-p="cooldownMs" value="${tr.cooldownMs || 0}">
                </div>
                <div class="form-sep">${escapeHtml(t('Actions'))}</div>
                <div class="form-grid wide">
                    <label>${escapeHtml(t('Notify'))}</label><div class="inline">
                        <label class="chk"><input type="checkbox" data-p="actions.notify" ${a.notify ? 'checked' : ''}> ${escapeHtml(t('Notification'))}</label>
                        <label class="chk"><input type="checkbox" data-p="actions.sound" ${a.sound ? 'checked' : ''}> ${escapeHtml(t('Sound'))}</label>
                        <label class="chk"><input type="checkbox" data-p="actions.marker" ${a.marker ? 'checked' : ''}> ${escapeHtml(t('Timeline marker'))}</label>
                    </div>
                    <label>${escapeHtml(t('Highlight frame'))}</label><div class="inline"><input type="checkbox" data-hl ${a.highlight ? 'checked' : ''}><input type="color" data-p="actions.highlight" value="${a.highlight || '#f44336'}"></div>
                    <label>${escapeHtml(t('Chronometer'))}</label><select class="input sm" data-p="actions.stopwatch">${options([['none', t('Nothing')], ['start', t('Start')], ['stop', t('Stop')], ['lap', t('Lap')], ['toggle', t('Toggle')]], a.stopwatch || 'none')}</select>
                    <label>${escapeHtml(t('Auto reply'))}</label><div class="inline">
                        <input type="checkbox" data-p="actions.reply.enabled" ${a.reply.enabled ? 'checked' : ''}>
                        <input class="input mono" data-p="actions.reply.payload" value="${escapeHtml(a.reply.payload || '')}" placeholder="${escapeHtml(t('Reply ($1 = regex group)'))}">
                        <select class="input sm" data-p="actions.reply.mode">${options([['text', t('Text')], ['hex', 'HEX']], a.reply.mode || 'text')}</select>
                        <select class="input sm" data-p="actions.reply.lineEnding">${options([['none', t('None')], ['NL', 'LF'], ['CR', 'CR'], ['CRNL', 'CRLF']], a.reply.lineEnding || 'NL')}</select>
                        <input class="input xs" type="number" min="0" data-p="actions.reply.delayMs" value="${a.reply.delayMs || 0}" title="${escapeHtml(t('Delay (ms)'))}">
                    </div>
                    <label>${escapeHtml(t('Run macro'))}</label><select class="input sm" data-p="actions.macroId">${options([['', t('None')], ...macros.map(m => [m.id, m.name])], a.macroId || '')}</select>
                    <label>${escapeHtml(t('Other'))}</label><div class="inline">
                        <label class="chk"><input type="checkbox" data-p="actions.pause" ${a.pause ? 'checked' : ''}> ${escapeHtml(t('Freeze display'))}</label>
                        <label class="chk"><input type="checkbox" data-p="actions.snapshot" ${a.snapshot ? 'checked' : ''}> ${escapeHtml(t('Save capture snapshot'))}</label>
                        <label class="chk"><input type="checkbox" data-p="actions.disconnect" ${a.disconnect ? 'checked' : ''}> ${escapeHtml(t('Disconnect port'))}</label>
                    </div>
                </div>
                <div class="form-sep">${escapeHtml(t('Test'))}</div>
                <div class="inline"><input class="input mono" data-test placeholder="${escapeHtml(t('Sample frame text'))}"><span class="test-result dim"></span></div>`;
            bindForm(container, tr, onChange);
            const hl = container.querySelector('[data-hl]');
            const color = container.querySelector('[data-p="actions.highlight"]');
            const syncHl = () => {
                color.disabled = !hl.checked;
                a.highlight = hl.checked ? color.value : '';
            };
            hl.addEventListener('change', () => {
                syncHl();
                onChange();
            });
            color.addEventListener('change', syncHl);
            syncHl();
            const test = container.querySelector('[data-test]');
            const result = container.querySelector('.test-result');
            const runTest = () => {
                if (!test.value) {
                    result.textContent = '';
                    return;
                }
                const r = testTrigger(tr, test.value);
                result.textContent = !r.ok ? r.error : r.match ? `${t('Match')}${r.groups.length > 1 ? ': ' + r.groups.slice(1).map((g, i) => `$${i + 1}=${g}`).join(' ') : ''}` : t('No match');
                result.className = `test-result ${r.ok && r.match ? 'ok' : 'err'}`;
            };
            test.addEventListener('input', runTest);
            container.addEventListener('change', runTest);
        }
    });
}

export function openHighlightsEditor(selectedId) {
    listEditor({
        title: t('Highlight rules'),
        width: 820,
        items: getHighlightRules(),
        save: saveHighlightRules,
        selectedId,
        exportName: 'diagterm-highlights.json',
        label: r => r.pattern,
        sublabel: r => `${r.regex ? 'regex' : t('text')} - ${r.scope === 'line' ? t('whole line') : t('match')}`,
        create: () => ({ id: uid(), enabled: true, pattern: 'ERROR', regex: false, caseSensitive: false, color: '#ff5252', background: '', bold: true, scope: 'match' }),
        renderForm: (r, container, onChange) => {
            container.innerHTML = `
                <div class="form-grid wide">
                    <label>${escapeHtml(t('Pattern'))}</label><div class="inline"><input class="input mono" data-p="pattern" value="${escapeHtml(r.pattern)}"><label class="chk"><input type="checkbox" data-p="enabled" ${r.enabled !== false ? 'checked' : ''}> ${escapeHtml(t('Enabled'))}</label></div>
                    <label>${escapeHtml(t('Options'))}</label><div class="inline">
                        <label class="chk"><input type="checkbox" data-p="regex" ${r.regex ? 'checked' : ''}> ${escapeHtml(t('Regex'))}</label>
                        <label class="chk"><input type="checkbox" data-p="caseSensitive" ${r.caseSensitive ? 'checked' : ''}> ${escapeHtml(t('Case sensitive'))}</label>
                        <label class="chk"><input type="checkbox" data-p="bold" ${r.bold ? 'checked' : ''}> ${escapeHtml(t('Bold'))}</label>
                    </div>
                    <label>${escapeHtml(t('Apply to'))}</label><select class="input sm" data-p="scope">${options([['match', t('Matched text')], ['line', t('Whole line')]], r.scope)}</select>
                    <label>${escapeHtml(t('Text color'))}</label><div class="inline"><input type="color" data-p="color" value="${r.color || '#ffffff'}"><button class="btn sm" data-clear="color">${escapeHtml(t('None'))}</button></div>
                    <label>${escapeHtml(t('Background'))}</label><div class="inline"><input type="color" data-p="background" value="${r.background || '#000000'}"><button class="btn sm" data-clear="background">${escapeHtml(t('None'))}</button></div>
                    <label>${escapeHtml(t('Preview'))}</label><div class="hl-preview mono"></div>
                </div>`;
            const preview = container.querySelector('.hl-preview');
            const update = () => {
                const re = compileRule(r);
                const sample = r.pattern && !r.regex ? `Sample line with ${r.pattern} inside` : 'Sample line: ERROR 42 at sensor temp=21.5';
                if (!re) {
                    preview.innerHTML = `<span class="err">${escapeHtml(t('Invalid pattern'))}</span>`;
                    return;
                }
                const style = `${r.color ? `color:${r.color};` : ''}${r.background ? `background:${r.background};` : ''}${r.bold ? 'font-weight:600;' : ''}`;
                if (r.scope === 'line') preview.innerHTML = `<span style="${style}">${escapeHtml(sample)}</span>`;
                else preview.innerHTML = escapeHtml(sample).replace(re, (m) => `<span style="${style}">${m}</span>`);
            };
            bindForm(container, r, () => {
                update();
                onChange();
            });
            container.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-clear]');
                if (!btn) return;
                r[btn.dataset.clear] = '';
                update();
                onChange();
            });
            update();
        }
    });
}

export function openCustomDecodersEditor(selectedId) {
    const checksumOptions = [['', t('None')], ...Object.entries(CHECKSUMS).map(([id, d]) => [id, d.label])];
    listEditor({
        title: t('Custom frame parsers'),
        width: 1040,
        items: getStore('decoders-custom', []) || [],
        save: (list) => saveStore('decoders-custom', list),
        selectedId,
        exportName: 'diagterm-parsers.json',
        label: d => d.name,
        sublabel: d => `${(d.fields || []).length} ${t('fields')}${d.checksum && d.checksum.type ? ' - ' + d.checksum.type : ''}`,
        create: () => ({
            id: uid(),
            name: t('My protocol'),
            sync: 'AA 55',
            lengthField: { offset: 2, type: '', adjust: 0 },
            checksum: { type: 'crc16-modbus', from: 0, endian: '' },
            fields: [
                { name: 'cmd', offset: 3, type: 'u8', scale: 1, unit: '' },
                { name: 'value', offset: 4, type: 'i16le', scale: 0.1, unit: '' }
            ],
            sample: 'AA 55 08 01 D2 04 00 00'
        }),
        renderForm: (d, container, onChange) => {
            d.lengthField = d.lengthField || { offset: 0, type: '', adjust: 0 };
            d.checksum = d.checksum || { type: '', from: 0, endian: '' };
            d.fields = d.fields || [];
            const fieldRows = () => d.fields.map((f, i) => `
                <tr data-i="${i}">
                    <td><input class="input sm" data-f="name" value="${escapeHtml(f.name || '')}"></td>
                    <td><input class="input xs" type="number" data-f="offset" value="${f.offset || 0}" title="${escapeHtml(t('Negative = from the end'))}"></td>
                    <td><select class="input sm" data-f="type">${options(FIELD_TYPES, f.type || 'u8')}</select></td>
                    <td><input class="input xs" type="number" min="1" data-f="length" value="${f.length || 1}" title="${escapeHtml(t('For hex/ascii/bits'))}"></td>
                    <td><input class="input xs" data-f="mask" value="${escapeHtml(f.mask || '')}" placeholder="FF"></td>
                    <td><input class="input xs" type="number" step="any" data-f="scale" value="${f.scale !== undefined ? f.scale : 1}"></td>
                    <td><input class="input xs" type="number" step="any" data-f="offsetValue" value="${f.offsetValue || 0}"></td>
                    <td><input class="input xs" data-f="unit" value="${escapeHtml(f.unit || '')}"></td>
                    <td><button class="icon-btn" data-field-del="${i}">&times;</button></td>
                </tr>`).join('');
            container.innerHTML = `
                <div class="form-grid wide">
                    <label>${escapeHtml(t('Name'))}</label><input class="input" data-p="name" value="${escapeHtml(d.name)}">
                    <label>${escapeHtml(t('Sync bytes (hex)'))}</label><input class="input mono" data-p="sync" value="${escapeHtml(d.sync || '')}" placeholder="${escapeHtml(t('optional, e.g. AA 55'))}">
                    <label>${escapeHtml(t('Length field'))}</label><div class="inline">
                        <select class="input sm" data-p="lengthField.type">${options([['', t('None')], ...FIELD_TYPES.filter(x => /^u(8|16|32)/.test(x)).map(x => [x, x])], d.lengthField.type || '')}</select>
                        <span>${escapeHtml(t('at offset'))}</span><input class="input xs" type="number" min="0" data-p="lengthField.offset" value="${d.lengthField.offset || 0}">
                        <span>${escapeHtml(t('total = value +'))}</span><input class="input xs" type="number" data-p="lengthField.adjust" value="${d.lengthField.adjust || 0}">
                    </div>
                    <label>${escapeHtml(t('Checksum (trailing)'))}</label><div class="inline">
                        <select class="input sm" data-p="checksum.type">${options(checksumOptions, d.checksum.type || '')}</select>
                        <span>${escapeHtml(t('computed from byte'))}</span><input class="input xs" type="number" min="0" data-p="checksum.from" value="${d.checksum.from || 0}">
                        <select class="input sm" data-p="checksum.endian">${options([['', t('Default endianness')], ['le', 'Little-endian'], ['be', 'Big-endian']], d.checksum.endian || '')}</select>
                    </div>
                </div>
                <div class="form-sep">${escapeHtml(t('Fields'))}</div>
                <table class="grid-table">
                    <tr><th>${escapeHtml(t('Name'))}</th><th>${escapeHtml(t('Offset'))}</th><th>${escapeHtml(t('Type'))}</th><th>${escapeHtml(t('Len'))}</th><th>${escapeHtml(t('Mask'))}</th><th>${escapeHtml(t('Scale'))}</th><th>${escapeHtml(t('Add'))}</th><th>${escapeHtml(t('Unit'))}</th><th></th></tr>
                    <tbody class="fields-body">${fieldRows()}</tbody>
                </table>
                <button class="btn sm" data-field-add>${escapeHtml(t('Add field'))}</button>
                <div class="form-sep">${escapeHtml(t('Test with a sample frame'))}</div>
                <div class="inline"><input class="input mono" data-p="sample" value="${escapeHtml(d.sample || '')}" placeholder="hex"><button class="btn sm" data-fix-cs>${escapeHtml(t('Append checksum'))}</button></div>
                <div class="decode-test"></div>`;
            const testEl = container.querySelector('.decode-test');
            const runTest = () => {
                let bytes;
                try {
                    bytes = parseHexString(d.sample || '');
                } catch (error) {
                    testEl.innerHTML = `<span class="err">${escapeHtml(error.message)}</span>`;
                    return;
                }
                if (!bytes.length) {
                    testEl.innerHTML = '';
                    return;
                }
                const r = decodeCustom(bytes, d);
                testEl.innerHTML = `<div class="${r.ok ? 'ok' : 'err'}">${escapeHtml(r.summary || r.error || '')}</div>
                    <table class="kv">${(r.fields || []).map(f => `<tr class="${f.ok === false ? 'bad' : f.ok ? 'ok' : ''}"><th>${escapeHtml(f.name)}</th><td>${escapeHtml(f.value)}</td></tr>`).join('')}</table>`;
            };
            bindForm(container, d, () => {
                runTest();
                onChange();
            });
            const body = container.querySelector('.fields-body');
            body.addEventListener('change', (e) => {
                const row = e.target.closest('[data-i]');
                const key = e.target.dataset.f;
                if (!row || !key) return;
                const field = d.fields[parseInt(row.dataset.i, 10)];
                field[key] = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
                runTest();
                onChange();
            });
            container.addEventListener('click', (e) => {
                if (e.target.closest('[data-field-add]')) {
                    d.fields.push({ name: `field${d.fields.length + 1}`, offset: 0, type: 'u8', scale: 1, unit: '' });
                    body.innerHTML = fieldRows();
                    onChange();
                }
                const del = e.target.closest('[data-field-del]');
                if (del) {
                    d.fields.splice(parseInt(del.dataset.fieldDel, 10), 1);
                    body.innerHTML = fieldRows();
                    runTest();
                    onChange();
                }
                if (e.target.closest('[data-fix-cs]') && d.checksum.type) {
                    try {
                        const bytes = parseHexString(d.sample || '');
                        const le = d.checksum.endian ? d.checksum.endian === 'le' : undefined;
                        const cs = checksumBytes(d.checksum.type, bytes, Math.min(bytes.length, parseInt(d.checksum.from, 10) || 0), bytes.length, le);
                        d.sample = toHex(new Uint8Array([...bytes, ...cs]));
                        container.querySelector('[data-p="sample"]').value = d.sample;
                        runTest();
                        onChange();
                    } catch (error) {
                        toast(error.message, { type: 'error' });
                    }
                }
            });
            runTest();
        }
    });
}
