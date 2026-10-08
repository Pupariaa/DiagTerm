import { escapeHtml, uid } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { getSetting } from '../core/settings.js';
import { toast, promptDialog, confirmDialog } from '../core/dialogs.js';
import { runCommand } from '../core/commands.js';
import { formatBytes } from '../core/format.js';
import { icon } from '../ui/icons.js';
import {
    flashEvents, initFlashState, getDraft, saveDraft, getProfiles, saveProfiles, normalizeProfile, profileForJob,
    loadBoards, findBoard, pushRecentBoard, enqueueJobs, getProduction, activeJobCount, getFlashUiState, setFlashUiState, allJobs
} from './flash-state.js';
import { pickBoard } from './board-picker.js';
import { PortSelector } from './port-select.js';
import { JobsPanel } from './jobs-panel.js';
import { FilesystemTab, ToolsTab, PartitionsTab } from './flash-tools.js';
import { BoardManagerTab } from './board-manager-view.js';

const TABS = [
    ['program', 'Flash', 'flash'],
    ['jobs', 'Jobs', 'stats'],
    ['fs', 'Filesystem', 'folder'],
    ['tools', 'Tools', 'cpu'],
    ['partitions', 'Partitions', 'grid'],
    ['boards', 'Board manager', 'download']
];

let root;
let currentTab = 'program';
let draft;
let target = null;
let targetError = null;
let inputInfo = null;
let portSelector = null;
let jobsPanel = null;
const tabs = {};
let describeSeq = 0;
let inputSeq = 0;

function setPath(obj, path, value) {
    const parts = path.split('.');
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
    return path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), obj);
}

function sel(path, list, extra = '') {
    const value = getPath(draft, path);
    return `<select class="input" data-f="${path}" ${extra}>${list.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`;
}

