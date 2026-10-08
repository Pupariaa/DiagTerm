import { escapeHtml } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { toast, confirmDialog } from '../core/dialogs.js';
import { formatBytes } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { PortSelector } from './port-select.js';
import { flashEvents, findBoard, profileForJob, enqueueJobs, getJob, getFlashUiState, setFlashUiState } from './flash-state.js';

function parseNum(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === 'number') return value;
    const s = String(value).trim().toLowerCase();
    if (!s) return NaN;
    const m = s.match(/^(0x[0-9a-f]+|\d+)\s*([km])?$/);
    if (!m) return NaN;
    let n = m[1].startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
    if (m[2] === 'k') n *= 1024;
    if (m[2] === 'm') n *= 1024 * 1024;
    return n;
}

function hex(n) {
    return Number.isFinite(n) ? `0x${n.toString(16)}` : '';
}

function boardBar(ctx) {
    const draft = ctx.getDraft();
    const board = draft.fqbn ? findBoard(draft.fqbn) : null;
    const target = ctx.getTarget();
    return `
        <div class="tool-board">
            ${icon('cpu', 18)}
            <div>
                <b>${escapeHtml(board ? board.name : t('No board selected'))}</b>
                <div class="dim small">${escapeHtml(board ? `${draft.fqbn}${target ? ` - ${target.driver}` : ''}` : t('Operations use the board and options selected in the Flash tab'))}</div>
            </div>
            <button class="btn sm" data-tb="pick">${escapeHtml(t('Change board'))}</button>
        </div>`;
}

function trackJobs(ids, onDone) {
    const pending = new Set(ids);
    const off = flashEvents.on('job', (job) => {
        if (!pending.has(job.id)) return;
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
            pending.delete(job.id);
            onDone(job);
            if (!pending.size) off();
        }
    });
    return off;
}

export class FilesystemTab {
    constructor(host, ctx) {
        this.host = host;
        this.ctx = ctx;
        const ui = getFlashUiState().fsTab || {};
        this.state = {
            fsType: ui.fsType || 'littlefs',
            layoutSource: ui.layoutSource || 'board',
            offset: ui.offset || '',
            size: ui.size || '',
            source: ui.source || 'folder',
            sourceDir: ui.sourceDir || '',
            imageFile: ui.imageFile || '',
            outDir: ui.outDir || '',
            keepImage: !!ui.keepImage
        };
        this.lastResult = null;
        this.rendered = false;
        host.addEventListener('click', (e) => this.onClick(e));
        host.addEventListener('change', (e) => this.onChange(e));
        flashEvents.on('target', () => { if (this.rendered) this.renderLayout(); });
    }

    save() {
        setFlashUiState({ fsTab: { ...this.state } });
    }

    onShow() {
        if (!this.rendered) this.render();
        else {
            this.host.querySelector('.tool-board-wrap').innerHTML = boardBar(this.ctx);
            this.renderLayout();
        }
    }

