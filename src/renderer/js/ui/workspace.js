import { el, escapeHtml } from '../core/dom.js';
import { onEvent, emit } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { contextMenu, promptDialog, confirmDialog } from '../core/dialogs.js';
import { allSessions, activeSession, setActive, createSession, removeSession, moveSession, getSession } from '../serial/sessions.js';
import { getPorts, sortPorts, portLabel, refreshPorts } from '../serial/ports.js';
import { TabView, getTabView } from './tab-view.js';
import { icon } from './icons.js';
import { setTimelineSync, isTimelineSync } from './timeline.js';
import { openCaptureFile } from '../features/capture-files.js';
import { openComnex } from '../features/comnex.js';
import { runCommand } from '../core/commands.js';

const LAYOUTS = { single: 1, cols: 2, rows: 2, grid: 4 };

let root;
let tabbar;
let panesEl;
let layout = 'single';
let panes = [null];
let focused = 0;
const tabViews = new Map();

export function getLayoutState() {
    return { layout, panes: panes.slice(), focused };
}

export function setLayoutState(state) {
    if (!state || !LAYOUTS[state.layout]) return;
    layout = state.layout;
    panes = new Array(LAYOUTS[layout]).fill(null).map((_, i) => (state.panes && state.panes[i] && getSession(state.panes[i]) ? state.panes[i] : null));
    focused = Math.min(state.focused || 0, panes.length - 1);
    renderPanes();
}

function viewFor(session) {
    let view = tabViews.get(session.id);
    if (!view) {
        view = new TabView(session);
        tabViews.set(session.id, view);
    }
    return view;
}

export function setLayout(next) {
    if (!LAYOUTS[next]) return;
    const count = LAYOUTS[next];
    const sessions = allSessions();
    const current = panes.filter(Boolean);
    const out = [];
    for (let i = 0; i < count; i++) {
        if (current[i]) out.push(current[i]);
        else {
            const candidate = sessions.find(s => !out.includes(s.id) && !current.includes(s.id));
            out.push(candidate ? candidate.id : null);
        }
    }
    layout = next;
    panes = out;
    focused = Math.min(focused, count - 1);
    renderPanes();
    renderTabbar();
    emit('workspace:changed');
}

function showInFocused(sessionId) {
    const existing = panes.indexOf(sessionId);
    if (existing >= 0) {
        focused = existing;
    } else {
        panes[focused] = sessionId;
    }
    renderPanes();
    renderTabbar();
}

function renderTabbar() {
    const sessions = allSessions();
    const active = activeSession();
    const tabs = sessions.map(s => {
        const paneIdx = panes.indexOf(s.id);
        return `
            <div class="tab ${active && active.id === s.id ? 'active' : ''} ${paneIdx >= 0 ? 'shown' : ''} kind-${s.kind}" data-id="${s.id}" draggable="true" title="${escapeHtml(s.path || s.displayName)}">
                <span class="tab-dot st-${s.state}"></span>
                ${s.kind === 'replay' ? icon('replay', 12) : s.kind === 'bridge' ? icon('bridge', 12) : ''}
                <span class="tab-name">${escapeHtml(s.displayName)}</span>
                ${s.title && s.path && s.kind === 'serial' ? `<span class="tab-port">${escapeHtml(s.path)}</span>` : ''}
                ${layout !== 'single' && paneIdx >= 0 ? `<span class="tab-pane">${paneIdx + 1}</span>` : ''}
                <span class="tab-close" data-close="${s.id}" title="${escapeHtml(t('Close tab (Ctrl+W)'))}">${icon('close', 12)}</span>
            </div>`;
    }).join('');
    tabbar.innerHTML = `
        <div class="tabs">${tabs}<button class="tab-new" data-act="new" title="${escapeHtml(t('New tab (Ctrl+T)'))}">${icon('plus', 14)}</button></div>
        <div class="tabbar-actions">
            <button class="tb-btn icon-only ${layout === 'single' ? 'active' : ''}" data-layout="single" title="${escapeHtml(t('Single view'))}">${icon('single', 14)}</button>
            <button class="tb-btn icon-only ${layout === 'cols' ? 'active' : ''}" data-layout="cols" title="${escapeHtml(t('Split vertically'))}">${icon('split', 14)}</button>
            <button class="tb-btn icon-only ${layout === 'rows' ? 'active' : ''}" data-layout="rows" title="${escapeHtml(t('Split horizontally'))}">${icon('rows', 14)}</button>
            <button class="tb-btn icon-only ${layout === 'grid' ? 'active' : ''}" data-layout="grid" title="${escapeHtml(t('Four panes'))}">${icon('grid', 14)}</button>
            <button class="tb-btn ${isTimelineSync() ? 'active' : ''}" data-act="sync" title="${escapeHtml(t('Synchronize timelines across panes'))}">${escapeHtml(t('Sync'))}</button>
        </div>`;
}

