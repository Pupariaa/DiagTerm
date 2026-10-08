import { loadStore, getStore, saveStore } from '../core/store.js';
import { getSetting } from '../core/settings.js';
import { onEvent, emit } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { escapeHtml } from '../core/dom.js';
import { openModal, toast, promptDialog, confirmDialog } from '../core/dialogs.js';
import { invoke } from '../core/api.js';
import { allSessions, activeSession, createSession, removeSession, setActive } from '../serial/sessions.js';
import { getPorts } from '../serial/ports.js';
import { getLayoutState, setLayoutState } from '../ui/workspace.js';
import { getTabView } from '../ui/tab-view.js';

let lastSaved = '';
let restoring = false;

function snapshot() {
    const sessions = allSessions().filter(s => s.kind === 'serial').map(s => s.toConfig());
    const active = activeSession();
    return {
        version: 1,
        savedAt: Date.now(),
        sessions,
        layout: getLayoutState(),
        activeId: active ? active.id : null
    };
}

export function saveSessionNow() {
    if (restoring) return;
    const snap = snapshot();
    const { savedAt, ...rest } = snap;
    const key = JSON.stringify(rest);
    if (key === lastSaved) return;
    lastSaved = key;
    saveStore('session', snap);
}

async function applySnapshot(snap, { reopen = true, replace = false } = {}) {
    if (!snap || !Array.isArray(snap.sessions)) return;
    restoring = true;
    try {
        if (replace) {
            for (const s of allSessions().slice()) await removeSession(s.id);
        }
        const existingIds = new Set(allSessions().map(s => s.id));
        const created = [];
        for (const config of snap.sessions) {
            const cfg = { ...config };
            if (existingIds.has(cfg.id)) delete cfg.id;
            created.push(createSession(cfg, { activate: false }));
        }
        if (snap.layout) setLayoutState(snap.layout);
        const target = created.find(s => s.id === snap.activeId) || created[0];
        if (target) setActive(target.id);
        if (reopen) {
            const available = new Set(getPorts().map(p => p.path));
            for (const s of created) {
                if (!s.wasOpen || !s.path) continue;
                if (available.has(s.path)) {
                    const view = getTabView(s.id);
                    try {
                        if (view) await view.connect();
                        else await s.open();
                    } catch (error) {
                        console.error(`Failed to reopen ${s.path}:`, error.message);
                    }
                } else if (s.autoReconnect) {
                    s.addSystem(t('{port} not present: waiting for the device', { port: s.path }), 'warn');
                }
            }
        }
    } finally {
        restoring = false;
    }
    saveSessionNow();
}

export async function restoreSession() {
    const snap = await loadStore('session', null);
    if (!getSetting('general.restoreSession', true) || !snap || !snap.sessions || !snap.sessions.length) return false;
    await applySnapshot(snap, { reopen: true });
    return allSessions().length > 0;
}

export function initSessionPersistence() {
    const mark = () => setTimeout(saveSessionNow, 0);
    onEvent('sessions:changed', mark);
    onEvent('session:active', mark);
    onEvent('workspace:changed', mark);
    onEvent('session:created', (session) => {
        for (const evt of ['options', 'framing', 'view', 'auto-reconnect', 'logging', 'path', 'state', 'history']) {
            session.on(evt, mark);
        }
    });
    setInterval(saveSessionNow, 5000);
    window.addEventListener('beforeunload', saveSessionNow);
}

export function getWorkspaces() {
    return getStore('workspaces', []) || [];
}

function saveWorkspaces(list) {
    saveStore('workspaces', list);
    emit('workspaces:changed', list);
}

export async function saveWorkspaceAs(existingName) {
    const name = existingName || await promptDialog({ title: t('Save workspace'), label: t('Workspace name'), value: '' });
    if (!name || !name.trim()) return;
    const list = getWorkspaces().filter(w => w.name !== name.trim());
    list.push({ name: name.trim(), savedAt: Date.now(), snapshot: snapshot() });
    list.sort((a, b) => a.name.localeCompare(b.name));
    saveWorkspaces(list);
    toast(t('Workspace "{name}" saved', { name: name.trim() }), { type: 'success' });
}