    render() {
        this.rendered = true;
        const s = this.state;
        this.host.innerHTML = `
            <div class="tools-page">
                <div class="tool-board-wrap">${boardBar(this.ctx)}</div>
                <div class="tools-cols">
                    <div class="tools-main">
                        <section class="card">
                            <h3>${escapeHtml(t('Filesystem'))}</h3>
                            <div class="grid3">
                                <label class="field"><span>${escapeHtml(t('Type'))}</span>
                                    <select class="input" data-s="fsType">${[['littlefs', 'LittleFS'], ['spiffs', 'SPIFFS'], ['ffat', 'FFat (FAT)']].map(([v, l]) => `<option value="${v}" ${s.fsType === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
                                </label>
                                <label class="field"><span>${escapeHtml(t('Partition layout'))}</span>
                                    <select class="input" data-s="layoutSource">${[['board', t('From board options')], ['device', t('Read from device (ESP32)')], ['custom', t('Custom offset and size')]].map(([v, l]) => `<option value="${v}" ${s.layoutSource === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
                                </label>
                                <div class="row gap fs-custom ${s.layoutSource === 'custom' ? '' : 'hidden'}">
                                    <label class="field"><span>${escapeHtml(t('Offset'))}</span><input class="input mono" data-s="offset" value="${escapeHtml(s.offset)}" placeholder="0x290000"></label>
                                    <label class="field"><span>${escapeHtml(t('Size'))}</span><input class="input mono" data-s="size" value="${escapeHtml(s.size)}" placeholder="0x160000"></label>
                                </div>
                            </div>
                            <div class="fs-layout small"></div>
                        </section>
                        <section class="card">
                            <h3>${escapeHtml(t('Upload to boards'))}</h3>
                            <div class="seg">
                                <button class="seg-btn ${s.source === 'folder' ? 'active' : ''}" data-tb="source" data-v="folder">${escapeHtml(t('From folder'))}</button>
                                <button class="seg-btn ${s.source === 'image' ? 'active' : ''}" data-tb="source" data-v="image">${escapeHtml(t('From image file'))}</button>
                            </div>
                            <div class="file-cell">
                                <input class="input" data-s="${s.source === 'folder' ? 'sourceDir' : 'imageFile'}" value="${escapeHtml(s.source === 'folder' ? s.sourceDir : s.imageFile)}" placeholder="${escapeHtml(s.source === 'folder' ? t('Folder whose content becomes the filesystem root') : t('Filesystem image (.bin)'))}">
                                <button class="btn sm" data-tb="${s.source === 'folder' ? 'browse-src' : 'browse-img'}">${escapeHtml(t('Browse...'))}</button>
                            </div>
                            <div class="row gap">
                                <button class="btn btn-primary" data-tb="upload">${icon('upload', 14)}<span>${escapeHtml(t('Upload filesystem'))}</span></button>
                                ${s.source === 'folder' ? `<button class="btn" data-tb="build">${escapeHtml(t('Build image only...'))}</button>` : ''}
                            </div>
                        </section>
                        <section class="card">
                            <h3>${escapeHtml(t('Download from board'))}</h3>
                            <p class="dim small">${escapeHtml(t('Reads the filesystem partition and extracts every file (ESP32 and ESP8266). Uses the first selected port.'))}</p>
                            <div class="file-cell">
                                <input class="input" data-s="outDir" value="${escapeHtml(s.outDir)}" placeholder="${escapeHtml(t('Destination folder'))}">
                                <button class="btn sm" data-tb="browse-out">${escapeHtml(t('Browse...'))}</button>
                            </div>
                            <label class="check"><input type="checkbox" data-s="keepImage" ${s.keepImage ? 'checked' : ''}><span>${escapeHtml(t('Also keep the raw partition image'))}</span></label>
                            <button class="btn" data-tb="download">${icon('download', 14)}<span>${escapeHtml(t('Download and extract'))}</span></button>
                            <div class="fs-result"></div>
                        </section>
                    </div>
                    <div class="tools-side">
                        <section class="card">
                            <h3>${escapeHtml(t('Ports'))}</h3>
                            <div class="fs-ports"></div>
                        </section>
                    </div>
                </div>
            </div>`;
        this.ports = new PortSelector(this.host.querySelector('.fs-ports'), { multiple: true, initial: getFlashUiState().selectedPorts || [] });
        this.renderLayout();
        this.renderResult();
    }

    renderLayout() {
        const el = this.host.querySelector('.fs-layout');
        if (!el) return;
        const target = this.ctx.getTarget();
        if (this.state.layoutSource !== 'board') {
            el.innerHTML = this.state.layoutSource === 'device' ? `<span class="dim">${escapeHtml(t('The partition table is read from each board before writing'))}</span>` : '';
            return;
        }
        if (!target) {
            el.innerHTML = `<span class="dim">${escapeHtml(t('Select a board to see the filesystem area'))}</span>`;
            return;
        }
        const l = target.fs && target.fs[this.state.fsType];
        if (!l) {
            el.innerHTML = '';
            return;
        }
        el.innerHTML = l.error ? `<div class="notice warn">${escapeHtml(l.error)}</div>` : `<div class="notice ok">${escapeHtml(t('Partition'))} <b>${escapeHtml(l.partition || '-')}</b> ${escapeHtml(t('at'))} <span class="mono">${hex(l.offset)}</span>, ${escapeHtml(formatBytes(l.size))} (<span class="mono">${hex(l.size)}</span>)</div>`;
    }

    renderResult() {
        const el = this.host.querySelector('.fs-result');
        if (!el) return;
        const r = this.lastResult;
        if (!r) {
            el.innerHTML = '';
            return;
        }
        if (r.status !== 'done') {
            el.innerHTML = `<div class="notice error">${escapeHtml(r.error || t('Failed'))}</div>`;
            return;
        }
        const files = (r.result.fsFiles || []).filter(f => !f.dir);
        const total = files.reduce((a, f) => a + f.size, 0);
        el.innerHTML = `
            <div class="notice ok">
                <div class="row gap"><b>${escapeHtml(t('{n} files', { n: files.length }))}</b> <span class="dim">${escapeHtml(formatBytes(total))}</span><span class="spacer"></span><button class="btn sm" data-tb="open-out" data-dir="${escapeHtml(r.result.fsDir)}">${icon('folder', 14)}<span>${escapeHtml(t('Open folder'))}</span></button></div>
                <div class="fs-files mono small">${files.slice(0, 500).map(f => `<div><span>${escapeHtml(f.path)}</span><span class="dim">${escapeHtml(formatBytes(f.size))}</span></div>`).join('')}</div>
            </div>`;
    }

    params() {
        const s = this.state;
        const out = { fsType: s.fsType, layoutSource: s.layoutSource === 'device' ? 'device' : undefined };
        if (s.layoutSource === 'custom') {
            out.offset = s.offset;
            out.size = s.size;
        }
        return out;
    }

    requireBoard() {
        if (!this.ctx.getDraft().fqbn) {
            toast(t('Select a board first'), { type: 'error' });
            return false;
        }
        return true;
    }

    async onClick(e) {
        const b = e.target.closest('[data-tb]');
        if (!b) return;
        const s = this.state;
        switch (b.dataset.tb) {
            case 'pick': await this.ctx.pickBoard(); this.onShow(); break;
            case 'source': s.source = b.dataset.v; this.save(); this.render(); break;
            case 'browse-src': {
                const p = await invoke('files:select-folder', s.sourceDir || undefined);
                if (p) { s.sourceDir = p; this.save(); this.render(); }
                break;
            }
            case 'browse-img': {
                const p = await invoke('files:select-file', [{ name: t('Binary image'), extensions: ['bin', 'img'] }, { name: t('All files'), extensions: ['*'] }]);
                if (p) { s.imageFile = p; this.save(); this.render(); }
                break;
            }
            case 'browse-out': {
                const p = await invoke('files:select-folder', s.outDir || undefined);
                if (p) { s.outDir = p; this.save(); this.render(); }
                break;
            }
            case 'open-out': invoke('files:open-path', b.dataset.dir); break;
            case 'upload': {
                if (!this.requireBoard()) return;
                const ports = this.ports.getSelected().filter(Boolean);
                if (!ports.length) { toast(t('Select at least one port'), { type: 'error' }); return; }
                if (s.source === 'folder' ? !s.sourceDir : !s.imageFile) { toast(t('Select the filesystem source'), { type: 'error' }); return; }
                const profile = profileForJob(this.ctx.getDraft());
                const fs = { ...this.params(), sourceDir: s.source === 'folder' ? s.sourceDir : '', imageFile: s.source === 'image' ? s.imageFile : '' };
                await enqueueJobs(ports.map(port => ({ port, operation: 'fs-upload', profile, params: { fs }, label: `${s.fsType} upload` })));
                this.ctx.switchTab('jobs');
                break;
            }
            case 'build': {
                if (!this.requireBoard()) return;
                if (!s.sourceDir) { toast(t('Select the source folder'), { type: 'error' }); return; }
                const folder = await invoke('files:select-folder');
                if (!folder) return;
                const outFile = `${folder.replace(/[\\/]+$/, '')}${folder.includes('\\') ? '\\' : '/'}${s.fsType}_${Date.now()}.bin`;
                const port = this.ports.getSelected().find(Boolean) || null;
                if (s.layoutSource === 'device' && !port) { toast(t('Reading the layout from the device requires a port'), { type: 'error' }); return; }
                const ids = await enqueueJobs([{ port, operation: 'fs-build', profile: profileForJob(this.ctx.getDraft()), params: { ...this.params(), sourceDir: s.sourceDir, imageFile: '', outFile }, label: `${s.fsType} image` }]);
                trackJobs(ids, (job) => {
                    if (job.status === 'done') {
                        toast(t('Image built: {file}', { file: outFile }), { type: 'success' });
                        invoke('files:show-item', outFile);
                    } else {
                        toast(job.error || t('Image build failed'), { type: 'error' });
                    }
                });
                break;
            }
            case 'download': {
                if (!this.requireBoard()) return;
                const port = this.ports.getSelected().find(Boolean);
                if (!port) { toast(t('Select a port'), { type: 'error' }); return; }
                const params = { ...this.params() };
                if (s.outDir) params.outDir = `${s.outDir.replace(/[\\/]+$/, '')}${s.outDir.includes('\\') ? '\\' : '/'}${port.replace(/[^a-z0-9]/gi, '')}_${s.fsType}`;
                if (s.keepImage && s.outDir) params.keepImage = `${s.outDir.replace(/[\\/]+$/, '')}${s.outDir.includes('\\') ? '\\' : '/'}${port.replace(/[^a-z0-9]/gi, '')}_${s.fsType}.bin`;
                const ids = await enqueueJobs([{ port, operation: 'fs-download', profile: profileForJob(this.ctx.getDraft()), params, label: `${s.fsType} download` }]);
                this.lastResult = null;
                this.renderResult();
                const el = this.host.querySelector('.fs-result');
                el.innerHTML = `<div class="dim">${escapeHtml(t('Reading filesystem...'))}</div>`;
                trackJobs(ids, (job) => {
                    this.lastResult = job;
                    this.renderResult();
                });
                break;
            }
            default: break;
        }
    }

    onChange(e) {
        const key = e.target.dataset.s;
        if (!key) return;
        this.state[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
        this.save();
        if (key === 'layoutSource') {
            this.host.querySelector('.fs-custom').classList.toggle('hidden', this.state.layoutSource !== 'custom');
        }
        if (key === 'fsType' || key === 'layoutSource') this.renderLayout();
    }
}

export class ToolsTab {
    constructor(host, ctx) {
        this.host = host;
        this.ctx = ctx;
        const ui = getFlashUiState().toolsTab || {};
        this.state = {
            regionOffset: ui.regionOffset || '0x9000',
            regionSize: ui.regionSize || '0x5000',
            readOffset: ui.readOffset || '0x0',
            readSize: ui.readSize || 'ALL',
            readFolder: ui.readFolder || '',
            programmer: ui.programmer || ''
        };
        this.results = new Map();
        this.programmers = [];
        this.rendered = false;
        host.addEventListener('click', (e) => this.onClick(e));
        host.addEventListener('change', (e) => {
            const key = e.target.dataset.s;
            if (!key) return;
            this.state[key] = e.target.value.trim();
            setFlashUiState({ toolsTab: { ...this.state } });
        });
    }

    async onShow() {
        if (!this.rendered) this.render();
        else this.host.querySelector('.tool-board-wrap').innerHTML = boardBar(this.ctx);
        const fqbn = this.ctx.getDraft().fqbn;
        if (fqbn) {
            this.programmers = await invoke('flash:programmers', fqbn);
            this.renderProgrammers();
        }
    }

    render() {
        this.rendered = true;
        const s = this.state;
        this.host.innerHTML = `
            <div class="tools-page">
                <div class="tool-board-wrap">${boardBar(this.ctx)}</div>
                <div class="tools-cols">
                    <div class="tools-main">
                        <div class="tool-cards">
                            <section class="card tool-card">
                                <h3>${icon('info', 16)} ${escapeHtml(t('Chip information'))}</h3>
                                <p class="dim small">${escapeHtml(t('Chip model, revision, MAC address, flash size and PSRAM of every selected board.'))}</p>
                                <button class="btn btn-primary" data-tb="info">${escapeHtml(t('Read info'))}</button>
                            </section>
                            <section class="card tool-card">
                                <h3>${icon('trash', 16)} ${escapeHtml(t('Erase flash'))}</h3>
                                <p class="dim small">${escapeHtml(t('Erases the entire flash memory, including NVS, calibration and filesystem.'))}</p>
                                <button class="btn btn-danger" data-tb="erase">${escapeHtml(t('Erase all'))}</button>
                            </section>
                            <section class="card tool-card">
                                <h3>${icon('trash', 16)} ${escapeHtml(t('Erase region'))}</h3>
                                <div class="row gap">
                                    <label class="field"><span>${escapeHtml(t('Offset'))}</span><input class="input mono" data-s="regionOffset" value="${escapeHtml(s.regionOffset)}"></label>
                                    <label class="field"><span>${escapeHtml(t('Size'))}</span><input class="input mono" data-s="regionSize" value="${escapeHtml(s.regionSize)}"></label>
                                </div>
                                <div class="row gap">
                                    <button class="btn" data-tb="erase-region">${escapeHtml(t('Erase region'))}</button>
                                    <button class="tb-btn" data-tb="preset-nvs" title="${escapeHtml(t('Default NVS partition of ESP32 Arduino'))}">NVS</button>
                                    <button class="tb-btn" data-tb="preset-otadata" title="${escapeHtml(t('OTA data partition (boot the factory app again)'))}">otadata</button>
                                </div>
                            </section>
                            <section class="card tool-card">
                                <h3>${icon('download', 16)} ${escapeHtml(t('Read flash'))}</h3>
                                <div class="row gap">
                                    <label class="field"><span>${escapeHtml(t('Offset'))}</span><input class="input mono" data-s="readOffset" value="${escapeHtml(s.readOffset)}"></label>
                                    <label class="field"><span>${escapeHtml(t('Size'))}</span><input class="input mono" data-s="readSize" value="${escapeHtml(s.readSize)}" placeholder="ALL"></label>
                                </div>
                                <div class="file-cell"><input class="input" data-s="readFolder" value="${escapeHtml(s.readFolder)}" placeholder="${escapeHtml(t('Destination folder'))}"><button class="btn sm" data-tb="browse-read">${escapeHtml(t('Browse...'))}</button></div>
                                <button class="btn" data-tb="read">${escapeHtml(t('Read to file'))}</button>
                            </section>
                            <section class="card tool-card">
                                <h3>${icon('grid', 16)} ${escapeHtml(t('Partition table'))}</h3>
                                <p class="dim small">${escapeHtml(t('Reads the partition table of an ESP32 and opens it in the partition editor.'))}</p>
                                <button class="btn" data-tb="partitions">${escapeHtml(t('Read partition table'))}</button>
                            </section>
                            <section class="card tool-card">
                                <h3>${icon('bolt', 16)} ${escapeHtml(t('Burn bootloader'))}</h3>
                                <p class="dim small">${escapeHtml(t('Writes the bootloader and fuses with a programmer (AVR ISP, USBasp, Arduino as ISP...).'))}</p>
                                <label class="field"><span>${escapeHtml(t('Programmer'))}</span><select class="input" data-s="programmer"></select></label>
                                <button class="btn" data-tb="bootloader">${escapeHtml(t('Burn bootloader'))}</button>
                            </section>
                        </div>
                        <section class="card">
                            <h3>${escapeHtml(t('Results'))} <button class="tb-btn" data-tb="copy-results">${escapeHtml(t('Copy'))}</button> <button class="tb-btn" data-tb="clear-results">${escapeHtml(t('Clear'))}</button></h3>
                            <div class="tool-results"></div>
                        </section>
                    </div>
                    <div class="tools-side">
                        <section class="card">
                            <h3>${escapeHtml(t('Ports'))}</h3>
                            <div class="tool-ports"></div>
                        </section>
                    </div>
                </div>
            </div>`;
        this.ports = new PortSelector(this.host.querySelector('.tool-ports'), { multiple: true, allowNone: true, noneLabel: t('No port (programmer over USB)'), initial: getFlashUiState().selectedPorts || [] });
        this.renderProgrammers();
        this.renderResults();
    }

    renderProgrammers() {
        const select = this.host.querySelector('[data-s="programmer"]');
        if (!select) return;
        select.innerHTML = this.programmers.length
            ? this.programmers.map(p => `<option value="${escapeHtml(p.ref)}" ${p.ref === this.state.programmer ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
            : `<option value="">${escapeHtml(t('No programmer for this platform'))}</option>`;
        if (!this.state.programmer && this.programmers[0]) this.state.programmer = this.programmers[0].ref;
    }

    renderResults() {
        const el = this.host.querySelector('.tool-results');
        if (!el) return;
        const list = Array.from(this.results.values()).sort((a, b) => b.id - a.id);
        if (!list.length) {
            el.innerHTML = `<div class="dim">${escapeHtml(t('Results of the operations started here appear in this table.'))}</div>`;
            return;
        }
        const keys = ['chip', 'mac', 'flashSize', 'flashManufacturer', 'flashDevice', 'psram', 'crystal', 'features', 'signature', 'readFile', 'bootselDrives'];
        const used = keys.filter(k => list.some(j => j.result && j.result[k]));
        el.innerHTML = `
            <table class="table compact">
                <thead><tr><th>${escapeHtml(t('Port'))}</th><th>${escapeHtml(t('Operation'))}</th><th>${escapeHtml(t('Status'))}</th>${used.map(k => `<th>${escapeHtml(k)}</th>`).join('')}</tr></thead>
                <tbody>${list.map(j => `
                    <tr class="st-${j.status}">
                        <td>${escapeHtml(j.port || '-')}</td>
                        <td>${escapeHtml(j.operation)}</td>
                        <td>${escapeHtml(j.status === 'error' ? j.error || 'error' : j.status)}</td>
                        ${used.map(k => `<td class="mono">${escapeHtml(j.result && j.result[k] ? String(j.result[k]) : '')}</td>`).join('')}
                    </tr>`).join('')}
                </tbody>
            </table>`;
    }

    async run(operation, params = {}, { confirm, label, perPort } = {}) {
        if (!this.ctx.getDraft().fqbn) {
            toast(t('Select a board first'), { type: 'error' });
            return;
        }
        const ports = this.ports.getSelected();
        if (!ports.length) {
            toast(t('Select at least one port'), { type: 'error' });
            return;
        }
        if (confirm) {
            const ok = await confirmDialog(confirm.replace('{n}', ports.length), { danger: true, okLabel: t('Continue') });
            if (!ok) return;
        }
        const profile = profileForJob(this.ctx.getDraft());
        const ids = await enqueueJobs(ports.map(port => ({ port: port || null, operation, profile, params: perPort ? { ...params, ...perPort(port) } : params, label: label || operation })));
        for (const id of ids) {
            const job = getJob(id) || { id, port: null, operation, status: 'queued' };
            this.results.set(id, job);
        }
        this.renderResults();
        const off = flashEvents.on('job', (job) => {
            if (!this.results.has(job.id)) return;
            this.results.set(job.id, job);
            this.renderResults();
            if (operation === 'partitions-read' && job.status === 'done' && job.result && job.result.partitions) {
                flashEvents.emit('partitions-loaded', job.result.partitions, `${job.port}`);
                this.ctx.switchTab('partitions');
            }
        });
        setTimeout(off, 30 * 60 * 1000);
    }

    async onClick(e) {
        const b = e.target.closest('[data-tb]');
        if (!b) return;
        const s = this.state;
        switch (b.dataset.tb) {
            case 'pick': await this.ctx.pickBoard(); this.onShow(); break;
            case 'info': this.run('info', {}, { label: t('Chip info') }); break;
            case 'erase': this.run('erase', {}, { confirm: t('Erase the entire flash of {n} board(s)? This cannot be undone.'), label: t('Erase') }); break;
            case 'erase-region': {
                if (Number.isNaN(parseNum(s.regionOffset)) || Number.isNaN(parseNum(s.regionSize))) {
                    toast(t('Invalid offset or size'), { type: 'error' });
                    return;
                }
                this.run('erase-region', { offset: hex(parseNum(s.regionOffset)), size: hex(parseNum(s.regionSize)) }, { confirm: t('Erase {size} at {offset} on {n} board(s)?').replace('{size}', s.regionSize).replace('{offset}', s.regionOffset), label: t('Erase region') });
                break;
            }
            case 'preset-nvs':
                s.regionOffset = '0x9000';
                s.regionSize = '0x5000';
                setFlashUiState({ toolsTab: { ...s } });
                this.render();
                break;
            case 'preset-otadata':
                s.regionOffset = '0xe000';
                s.regionSize = '0x2000';
                setFlashUiState({ toolsTab: { ...s } });
                this.render();
                break;
            case 'browse-read': {
                const p = await invoke('files:select-folder', s.readFolder || undefined);
                if (p) { s.readFolder = p; setFlashUiState({ toolsTab: { ...s } }); this.render(); }
                break;
            }
            case 'read': {
                let folder = s.readFolder;
                if (!folder) {
                    folder = await invoke('files:select-folder');
                    if (!folder) return;
                    s.readFolder = folder;
                    setFlashUiState({ toolsTab: { ...s } });
                }
                const sep = folder.includes('\\') ? '\\' : '/';
                const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
                const size = !s.readSize || s.readSize.toUpperCase() === 'ALL' ? 'ALL' : hex(parseNum(s.readSize));
                this.run('read-flash', { offset: hex(parseNum(s.readOffset) || 0), size }, {
                    label: t('Read flash'),
                    perPort: (port) => ({ outFile: `${folder.replace(/[\\/]+$/, '')}${sep}${String(port || 'device').replace(/[^a-z0-9]/gi, '')}_${s.readOffset}_${stamp}.bin` })
                });
                break;
            }
            case 'partitions': this.run('partitions-read', {}, { label: t('Read partitions') }); break;
            case 'bootloader': {
                if (!s.programmer) {
                    toast(t('Select a programmer'), { type: 'error' });
                    return;
                }
                this.run('bootloader', { programmer: s.programmer }, { confirm: t('Burn the bootloader on {n} board(s)? Fuses will be written.'), label: t('Burn bootloader') });
                break;
            }
            case 'copy-results': {
                const lines = Array.from(this.results.values()).map(j => [j.port, j.operation, j.status, ...Object.entries(j.result || {}).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${v}`)].join('\t'));
                await navigator.clipboard.writeText(lines.join('\n'));
                toast(t('Results copied'));
                break;
            }
            case 'clear-results': this.results.clear(); this.renderResults(); break;
            default: break;
        }
    }
}