function welcomeHtml() {
    const ports = sortPorts(getPorts());
    return `
        <div class="welcome">
            <div class="welcome-inner">
                <h1>DiagTerm</h1>
                <p class="dim">${escapeHtml(t('Serial terminal, protocol analyzer and multi-board flasher'))}</p>
                <div class="welcome-actions">
                    <button class="btn btn-primary" data-w="new">${icon('plus')}<span>${escapeHtml(t('New terminal'))}</span></button>
                    <button class="btn" data-w="capture">${icon('replay')}<span>${escapeHtml(t('Open capture'))}</span></button>
                    <button class="btn" data-w="flash">${icon('flash')}<span>${escapeHtml(t('Flash boards'))}</span></button>
                    <button class="btn" data-w="comnex">${icon('usb')}<span>COMNEX</span></button>
                    <button class="btn" data-w="palette">${icon('palette')}<span>${escapeHtml(t('Command palette'))}</span><kbd>Ctrl+Shift+P</kbd></button>
                </div>
                <h3>${escapeHtml(t('Detected ports'))} <button class="tb-btn icon-only" data-w="refresh">${icon('refresh', 14)}</button></h3>
                <div class="welcome-ports">
                    ${ports.length ? ports.map(p => `
                        <div class="welcome-port" data-port="${escapeHtml(p.path)}">
                            ${icon('usb', 18)}
                            <div><b>${escapeHtml(p.path)}</b><div class="dim">${escapeHtml(portLabel(p).split(' - ').slice(1).join(' - ') || t('Serial port'))}</div></div>
                            <button class="btn sm" data-open="${escapeHtml(p.path)}">${escapeHtml(t('Open'))}</button>
                        </div>`).join('') : `<div class="dim">${escapeHtml(t('No serial port detected. Plug a device: it will appear here automatically.'))}</div>`}
                </div>
            </div>
        </div>`;
}

function renderPanes() {
    panesEl.className = `panes layout-${layout}`;
    const sessions = allSessions();
    if (!sessions.length) {
        for (const view of tabViews.values()) view.root.remove();
        panesEl.innerHTML = welcomeHtml();
        return;
    }
    panes = panes.map(id => (id && getSession(id) ? id : null));
    for (let i = 0; i < panes.length; i++) {
        if (!panes[i]) {
            const candidate = sessions.find(s => !panes.includes(s.id));
            panes[i] = candidate ? candidate.id : null;
        }
    }
    const existing = Array.from(panesEl.querySelectorAll(':scope > .pane'));
    if (existing.length !== panes.length || panesEl.querySelector('.welcome')) {
        for (const view of tabViews.values()) view.root.remove();
        panesEl.innerHTML = panes.map((_, i) => `<div class="pane" data-pane="${i}"><div class="pane-body"></div></div>`).join('');
    }
    panes.forEach((id, i) => {
        const pane = panesEl.querySelector(`.pane[data-pane="${i}"]`);
        const body = pane.querySelector('.pane-body');
        pane.classList.toggle('focused', i === focused && panes.length > 1);
        const session = id ? getSession(id) : null;
        const current = body.firstElementChild;
        if (!session) {
            if (current) current.remove();
            body.innerHTML = `<div class="pane-empty dim">${escapeHtml(t('Click a tab to show it here'))}</div>`;
            return;
        }
        const view = viewFor(session);
        if (current !== view.root) {
            body.innerHTML = '';
            body.appendChild(view.root);
            requestAnimationFrame(() => {
                view.terminal.relayout();
            });
        }
    });
    const focusedId = panes[focused];
    if (focusedId && (!activeSession() || activeSession().id !== focusedId)) setActive(focusedId);
}

