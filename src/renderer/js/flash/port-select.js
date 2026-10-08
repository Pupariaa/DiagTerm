import { escapeHtml } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { onEvent } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { getPorts, sortPorts, refreshPorts } from '../serial/ports.js';
import { sessionsForPath } from '../serial/sessions.js';
import { allJobs, flashEvents } from './flash-state.js';
import { icon } from '../ui/icons.js';

const detectCache = new Map();

async function detectFor(path) {
    if (detectCache.has(path)) return detectCache.get(path);
    const promise = invoke('flash:detect-board', path).catch(() => []);
    detectCache.set(path, promise);
    return promise;
}

export class PortSelector {
    constructor(host, { multiple = true, allowNone = false, noneLabel, onChange, initial = [] } = {}) {
        this.host = host;
        this.multiple = multiple;
        this.allowNone = allowNone;
        this.noneLabel = noneLabel || t('No port (BOOTSEL drive / DFU)');
        this.onChange = onChange;
        this.selected = new Set(initial);
        this.filter = '';
        this.detected = new Map();
        this.subs = [];
        this.host.addEventListener('click', (e) => this.onClick(e));
        this.host.addEventListener('input', (e) => {
            if (e.target.classList.contains('ps-filter')) {
                this.filter = e.target.value.trim().toLowerCase();
                this.renderList();
            }
        });
        this.host.addEventListener('change', (e) => {
            const cb = e.target.closest('[data-port]');
            if (!cb) return;
            this.toggle(cb.dataset.port, cb.checked);
        });
        this.subs.push(onEvent('ports:changed', ({ added }) => {
            for (const p of added || []) detectCache.delete(p);
            const present = new Set(getPorts().map(p => p.path));
            for (const p of Array.from(this.selected)) if (p !== '' && !present.has(p)) this.selected.delete(p);
            this.render();
        }));
        this.subs.push(onEvent('session:state', () => this.renderList()));
        this.subs.push(flashEvents.on('jobs', () => this.renderList()));
        this.render();
    }

    toggle(path, on) {
        if (!this.multiple) this.selected.clear();
        if (on) this.selected.add(path);
        else this.selected.delete(path);
        this.renderList();
        if (this.onChange) this.onChange(this.getSelected());
    }

    getSelected() {
        return Array.from(this.selected);
    }

    setSelected(list) {
        this.selected = new Set(list || []);
        this.renderList();
    }

    visiblePorts() {
        const ports = sortPorts(getPorts());
        if (!this.filter) return ports;
        return ports.filter(p => `${p.path} ${p.manufacturer || ''} ${p.friendlyName || ''} ${p.serialNumber || ''} ${p.vendorId || ''}:${p.productId || ''} ${(this.detected.get(p.path) || []).map(b => b.name).join(' ')}`.toLowerCase().includes(this.filter));
    }

    onClick(e) {
        const act = e.target.closest('[data-ps]');
        if (!act) return;
        switch (act.dataset.ps) {
            case 'all':
                for (const p of this.visiblePorts()) this.selected.add(p.path);
                break;
            case 'none':
                this.selected.clear();
                break;
            case 'same': {
                const ref = getPorts().find(p => this.selected.has(p.path) && p.vendorId);
                if (ref) {
                    for (const p of getPorts()) if (p.vendorId === ref.vendorId && p.productId === ref.productId) this.selected.add(p.path);
                }
                break;
            }
            case 'free':
                for (const p of this.visiblePorts()) {
                    if (!sessionsForPath(p.path).some(s => s.isOpen)) this.selected.add(p.path);
                }
                break;
            case 'refresh':
                refreshPorts();
                return;
            default: return;
        }
        this.renderList();
        if (this.onChange) this.onChange(this.getSelected());
    }