const PRESETS = {
    'default-4mb': ['Default 4MB with SPIFFS', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x140000\napp1,app,ota_1,0x150000,0x140000\nspiffs,data,spiffs,0x290000,0x160000\ncoredump,data,coredump,0x3F0000,0x10000'],
    'default-ffat': ['Default 4MB with FFat', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x140000\napp1,app,ota_1,0x150000,0x140000\nffat,data,fat,0x290000,0x160000\ncoredump,data,coredump,0x3F0000,0x10000'],
    'huge-app': ['Huge app (3MB, no OTA)', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x300000\nspiffs,data,spiffs,0x310000,0xE0000\ncoredump,data,coredump,0x3F0000,0x10000'],
    'min-spiffs': ['Minimal SPIFFS (1.9MB app with OTA)', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x1E0000\napp1,app,ota_1,0x1F0000,0x1E0000\nspiffs,data,spiffs,0x3D0000,0x20000\ncoredump,data,coredump,0x3F0000,0x10000'],
    'no-ota': ['No OTA (2MB app, 2MB SPIFFS)', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x200000\nspiffs,data,spiffs,0x210000,0x1E0000\ncoredump,data,coredump,0x3F0000,0x10000'],
    'default-8mb': ['8MB with SPIFFS', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x330000\napp1,app,ota_1,0x340000,0x330000\nspiffs,data,spiffs,0x670000,0x180000\ncoredump,data,coredump,0x7F0000,0x10000'],
    'default-16mb': ['16MB with FFat', 'nvs,data,nvs,0x9000,0x5000\notadata,data,ota,0xe000,0x2000\napp0,app,ota_0,0x10000,0x480000\napp1,app,ota_1,0x490000,0x480000\nffat,data,fat,0x910000,0x6E0000\ncoredump,data,coredump,0xFF0000,0x10000']
};

const SUBTYPES = {
    app: ['factory', 'ota_0', 'ota_1', 'ota_2', 'ota_3', 'test'],
    data: ['nvs', 'ota', 'phy', 'coredump', 'nvs_keys', 'efuse', 'fat', 'spiffs', 'littlefs', 'undefined']
};

const PART_COLORS = { app: '#4e8cff', nvs: '#ffb74d', ota: '#ba68c8', phy: '#90a4ae', coredump: '#e57373', fat: '#81c784', spiffs: '#4db6ac', littlefs: '#26a69a' };

export class PartitionsTab {
    constructor(host, ctx) {
        this.host = host;
        this.ctx = ctx;
        const ui = getFlashUiState().partitionsTab || {};
        this.rows = ui.rows || [];
        this.flashSize = ui.flashSize || 4 * 1024 * 1024;
        this.source = ui.source || '';
        this.errors = [];
        this.rendered = false;
        host.addEventListener('click', (e) => this.onClick(e));
        host.addEventListener('change', (e) => this.onChange(e));
        flashEvents.on('partitions-loaded', (rows, from) => {
            this.setRows(rows, t('Read from {port}', { port: from }));
        });
    }

    persist() {
        setFlashUiState({ partitionsTab: { rows: this.rows, flashSize: this.flashSize, source: this.source } });
    }

    onShow() {
        if (!this.rendered) this.render();
    }

    setRows(rows, source) {
        this.rows = rows.map(r => ({ name: r.name, type: r.type, subtype: r.subtype, offset: Number(r.offset), size: Number(r.size), flags: r.flags || '' }));
        this.source = source || '';
        const end = this.rows.reduce((m, r) => Math.max(m, r.offset + r.size), 0);
        for (const size of [1, 2, 4, 8, 16, 32].map(n => n * 1024 * 1024)) {
            if (end <= size) {
                if (end > this.flashSize) this.flashSize = size;
                break;
            }
        }
        this.persist();
        this.render();
    }

    async validate() {
        this.errors = this.rows.length ? await invoke('flash:partitions-validate', this.rows, this.flashSize) : [];
        const el = this.host.querySelector('.pt-errors');
        if (el) el.innerHTML = this.errors.length ? `<div class="notice error">${this.errors.map(e => `<div>${escapeHtml(e)}</div>`).join('')}</div>` : this.rows.length ? `<div class="notice ok">${escapeHtml(t('Partition table is valid'))}</div>` : '';
    }

    mapHtml() {
        const total = this.flashSize;
        const reserved = [{ name: 'boot', offset: 0, size: 0x8000, cls: 'reserved' }, { name: 'table', offset: 0x8000, size: 0x1000, cls: 'reserved' }];
        const blocks = [...reserved, ...this.rows.map((r, i) => ({ ...r, i }))].sort((a, b) => a.offset - b.offset);
        let used = 0;
        const segs = [];
        let pos = 0;
        for (const b of blocks) {
            if (b.offset > pos) segs.push({ free: true, offset: pos, size: b.offset - pos });
            segs.push(b);
            pos = Math.max(pos, b.offset + b.size);
            used += b.size;
        }
        if (pos < total) segs.push({ free: true, offset: pos, size: total - pos });
        return `
            <div class="pt-map">
                ${segs.map(s => {
                    const w = Math.max(0.4, (s.size / total) * 100);
                    if (s.free) return `<div class="pt-seg free" style="width:${w}%" title="${escapeHtml(t('Free'))} ${hex(s.offset)} ${formatBytes(s.size)}"></div>`;
                    const color = s.cls === 'reserved' ? '' : `background:${PART_COLORS[s.type === 'app' ? 'app' : s.subtype] || '#78909c'}`;
                    return `<div class="pt-seg ${s.cls || ''}" style="width:${w}%;${color}" title="${escapeHtml(s.name)} ${hex(s.offset)} ${formatBytes(s.size)}" ${s.i !== undefined ? `data-pi="${s.i}"` : ''}><span>${escapeHtml(s.name)}</span></div>`;
                }).join('')}
            </div>
            <div class="dim small">${escapeHtml(t('{used} used of {total}, {free} free', { used: formatBytes(Math.min(used, total)), total: formatBytes(total), free: formatBytes(Math.max(0, total - pos)) }))}</div>`;
    }

    render() {
        this.rendered = true;
        const target = this.ctx.getTarget();
        this.host.innerHTML = `
            <div class="tools-page">
                <div class="tool-board-wrap">${boardBar(this.ctx)}</div>
                <section class="card">
                    <div class="row gap wrap">
                        <h3>${escapeHtml(t('Partition table editor'))}</h3>
                        ${this.source ? `<span class="badge">${escapeHtml(this.source)}</span>` : ''}
                        <span class="spacer"></span>
                        <label class="inline">${escapeHtml(t('Flash size'))}
                            <select class="input sm" data-pt="flash-size">${[1, 2, 4, 8, 16, 32].map(n => `<option value="${n * 1024 * 1024}" ${this.flashSize === n * 1024 * 1024 ? 'selected' : ''}>${n} MB</option>`).join('')}</select>
                        </label>
                    </div>
                    <div class="row gap wrap pt-load">
                        <select class="input sm" data-pt="preset">
                            <option value="">${escapeHtml(t('Load a preset...'))}</option>
                            ${Object.entries(PRESETS).map(([id, [label]]) => `<option value="${id}">${escapeHtml(t(label))}</option>`).join('')}
                        </select>
                        <button class="btn sm" data-pa="from-board" ${target && target.partitions ? '' : 'disabled'}>${escapeHtml(t('From selected board scheme'))}</button>
                        <button class="btn sm" data-pa="import-csv">${escapeHtml(t('Import CSV...'))}</button>
                        <button class="btn sm" data-pa="import-bin">${escapeHtml(t('Import binary...'))}</button>
                        <button class="btn sm" data-pa="from-device">${escapeHtml(t('Read from device'))}</button>
                    </div>
                    <div class="pt-map-wrap">${this.mapHtml()}</div>
                    <table class="table pt-table">
                        <thead><tr><th>${escapeHtml(t('Name'))}</th><th>${escapeHtml(t('Type'))}</th><th>${escapeHtml(t('Subtype'))}</th><th>${escapeHtml(t('Offset'))}</th><th>${escapeHtml(t('Size'))}</th><th></th><th>${escapeHtml(t('Encrypted'))}</th><th></th></tr></thead>
                        <tbody>
                            ${this.rows.map((r, i) => `
                                <tr data-row="${i}">
                                    <td><input class="input sm" data-k="name" value="${escapeHtml(r.name)}" maxlength="16"></td>
                                    <td><select class="input sm" data-k="type">${['app', 'data'].map(v => `<option ${r.type === v ? 'selected' : ''}>${v}</option>`).join('')}${!['app', 'data'].includes(r.type) ? `<option selected>${escapeHtml(r.type)}</option>` : ''}</select></td>
                                    <td><input class="input sm" data-k="subtype" value="${escapeHtml(r.subtype)}" list="pt-sub-${r.type === 'app' ? 'app' : 'data'}"></td>
                                    <td><input class="input sm mono" data-k="offset" value="${hex(r.offset)}"></td>
                                    <td><input class="input sm mono" data-k="size" value="${hex(r.size)}"></td>
                                    <td class="dim small">${escapeHtml(formatBytes(r.size))}</td>
                                    <td><input type="checkbox" data-k="encrypted" ${/encrypted/.test(r.flags || '') ? 'checked' : ''}></td>
                                    <td class="nowrap">
                                        <button class="tb-btn icon-only" data-pa="up" data-i="${i}">${icon('up', 13)}</button>
                                        <button class="tb-btn icon-only" data-pa="down" data-i="${i}">${icon('down', 13)}</button>
                                        <button class="tb-btn icon-only" data-pa="del" data-i="${i}">${icon('trash', 13)}</button>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                    <datalist id="pt-sub-app">${SUBTYPES.app.map(s => `<option value="${s}">`).join('')}</datalist>
                    <datalist id="pt-sub-data">${SUBTYPES.data.map(s => `<option value="${s}">`).join('')}</datalist>
                    <div class="row gap wrap">
                        <button class="btn sm" data-pa="add">${icon('plus', 14)}<span>${escapeHtml(t('Add partition'))}</span></button>
                        <button class="btn sm" data-pa="pack" title="${escapeHtml(t('Recompute offsets sequentially with the required alignment'))}">${escapeHtml(t('Pack offsets'))}</button>
                        <button class="btn sm" data-pa="fill" title="${escapeHtml(t('Grow the last partition to the end of the flash'))}">${escapeHtml(t('Fill to end'))}</button>
                        <button class="btn sm" data-pa="clear">${escapeHtml(t('Clear'))}</button>
                        <span class="spacer"></span>
                        <button class="btn sm" data-pa="export-csv">${escapeHtml(t('Export CSV'))}</button>
                        <button class="btn sm" data-pa="export-bin">${escapeHtml(t('Export binary'))}</button>
                        <button class="btn sm btn-danger" data-pa="write">${escapeHtml(t('Write to device...'))}</button>
                    </div>
                    <div class="pt-errors"></div>
                </section>
                <section class="card">
                    <h3>${escapeHtml(t('Device'))}</h3>
                    <div class="pt-ports"></div>
                </section>
            </div>`;
        this.ports = new PortSelector(this.host.querySelector('.pt-ports'), { multiple: false, initial: (getFlashUiState().selectedPorts || []).filter(Boolean).slice(0, 1) });
        this.validate();
    }

    async loadCsvText(text, source) {
        const res = await invoke('flash:partitions-parse-csv', text);
        if (!res.success) {
            toast(res.error, { type: 'error' });
            return;
        }
        this.setRows(res.rows, source);
    }

    pack() {
        let next = 0x9000;
        for (const r of this.rows) {
            const align = r.type === 'app' ? 0x10000 : 0x1000;
            r.offset = Math.ceil(next / align) * align;
            next = r.offset + r.size;
        }
    }

    async onClick(e) {
        if (e.target.closest('[data-tb="pick"]')) {
            await this.ctx.pickBoard();
            this.render();
            return;
        }
        const b = e.target.closest('[data-pa]');
        if (!b) return;
        const i = b.dataset.i !== undefined ? parseInt(b.dataset.i, 10) : -1;
        switch (b.dataset.pa) {
            case 'from-board': {
                const target = this.ctx.getTarget();
                if (target && target.partitions) this.setRows(target.partitions, target.partitionScheme || t('Board scheme'));
                return;
            }
            case 'import-csv': {
                const file = await invoke('files:select-file', [{ name: 'CSV', extensions: ['csv'] }, { name: t('All files'), extensions: ['*'] }]);
                if (!file) return;
                const res = await invoke('files:read-text', file);
                if (res.success) this.loadCsvText(res.content, file.split(/[\\/]/).pop());
                return;
            }
            case 'import-bin': {
                const file = await invoke('files:select-file', [{ name: t('Binary'), extensions: ['bin'] }, { name: t('All files'), extensions: ['*'] }]);
                if (!file) return;
                const res = await invoke('flash:partitions-parse-binary', file);
                if (!res.success) toast(res.error, { type: 'error' });
                else this.setRows(res.rows, file.split(/[\\/]/).pop());
                return;
            }
            case 'from-device': {
                const port = this.ports.getSelected()[0];
                if (!this.ctx.getDraft().fqbn || !port) {
                    toast(t('Select an ESP32 board and a port'), { type: 'error' });
                    return;
                }
                const ids = await enqueueJobs([{ port, operation: 'partitions-read', profile: profileForJob(this.ctx.getDraft()), label: t('Read partitions') }]);
                toast(t('Reading partition table from {port}...', { port }));
                trackJobs(ids, (job) => {
                    if (job.status === 'done' && job.result && job.result.partitions) this.setRows(job.result.partitions, t('Read from {port}', { port }));
                    else toast(job.error || t('Failed'), { type: 'error' });
                });
                return;
            }
            case 'add': {
                const last = this.rows[this.rows.length - 1];
                const offset = last ? Math.ceil((last.offset + last.size) / 0x1000) * 0x1000 : 0x9000;
                this.rows.push({ name: `part${this.rows.length}`, type: 'data', subtype: 'spiffs', offset, size: 0x10000, flags: '' });
                break;
            }
            case 'del': this.rows.splice(i, 1); break;
            case 'up': if (i > 0) [this.rows[i - 1], this.rows[i]] = [this.rows[i], this.rows[i - 1]]; break;
            case 'down': if (i < this.rows.length - 1) [this.rows[i + 1], this.rows[i]] = [this.rows[i], this.rows[i + 1]]; break;
            case 'pack': this.pack(); break;
            case 'fill': {
                const last = this.rows.slice().sort((a, b) => a.offset - b.offset).pop();
                if (last) last.size = Math.max(0x1000, this.flashSize - last.offset);
                break;
            }
            case 'clear': this.rows = []; this.source = ''; break;
            case 'export-csv': {
                const csv = await invoke('flash:partitions-to-csv', this.rows);
                await invoke('files:save-text', csv, 'csv', 'partitions.csv');
                return;
            }
            case 'export-bin': {
                await this.validate();
                if (this.errors.length) {
                    toast(t('Fix the errors before exporting'), { type: 'error' });
                    return;
                }
                const bytes = await invoke('flash:partitions-to-binary', this.rows);
                await invoke('files:save-binary', bytes, 'bin', 'partitions.bin');
                return;
            }
            case 'write': {
                await this.validate();
                if (this.errors.length) {
                    toast(t('Fix the errors before writing'), { type: 'error' });
                    return;
                }
                const port = this.ports.getSelected()[0];
                if (!this.ctx.getDraft().fqbn || !port) {
                    toast(t('Select an ESP32 board and a port'), { type: 'error' });
                    return;
                }
                const ok = await confirmDialog(t('Write this partition table to {port}? Data in moved partitions will be lost and the firmware may need to be reflashed.', { port }), { danger: true, okLabel: t('Write') });
                if (!ok) return;
                await enqueueJobs([{ port, operation: 'partitions-write', profile: profileForJob(this.ctx.getDraft()), params: { rows: this.rows }, label: t('Write partitions') }]);
                this.ctx.switchTab('jobs');
                return;
            }
            default: return;
        }
        this.persist();
        this.render();
    }

    onChange(e) {
        if (e.target.dataset.pt === 'flash-size') {
            this.flashSize = parseInt(e.target.value, 10);
            this.persist();
            this.render();
            return;
        }
        if (e.target.dataset.pt === 'preset') {
            const preset = PRESETS[e.target.value];
            if (preset) this.loadCsvText(preset[1], t(preset[0]));
            return;
        }
        const tr = e.target.closest('[data-row]');
        if (!tr) return;
        const row = this.rows[parseInt(tr.dataset.row, 10)];
        const k = e.target.dataset.k;
        if (k === 'offset' || k === 'size') {
            const n = parseNum(e.target.value);
            if (Number.isNaN(n)) {
                toast(t('Invalid number'), { type: 'error' });
                e.target.value = hex(row[k]);
                return;
            }
            row[k] = n;
            e.target.value = hex(n);
            if (k === 'size') tr.children[5].textContent = formatBytes(n);
        } else if (k === 'encrypted') {
            row.flags = e.target.checked ? 'encrypted' : '';
        } else if (k === 'type') {
            row.type = e.target.value;
            if (!SUBTYPES[row.type].includes(row.subtype)) row.subtype = SUBTYPES[row.type][0];
            this.persist();
            this.render();
            return;
        } else if (k) {
            row[k] = e.target.value.trim();
        }
        this.persist();
        this.host.querySelector('.pt-map-wrap').innerHTML = this.mapHtml();
        this.validate();
    }
}
