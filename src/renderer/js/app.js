import { invoke, on, setZoomFactor } from './core/api.js';
import { onEvent, emit } from './core/bus.js';
import { loadSettings, getSetting, setSetting } from './core/settings.js';
import { t } from './core/i18n.js';
import { escapeHtml } from './core/dom.js';
import { registerCommand, handleGlobalKey } from './core/commands.js';
import { closeTopModal, topModal, closePopover, confirmDialog, toast } from './core/dialogs.js';
import { initClock } from './serial/clock.js';
import { initPorts } from './serial/ports.js';
import { initSessions, allSessions, activeSession } from './serial/sessions.js';
import { initHighlights } from './features/highlight.js';
import { initTriggers, setTriggerRunners } from './features/triggers.js';
import { initMacros, setMacroContext, runMacro } from './features/macros.js';
import { initBridges, openBridges } from './features/bridges.js';
import { initDecoders } from './ui/decoder-panel.js';
import { notify } from './features/notify.js';
import { snapshotCapture, openCaptureFile } from './features/capture-files.js';
import { openMacrosEditor, openTriggersEditor, openHighlightsEditor, openCustomDecodersEditor } from './features/editors.js';
import { openStats } from './features/stats.js';
import { openCompare } from './features/compare.js';
import { openComnex } from './features/comnex.js';
import { openExportModal } from './features/export.js';
import { openSendFileModal } from './features/send-file.js';
import { initUpdates, openAbout, checkForUpdates, getAppVersion } from './features/about.js';
import { initSessionPersistence, restoreSession, saveSessionNow, openWorkspaces, saveWorkspaceAs, initWorkspaces } from './features/workspaces.js';
import { initWorkspace, newTab, cycleTab, closeActiveTab, setLayout, focusedTabView } from './ui/workspace.js';
import { initStatusbar } from './ui/statusbar.js';
import { openPalette, closePalette, isPaletteOpen } from './ui/palette.js';
import { initSettingsView, refreshSettingsView } from './ui/settings-view.js';
import { setTimelineSync, isTimelineSync } from './ui/timeline.js';
import { icon } from './ui/icons.js';

let currentView = 'terminal';
let flashInitialized = false;
let flashModule = null;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
    const pref = getSetting('general.theme', 'dark');
    const theme = pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;
    const rootEl = document.documentElement;
    rootEl.dataset.theme = theme;
    const accent = getSetting('general.accentColor', '');
    if (accent) rootEl.style.setProperty('--accent', accent);
    else rootEl.style.removeProperty('--accent');
    const vars = {
        '--rx-text': getSetting('terminal.rxColor', ''),
        '--tx-text': getSetting('terminal.txColor', ''),
        '--rx': getSetting('timeline.rxColor', ''),
        '--tx': getSetting('timeline.txColor', ''),
        '--marker': getSetting('timeline.markerColor', '')
    };
    for (const [k, v] of Object.entries(vars)) {
        if (v && theme !== 'high-contrast') rootEl.style.setProperty(k, v);
        else rootEl.style.removeProperty(k);
    }
    setZoomFactor((Number(getSetting('general.uiScale', 100)) || 100) / 100);
    rootEl.lang = getSetting('general.language', 'en');
    emit('theme:changed', theme);
}

async function ensureFlash() {
    if (!flashModule) flashModule = await import('./flash/flash-view.js');
    if (!flashInitialized) {
        flashInitialized = true;
        await flashModule.initFlashView(document.getElementById('view-flash'));
    }
    return flashModule;
}

export async function showView(view) {
    if (view === currentView && view !== 'flash') return;
    currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    closePopover();
    if (view === 'flash') {
        const mod = await ensureFlash();
        mod.onFlashViewShown();
    } else if (view === 'settings') {
        refreshSettingsView();
    } else if (view === 'terminal') {
        const v = focusedTabView();
        if (v) requestAnimationFrame(() => v.terminal.relayout());
    }
    emit('view:changed', view);
}