    render() {
        this.host.innerHTML = `
            <div class="ps">
                <div class="ps-toolbar">
                    <input class="input sm ps-filter" type="text" placeholder="${escapeHtml(t('Filter ports'))}" value="${escapeHtml(this.filter)}">
                    ${this.multiple ? `
                        <button class="tb-btn" data-ps="all">${escapeHtml(t('All'))}</button>
                        <button class="tb-btn" data-ps="same" title="${escapeHtml(t('Select every port with the same VID:PID as the selection'))}">${escapeHtml(t('Same type'))}</button>
                        <button class="tb-btn" data-ps="free" title="${escapeHtml(t('Select ports not opened in a terminal'))}">${escapeHtml(t('Free'))}</button>
                        <button class="tb-btn" data-ps="none">${escapeHtml(t('None'))}</button>` : ''}
                    <button class="tb-btn icon-only" data-ps="refresh" title="${escapeHtml(t('Refresh ports'))}">${icon('refresh', 14)}</button>
                </div>
                <div class="ps-list"></div>
            </div>`;
        this.renderList();
        for (const p of getPorts()) {
            if (this.detected.has(p.path)) continue;
            detectFor(p.path).then(list => {
                this.detected.set(p.path, list || []);
                this.renderList();
            });
        }
    }

    renderList() {
        const listEl = this.host.querySelector('.ps-list');
        if (!listEl) return;
        const ports = this.visiblePorts();
        const busy = new Map();
        for (const j of allJobs()) {
            if (j.status === 'running' || j.status === 'queued') busy.set(j.currentPort || j.port, j);
        }
        const type = this.multiple ? 'checkbox' : 'radio';
        const rows = ports.map(p => {
            const sessions = sessionsForPath(p.path);
            const open = sessions.some(s => s.isOpen);
            const job = busy.get(p.path);
            const boardsFound = this.detected.get(p.path) || [];
            const desc = [p.friendlyName && !p.friendlyName.startsWith(p.path) ? p.friendlyName.replace(/\s*\(COM\d+\)$/, '') : p.manufacturer, p.serialNumber ? `SN ${p.serialNumber}` : ''].filter(Boolean).join(' - ');
            return `
                <label class="ps-row ${this.selected.has(p.path) ? 'selected' : ''}">
                    <input type="${type}" name="ps-${this.multiple ? 'm' : 's'}" data-port="${escapeHtml(p.path)}" ${this.selected.has(p.path) ? 'checked' : ''}>
                    <div class="ps-main">
                        <div><b>${escapeHtml(p.path)}</b> ${p.vendorId ? `<span class="mono dim small">${escapeHtml(p.vendorId)}:${escapeHtml(p.productId || '')}</span>` : ''}</div>
                        <div class="dim small">${escapeHtml(desc || t('Serial port'))}</div>
                        ${boardsFound.length ? `<div class="small ok-text">${escapeHtml(boardsFound.slice(0, 2).map(b => b.name).join(', '))}${boardsFound.length > 2 ? ` +${boardsFound.length - 2}` : ''}</div>` : ''}
                    </div>
                    <div class="ps-badges">
                        ${open ? `<span class="badge warn" title="${escapeHtml(t('Open in a terminal: it will be released during flashing and reopened afterwards'))}">${escapeHtml(t('in terminal'))}</span>` : ''}
                        ${job ? `<span class="badge info">${escapeHtml(job.phase || t('busy'))}</span>` : ''}
                    </div>
                </label>`;
        });
        if (this.allowNone) {
            rows.unshift(`
                <label class="ps-row ${this.selected.has('') ? 'selected' : ''}">
                    <input type="${type}" name="ps-${this.multiple ? 'm' : 's'}" data-port="" ${this.selected.has('') ? 'checked' : ''}>
                    <div class="ps-main"><div><b>${escapeHtml(this.noneLabel)}</b></div></div>
                </label>`);
        }
        listEl.innerHTML = rows.length ? rows.join('') : `<div class="dim ps-empty">${escapeHtml(t('No serial port detected'))}</div>`;
    }

    dispose() {
        for (const off of this.subs) off();
        this.subs = [];
    }
}
