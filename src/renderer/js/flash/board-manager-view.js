import { escapeHtml } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { getSetting } from '../core/settings.js';
import { toast, confirmDialog } from '../core/dialogs.js';
import { runCommand } from '../core/commands.js';
import { icon } from '../ui/icons.js';
import { flashEvents, loadCatalog, getCatalog, getBoardProgress, loadBoards } from './flash-state.js';

const POPULAR = ['esp32:esp32', 'esp8266:esp8266', 'arduino:avr', 'rp2040:rp2040', 'arduino:samd', 'arduino:renesas_uno', 'arduino:mbed_rp2040', 'CH55xDuino:mcs51', 'WCH:ch32v'];

export class BoardManagerTab {
    constructor(host) {
        this.host = host;
        this.query = '';
        this.filter = 'all';
        this.selectedVersions = new Map();
        this.busy = new Set();
        this.lastFetch = null;
        this.rendered = false;
        this.fetchResults = null;
        host.addEventListener('click', (e) => this.onClick(e));
        host.addEventListener('input', (e) => {
            if (e.target.classList.contains('bm-search')) {
                this.query = e.target.value.trim().toLowerCase();
                this.renderList();
            }
        });
        host.addEventListener('change', (e) => {
            if (e.target.classList.contains('bm-filter')) {
                this.filter = e.target.value;
                this.renderList();
            } else if (e.target.dataset.ver) {
                this.selectedVersions.set(e.target.dataset.ver, e.target.value);
                this.renderList();
            }
        });
        flashEvents.on('catalog', () => { if (this.rendered) this.renderList(); });
        flashEvents.on('board-progress', (p) => {
            if (!this.rendered) return;
            if (p.task === 'indexes' && p.phase === 'done') {
                this.fetchResults = p.results || null;
                this.renderHeader();
            }
            this.renderProgress();
        });
        flashEvents.on('auto-updated', () => { if (this.rendered) this.onShow(); });
    }

    async onShow() {
        if (!this.rendered) this.render();
        const state = await invoke('store:get', 'boards-state', {});
        this.lastFetch = state && state.lastIndexFetch ? state.lastIndexFetch : null;
        await loadCatalog();
        this.renderHeader();
        if (!getCatalog().some(c => c.versions && c.versions.length && c.indexUrl) && !this.lastFetch) this.refreshIndexes();
    }

    render() {
        this.rendered = true;
        this.host.innerHTML = `
            <div class="bm">
                <div class="bm-header"></div>
                <div class="bm-toolbar">
                    <input class="input bm-search" type="text" placeholder="${escapeHtml(t('Search packages and boards'))}" value="${escapeHtml(this.query)}">
                    <select class="input bm-filter">
                        <option value="all">${escapeHtml(t('All packages'))}</option>
                        <option value="installed">${escapeHtml(t('Installed'))}</option>
                        <option value="updates">${escapeHtml(t('Updates available'))}</option>
                        <option value="available">${escapeHtml(t('Not installed'))}</option>
                    </select>
                </div>
                <div class="bm-progress"></div>
                <div class="bm-list"></div>
            </div>`;
        this.renderHeader();
        this.renderProgress();
        this.renderList();
    }

    renderHeader() {
        const el = this.host.querySelector('.bm-header');
        if (!el) return;
        const catalog = getCatalog();
        const installed = catalog.filter(c => c.installed.length).length;
        const updates = catalog.filter(c => c.updateAvailable).length;
        const failed = (this.fetchResults || []).filter(r => !r.success);
        el.innerHTML = `
            <div class="bm-head-main">
                <div>
                    <h2>${escapeHtml(t('Board manager'))}</h2>
                    <div class="dim small">
                        ${escapeHtml(t('{n} packages installed', { n: installed }))}${updates ? ` - <span class="warn-text">${escapeHtml(t('{n} updates available', { n: updates }))}</span>` : ''}
                        - ${escapeHtml(getSetting('flash.autoUpdate', true) ? t('Automatic updates on') : t('Automatic updates off'))}
                        ${this.lastFetch ? ` - ${escapeHtml(t('Indexes updated {date}', { date: new Date(this.lastFetch).toLocaleString() }))}` : ''}
                    </div>
                </div>
                <div class="row gap">
                    <button class="btn" data-bm="refresh">${icon('refresh', 14)}<span>${escapeHtml(t('Update indexes'))}</span></button>
                    ${updates ? `<button class="btn btn-primary" data-bm="update-all">${escapeHtml(t('Update all'))}</button>` : ''}
                    <button class="btn" data-bm="settings">${icon('gear', 14)}<span>${escapeHtml(t('URLs and options'))}</span></button>
                    <button class="btn" data-bm="folder" title="${escapeHtml(t('Open packages folder'))}">${icon('folder', 14)}</button>
                </div>
            </div>
            ${failed.length ? `<div class="notice warn small">${failed.map(f => `<div>${escapeHtml(f.url)}: ${escapeHtml(f.error)}</div>`).join('')}</div>` : ''}`;
    }