function withTab(fn) {
    return () => {
        const v = focusedTabView();
        if (!v) return;
        if (currentView !== 'terminal') showView('terminal');
        fn(v, v.session);
    };
}

function hasTab() {
    return !!focusedTabView();
}

function registerCommands() {
    const cmds = [
        { id: 'palette.open', title: 'Command palette', category: 'General', key: 'Ctrl+Shift+P', run: () => openPalette() },
        { id: 'view.terminal', title: 'Show terminals', category: 'View', key: 'Ctrl+1', run: () => showView('terminal') },
        { id: 'view.flash', title: 'Show flash', category: 'View', key: 'Ctrl+2', run: () => showView('flash') },
        { id: 'view.settings', title: 'Show settings', category: 'View', key: 'Ctrl+,', run: () => showView('settings') },
        {
            id: 'flash.board-manager', title: 'Board manager', category: 'Flash', run: async () => {
                await showView('flash');
                flashModule.switchTab('boards');
            }
        },
        {
            id: 'flash.jobs', title: 'Flash jobs', category: 'Flash', run: async () => {
                await showView('flash');
                flashModule.switchTab('jobs');
            }
        },
        {
            id: 'flash.partitions', title: 'Partition editor', category: 'Flash', run: async () => {
                await showView('flash');
                flashModule.switchTab('partitions');
            }
        },
        {
            id: 'flash.filesystem', title: 'Filesystem upload and download', category: 'Flash', run: async () => {
                await showView('flash');
                flashModule.switchTab('fs');
            }
        },
        {
            id: 'flash.tools', title: 'Chip tools (info, erase, read flash)', category: 'Flash', run: async () => {
                await showView('flash');
                flashModule.switchTab('tools');
            }
        },
        { id: 'tab.new', title: 'New terminal tab', category: 'Tabs', key: 'Ctrl+T', run: () => { showView('terminal'); newTab(); } },
        { id: 'tab.new-alt', title: 'New terminal tab', category: 'Tabs', key: 'Ctrl+N', hidden: true, run: () => { showView('terminal'); newTab(); } },
        { id: 'tab.close', title: 'Close tab', category: 'Tabs', key: 'Ctrl+W', enabled: hasTab, run: () => closeActiveTab() },
        { id: 'tab.next', title: 'Next tab', category: 'Tabs', key: 'Ctrl+Tab', enabled: hasTab, run: () => cycleTab(1) },
        { id: 'tab.prev', title: 'Previous tab', category: 'Tabs', key: 'Ctrl+Shift+Tab', enabled: hasTab, run: () => cycleTab(-1) },
        { id: 'tab.connect', title: 'Connect / disconnect', category: 'Tabs', key: 'Ctrl+Shift+C', enabled: hasTab, run: withTab(v => v.toggleConnection()) },
        { id: 'tab.reset', title: 'Reset board (DTR/RTS pulse)', category: 'Tabs', key: 'Ctrl+Shift+R', enabled: hasTab, run: withTab(v => v.action('reset')) },
        { id: 'tab.auto-reconnect', title: 'Toggle automatic reconnection', category: 'Tabs', enabled: hasTab, run: withTab(v => v.action('auto-reconnect')) },
        { id: 'layout.single', title: 'Layout: single', category: 'Layout', run: () => setLayout('single') },
        { id: 'layout.cols', title: 'Layout: two columns', category: 'Layout', key: 'Ctrl+Alt+2', run: () => setLayout('cols') },
        { id: 'layout.rows', title: 'Layout: two rows', category: 'Layout', run: () => setLayout('rows') },
        { id: 'layout.grid', title: 'Layout: four panes', category: 'Layout', key: 'Ctrl+Alt+4', run: () => setLayout('grid') },
        { id: 'layout.sync', title: 'Toggle timeline synchronization', category: 'Layout', run: () => setTimelineSync(!isTimelineSync()) },
        { id: 'term.search', title: 'Search in logs', category: 'Terminal', key: 'Ctrl+F', enabled: hasTab, run: withTab(v => v.focusSearch()) },
        { id: 'term.search-next', title: 'Next match', category: 'Terminal', key: 'F3', enabled: hasTab, run: withTab(v => v.action('search-next')) },
        { id: 'term.search-prev', title: 'Previous match', category: 'Terminal', key: 'Shift+F3', enabled: hasTab, run: withTab(v => v.action('search-prev')) },
        { id: 'term.focus-send', title: 'Focus send box', category: 'Terminal', key: 'Ctrl+L', enabled: hasTab, run: withTab(v => v.focusSend()) },
        { id: 'term.clear', title: 'Clear terminal', category: 'Terminal', key: 'Ctrl+K', enabled: hasTab, run: withTab(v => v.action('clear')) },
        { id: 'term.marker', title: 'Insert marker', category: 'Terminal', key: 'Ctrl+M', enabled: hasTab, run: withTab(v => v.action('marker')) },
        { id: 'term.follow', title: 'Toggle auto-scroll', category: 'Terminal', key: 'Ctrl+End', enabled: hasTab, run: withTab(v => v.action('follow')) },
        { id: 'term.pause', title: 'Freeze / resume display', category: 'Terminal', key: 'Ctrl+Shift+Space', enabled: hasTab, run: withTab(v => v.action('pause')) },
        { id: 'term.wrap', title: 'Toggle line wrap', category: 'Terminal', key: 'Alt+Z', enabled: hasTab, run: withTab(v => v.action('wrap')) },
        { id: 'term.control-chars', title: 'Toggle control characters', category: 'Terminal', enabled: hasTab, run: withTab(v => v.action('control-chars')) },
        { id: 'term.view-ascii', title: 'View as text', category: 'Terminal', key: 'Alt+1', enabled: hasTab, run: withTab((v, s) => s.updateView({ viewMode: 'ascii' })) },
        { id: 'term.view-hex', title: 'View as hex', category: 'Terminal', key: 'Alt+2', enabled: hasTab, run: withTab((v, s) => s.updateView({ viewMode: 'hex' })) },
        { id: 'term.view-mixed', title: 'View as hex dump', category: 'Terminal', key: 'Alt+3', enabled: hasTab, run: withTab((v, s) => s.updateView({ viewMode: 'mixed' })) },
        {
            id: 'term.timestamps', title: 'Cycle timestamp mode', category: 'Terminal', key: 'Ctrl+Shift+T', enabled: hasTab, run: withTab((v, s) => {
                const modes = [['none', 'No time'], ['absolute', 'Clock time'], ['relative', 'Since start'], ['delta', 'Delta (prev. frame)'], ['gap', 'Idle gap (prev. end)'], ['chrono', 'Chronometer']];
                const idx = modes.findIndex(m => m[0] === s.view.timestampMode);
                const next = modes[(idx + 1) % modes.length];
                s.updateView({ timestampMode: next[0] });
                toast(t('Timestamps: {mode}', { mode: t(next[1]) }));
            })
        },
        { id: 'term.timeline', title: 'Toggle timeline', category: 'Terminal', key: 'Ctrl+J', enabled: hasTab, run: withTab(v => v.action('timeline')) },
        { id: 'term.plotter', title: 'Toggle plotter', category: 'Terminal', key: 'Ctrl+Shift+L', enabled: hasTab, run: withTab(v => v.action('plotter')) },
        { id: 'term.decoder', title: 'Toggle decoder', category: 'Terminal', key: 'Ctrl+Shift+D', enabled: hasTab, run: withTab(v => v.action('decoder')) },
        { id: 'term.record', title: 'Toggle disk recording', category: 'Terminal', enabled: hasTab, run: withTab(v => v.action('log-disk')) },
        { id: 'sw.toggle', title: 'Chronometer start / stop', category: 'Chronometer', key: 'Ctrl+Alt+S', enabled: hasTab, run: withTab((v, s) => s.swToggle()) },
        { id: 'sw.lap', title: 'Chronometer lap', category: 'Chronometer', key: 'Ctrl+Alt+L', enabled: hasTab, run: withTab((v, s) => s.swLap()) },
        { id: 'sw.reset', title: 'Chronometer reset', category: 'Chronometer', key: 'Ctrl+Alt+R', enabled: hasTab, run: withTab((v, s) => s.swReset()) },
        { id: 'file.export', title: 'Export logs', category: 'File', key: 'Ctrl+E', enabled: hasTab, run: withTab((v, s) => openExportModal(s, v.terminal)) },
        { id: 'file.save-capture', title: 'Save capture (.dtcap)', category: 'File', key: 'Ctrl+S', enabled: hasTab, run: withTab(v => v.action('save-capture')) },
        { id: 'file.open-capture', title: 'Open capture / replay', category: 'File', key: 'Ctrl+O', run: () => { showView('terminal'); openCaptureFile(); } },
        { id: 'file.send', title: 'Send a file', category: 'File', key: 'Ctrl+Shift+F', enabled: hasTab, run: withTab((v, s) => openSendFileModal(s)) },
        { id: 'tools.stats', title: 'Statistics', category: 'Tools', enabled: hasTab, run: withTab((v, s) => openStats(s)) },
        { id: 'tools.compare', title: 'Compare with a log file', category: 'Tools', enabled: hasTab, run: withTab((v, s) => openCompare(s)) },
        { id: 'tools.bridges', title: 'Bridges and sniffer', category: 'Tools', key: 'Ctrl+Shift+B', run: () => openBridges(activeSession()) },
        { id: 'tools.comnex', title: 'COMNEX hubs', category: 'Tools', run: () => openComnex() },
        { id: 'edit.macros', title: 'Edit macros', category: 'Automation', key: 'Ctrl+Shift+M', run: () => openMacrosEditor() },
        { id: 'edit.triggers', title: 'Edit triggers', category: 'Automation', run: () => openTriggersEditor() },
        { id: 'edit.highlights', title: 'Edit highlights', category: 'Automation', key: 'Ctrl+Shift+H', run: () => openHighlightsEditor() },
        { id: 'edit.decoders', title: 'Edit custom decoders', category: 'Automation', run: () => openCustomDecodersEditor() },
        { id: 'workspace.manage', title: 'Workspaces', category: 'Workspace', run: () => openWorkspaces() },
        { id: 'workspace.save', title: 'Save workspace as...', category: 'Workspace', run: () => saveWorkspaceAs() },
        {
            id: 'theme.toggle', title: 'Toggle light / dark theme', category: 'View', run: () => {
                const cur = document.documentElement.dataset.theme;
                setSetting('general.theme', cur === 'dark' ? 'light' : 'dark');
            }
        },
        { id: 'app.about', title: 'About DiagTerm', category: 'Help', run: () => openAbout() },
        { id: 'app.updates', title: 'Check for updates', category: 'Help', run: () => checkForUpdates() },
        { id: 'app.devtools', title: 'Toggle developer tools', category: 'Help', key: 'F12', enabled: () => !!getSetting('advanced.devTools', false), run: () => invoke('app:toggle-devtools') },
        { id: 'app.reload', title: 'Reload interface', category: 'Help', key: 'Ctrl+Shift+F5', run: () => { saveSessionNow(); invoke('app:reload'); } }
    ];
    for (const c of cmds) registerCommand(c);
}