async function closeTab(id) {
    const session = getSession(id);
    if (!session) return;
    if (session.isOpen && session.kind === 'serial') {
        const ok = await confirmDialog(t('Close {name}? The port will be disconnected.', { name: session.displayName }), { okLabel: t('Close') });
        if (!ok) return;
    }
    await removeSession(id);
}

export function newTab(config = {}) {
    const used = new Set(allSessions().map(s => s.path));
    if (!config.path && config.autoPort !== false) {
        const free = sortPorts(getPorts()).find(p => !used.has(p.path));
        if (free) config.path = free.path;
    }
    return createSession(config);
}

function showTabMenu(id, x, y) {
    const session = getSession(id);
    if (!session) return;
    const items = [
        { label: session.isOpen ? t('Disconnect') : t('Connect'), disabled: session.isVirtual, action: () => getTabView(id) && getTabView(id).toggleConnection() },
        {
            label: t('Rename...'), action: async () => {
                const name = await promptDialog({ title: t('Rename tab'), label: t('Tab title (empty for port name)'), value: session.title });
                if (name === null) return;
                session.title = name.trim();
                emit('sessions:changed', allSessions());
            }
        },
        { label: t('Duplicate settings in a new tab'), action: () => newTab({ ...session.toConfig(), id: undefined, path: '', wasOpen: false, title: '' }) },
        { separator: true }
    ];
    if (layout !== 'single') {
        for (let i = 0; i < panes.length; i++) {
            items.push({ label: t('Show in pane {n}', { n: i + 1 }), action: () => {
                focused = i;
                showInFocused(id);
            } });
        }
        items.push({ separator: true });
    }
    items.push({ label: t('Close'), shortcut: 'Ctrl+W', action: () => closeTab(id) });
    items.push({ label: t('Close other tabs'), action: async () => {
        for (const s of allSessions().slice()) if (s.id !== id) await closeTab(s.id);
    } });
    contextMenu(x, y, items);
}