function chk(path, label, help = '') {
    return `<label class="check" ${help ? `title="${escapeHtml(help)}"` : ''}><input type="checkbox" data-f="${path}" ${getPath(draft, path) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

function txt(path, placeholder = '', cls = '') {
    return `<input class="input ${cls}" type="text" data-f="${path}" value="${escapeHtml(getPath(draft, path) ?? '')}" placeholder="${escapeHtml(placeholder)}" spellcheck="false">`;
}

function hexSize(n) {
    if (n === undefined || n === null || Number.isNaN(n)) return '-';
    return `0x${Number(n).toString(16)} (${formatBytes(Number(n))})`;
}

export function currentDraft() {
    return draft;
}

export function currentTarget() {
    return target;
}

export function updateDraft(mutator) {
    mutator(draft);
    saveDraft(draft);
}

async function refreshTarget() {
    const seq = ++describeSeq;
    target = null;
    targetError = null;
    if (!draft.fqbn) {
        renderTargetInfo();
        return;
    }
    const res = await invoke('flash:describe-target', draft.fqbn, draft.menus);
    if (seq !== describeSeq) return;
    if (res.success) {
        target = res.target;
        draft.menus = { ...res.target.selected };
        saveDraft(draft);
    } else {
        targetError = res.error;
    }
    renderTargetInfo();
    renderOptions();
    renderFs();
    refreshInput();
    flashEvents.emit('target', target);
}

async function refreshInput() {
    const seq = ++inputSeq;
    inputInfo = null;
    const input = draft.input;
    const hasInput = input.mode === 'images' ? (input.images || []).some(i => i.file) : !!input.path;
    if (!hasInput) {
        renderInputInfo();
        return;
    }
    const res = await invoke('flash:describe-input', profileForJob(draft).input, draft.fqbn || null, draft.menus);
    if (seq !== inputSeq) return;
    inputInfo = res;
    renderInputInfo();
}

function boardHeaderHtml() {
    const board = draft.fqbn ? findBoard(draft.fqbn) : null;
    return `
        <div class="fl-board">
            <button class="fl-board-btn" data-fa="pick-board">
                ${icon('cpu', 22)}
                <div>
                    <div class="fl-board-name">${escapeHtml(board ? board.name : draft.fqbn || t('Select a board...'))}</div>
                    <div class="dim small">${escapeHtml(board ? `${board.platform} ${board.version}` : draft.fqbn ? t('Package not installed') : t('ESP32, ESP8266, AVR, RP2040, SAMD, STM32, CH55x... from installed packages'))}</div>
                </div>
                ${icon('down', 14)}
            </button>
            ${draft.fqbn && !board ? `<button class="btn btn-primary" data-fa="manager">${escapeHtml(t('Install package'))}</button>` : ''}
        </div>
        <div class="fl-menus"></div>`;
}

function renderMenus() {
    const host = root.querySelector('.fl-menus');
    if (!host) return;
    const board = draft.fqbn ? findBoard(draft.fqbn) : null;
    if (!board || !board.menus || !board.menus.length) {
        host.innerHTML = '';
        return;
    }
    host.innerHTML = `<div class="fl-menu-grid">${board.menus.map(m => `
        <label class="fl-menu">
            <span>${escapeHtml(m.label)}</span>
            <select class="input sm" data-menu="${escapeHtml(m.id)}">${m.options.map(o => `<option value="${escapeHtml(o.id)}" ${(draft.menus[m.id] || m.options[0].id) === o.id ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
        </label>`).join('')}</div>`;
}

function renderTargetInfo() {
    const host = root.querySelector('.fl-target');
    if (!host) return;
    if (targetError) {
        host.innerHTML = `<div class="notice error">${escapeHtml(targetError)}</div>`;
        return;
    }
    if (!target) {
        host.innerHTML = '';
        return;
    }
    const chips = [
        [t('Driver'), target.driver],
        [t('Tool'), target.tool || '-'],
        target.mcu ? [t('MCU'), target.mcu] : null,
        target.uploadSpeed ? [t('Upload speed'), target.uploadSpeed] : null,
        target.flashSize ? [t('Flash size'), target.flashSize] : null,
        target.flashMode ? [t('Flash mode'), target.flashMode] : null,
        target.partitionScheme ? [t('Partitions'), target.partitionScheme] : null,
        target.use1200bps ? [t('Reset'), t('1200 bps touch')] : null,
        [t('Package'), `${target.platform}${target.source === 'arduino15' ? ' (Arduino15)' : ''}`]
    ].filter(Boolean);
    host.innerHTML = `<div class="kv-chips">${chips.map(([k, v]) => `<span class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></span>`).join('')}</div>`;
}

function renderInput() {
    const host = root.querySelector('.fl-input');
    if (!host) return;
    const mode = draft.input.mode;
    let body = '';
    if (mode === 'images') {
        const images = draft.input.images || [];
        body = `
            <table class="table compact fl-images">
                <thead><tr><th>${escapeHtml(t('Offset'))}</th><th>${escapeHtml(t('File'))}</th><th></th></tr></thead>
                <tbody>
                    ${images.map((img, i) => `
                        <tr>
                            <td><input class="input sm mono" data-img="${i}" data-k="offset" value="${escapeHtml(img.offset || '')}" placeholder="0x10000"></td>
                            <td><div class="file-cell"><input class="input sm" data-img="${i}" data-k="file" value="${escapeHtml(img.file || '')}" placeholder="${escapeHtml(t('Binary file'))}"><button class="tb-btn" data-fa="img-browse" data-i="${i}">${escapeHtml(t('Browse'))}</button></div></td>
                            <td><button class="tb-btn icon-only" data-fa="img-del" data-i="${i}">${icon('trash', 14)}</button></td>
                        </tr>`).join('')}
                </tbody>
            </table>
            <div class="row gap">
                <button class="btn sm" data-fa="img-add">${icon('plus', 14)}<span>${escapeHtml(t('Add image'))}</span></button>
                <button class="btn sm" data-fa="img-preset">${escapeHtml(t('ESP32 standard layout'))}</button>
            </div>`;
    } else {
        const isFolder = mode === 'folder';
        body = `
            <div class="file-cell">
                ${txt('input.path', isFolder ? t('Build folder exported from the Arduino IDE / PlatformIO / ESP-IDF') : t('Firmware file (.bin, .hex, .uf2, .elf)'))}
                <button class="btn sm" data-fa="${isFolder ? 'input-folder' : 'input-file'}">${escapeHtml(t('Browse...'))}</button>
            </div>
            ${mode === 'file' ? `<div class="row gap"><label class="inline">${escapeHtml(t('Offset (ESP .bin only)'))} ${txt('input.offset', 'auto', 'sm mono w120')}</label></div>` : ''}`;
    }
    host.innerHTML = `
        <div class="seg">
            ${[['folder', t('Build folder')], ['file', t('Single file')], ['merged', t('Merged image')], ['images', t('Custom images')]].map(([v, l]) => `<button class="seg-btn ${mode === v ? 'active' : ''}" data-fa="input-mode" data-v="${v}">${escapeHtml(l)}</button>`).join('')}
        </div>
        ${body}
        <div class="fl-input-info"></div>`;
    renderInputInfo();
}

function renderInputInfo() {
    const host = root.querySelector('.fl-input-info');
    if (!host) return;
    if (!inputInfo) {
        host.innerHTML = '';
        return;
    }
    if (!inputInfo.success) {
        host.innerHTML = `<div class="notice error">${escapeHtml(inputInfo.error)}</div>`;
        return;
    }
    const parts = [];
    if (inputInfo.build && inputInfo.build.projectName) parts.push(`<div class="small">${escapeHtml(t('Project'))}: <b>${escapeHtml(inputInfo.build.projectName)}</b> <span class="dim">${escapeHtml(inputInfo.build.folder || '')}</span></div>`);
    if (inputInfo.images && inputInfo.images.length) {
        parts.push(`<table class="table compact"><thead><tr><th>${escapeHtml(t('Offset'))}</th><th>${escapeHtml(t('File'))}</th><th>${escapeHtml(t('Size'))}</th></tr></thead><tbody>${inputInfo.images.map(i => `<tr><td class="mono">${escapeHtml(String(i.offset))}</td><td title="${escapeHtml(i.file)}">${escapeHtml(i.file.split(/[\\/]/).pop())}</td><td>${escapeHtml(formatBytes(i.size || 0))}</td></tr>`).join('')}</tbody></table>`);
    } else if (inputInfo.file) {
        parts.push(`<div class="small">${escapeHtml(t('File'))}: ${escapeHtml(inputInfo.file)}</div>`);
    } else if (inputInfo.build) {
        const b = inputInfo.build;
        const found = [['app', b.app], ['bootloader', b.bootloader], ['partitions', b.partitions], ['merged', b.merged], ['hex', b.hex], ['uf2', b.uf2], ['elf', b.elf]].filter(([, v]) => v).map(([k]) => k);
        parts.push(`<div class="small">${escapeHtml(t('Found'))}: ${escapeHtml(found.join(', ') || '-')}</div>`);
    }
    host.innerHTML = `<div class="notice ok">${parts.join('')}</div>`;
}

function renderFs() {
    const host = root.querySelector('.fl-fs');
    if (!host) return;
    const fs = draft.fs;
    const layout = target && target.fs ? target.fs[fs.fsType] : null;
    host.innerHTML = `
        ${chk('fs.enabled', t('Upload a filesystem with the firmware'))}
        <div class="fl-fs-body ${fs.enabled ? '' : 'hidden'}">
            <div class="grid2">
                <label class="field"><span>${escapeHtml(t('Type'))}</span>${sel('fs.fsType', [['littlefs', 'LittleFS'], ['spiffs', 'SPIFFS'], ['ffat', 'FFat (FAT)']])}</label>
                <label class="field"><span>${escapeHtml(t('Source'))}</span>${sel('fs.source', [['folder', t('Folder (image built automatically)')], ['image', t('Prebuilt image file')]])}</label>
            </div>
            <div class="file-cell">
                ${fs.source === 'folder' ? txt('fs.sourceDir', t('Data folder (for example the sketch "data" folder)')) : txt('fs.imageFile', t('Filesystem image (.bin)'))}
                <button class="btn sm" data-fa="${fs.source === 'folder' ? 'fs-folder' : 'fs-image'}">${escapeHtml(t('Browse...'))}</button>
            </div>
            <div class="grid2">
                <label class="field"><span>${escapeHtml(t('Partition layout'))}</span>${sel('fs.layoutSource', [['board', t('From board options')], ['device', t('Read from device (ESP32)')], ['custom', t('Custom offset and size')]])}</label>
                ${fs.layoutSource === 'custom' ? `<div class="row gap"><label class="field"><span>${escapeHtml(t('Offset'))}</span>${txt('fs.offset', '0x290000', 'mono')}</label><label class="field"><span>${escapeHtml(t('Size'))}</span>${txt('fs.size', '0x160000', 'mono')}</label></div>` : ''}
            </div>
            ${fs.layoutSource === 'board' && layout ? (layout.error ? `<div class="notice warn">${escapeHtml(layout.error)}</div>` : `<div class="small dim">${escapeHtml(t('Partition'))} ${escapeHtml(layout.partition || '')} ${escapeHtml(t('at'))} ${escapeHtml(hexSize(layout.offset))}, ${escapeHtml(t('size'))} ${escapeHtml(hexSize(layout.size))}</div>`) : ''}
        </div>`;
}

function renderOptions() {
    const host = root.querySelector('.fl-options');
    if (!host) return;
    const driver = target ? target.driver : '';
    const esp = driver === 'esptool';
    const rp = driver === 'rp2040';
    host.innerHTML = `
        <div class="checks">
            ${chk('eraseFirst', t('Erase entire flash first'), t('Removes NVS, Wi-Fi credentials and filesystem'))}
            ${chk('verify', t('Verify after writing'))}
            ${chk('verbose', t('Verbose tool output'))}
            ${chk('forceGeneric', t('Use the platform upload recipe (generic driver)'), t('Runs the exact upload command defined by the board package, like the Arduino IDE'))}
        </div>
        <div class="grid3">
            <label class="field"><span>${escapeHtml(t('Upload speed'))}</span><input class="input" list="fl-speeds" data-f="options.uploadSpeed" value="${escapeHtml(draft.options.uploadSpeed || '')}" placeholder="${escapeHtml(target && target.uploadSpeed ? target.uploadSpeed : t('Board default'))}"><datalist id="fl-speeds">${[115200, 230400, 460800, 921600, 1500000, 2000000].map(v => `<option value="${v}">`).join('')}</datalist></label>
            ${esp ? `
                <label class="field"><span>${escapeHtml(t('Chip'))}</span>${sel('options.chip', [['board', t('From board')], ['auto', t('Auto-detect')], ['esp32', 'ESP32'], ['esp32s2', 'ESP32-S2'], ['esp32s3', 'ESP32-S3'], ['esp32c3', 'ESP32-C3'], ['esp32c6', 'ESP32-C6'], ['esp32h2', 'ESP32-H2'], ['esp32p4', 'ESP32-P4'], ['esp8266', 'ESP8266']])}</label>
                <label class="field"><span>${escapeHtml(t('Flash mode'))}</span>${sel('options.flashMode', [['keep', t('Keep (from image)')], ['qio', 'QIO'], ['qout', 'QOUT'], ['dio', 'DIO'], ['dout', 'DOUT']])}</label>
                <label class="field"><span>${escapeHtml(t('Flash frequency'))}</span>${sel('options.flashFreq', [['keep', t('Keep (from image)')], ['80m', '80 MHz'], ['40m', '40 MHz'], ['26m', '26 MHz'], ['20m', '20 MHz']])}</label>
                <label class="field"><span>${escapeHtml(t('Flash size'))}</span>${sel('options.flashSize', [['keep', t('Keep (from image)')], ['detect', t('Detect')], ['1MB', '1 MB'], ['2MB', '2 MB'], ['4MB', '4 MB'], ['8MB', '8 MB'], ['16MB', '16 MB'], ['32MB', '32 MB']])}</label>
                ${chk('options.compress', t('Compressed transfer'))}` : ''}
            ${rp ? `<label class="field"><span>${escapeHtml(t('Upload method'))}</span>${sel('options.method', [['touch', t('Reboot via 1200 bps touch')], ['bootsel', t('Board already in BOOTSEL mode')]])}</label>` : ''}
        </div>`;
}

function profilesBarHtml() {
    const profiles = getProfiles();
    return `
        <div class="fl-profiles">
            <select class="input" data-fa-change="profile">
                <option value="">${escapeHtml(t('Unsaved configuration'))}</option>
                ${profiles.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === draft.id && draft.name ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>
            <button class="btn sm" data-fa="profile-save" ${draft.name ? '' : 'disabled'}>${icon('save', 14)}<span>${escapeHtml(t('Save'))}</span></button>
            <button class="btn sm" data-fa="profile-save-as">${escapeHtml(t('Save as...'))}</button>
            <button class="btn sm" data-fa="profile-delete" ${draft.name ? '' : 'disabled'}>${icon('trash', 14)}</button>
            <button class="btn sm" data-fa="profile-export" title="${escapeHtml(t('Export profiles'))}">${icon('download', 14)}</button>
            <button class="btn sm" data-fa="profile-import" title="${escapeHtml(t('Import profiles'))}">${icon('upload', 14)}</button>
        </div>`;
}

function renderProduction() {
    const host = root.querySelector('.fl-production');
    if (!host) return;
    const prod = getProduction();
    const filters = getSetting('flash.productionFilters', []) || [];
    const ui = getFlashUiState();
    host.innerHTML = `
        <div class="fl-prod ${prod.active ? 'active' : ''}">
            <div class="fl-prod-head">
                <div>
                    <b>${escapeHtml(t('Production mode'))}</b>
                    <div class="dim small">${escapeHtml(t('Every board plugged in is flashed automatically with the current configuration.'))}</div>
                </div>
                <button class="btn ${prod.active ? 'btn-danger' : 'btn-primary'}" data-fa="production">${escapeHtml(prod.active ? t('Stop') : t('Start'))}</button>
            </div>
            <div class="small">
                ${filters.length ? escapeHtml(t('Filters: {list}', { list: filters.map(f => [f.vid && f.pid ? `${f.vid}:${f.pid}` : f.vid || f.pid, f.serialPrefix ? `SN ${f.serialPrefix}*` : '', f.manufacturer].filter(Boolean).join(' ')).join(' | ') })) : escapeHtml(t('No USB filter: every new port is flashed.'))}
                <a href="#" data-fa="prod-filters">${escapeHtml(t('Edit filters'))}</a>
            </div>
            <label class="check small"><input type="checkbox" data-fa-change="prod-existing" ${ui.productionIncludeExisting ? 'checked' : ''}><span>${escapeHtml(t('Also flash boards already connected when starting'))}</span></label>
            ${prod.active || prod.stats.queued ? `
                <div class="fl-prod-stats">
                    <span class="stat"><b>${prod.stats.queued}</b> ${escapeHtml(t('detected'))}</span>
                    <span class="stat ok"><b>${prod.stats.done}</b> ${escapeHtml(t('succeeded'))}</span>
                    <span class="stat err"><b>${prod.stats.failed}</b> ${escapeHtml(t('failed'))}</span>
                    ${prod.active && prod.profileName ? `<span class="dim">${escapeHtml(t('Profile'))}: ${escapeHtml(prod.profileName)}</span>` : ''}
                </div>` : ''}
        </div>`;
}

function renderStartButton() {
    const btn = root.querySelector('[data-fa="start"]');
    if (!btn) return;
    const ports = portSelector ? portSelector.getSelected() : [];
    const n = ports.length;
    const ready = !!draft.fqbn && n > 0;
    btn.disabled = !ready;
    btn.querySelector('span').textContent = n > 1 ? t('Flash {n} boards', { n }) : n === 1 ? (ports[0] ? t('Flash {port}', { port: ports[0] }) : t('Flash')) : t('Select at least one port');
    const hint = root.querySelector('.fl-start-hint');
    if (hint) {
        const steps = [];
        if (draft.eraseFirst) steps.push(t('erase'));
        if (draft.input.path || (draft.input.mode === 'images' && draft.input.images.some(i => i.file))) steps.push(t('firmware'));
        if (draft.fs.enabled) steps.push(draft.fs.fsType);
        if (draft.verify) steps.push(t('verify'));
        hint.textContent = !draft.fqbn ? t('Select a board first') : steps.length ? `${t('Steps')}: ${steps.join(' > ')}` : t('Nothing to flash: select a firmware or enable the filesystem');
    }
}

function renderProgramTab(host) {
    host.innerHTML = `
        <div class="fl-program">
            <div class="fl-config">
                ${profilesBarHtml()}
                <section class="card">
                    <h3>${escapeHtml(t('Board'))}</h3>
                    <div class="fl-board-wrap">${boardHeaderHtml()}</div>
                    <div class="fl-target"></div>
                </section>
                <section class="card">
                    <h3>${escapeHtml(t('Firmware'))}</h3>
                    <div class="fl-input"></div>
                </section>
                <section class="card">
                    <h3>${escapeHtml(t('Filesystem'))}</h3>
                    <div class="fl-fs"></div>
                </section>
                <section class="card">
                    <h3>${escapeHtml(t('Options'))}</h3>
                    <div class="fl-options"></div>
                </section>
            </div>
            <div class="fl-side">
                <section class="card fl-ports-card">
                    <h3>${escapeHtml(t('Target ports'))}</h3>
                    <div class="fl-ports"></div>
                </section>
                <section class="card fl-start-card">
                    <button class="btn btn-primary btn-lg" data-fa="start">${icon('flash', 18)}<span></span></button>
                    <div class="fl-start-hint dim small"></div>
                </section>
                <section class="card fl-production"></section>
            </div>
        </div>`;
    if (portSelector) portSelector.dispose();
    const ui = getFlashUiState();
    portSelector = new PortSelector(host.querySelector('.fl-ports'), {
        multiple: true,
        allowNone: true,
        initial: ui.selectedPorts || [],
        onChange: (list) => {
            setFlashUiState({ selectedPorts: list });
            renderStartButton();
        }
    });
    renderMenus();
    renderTargetInfo();
    renderInput();
    renderFs();
    renderOptions();
    renderProduction();
    renderStartButton();
}

async function startFlash() {
    const ports = portSelector.getSelected();
    if (!draft.fqbn || !ports.length) return;
    const profile = profileForJob(draft);
    if (!profile.input.path && !(profile.input.images || []).length && !(profile.fs.enabled && (profile.fs.sourceDir || profile.fs.imageFile)) && !profile.eraseFirst) {
        toast(t('Select a firmware, a filesystem or enable erase'), { type: 'error' });
        return;
    }
    const busyPorts = new Set(allJobs().filter(j => j.status === 'running' || j.status === 'queued').map(j => j.currentPort || j.port));
    const busy = ports.filter(p => p && busyPorts.has(p));
    if (busy.length) {
        const ok = await confirmDialog(t('{list} already have a running job. Queue anyway?', { list: busy.join(', ') }), { okLabel: t('Queue') });
        if (!ok) return;
    }
    pushRecentBoard(draft.fqbn);
    const label = draft.name || (findBoard(draft.fqbn) || {}).name || draft.fqbn;
    await enqueueJobs(ports.map(port => ({ port: port || null, operation: 'program', profile: { ...profile, name: label }, label })));
    switchTab('jobs');
}

async function toggleProduction() {
    const prod = getProduction();
    if (prod.active) {
        await invoke('flash:production-stop');
        return;
    }
    if (!draft.fqbn) {
        toast(t('Select a board first'), { type: 'error' });
        return;
    }
    const profile = profileForJob(draft);
    const ok = await confirmDialog(t('Start production mode? Every matching board plugged in will be flashed with "{name}".', { name: draft.name || (findBoard(draft.fqbn) || {}).name || draft.fqbn }), { okLabel: t('Start') });
    if (!ok) return;
    await invoke('flash:production-start', {
        profile: { ...profile, name: draft.name || (findBoard(draft.fqbn) || {}).name || draft.fqbn },
        includeExisting: !!getFlashUiState().productionIncludeExisting
    });
    switchTab('jobs');
}

async function browse(kind) {
    if (kind === 'folder') return invoke('files:select-folder');
    const filters = kind === 'fw'
        ? [{ name: t('Firmware'), extensions: ['bin', 'hex', 'uf2', 'elf', 'dfu', 'zip'] }, { name: t('All files'), extensions: ['*'] }]
        : [{ name: t('Binary image'), extensions: ['bin', 'img'] }, { name: t('All files'), extensions: ['*'] }];
    return invoke('files:select-file', filters);
}

async function onAction(btn) {
    const act = btn.dataset.fa;
    switch (act) {
        case 'pick-board': {
            const fqbn = await pickBoard({ current: draft.fqbn, portHint: (portSelector && portSelector.getSelected()[0]) || null });
            if (!fqbn) return;
            if (fqbn !== draft.fqbn) {
                draft.fqbn = fqbn;
                draft.menus = {};
                pushRecentBoard(fqbn);
                saveDraft(draft);
                renderProgramTab(tabs.program);
                refreshTarget();
            }
            break;
        }
        case 'manager': switchTab('boards'); break;
        case 'input-mode':
            draft.input.mode = btn.dataset.v;
            if (draft.input.mode === 'images' && !draft.input.images.length) draft.input.images = [{ offset: '0x10000', file: draft.input.path || '' }];
            saveDraft(draft);
            renderInput();
            refreshInput();
            renderStartButton();
            break;
        case 'input-folder': {
            const p = await browse('folder');
            if (!p) return;
            draft.input.path = p;
            saveDraft(draft);
            renderInput();
            refreshInput();
            renderStartButton();
            break;
        }
        case 'input-file': {
            const p = await browse('fw');
            if (!p) return;
            draft.input.path = p;
            if (/\.merged\.bin$/i.test(p)) draft.input.mode = 'merged';
            saveDraft(draft);
            renderInput();
            refreshInput();
            renderStartButton();
            break;
        }
        case 'img-add':
            draft.input.images.push({ offset: '', file: '' });
            saveDraft(draft);
            renderInput();
            break;
        case 'img-del':
            draft.input.images.splice(parseInt(btn.dataset.i, 10), 1);
            saveDraft(draft);
            renderInput();
            refreshInput();
            break;
        case 'img-browse': {
            const p = await browse('bin');
            if (!p) return;
            draft.input.images[parseInt(btn.dataset.i, 10)].file = p;
            saveDraft(draft);
            renderInput();
            refreshInput();
            renderStartButton();
            break;
        }
        case 'img-preset': {
            const boot = target && target.bootloaderAddr ? target.bootloaderAddr : '0x1000';
            const existing = new Map((draft.input.images || []).map(i => [i.offset, i.file]));
            draft.input.images = [[boot, 'bootloader'], ['0x8000', 'partitions'], ['0xe000', 'boot_app0'], ['0x10000', 'app']].map(([offset]) => ({ offset, file: existing.get(offset) || '' }));
            saveDraft(draft);
            renderInput();
            break;
        }
        case 'fs-folder': {
            const p = await browse('folder');
            if (!p) return;
            draft.fs.sourceDir = p;
            saveDraft(draft);
            renderFs();
            renderStartButton();
            break;
        }
        case 'fs-image': {
            const p = await browse('bin');
            if (!p) return;
            draft.fs.imageFile = p;
            saveDraft(draft);
            renderFs();
            renderStartButton();
            break;
        }
        case 'start': startFlash(); break;
        case 'production': toggleProduction(); break;
        case 'prod-filters': {
            const { openSettingsCategory } = await import('../ui/settings-view.js');
            runCommand('view.settings');
            openSettingsCategory('flash');
            break;
        }
        case 'profile-save': {
            const list = getProfiles();
            const idx = list.findIndex(p => p.id === draft.id);
            const copy = JSON.parse(JSON.stringify(draft));
            if (idx >= 0) list[idx] = copy;
            else list.push(copy);
            saveProfiles(list);
            toast(t('Profile "{name}" saved', { name: draft.name }), { type: 'success' });
            break;
        }
        case 'profile-save-as': {
            const name = await promptDialog({ title: t('Save flash profile'), label: t('Profile name'), value: draft.name || (findBoard(draft.fqbn) || {}).name || '' });
            if (!name || !name.trim()) return;
            draft.id = uid();
            draft.name = name.trim();
            const list = getProfiles().filter(p => p.name !== draft.name);
            list.push(JSON.parse(JSON.stringify(draft)));
            list.sort((a, b) => a.name.localeCompare(b.name));
            saveProfiles(list);
            saveDraft(draft);
            renderProgramTab(tabs.program);
            break;
        }
        case 'profile-delete': {
            const ok = await confirmDialog(t('Delete profile "{name}"?', { name: draft.name }), { danger: true, okLabel: t('Delete') });
            if (!ok) return;
            saveProfiles(getProfiles().filter(p => p.id !== draft.id));
            draft.name = '';
            draft.id = uid();
            saveDraft(draft);
            renderProgramTab(tabs.program);
            break;
        }
        case 'profile-export':
            await invoke('files:save-text', JSON.stringify(getProfiles(), null, 2), 'json', 'diagterm-flash-profiles.json');
            break;
        case 'profile-import': {
            const file = await invoke('files:select-file', [{ name: 'JSON', extensions: ['json'] }]);
            if (!file) return;
            const res = await invoke('files:read-text', file);
            if (!res.success) return;
            try {
                const data = JSON.parse(res.content);
                const incoming = (Array.isArray(data) ? data : [data]).filter(p => p && p.fqbn);
                const list = getProfiles();
                for (const p of incoming) {
                    const norm = normalizeProfile({ ...p, id: p.id || uid(), name: p.name || p.fqbn });
                    const idx = list.findIndex(x => x.id === norm.id || x.name === norm.name);
                    if (idx >= 0) list[idx] = norm;
                    else list.push(norm);
                }
                saveProfiles(list);
                renderProgramTab(tabs.program);
                toast(t('{n} profiles imported', { n: incoming.length }), { type: 'success' });
            } catch (error) {
                toast(t('Invalid profile file'), { type: 'error' });
            }
            break;
        }
        default: break;
    }
}

function onFieldChange(target) {
    if (target.dataset.menu) {
        draft.menus[target.dataset.menu] = target.value;
        saveDraft(draft);
        refreshTarget();
        return;
    }
    if (target.dataset.img !== undefined) {
        const i = parseInt(target.dataset.img, 10);
        draft.input.images[i][target.dataset.k] = target.value.trim();
        saveDraft(draft);
        refreshInput();
        renderStartButton();
        return;
    }
    if (target.dataset.faChange === 'profile') {
        const p = getProfiles().find(x => x.id === target.value);
        if (p) {
            draft = normalizeProfile(JSON.parse(JSON.stringify(p)));
        } else {
            draft = normalizeProfile({ ...draft, id: uid(), name: '' });
        }
        saveDraft(draft);
        renderProgramTab(tabs.program);
        refreshTarget();
        return;
    }
    if (target.dataset.faChange === 'prod-existing') {
        setFlashUiState({ productionIncludeExisting: target.checked });
        return;
    }
    const path = target.dataset.f;
    if (!path) return;
    const value = target.type === 'checkbox' ? target.checked : target.value;
    setPath(draft, path, typeof value === 'string' ? value.trim() : value);
    saveDraft(draft);
    if (path.startsWith('fs.')) renderFs();
    if (path === 'input.path' || path === 'input.offset') refreshInput();
    renderStartButton();
}

export function switchTab(id) {
    currentTab = id;
    setFlashUiState({ tab: id });
    if (!root) return;
    root.querySelectorAll('.fv-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    root.querySelectorAll('.fv-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== id));
    const tab = tabs[id];
    if (tab && tab.onShow) tab.onShow();
    if (id === 'jobs' && jobsPanel) jobsPanel.onShow();
}

function updateTabBadges() {
    if (!root) return;
    const n = activeJobCount();
    const badge = root.querySelector('.fv-tab[data-tab="jobs"] .badge');
    if (badge) {
        badge.textContent = n;
        badge.classList.toggle('hidden', !n);
    }
}

export async function initFlashView(host) {
    root = host;
    await initFlashState();
    draft = getDraft();
    const ui = getFlashUiState();
    currentTab = ui.tab || 'program';
    root.innerHTML = `
        <div class="flash-view">
            <div class="fv-tabs">
                ${TABS.map(([id, label, ic]) => `<button class="fv-tab ${id === currentTab ? 'active' : ''}" data-tab="${id}">${icon(ic, 15)}<span>${escapeHtml(t(label))}</span>${id === 'jobs' ? '<span class="badge hidden">0</span>' : ''}</button>`).join('')}
            </div>
            <div class="fv-body">
                ${TABS.map(([id]) => `<div class="fv-pane ${id === currentTab ? '' : 'hidden'}" data-pane="${id}"></div>`).join('')}
            </div>
        </div>`;
    root.querySelector('.fv-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('.fv-tab');
        if (b) switchTab(b.dataset.tab);
    });
    tabs.program = root.querySelector('[data-pane="program"]');
    tabs.program.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-fa]');
        if (!btn) return;
        if (btn.tagName === 'A') e.preventDefault();
        onAction(btn);
    });
    tabs.program.addEventListener('change', (e) => onFieldChange(e.target));
    jobsPanel = new JobsPanel(root.querySelector('[data-pane="jobs"]'));
    const ctx = { getDraft: () => draft, getTarget: () => target, switchTab, pickBoard: async () => {
        const fqbn = await pickBoard({ current: draft.fqbn });
        if (fqbn && fqbn !== draft.fqbn) {
            draft.fqbn = fqbn;
            draft.menus = {};
            saveDraft(draft);
            renderProgramTab(tabs.program);
            await refreshTarget();
        }
    } };
    tabs.fs = new FilesystemTab(root.querySelector('[data-pane="fs"]'), ctx);
    tabs.tools = new ToolsTab(root.querySelector('[data-pane="tools"]'), ctx);
    tabs.partitions = new PartitionsTab(root.querySelector('[data-pane="partitions"]'), ctx);
    tabs.boards = new BoardManagerTab(root.querySelector('[data-pane="boards"]'));
    renderProgramTab(tabs.program);
    flashEvents.on('boards', () => {
        const wrap = root.querySelector('.fl-board-wrap');
        if (!wrap) return;
        wrap.innerHTML = boardHeaderHtml();
        renderMenus();
        if (draft.fqbn) refreshTarget();
    });
    flashEvents.on('production', () => renderProduction());
    flashEvents.on('jobs', () => updateTabBadges());
    flashEvents.on('profiles', () => {
        const bar = tabs.program.querySelector('.fl-profiles');
        if (bar) bar.outerHTML = profilesBarHtml();
    });
    flashEvents.on('enqueued', () => updateTabBadges());
    updateTabBadges();
    await loadBoards();
    if (draft.fqbn) refreshTarget();
    if (currentTab !== 'program') switchTab(currentTab);
}

export function onFlashViewShown() {
    if (!root) return;
    loadBoards().then(() => renderMenus());
    if (tabs[currentTab] && tabs[currentTab].onShow) tabs[currentTab].onShow();
    if (currentTab === 'jobs' && jobsPanel) jobsPanel.onShow();
}