    renderProgress() {
        const el = this.host.querySelector('.bm-progress');
        if (!el) return;
        const tasks = Array.from(getBoardProgress().values());
        el.innerHTML = tasks.map(p => `
            <div class="bm-task ${p.phase}">
                <span>${escapeHtml(p.message || p.task)}</span>
                ${p.phase === 'download' && p.percent !== null && p.percent !== undefined ? `<div class="progress"><div class="progress-bar" style="width:${p.percent}%"></div></div><span class="dim small">${p.percent}%</span>` : p.phase === 'download' || p.phase === 'extract' || p.phase === 'tools' || p.phase === 'start' ? '<div class="spinner"></div>' : ''}
            </div>`).join('');
    }

    renderList() {
        const el = this.host.querySelector('.bm-list');
        if (!el) return;
        let list = getCatalog().slice();
        const q = this.query;
        if (q) list = list.filter(c => `${c.name} ${c.key} ${c.maintainer} ${(c.boards || []).join(' ')}`.toLowerCase().includes(q));
        if (this.filter === 'installed') list = list.filter(c => c.installed.length);
        if (this.filter === 'updates') list = list.filter(c => c.updateAvailable);
        if (this.filter === 'available') list = list.filter(c => !c.installed.length);
        list.sort((a, b) => (b.installed.length ? 1 : 0) - (a.installed.length ? 1 : 0) || (POPULAR.indexOf(a.key) < 0 ? 99 : POPULAR.indexOf(a.key)) - (POPULAR.indexOf(b.key) < 0 ? 99 : POPULAR.indexOf(b.key)) || a.name.localeCompare(b.name));
        if (!list.length) {
            el.innerHTML = `<div class="dim bm-empty">${escapeHtml(getCatalog().length ? t('No package matches') : t('No package index loaded yet. Click "Update indexes".'))}</div>`;
            return;
        }
        el.innerHTML = list.map(c => {
            const selected = this.selectedVersions.get(c.key) || c.latest;
            const managed = c.installed.filter(i => i.source === 'managed');
            const external = c.installed.filter(i => i.source !== 'managed');
            const busy = this.busy.has(c.key);
            const boardsText = (c.boards || []).slice(0, 14).join(', ') + ((c.boards || []).length > 14 ? ` +${c.boards.length - 14}` : '');
            const installedSelected = c.installed.some(i => i.version === selected);
            return `
                <div class="bm-item ${c.installed.length ? 'installed' : ''} ${c.updateAvailable ? 'update' : ''}">
                    <div class="bm-item-main">
                        <div class="bm-title">
                            <b>${escapeHtml(c.name)}</b>
                            <span class="dim small mono">${escapeHtml(c.key)}</span>
                            ${c.activeVersion ? `<span class="badge ok">${escapeHtml(c.activeVersion)}${c.activeSource && c.activeSource !== 'managed' ? ` (${escapeHtml(c.activeSource)})` : ''}</span>` : ''}
                            ${c.updateAvailable ? `<span class="badge warn">${escapeHtml(t('{v} available', { v: c.latest }))}</span>` : ''}
                            ${c.deprecated ? `<span class="badge err">${escapeHtml(t('deprecated'))}</span>` : ''}
                        </div>
                        <div class="dim small">${escapeHtml(t('by {m}', { m: c.maintainer || '?' }))}${c.website ? ` - <a href="#" data-bm="web" data-url="${escapeHtml(c.website)}">${escapeHtml(t('website'))}</a>` : ''}</div>
                        ${boardsText ? `<div class="bm-boards small">${escapeHtml(boardsText)}</div>` : ''}
                        ${external.length ? `<div class="small dim">${escapeHtml(t('Also found in Arduino IDE folder: {v}', { v: external.map(e => e.version).join(', ') }))}</div>` : ''}
                    </div>
                    <div class="bm-item-actions">
                        ${c.versions && c.versions.length ? `<select class="input sm" data-ver="${escapeHtml(c.key)}">${c.versions.map(v => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}${c.installed.some(i => i.version === v) ? ' *' : ''}</option>`).join('')}</select>` : ''}
                        ${busy ? `<div class="spinner"></div>` : `
                            ${!installedSelected && c.versions && c.versions.length ? `<button class="btn sm btn-primary" data-bm="install" data-key="${escapeHtml(c.key)}" data-version="${escapeHtml(selected)}">${escapeHtml(managed.length ? (c.latest === selected ? t('Update') : t('Install version')) : t('Install'))}</button>` : ''}
                            ${managed.map(m => `<button class="btn sm" data-bm="remove" data-key="${escapeHtml(c.key)}" data-version="${escapeHtml(m.version)}" title="${escapeHtml(m.path)}">${escapeHtml(t('Remove {v}', { v: m.version }))}</button>`).join('')}`}
                    </div>
                </div>`;
        }).join('');
    }

    async refreshIndexes() {
        const btn = this.host.querySelector('[data-bm="refresh"]');
        if (btn) btn.disabled = true;
        try {
            this.fetchResults = await invoke('boards:fetch-indexes');
            const state = await invoke('store:get', 'boards-state', {});
            this.lastFetch = state && state.lastIndexFetch ? state.lastIndexFetch : Date.now();
            await loadCatalog();
        } finally {
            if (btn) btn.disabled = false;
            this.renderHeader();
            this.renderList();
        }
    }

    async install(key, version) {
        const [packager, arch] = key.split(':');
        this.busy.add(key);
        this.renderList();
        try {
            const res = await invoke('boards:install', packager, arch, version);
            if (res && res.success) toast(t('{key} {v} installed', { key, v: res.version || version }), { type: 'success' });
            else toast(t('Installation failed: {error}', { error: (res && res.error) || '' }), { type: 'error', timeout: 8000 });
        } finally {
            this.busy.delete(key);
            await loadCatalog();
            await loadBoards(true);
            this.renderHeader();
            this.renderList();
        }
    }

    async onClick(e) {
        const b = e.target.closest('[data-bm]');
        if (!b) return;
        if (b.tagName === 'A') e.preventDefault();
        switch (b.dataset.bm) {
            case 'refresh': this.refreshIndexes(); break;
            case 'update-all': {
                for (const c of getCatalog().filter(x => x.updateAvailable)) await this.install(c.key, c.latest);
                break;
            }
            case 'settings': {
                const { openSettingsCategory } = await import('../ui/settings-view.js');
                runCommand('view.settings');
                openSettingsCategory('flash');
                break;
            }
            case 'folder': {
                const dir = await invoke('boards:root');
                if (dir) invoke('files:open-path', dir);
                break;
            }
            case 'web': invoke('files:open-external', b.dataset.url); break;
            case 'install': this.install(b.dataset.key, b.dataset.version); break;
            case 'remove': {
                const ok = await confirmDialog(t('Remove {key} {v}?', { key: b.dataset.key, v: b.dataset.version }), { danger: true, okLabel: t('Remove') });
                if (!ok) return;
                const [packager, arch] = b.dataset.key.split(':');
                this.busy.add(b.dataset.key);
                this.renderList();
                await invoke('boards:uninstall', packager, arch, b.dataset.version);
                this.busy.delete(b.dataset.key);
                await loadCatalog();
                await loadBoards(true);
                this.renderList();
                break;
            }
            default: break;
        }
    }
}