export async function loadWorkspace(name, { reopen = true } = {}) {
    const ws = getWorkspaces().find(w => w.name === name);
    if (!ws) return;
    if (allSessions().some(s => s.isOpen)) {
        const ok = await confirmDialog(t('Loading a workspace closes the current tabs. Continue?'), { okLabel: t('Load') });
        if (!ok) return;
    }
    await applySnapshot(ws.snapshot, { reopen, replace: true });
    toast(t('Workspace "{name}" loaded', { name }), { type: 'success' });
}

export function openWorkspaces() {
    let modal;
    const render = () => {
        const list = getWorkspaces();
        modal.setBody(`
            <div class="ws-list">
                ${list.length ? list.map(w => `
                    <div class="ws-row" data-name="${escapeHtml(w.name)}">
                        <div class="ws-info">
                            <b>${escapeHtml(w.name)}</b>
                            <div class="dim">${escapeHtml(t('{n} tabs', { n: (w.snapshot.sessions || []).length }))} - ${escapeHtml((w.snapshot.sessions || []).map(s => s.title || s.path || '?').join(', '))}</div>
                            <div class="dim small">${escapeHtml(new Date(w.savedAt).toLocaleString())}</div>
                        </div>
                        <div class="ws-actions">
                            <button class="btn sm btn-primary" data-ws="load">${escapeHtml(t('Load'))}</button>
                            <button class="btn sm" data-ws="load-closed">${escapeHtml(t('Load without connecting'))}</button>
                            <button class="btn sm" data-ws="overwrite">${escapeHtml(t('Overwrite'))}</button>
                            <button class="btn sm" data-ws="rename">${escapeHtml(t('Rename'))}</button>
                            <button class="btn sm btn-danger" data-ws="delete">${escapeHtml(t('Delete'))}</button>
                        </div>
                    </div>`).join('') : `<div class="dim">${escapeHtml(t('No saved workspace. A workspace stores every tab with its port, serial settings, view and layout.'))}</div>`}
            </div>`);
    };
    modal = openModal({
        title: t('Workspaces'),
        width: 760,
        body: '',
        buttons: [
            { label: t('Import...'), left: true, keepOpen: true, action: async () => {
                const file = await invoke('files:select-file', [{ name: 'JSON', extensions: ['json'] }]);
                const filePath = Array.isArray(file) ? file[0] : file;
                if (!filePath) return false;
                const res = await invoke('files:read-text', filePath);
                if (!res.success) return false;
                try {
                    const data = JSON.parse(res.content);
                    const incoming = Array.isArray(data) ? data : [data];
                    const list = getWorkspaces();
                    for (const w of incoming) {
                        if (!w || !w.name || !w.snapshot) continue;
                        const idx = list.findIndex(x => x.name === w.name);
                        if (idx >= 0) list[idx] = w;
                        else list.push(w);
                    }
                    saveWorkspaces(list);
                    render();
                } catch (error) {
                    toast(t('Invalid workspace file'), { type: 'error' });
                }
                return false;
            } },
            { label: t('Export...'), left: true, keepOpen: true, action: async () => {
                await invoke('files:save-text', JSON.stringify(getWorkspaces(), null, 2), 'json', 'diagterm-workspaces.json');
                return false;
            } },
            { label: t('Save current as...'), keepOpen: true, action: async () => {
                await saveWorkspaceAs();
                render();
                return false;
            } },
            { label: t('Close'), primary: true }
        ]
    });
    modal.body.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-ws]');
        if (!btn) return;
        const name = btn.closest('.ws-row').dataset.name;
        switch (btn.dataset.ws) {
            case 'load':
                modal.close();
                await loadWorkspace(name, { reopen: true });
                break;
            case 'load-closed':
                modal.close();
                await loadWorkspace(name, { reopen: false });
                break;
            case 'overwrite':
                await saveWorkspaceAs(name);
                render();
                break;
            case 'rename': {
                const next = await promptDialog({ title: t('Rename workspace'), label: t('Workspace name'), value: name });
                if (!next || !next.trim()) return;
                const list = getWorkspaces();
                const ws = list.find(w => w.name === name);
                if (ws) ws.name = next.trim();
                saveWorkspaces(list);
                render();
                break;
            }
            case 'delete': {
                const ok = await confirmDialog(t('Delete workspace "{name}"?', { name }), { danger: true, okLabel: t('Delete') });
                if (!ok) return;
                saveWorkspaces(getWorkspaces().filter(w => w.name !== name));
                render();
                break;
            }
            default: break;
        }
    });
    render();
}

export async function initWorkspaces() {
    await loadStore('workspaces', []);
}