export function initWorkspace(host) {
    root = host;
    root.innerHTML = '';
    tabbar = el('<div class="tabbar"></div>');
    panesEl = el('<div class="panes layout-single"></div>');
    root.appendChild(tabbar);
    root.appendChild(panesEl);

    tabbar.addEventListener('click', (e) => {
        const close = e.target.closest('[data-close]');
        if (close) {
            e.stopPropagation();
            closeTab(close.dataset.close);
            return;
        }
        const lay = e.target.closest('[data-layout]');
        if (lay) {
            setLayout(lay.dataset.layout);
            return;
        }
        const act = e.target.closest('[data-act]');
        if (act && act.dataset.act === 'new') {
            newTab();
            return;
        }
        if (act && act.dataset.act === 'sync') {
            setTimelineSync(!isTimelineSync());
            renderTabbar();
            return;
        }
        const tab = e.target.closest('.tab');
        if (tab) {
            setActive(tab.dataset.id);
            showInFocused(tab.dataset.id);
        }
    });
    tabbar.addEventListener('auxclick', (e) => {
        const tab = e.target.closest('.tab');
        if (tab && e.button === 1) closeTab(tab.dataset.id);
    });
    tabbar.addEventListener('dblclick', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab && e.target.closest('.tabs')) newTab();
    });
    tabbar.addEventListener('contextmenu', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        e.preventDefault();
        showTabMenu(tab.dataset.id, e.clientX, e.clientY);
    });
    let dragId = null;
    tabbar.addEventListener('dragstart', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        dragId = tab.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
    });
    tabbar.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
    });
    tabbar.addEventListener('drop', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const tab = e.target.closest('.tab');
        if (tab && tab.dataset.id !== dragId) {
            const idx = allSessions().findIndex(s => s.id === tab.dataset.id);
            moveSession(dragId, idx);
        }
        dragId = null;
    });
    panesEl.addEventListener('dragover', (e) => {
        if (dragId) e.preventDefault();
    });
    panesEl.addEventListener('drop', (e) => {
        if (!dragId) return;
        const pane = e.target.closest('.pane');
        if (pane) {
            e.preventDefault();
            focused = parseInt(pane.dataset.pane, 10);
            showInFocused(dragId);
        }
        dragId = null;
    });
    panesEl.addEventListener('mousedown', (e) => {
        const pane = e.target.closest('.pane');
        if (!pane) return;
        const idx = parseInt(pane.dataset.pane, 10);
        if (idx !== focused) {
            focused = idx;
            if (panes[idx]) setActive(panes[idx]);
            renderPanes();
            renderTabbar();
        }
    }, true);
    panesEl.addEventListener('click', async (e) => {
        const w = e.target.closest('[data-w]');
        if (w) {
            switch (w.dataset.w) {
                case 'new': newTab(); break;
                case 'capture': openCaptureFile(); break;
                case 'flash': runCommand('view.flash'); break;
                case 'comnex': openComnex(); break;
                case 'palette': runCommand('palette.open'); break;
                case 'refresh': refreshPorts(); break;
                default: break;
            }
            return;
        }
        const open = e.target.closest('[data-open]');
        if (open) {
            const s = newTab({ path: open.dataset.open });
            const view = getTabView(s.id);
            if (view) view.connect();
            else setTimeout(() => { const v = getTabView(s.id); if (v) v.connect(); }, 0);
        }
    });

    onEvent('session:created', (session) => {
        if (layout === 'single' || !panes.includes(null)) panes[focused] = session.id;
        else panes[panes.indexOf(null)] = session.id;
        renderPanes();
        renderTabbar();
    });
    onEvent('session:removed', (session) => {
        const view = tabViews.get(session.id);
        if (view) {
            view.dispose();
            tabViews.delete(session.id);
        }
        panes = panes.map(id => (id === session.id ? null : id));
        renderPanes();
        renderTabbar();
    });
    onEvent('session:active', (session) => {
        if (session && !panes.includes(session.id)) panes[focused] = session.id;
        if (session) focused = Math.max(0, panes.indexOf(session.id));
        renderPanes();
        renderTabbar();
    });
    onEvent('sessions:changed', () => renderTabbar());
    onEvent('session:state', () => renderTabbar());
    onEvent('ports:changed', () => {
        if (!allSessions().length) renderPanes();
    });
    onEvent('timeline:sync-mode', () => renderTabbar());
    renderTabbar();
    renderPanes();
}

export function focusedTabView() {
    const s = activeSession();
    return s ? getTabView(s.id) : null;
}

export function cycleTab(delta) {
    const sessions = allSessions();
    if (!sessions.length) return;
    const active = activeSession();
    const idx = active ? sessions.findIndex(s => s.id === active.id) : -1;
    const next = sessions[(idx + delta + sessions.length) % sessions.length];
    setActive(next.id);
    showInFocused(next.id);
}

export function closeActiveTab() {
    const s = activeSession();
    if (s) closeTab(s.id);
}