function buildShell() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <header class="titlebar">
            <div class="tb-left">
                <img class="app-logo" src="../icons/diagTerm.svg" alt="">
                <span class="app-name">DiagTerm</span>
                <nav class="nav">
                    <button class="nav-btn active" data-view="terminal">${icon('terminal', 15)}<span>${escapeHtml(t('Terminal'))}</span></button>
                    <button class="nav-btn" data-view="flash">${icon('flash', 15)}<span>${escapeHtml(t('Flash'))}</span><span class="nav-badge hidden" data-role="flash-badge"></span></button>
                    <button class="nav-btn" data-view="settings">${icon('gear', 15)}<span>${escapeHtml(t('Settings'))}</span></button>
                </nav>
            </div>
            <div class="tb-drag">
                <button class="palette-trigger" data-tb="palette">${icon('search', 13)}<span>${escapeHtml(t('Search commands, tabs, ports...'))}</span><kbd>Ctrl+Shift+P</kbd></button>
            </div>
            <div class="tb-right">
                <button class="tb-icon" data-tb="workspaces" title="${escapeHtml(t('Workspaces'))}">${icon('workspace', 16)}</button>
                <button class="tb-icon" data-tb="comnex" title="COMNEX">${icon('usb', 16)}</button>
                <button class="tb-icon" data-tb="about" title="${escapeHtml(t('About'))}">${icon('info', 16)}</button>
                <div class="window-controls">
                    <button class="wc-btn" data-wc="min" title="${escapeHtml(t('Minimize'))}">${icon('minimize', 14)}</button>
                    <button class="wc-btn" data-wc="max" title="${escapeHtml(t('Maximize'))}">${icon('maximize', 13)}</button>
                    <button class="wc-btn wc-close" data-wc="close" title="${escapeHtml(t('Close'))}">${icon('close', 14)}</button>
                </div>
            </div>
        </header>
        <main class="views">
            <section class="view" data-view="terminal" id="view-terminal"></section>
            <section class="view hidden" data-view="flash" id="view-flash"><div class="view-loading dim">${escapeHtml(t('Loading...'))}</div></section>
            <section class="view hidden" data-view="settings" id="view-settings"></section>
        </main>
        <footer class="statusbar" id="statusbar"></footer>`;
    app.querySelector('.nav').addEventListener('click', (e) => {
        const b = e.target.closest('.nav-btn');
        if (b) showView(b.dataset.view);
    });
    app.querySelector('.titlebar').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tb]');
        if (b) {
            switch (b.dataset.tb) {
                case 'palette': openPalette(); break;
                case 'workspaces': openWorkspaces(); break;
                case 'comnex': openComnex(); break;
                case 'about': openAbout(); break;
                default: break;
            }
            return;
        }
        const w = e.target.closest('[data-wc]');
        if (!w) return;
        if (w.dataset.wc === 'min') invoke('window-minimize');
        else if (w.dataset.wc === 'max') invoke('window-maximize');
        else invoke('window-close');
    });
    app.querySelector('.tb-drag').addEventListener('dblclick', (e) => {
        if (!e.target.closest('button')) invoke('window-maximize');
    });
    on('window:maximized', (max) => {
        const btn = app.querySelector('[data-wc="max"]');
        btn.innerHTML = icon(max ? 'restore' : 'maximize', 13);
        btn.title = max ? t('Restore') : t('Maximize');
        document.body.classList.toggle('maximized', !!max);
    });
    getAppVersion().then(v => {
        document.title = v ? `DiagTerm ${v}` : 'DiagTerm';
        const name = app.querySelector('.app-name');
        if (name && v) name.title = `DiagTerm ${v}`;
    });
}

const flashActive = new Map();

function updateFlashBadge(job) {
    if (job) flashActive.set(job.id, job.status);
    const n = Array.from(flashActive.values()).filter(s => s === 'running' || s === 'queued').length;
    const badge = document.querySelector('[data-role="flash-badge"]');
    if (!badge) return;
    badge.textContent = n;
    badge.classList.toggle('hidden', !n);
}

function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (isPaletteOpen()) {
                closePalette();
                e.preventDefault();
                return;
            }
            if (document.querySelector('.popover')) {
                closePopover();
                e.preventDefault();
                return;
            }
            if (topModal()) {
                closeTopModal();
                e.preventDefault();
                return;
            }
        }
        if (isPaletteOpen()) return;
        if (topModal() && !(e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'P')) {
            if (e.key !== 'F12') return;
        }
        handleGlobalKey(e);
    });
    window.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const cur = Number(getSetting('general.uiScale', 100)) || 100;
        const next = Math.max(70, Math.min(200, cur + (e.deltaY < 0 ? 5 : -5)));
        if (next !== cur) setSetting('general.uiScale', next);
    }, { passive: false });
}

function bindDrop() {
    window.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        if (e.defaultPrevented) return;
        const files = Array.from(e.dataTransfer.files);
        const captures = files.filter(f => /\.dtcap$/i.test(f.name) || (/\.json$/i.test(f.name) && !e.target.closest('.tabview')));
        if (!captures.length) return;
        e.preventDefault();
        showView('terminal');
        for (const f of captures) openCaptureFile(f.path);
    });
}

function bindClose() {
    on('app:close-requested', async () => {
        const open = allSessions().filter(s => s.isOpen);
        let jobs = 0;
        try {
            const list = await invoke('flash:jobs');
            jobs = (list || []).filter(j => j.status === 'running' || j.status === 'queued').length;
        } catch (error) {
            jobs = 0;
        }
        saveSessionNow();
        if (!open.length && !jobs) {
            invoke('app:confirm-close');
            return;
        }
        const parts = [];
        if (open.length) parts.push(t('{n} open ports ({list})', { n: open.length, list: open.map(s => s.path).join(', ') }));
        if (jobs) parts.push(t('{n} flash jobs in progress', { n: jobs }));
        const ok = await confirmDialog(t('Quit DiagTerm? {details}', { details: parts.join(' - ') }), { title: t('Quit'), okLabel: t('Quit'), danger: !!jobs });
        if (ok) invoke('app:confirm-close');
    });
}

function bindNotifications() {
    onEvent('session:state', (session, state, info) => {
        if (state === 'lost' && getSetting('notifications.enabled', true) && getSetting('notifications.notifyOnDisconnect', false)) {
            notify(t('Port lost'), t('{port} disconnected', { port: session.path }), { type: 'warn' });
        }
        if (state === 'open' && info && info.reconnected && getSetting('notifications.enabled', true) && getSetting('notifications.notifyOnDisconnect', false)) {
            notify(t('Port reconnected'), info.previousPath && info.previousPath !== session.path ? t('{old} is back as {port}', { old: info.previousPath, port: session.path }) : t('{port} reconnected', { port: session.path }), { type: 'success', system: false });
        }
    });
    on('boards:auto-updated', (info) => {
        toast(t('Board package {key} updated from {from} to {to}', info), { type: 'success', timeout: 6000 });
    });
}

async function boot() {
    await loadSettings();
    applyTheme();
    buildShell();
    registerCommands();
    await initClock();
    await Promise.all([
        initHighlights(),
        initTriggers(),
        initMacros(),
        initDecoders(),
        initWorkspaces()
    ]);
    setMacroContext({ getActiveSession: () => activeSession() });
    setTriggerRunners({ runMacro, snapshot: snapshotCapture });
    initSessions();
    initWorkspace(document.getElementById('view-terminal'));
    initStatusbar(document.getElementById('statusbar'));
    initSettingsView(document.getElementById('view-settings'));
    await initPorts();
    await initBridges();
    initUpdates();
    bindGlobalKeys();
    bindDrop();
    bindClose();
    bindNotifications();
    initSessionPersistence();
    onEvent('settings:changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('general') || keyPath.startsWith('terminal.rxColor') || keyPath.startsWith('terminal.txColor') || keyPath.startsWith('timeline.')) applyTheme();
    });
    systemDark.addEventListener('change', () => {
        if (getSetting('general.theme') === 'system') applyTheme();
    });
    await restoreSession().catch(error => {
        console.error('Session restore failed:', error);
        return false;
    });
    invoke('flash:jobs').then(list => {
        for (const j of list || []) flashActive.set(j.id, j.status);
        updateFlashBadge();
    }).catch(() => { });
    on('flash:job', (job) => updateFlashBadge(job));
    console.log('DiagTerm renderer ready');
}

boot().catch(error => {
    console.error('Boot failed:', error);
    document.getElementById('app').innerHTML = `<div class="boot-error"><h2>DiagTerm</h2><pre>${escapeHtml(error && error.stack ? error.stack : String(error))}</pre></div>`;
});
