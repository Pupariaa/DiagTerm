import { escapeHtml, el } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { toast } from '../core/dialogs.js';
import { formatDuration } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { allJobs, getJob, jobLog, fetchJobLog, flashEvents, clearFinishedJobs } from './flash-state.js';

const OPERATION_LABELS = {
    program: 'Program',
    erase: 'Erase',
    'erase-region': 'Erase region',
    'fs-upload': 'Filesystem upload',
    'fs-download': 'Filesystem download',
    'fs-build': 'Build filesystem',
    verify: 'Verify',
    info: 'Chip info',
    'read-flash': 'Read flash',
    'partitions-read': 'Read partitions',
    'partitions-write': 'Write partitions',
    bootloader: 'Burn bootloader'
};

const STATUS_LABELS = { queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Cancelled' };

function duration(job) {
    if (!job.startedAt) return '';
    const end = job.endedAt || Date.now();
    return formatDuration(end - job.startedAt, { precision: 1 });
}

function resultSummary(result) {
    if (!result) return '';
    const parts = [];
    if (result.chip) parts.push(result.chip);
    if (result.mac) parts.push(`MAC ${result.mac}`);
    if (result.flashSize) parts.push(`${t('Flash')} ${result.flashSize}`);
    if (result.psram) parts.push(`PSRAM ${result.psram}`);
    if (result.signature) parts.push(`${t('Signature')} ${result.signature}`);
    if (result.readFile) parts.push(result.readFile.split(/[\\/]/).pop());
    if (result.fsImage) parts.push(result.fsImage.split(/[\\/]/).pop());
    if (result.fsFiles) parts.push(t('{n} files', { n: result.fsFiles.filter(f => !f.dir).length }));
    if (result.partitions) parts.push(t('{n} partitions', { n: result.partitions.length }));
    return parts.join(' - ');
}

function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class JobsPanel {
    constructor(host) {
        this.host = host;
        this.filter = 'all';
        this.search = '';
        this.selectedId = null;
        this.follow = true;
        this.cards = new Map();
        this.build();
        flashEvents.on('job', (job) => this.onJob(job));
        flashEvents.on('jobs', () => this.updateSummary());
        flashEvents.on('log', (id, text) => this.onLog(id, text));
        flashEvents.on('enqueued', (ids) => {
            if (ids && ids.length && (!this.selectedId || !getJob(this.selectedId) || ['done', 'error', 'cancelled'].includes(getJob(this.selectedId).status))) {
                this.select(ids[0]);
            }
        });
        this.timer = setInterval(() => this.tick(), 1000);
    }

    build() {
        this.host.innerHTML = `
            <div class="jobs">
                <div class="jobs-toolbar">
                    <div class="jobs-summary"></div>
                    <div class="spacer"></div>
                    <input class="input sm jobs-search" type="text" placeholder="${escapeHtml(t('Filter by port, board, serial...'))}">
                    <select class="input sm jobs-filter">
                        <option value="all">${escapeHtml(t('All jobs'))}</option>
                        <option value="active">${escapeHtml(t('Running and queued'))}</option>
                        <option value="error">${escapeHtml(t('Failed'))}</option>
                        <option value="done">${escapeHtml(t('Succeeded'))}</option>
                    </select>
                    <button class="btn sm" data-ja="retry-failed">${icon('replay', 14)}<span>${escapeHtml(t('Retry failed'))}</span></button>
                    <button class="btn sm" data-ja="cancel-all">${icon('stop', 14)}<span>${escapeHtml(t('Cancel all'))}</span></button>
                    <button class="btn sm" data-ja="clear">${icon('trash', 14)}<span>${escapeHtml(t('Clear finished'))}</span></button>
                    <button class="btn sm" data-ja="report">${icon('download', 14)}<span>${escapeHtml(t('Report CSV'))}</span></button>
                </div>
                <div class="jobs-main">
                    <div class="jobs-grid"></div>
                    <div class="jobs-log">
                        <div class="jobs-log-head"></div>
                        <pre class="jobs-log-text"></pre>
                    </div>
                </div>
            </div>`;
        this.grid = this.host.querySelector('.jobs-grid');
        this.logHead = this.host.querySelector('.jobs-log-head');
        this.logText = this.host.querySelector('.jobs-log-text');
        this.host.querySelector('.jobs-filter').addEventListener('change', (e) => {
            this.filter = e.target.value;
            this.renderAll();
        });
        this.host.querySelector('.jobs-search').addEventListener('input', (e) => {
            this.search = e.target.value.trim().toLowerCase();
            this.renderAll();
        });
        this.host.addEventListener('click', (e) => this.onClick(e));
        this.logText.addEventListener('scroll', () => {
            const atBottom = this.logText.scrollHeight - this.logText.scrollTop - this.logText.clientHeight < 30;
            this.follow = atBottom;
        });
        this.renderAll();
    }

    matches(job) {
        if (this.filter === 'active' && !(job.status === 'running' || job.status === 'queued')) return false;
        if (this.filter === 'error' && !(job.status === 'error' || job.status === 'cancelled')) return false;
        if (this.filter === 'done' && job.status !== 'done') return false;
        if (this.search) {
            const hay = `${job.port || ''} ${job.currentPort || ''} ${job.boardName || ''} ${job.label || ''} ${job.usb ? job.usb.serialNumber : ''} ${job.operation} ${job.error || ''}`.toLowerCase();
            if (!hay.includes(this.search)) return false;
        }
        return true;
    }

    cardHtml(job) {
        const portChanged = job.currentPort && job.port && job.currentPort !== job.port;
        return `
            <div class="job-head">
                <span class="job-port">${escapeHtml(job.port || t('No port'))}${portChanged ? ` <span class="dim">&rarr; ${escapeHtml(job.currentPort)}</span>` : ''}</span>
                <span class="job-status">${escapeHtml(t(STATUS_LABELS[job.status] || job.status))}</span>
            </div>
            <div class="job-board">${escapeHtml(job.boardName || job.label || job.fqbn || '')}</div>
            <div class="job-op dim small">${escapeHtml(t(OPERATION_LABELS[job.operation] || job.operation))}${job.production ? ` - ${escapeHtml(t('production'))}` : ''}${job.usb && job.usb.serialNumber ? ` - SN ${escapeHtml(job.usb.serialNumber)}` : ''}</div>
            <div class="progress"><div class="progress-bar" style="width:${job.progress || 0}%"></div></div>
            <div class="job-foot">
                <span class="job-phase">${escapeHtml(job.status === 'error' ? job.error || t('Failed') : t(job.phase || ''))}</span>
                <span class="job-time dim">${escapeHtml(duration(job))}${job.attempts > 1 ? ` - ${escapeHtml(t('{n} attempts', { n: job.attempts }))}` : ''}</span>
            </div>
            ${job.status === 'done' && resultSummary(job.result) ? `<div class="job-result small">${escapeHtml(resultSummary(job.result))}</div>` : ''}
            <div class="job-actions">
                ${job.status === 'running' || job.status === 'queued' ? `<button class="tb-btn" data-ja="cancel" data-id="${job.id}">${escapeHtml(t('Cancel'))}</button>` : `<button class="tb-btn" data-ja="retry" data-id="${job.id}">${escapeHtml(t('Retry'))}</button>`}
                ${job.currentPort || job.port ? `<button class="tb-btn" data-ja="terminal" data-id="${job.id}" title="${escapeHtml(t('Open in terminal'))}">${icon('terminal', 13)}</button>` : ''}
                ${job.result && (job.result.readFile || job.result.fsDir || job.result.fsImage) ? `<button class="tb-btn" data-ja="open-result" data-id="${job.id}">${icon('folder', 13)}</button>` : ''}
            </div>`;
    }

    updateCard(job) {
        let card = this.cards.get(job.id);
        if (!this.matches(job)) {
            if (card) {
                card.remove();
                this.cards.delete(job.id);
            }
            return;
        }
        if (!card) {
            card = el(`<div class="job-card" data-job="${job.id}"></div>`);
            this.cards.set(job.id, card);
            this.grid.appendChild(card);
            const empty = this.grid.querySelector('.jobs-empty');
            if (empty) empty.remove();
        }
        card.className = `job-card st-${job.status} ${this.selectedId === job.id ? 'selected' : ''}`;
        card.innerHTML = this.cardHtml(job);
    }

    renderAll() {
        this.grid.innerHTML = '';
        this.cards.clear();
        const list = allJobs();
        for (const job of list) this.updateCard(job);
        if (!this.cards.size) {
            this.grid.innerHTML = `<div class="jobs-empty dim">${escapeHtml(list.length ? t('No job matches the filter') : t('No flash job yet. Configure a board and firmware in the Flash tab, select ports and start.'))}</div>`;
        }
        this.updateSummary();
        this.renderLogHead();
    }

    updateSummary() {
        const list = allJobs();
        const count = (s) => list.filter(j => j.status === s).length;
        const summary = this.host.querySelector('.jobs-summary');
        summary.innerHTML = `
            <span class="stat"><b>${count('running')}</b> ${escapeHtml(t('running'))}</span>
            <span class="stat"><b>${count('queued')}</b> ${escapeHtml(t('queued'))}</span>
            <span class="stat ok"><b>${count('done')}</b> ${escapeHtml(t('succeeded'))}</span>
            <span class="stat err"><b>${count('error')}</b> ${escapeHtml(t('failed'))}</span>
            ${count('cancelled') ? `<span class="stat dim"><b>${count('cancelled')}</b> ${escapeHtml(t('cancelled'))}</span>` : ''}`;
    }

    onJob(job) {
        this.updateCard(job);
        if (job.id === this.selectedId) this.renderLogHead();
        if (!this.selectedId && job.status === 'running') this.select(job.id);
    }

    onLog(id, text) {
        if (id !== this.selectedId) return;
        this.logText.textContent += text;
        if (this.logText.textContent.length > 600000) this.logText.textContent = this.logText.textContent.slice(-400000);
        if (this.follow) this.logText.scrollTop = this.logText.scrollHeight;
    }

    async select(id) {
        this.selectedId = id;
        for (const [jid, card] of this.cards) card.classList.toggle('selected', jid === id);
        this.renderLogHead();
        this.logText.textContent = jobLog(id);
        const text = await fetchJobLog(id);
        if (this.selectedId !== id) return;
        this.logText.textContent = text;
        this.follow = true;
        this.logText.scrollTop = this.logText.scrollHeight;
    }

    renderLogHead() {
        const job = this.selectedId ? getJob(this.selectedId) : null;
        if (!job) {
            this.logHead.innerHTML = `<span class="dim">${escapeHtml(t('Select a job to see its log'))}</span>`;
            this.logText.textContent = '';
            return;
        }
        const result = job.result || {};
        const rows = Object.entries(result).filter(([k, v]) => v !== null && v !== undefined && typeof v !== 'object' && k !== 'fsDir');
        this.logHead.innerHTML = `
            <div class="row gap">
                <b>#${job.id} ${escapeHtml(job.port || '')}</b>
                <span class="badge st-${job.status}">${escapeHtml(t(STATUS_LABELS[job.status] || job.status))}</span>
                <span class="dim small">${escapeHtml(job.boardName || '')} ${job.driver ? `- ${escapeHtml(job.driver)}` : ''}</span>
                <span class="spacer"></span>
                <button class="tb-btn" data-ja="copy-log">${escapeHtml(t('Copy'))}</button>
                <button class="tb-btn" data-ja="save-log">${escapeHtml(t('Save'))}</button>
            </div>
            ${job.error ? `<div class="notice error small">${escapeHtml(job.error)}</div>` : ''}
            ${rows.length ? `<div class="kv-chips">${rows.map(([k, v]) => `<span class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></span>`).join('')}</div>` : ''}
            ${result.fsFiles ? `<details class="small"><summary>${escapeHtml(t('{n} files extracted to {dir}', { n: result.fsFiles.filter(f => !f.dir).length, dir: result.fsDir }))}</summary><div class="mono">${result.fsFiles.map(f => `${escapeHtml(f.path)}${f.dir ? '/' : ` <span class="dim">${f.size}</span>`}`).join('<br>')}</div></details>` : ''}
            ${result.partitions ? `<details class="small"><summary>${escapeHtml(t('Partition table'))}</summary><table class="table compact"><tbody>${result.partitions.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.type)}</td><td>${escapeHtml(p.subtype)}</td><td class="mono">0x${Number(p.offset).toString(16)}</td><td class="mono">0x${Number(p.size).toString(16)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
    }

    tick() {
        if (!this.host.offsetParent) return;
        for (const job of allJobs()) {
            if (job.status !== 'running') continue;
            const card = this.cards.get(job.id);
            const time = card && card.querySelector('.job-time');
            if (time) time.textContent = `${duration(job)}${job.attempts > 1 ? ` - ${t('{n} attempts', { n: job.attempts })}` : ''}`;
        }
    }

    async exportReport() {
        const header = ['id', 'port', 'final_port', 'board', 'fqbn', 'operation', 'status', 'phase', 'error', 'started', 'ended', 'duration_s', 'attempts', 'serial_number', 'vid', 'pid', 'manufacturer', 'chip', 'mac', 'flash_size', 'production'];
        const lines = [header.join(',')];
        for (const j of allJobs()) {
            const r = j.result || {};
            lines.push([
                j.id, j.port, j.currentPort, j.boardName, j.fqbn, j.operation, j.status, j.phase, j.error,
                j.startedAt ? new Date(j.startedAt).toISOString() : '', j.endedAt ? new Date(j.endedAt).toISOString() : '',
                j.startedAt && j.endedAt ? ((j.endedAt - j.startedAt) / 1000).toFixed(1) : '', j.attempts,
                j.usb && j.usb.serialNumber, j.usb && j.usb.vendorId, j.usb && j.usb.productId, j.usb && j.usb.manufacturer,
                r.chip, r.mac, r.flashSize, j.production ? 'yes' : 'no'
            ].map(csvCell).join(','));
        }
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const res = await invoke('files:save-text', lines.join('\n') + '\n', 'csv', `flash-report-${stamp}.csv`);
        if (res && res.success) toast(t('Report saved'), { type: 'success' });
    }

    async onClick(e) {
        const btn = e.target.closest('[data-ja]');
        if (!btn) {
            const card = e.target.closest('.job-card');
            if (card) this.select(parseInt(card.dataset.job, 10));
            return;
        }
        e.stopPropagation();
        const id = btn.dataset.id ? parseInt(btn.dataset.id, 10) : null;
        switch (btn.dataset.ja) {
            case 'cancel': await invoke('flash:cancel', id); break;
            case 'retry': {
                const res = await invoke('flash:retry', id);
                if (res && res.id) this.select(res.id);
                break;
            }
            case 'retry-failed':
                for (const j of allJobs()) if (j.status === 'error') await invoke('flash:retry', j.id);
                break;
            case 'cancel-all': await invoke('flash:cancel-all'); break;
            case 'clear':
                await clearFinishedJobs();
                if (this.selectedId && !getJob(this.selectedId)) this.selectedId = null;
                this.renderAll();
                break;
            case 'report': this.exportReport(); break;
            case 'terminal': {
                const job = getJob(id);
                const port = job.currentPort || job.port;
                const { findFreeSessionForPath, setActive } = await import('../serial/sessions.js');
                const { newTab } = await import('../ui/workspace.js');
                const { runCommand } = await import('../core/commands.js');
                const existing = findFreeSessionForPath(port);
                const session = existing || newTab({ path: port });
                setActive(session.id);
                runCommand('view.terminal');
                if (!session.isOpen && session.state !== 'suspended') {
                    const { getTabView } = await import('../ui/tab-view.js');
                    const view = getTabView(session.id);
                    if (view) view.connect();
                }
                break;
            }
            case 'open-result': {
                const job = getJob(id);
                const r = job.result || {};
                if (r.fsDir) invoke('files:open-path', r.fsDir);
                else if (r.readFile) invoke('files:show-item', r.readFile);
                else if (r.fsImage) invoke('files:show-item', r.fsImage);
                break;
            }
            case 'copy-log':
                await navigator.clipboard.writeText(this.logText.textContent);
                toast(t('Log copied'));
                break;
            case 'save-log': {
                const job = getJob(this.selectedId);
                if (!job) return;
                await invoke('files:save-text', this.logText.textContent, 'txt', `flash-${job.id}-${String(job.port || 'noport').replace(/[^a-z0-9]/gi, '')}.log`);
                break;
            }
            default: break;
        }
    }

    onShow() {
        this.renderAll();
        if (this.selectedId) this.select(this.selectedId);
    }
}
