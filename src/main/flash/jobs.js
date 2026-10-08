const { ipcMain, Notification } = require('electron');
const fs = require('fs');
const { bus, send } = require('../context');
const settings = require('../settings');
const manager = require('../serial/manager');
const boardManager = require('./board-manager');
const boards = require('./boards');
const inputs = require('./inputs');
const partitions = require('./partitions');
const fsImage = require('./fs');
const esptool = require('./drivers/esptool');
const avrdude = require('./drivers/avrdude');
const rp2040 = require('./drivers/rp2040');
const generic = require('./drivers/generic');
const { sleep } = require('./serial-utils');

const jobs = new Map();
const queue = [];
let nextId = 1;
let running = 0;
const production = { active: false, profile: null, filters: [], seen: new Map(), stats: { queued: 0, done: 0, failed: 0 } };

function driverName(resolved) {
    const tool = resolved.tool || '';
    if (/esptool/i.test(tool)) return 'esptool';
    if (/^avrdude$/i.test(tool)) return 'avrdude';
    if (resolved.platform.arch === 'rp2040' || /uf2conv|picotool/i.test(tool)) return 'rp2040';
    return 'generic';
}

function publicJob(job) {
    return {
        id: job.id,
        port: job.port,
        currentPort: job.currentPort,
        operation: job.operation,
        label: job.label,
        profileName: job.profileName,
        fqbn: job.fqbn,
        boardName: job.boardName,
        driver: job.driver,
        status: job.status,
        phase: job.phase,
        progress: Math.round(job.progress * 10) / 10,
        attempts: job.attempts,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        error: job.error,
        result: job.result,
        usb: job.usb,
        production: !!job.production
    };
}

function emitJob(job, force = false) {
    const now = Date.now();
    if (!force && now - (job.lastEmit || 0) < 150) {
        if (!job.emitTimer) job.emitTimer = setTimeout(() => {
            job.emitTimer = null;
            emitJob(job, true);
        }, 150);
        return;
    }
    job.lastEmit = now;
    send('flash:job', publicJob(job));
}

function appendLog(job, text) {
    job.log += text;
    if (job.log.length > 2000000) job.log = job.log.slice(-1500000);
    job.pendingLog += text;
    if (!job.logTimer) {
        job.logTimer = setTimeout(() => {
            job.logTimer = null;
            const chunk = job.pendingLog;
            job.pendingLog = '';
            if (chunk) send('flash:log', { jobId: job.id, text: chunk });
        }, 100);
    }
}

function createJob(spec) {
    const portInfo = manager.getCachedPorts().find(p => p.path === spec.port) || {};
    const job = {
        id: nextId++,
        port: spec.port || null,
        currentPort: spec.port || null,
        operation: spec.operation || 'program',
        label: spec.label || null,
        profile: spec.profile || {},
        profileName: (spec.profile && spec.profile.name) || null,
        fqbn: spec.profile && spec.profile.fqbn,
        boardName: null,
        params: spec.params || {},
        status: 'queued',
        phase: 'Queued',
        progress: 0,
        attempts: 0,
        createdAt: Date.now(),
        startedAt: null,
        endedAt: null,
        error: null,
        result: null,
        usb: { serialNumber: portInfo.serialNumber || '', vendorId: portInfo.vendorId || '', productId: portInfo.productId || '', manufacturer: portInfo.manufacturer || '' },
        log: '',
        pendingLog: '',
        cancelled: false,
        kill: null,
        production: !!spec.production
    };
    jobs.set(job.id, job);
    queue.push(job);
    emitJob(job, true);
    return job;
}

function stepsFor(job) {
    const p = job.profile;
    if (job.operation !== 'program') return [job.operation];
    const steps = [];
    if (p.eraseFirst) steps.push('erase');
    if (p.input && (p.input.path || (p.input.images && p.input.images.length))) steps.push('upload');
    if (p.fs && p.fs.enabled && (p.fs.sourceDir || p.fs.imageFile)) steps.push('fs-upload');
    if (p.verify && steps.includes('upload')) steps.push('verify');
    if (steps.length === 0) throw new Error('Nothing to do: select a firmware or filesystem');
    return steps;
}

function stepLabel(step) {
    return {
        erase: 'Erasing flash',
        upload: 'Uploading firmware',
        'fs-upload': 'Uploading filesystem',
        'fs-download': 'Reading filesystem',
        'fs-build': 'Building filesystem image',
        verify: 'Verifying',
        info: 'Reading chip info',
        'read-flash': 'Reading flash',
        'partitions-read': 'Reading partition table',
        'partitions-write': 'Writing partition table',
        bootloader: 'Burning bootloader',
        'erase-region': 'Erasing region'
    }[step] || step;
}

async function executeStep(job, ctx, step, stepIndex, stepCount) {
    const driver = job.driver;
    const p = job.profile;
    const opts = { ...(p.options || {}), ...(job.params.options || {}) };
    const base = (stepIndex / stepCount) * 100;
    ctx.progress = (pct) => {
        job.progress = Math.min(100, base + (Math.max(0, Math.min(100, pct)) / stepCount));
        emitJob(job);
    };
    job.phase = `${stepLabel(step)}${stepCount > 1 ? ` (${stepIndex + 1}/${stepCount})` : ''}`;
    emitJob(job, true);
    appendLog(job, `\n=== ${job.phase} ===\n`);
    const result = job.result || {};
    switch (step) {
        case 'upload': {
            const desc = inputs.describe(p.input);
            if (driver === 'esptool') await esptool.upload(ctx, desc, opts);
            else if (driver === 'avrdude') await avrdude.upload(ctx, desc);
            else if (driver === 'rp2040') await rp2040.upload(ctx, desc, opts);
            else await generic.upload(ctx, desc);
            break;
        }
        case 'verify': {
            if (driver !== 'esptool') {
                appendLog(job, 'Verification is performed by the upload tool for this board\n');
                break;
            }
            await esptool.verify(ctx, inputs.describe(p.input), opts);
            break;
        }
        case 'erase': {
            if (driver === 'esptool') await esptool.erase(ctx, opts);
            else if (ctx.resolved.props['erase.pattern']) await generic.erase(ctx);
            else throw new Error('Erase is not supported for this board');
            break;
        }
        case 'erase-region': {
            if (driver !== 'esptool') throw new Error('Region erase is only supported on ESP chips');
            await esptool.eraseRegion(ctx, job.params.offset, job.params.size, opts);
            break;
        }
        case 'fs-upload': {
            const fsOpts = { ...opts, ...(p.fs || {}), ...(job.params.fs || {}) };
            if (p.input && p.input.path) {
                try {
                    const desc = inputs.describe(p.input);
                    if (desc.build) fsOpts.build = desc.build;
                } catch (error) {
                    appendLog(job, `Build folder ignored: ${error.message}\n`);
                }
            }
            const res = await fsImage.upload(ctx, fsOpts);
            result.fsLayout = res.layout;
            break;
        }
        case 'fs-build': {
            const res = await fsImage.build(ctx, { ...opts, ...(p.fs || {}), ...(job.params.fs || {}), ...job.params });
            result.fsImage = res.file;
            result.fsLayout = res.layout;
            break;
        }
        case 'fs-download': {
            const res = await fsImage.download(ctx, { ...opts, ...job.params });
            result.fsFiles = res.files;
            result.fsDir = res.outDir;
            result.fsLayout = res.layout;
            break;
        }
        case 'info': {
            let details;
            if (driver === 'esptool') details = await esptool.info(ctx, opts);
            else if (driver === 'avrdude') details = await avrdude.info(ctx);
            else if (driver === 'rp2040') details = await rp2040.info(ctx);
            else throw new Error('Chip info is not supported for this board');
            Object.assign(result, details);
            break;
        }
        case 'read-flash': {
            if (driver !== 'esptool') throw new Error('Flash read is only supported on ESP chips');
            const res = await esptool.readFlash(ctx, job.params.offset || '0x0', job.params.size || 'ALL', job.params.outFile, opts);
            result.readFile = res.file;
            break;
        }
        case 'partitions-read': {
            if (driver !== 'esptool') throw new Error('Partition tables are only supported on ESP32 chips');
            result.partitions = await esptool.readPartitionTable(ctx, opts);
            break;
        }
        case 'partitions-write': {
            if (driver !== 'esptool') throw new Error('Partition tables are only supported on ESP32 chips');
            await esptool.writePartitionTable(ctx, job.params.rows || [], opts);
            break;
        }
        case 'bootloader': {
            await generic.burnBootloader(ctx);
            break;
        }
        default:
            throw new Error(`Unknown operation ${step}`);
    }
    job.result = result;
    job.progress = ((stepIndex + 1) / stepCount) * 100;
    emitJob(job);
}

async function runJob(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    job.phase = 'Preparing';
    emitJob(job, true);
    let suspended = null;
    const hadRecord = job.port ? !!manager.getRecord(job.port) : false;
    const ctx = {
        job,
        port: job.port,
        originalPort: job.port,
        identity: job.usb,
        log: (text) => appendLog(job, text),
        progress: () => { }
    };
    try {
        const p = job.profile;
        const resolved = boards.resolve(p.fqbn, p.menus || {}, {
            programmer: job.operation === 'bootloader' ? job.params.programmer || p.programmer : undefined,
            verbose: !!p.verbose,
            verify: settings.get('flash.verify')
        });
        ctx.resolved = resolved;
        job.boardName = resolved.board.name;
        job.driver = driverName(resolved);
        if (p.forceGeneric) job.driver = 'generic';
        appendLog(job, `Board: ${resolved.board.name} (${p.fqbn})\nPlatform: ${resolved.platform.packager}:${resolved.platform.arch} ${resolved.platform.version} [${resolved.platform.source}]\nTool: ${resolved.tool || '-'} / driver ${job.driver}\nPort: ${job.port || '-'}\n`);
        if (hadRecord) {
            suspended = await manager.suspend(job.port);
            await sleep(150);
        }
        const steps = stepsFor(job);
        const retries = Math.max(0, parseInt(settings.get('flash.retries'), 10) || 0);
        for (let i = 0; i < steps.length; i++) {
            let attempt = 0;
            while (true) {
                attempt++;
                job.attempts = Math.max(job.attempts, attempt);
                try {
                    await executeStep(job, ctx, steps[i], i, steps.length);
                    break;
                } catch (error) {
                    if (job.cancelled) throw error;
                    if (attempt > retries) throw error;
                    appendLog(job, `\n${error.message}\nRetrying (${attempt}/${retries})...\n`);
                    ctx.portPrepared = false;
                    await sleep(1500);
                }
            }
            job.currentPort = ctx.port;
        }
        job.status = 'done';
        job.phase = 'Done';
        job.progress = 100;
        appendLog(job, `\n=== Success in ${((Date.now() - job.startedAt) / 1000).toFixed(1)} s ===\n`);
    } catch (error) {
        job.status = job.cancelled ? 'cancelled' : 'error';
        job.phase = job.cancelled ? 'Cancelled' : 'Failed';
        job.error = error.message;
        appendLog(job, `\n=== ${job.cancelled ? 'Cancelled' : 'Error'}: ${error.message} ===\n`);
    } finally {
        job.endedAt = Date.now();
        job.currentPort = ctx.port;
        if (hadRecord) {
            const reopen = !!settings.get('flash.reopenPortAfterFlash') || !!(suspended && suspended.wasOpen && job.operation !== 'program');
            await sleep(300);
            try {
                await manager.resume(job.port, { reopen, newPath: ctx.port && ctx.port !== job.port ? ctx.port : null });
            } catch (error) {
                appendLog(job, `Unable to reopen port: ${error.message}\n`);
            }
        }
        emitJob(job, true);
        if (job.production) {
            if (job.status === 'done') production.stats.done++;
            else production.stats.failed++;
            send('flash:production', productionState());
        }
        notifyDone(job);
    }
}

function notifyDone(job) {
    if (!settings.get('notifications.enabled') || !settings.get('notifications.notifyOnFlashDone')) return;
    const active = Array.from(jobs.values()).some(j => j.status === 'queued' || j.status === 'running');
    if (active) return;
    const finished = Array.from(jobs.values()).filter(j => j.endedAt && j.endedAt >= Date.now() - 600000);
    const ok = finished.filter(j => j.status === 'done').length;
    const failed = finished.filter(j => j.status === 'error').length;
    try {
        if (Notification.isSupported()) new Notification({ title: 'DiagTerm Flash', body: `${ok} succeeded, ${failed} failed` }).show();
    } catch (error) {
        console.error('Notification error:', error.message);
    }
}

function pump() {
    const limit = Math.max(1, parseInt(settings.get('flash.concurrency'), 10) || 1);
    while (running < limit) {
        const busyPorts = new Set(Array.from(jobs.values()).filter(j => j.status === 'running').map(j => j.port));
        const idx = queue.findIndex(j => !j.port || !busyPorts.has(j.port));
        if (idx < 0) break;
        const job = queue.splice(idx, 1)[0];
        if (job.cancelled) continue;
        running++;
        runJob(job).finally(() => {
            running--;
            pump();
        });
    }
}

function enqueue(specs) {
    const ids = [];
    for (const spec of specs) ids.push(createJob(spec).id);
    pump();
    return ids;
}

function cancel(id) {
    const job = jobs.get(id);
    if (!job) return { success: false };
    job.cancelled = true;
    if (job.status === 'queued') {
        const idx = queue.indexOf(job);
        if (idx >= 0) queue.splice(idx, 1);
        job.status = 'cancelled';
        job.phase = 'Cancelled';
        job.endedAt = Date.now();
    }
    if (job.kill) job.kill();
    emitJob(job, true);
    return { success: true };
}

function retry(id) {
    const job = jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'queued') return { success: false };
    const ids = enqueue([{ port: job.currentPort || job.port, operation: job.operation, profile: job.profile, params: job.params, label: job.label }]);
    return { success: true, id: ids[0] };
}

function clearFinished() {
    for (const [id, job] of jobs.entries()) {
        if (job.status !== 'queued' && job.status !== 'running') jobs.delete(id);
    }
    return { success: true };
}

function productionState() {
    return {
        active: production.active,
        profileName: production.profile ? production.profile.name : null,
        filters: production.filters,
        stats: production.stats
    };
}

function matchesFilters(info) {
    if (!production.filters.length) return true;
    return production.filters.some(f => {
        const vid = String(f.vid || '').toLowerCase().replace(/^0x/, '');
        const pid = String(f.pid || '').toLowerCase().replace(/^0x/, '');
        if (vid && info.vendorId !== vid.padStart(4, '0')) return false;
        if (pid && info.productId !== pid.padStart(4, '0')) return false;
        if (f.serialPrefix && !(info.serialNumber || '').startsWith(f.serialPrefix)) return false;
        if (f.manufacturer && !(info.manufacturer || '').toLowerCase().includes(String(f.manufacturer).toLowerCase())) return false;
        return true;
    });
}

function considerPort(info) {
    if (!production.active || !info) return;
    if (manager.isOpen(info.path)) return;
    if (!matchesFilters(info)) return;
    const busy = Array.from(jobs.values()).some(j => (j.status === 'queued' || j.status === 'running') && (j.port === info.path || j.currentPort === info.path));
    if (busy) return;
    const key = info.serialNumber ? `sn:${info.serialNumber}` : `path:${info.path}`;
    const cooldown = Math.max(1000, parseInt(settings.get('flash.productionCooldownMs'), 10) || 15000);
    const last = production.seen.get(key);
    if (last && Date.now() - last < cooldown) return;
    production.seen.set(key, Date.now());
    production.stats.queued++;
    enqueue([{ port: info.path, operation: 'program', profile: production.profile, production: true, label: 'Production' }]);
    send('flash:production', productionState());
}

function onPortsChanged({ list, added }) {
    if (!production.active) return;
    for (const portPath of added) {
        considerPort(list.find(p => p.path === portPath));
    }
    for (const job of jobs.values()) {
        if ((job.status === 'running' || job.status === 'queued') && job.usb && job.usb.serialNumber) {
            const key = `sn:${job.usb.serialNumber}`;
            production.seen.set(key, Date.now());
        }
    }
}

async function startProduction(config) {
    production.active = true;
    production.profile = config.profile;
    production.filters = config.filters || settings.get('flash.productionFilters') || [];
    production.stats = { queued: 0, done: 0, failed: 0 };
    production.seen = new Map();
    if (config.includeExisting) {
        const list = await manager.listPorts();
        for (const info of list) considerPort(info);
    }
    send('flash:production', productionState());
    return productionState();
}

function stopProduction() {
    production.active = false;
    send('flash:production', productionState());
    return productionState();
}

function describeTarget(fqbn, menus) {
    const resolved = boards.resolve(fqbn, menus || {});
    const props = resolved.props;
    const driver = driverName(resolved);
    const out = {
        fqbn,
        name: resolved.board.name,
        platform: `${resolved.platform.packager}:${resolved.platform.arch} ${resolved.platform.version}`,
        source: resolved.platform.source,
        tool: resolved.tool,
        driver,
        mcu: props['build.mcu'] || '',
        uploadSpeed: props['upload.speed'] || '',
        use1200bps: props['upload.use_1200bps_touch'] === 'true',
        waitForPort: props['upload.wait_for_upload_port'] === 'true',
        bootloaderAddr: props['build.bootloader_addr'] || '',
        flashSize: props['build.flash_size'] || '',
        flashMode: props['build.flash_mode'] || '',
        flashFreq: props['build.flash_freq'] || '',
        partitionScheme: props['build.partitions'] || '',
        selected: resolved.selected,
        fs: {}
    };
    for (const fsType of ['littlefs', 'spiffs', 'ffat']) {
        try {
            const layout = fsImage.layoutFor(resolved, fsType);
            out.fs[fsType] = { offset: layout.offset, size: layout.size, partition: layout.partition || null };
        } catch (error) {
            out.fs[fsType] = { error: error.message };
        }
    }
    if (resolved.platform.arch === 'esp32') {
        try {
            out.partitions = fsImage.loadPartitionRows(props);
        } catch (error) {
            out.partitions = null;
        }
    }
    return out;
}

function register() {
    boardManager.init();
    bus.on('ports-changed', onPortsChanged);

    ipcMain.handle('boards:catalog', () => boardManager.getCatalog());
    ipcMain.handle('boards:fetch-indexes', async () => boardManager.fetchIndexes());
    ipcMain.handle('boards:install', async (event, packager, arch, version) => {
        try {
            return await boardManager.installPlatform(packager, arch, version);
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('boards:uninstall', async (event, packager, arch, version) => boardManager.uninstallPlatform(packager, arch, version));
    ipcMain.handle('boards:root', () => boardManager.rootDir());
    ipcMain.handle('boards:update-now', async () => {
        await boardManager.autoUpdate();
        return { success: true };
    });
    ipcMain.handle('boards:installed-tools', () => boardManager.scanInstalled(true).tools);

    ipcMain.handle('flash:boards', () => {
        try {
            return boards.listBoards();
        } catch (error) {
            console.error('Error listing boards:', error.message);
            return [];
        }
    });
    ipcMain.handle('flash:describe-target', (event, fqbn, menus) => {
        try {
            return { success: true, target: describeTarget(fqbn, menus) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('flash:detect-board', (event, portPath) => {
        const info = manager.getCachedPorts().find(p => p.path === portPath);
        return boards.detectBoardsForPort(info);
    });
    ipcMain.handle('flash:programmers', (event, fqbn) => {
        try {
            return boards.listProgrammers(fqbn);
        } catch (error) {
            return [];
        }
    });
    ipcMain.handle('flash:describe-input', (event, input, fqbn, menus) => {
        try {
            const desc = inputs.describe(input);
            const out = { success: true, mode: desc.mode, build: desc.build || null, file: desc.file || null };
            if (fqbn) {
                const resolved = boards.resolve(fqbn, menus || {});
                if (driverName(resolved) === 'esptool') {
                    out.images = esptool.imagesFromInput(desc, resolved.props).map(i => ({ ...i, size: fs.existsSync(i.file) ? fs.statSync(i.file).size : 0 }));
                }
            }
            return out;
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('flash:enqueue', (event, specs) => enqueue(specs || []));
    ipcMain.handle('flash:cancel', (event, id) => cancel(id));
    ipcMain.handle('flash:cancel-all', () => {
        for (const job of jobs.values()) if (job.status === 'queued' || job.status === 'running') cancel(job.id);
        return { success: true };
    });
    ipcMain.handle('flash:retry', (event, id) => retry(id));
    ipcMain.handle('flash:clear', () => clearFinished());
    ipcMain.handle('flash:jobs', () => Array.from(jobs.values()).map(publicJob));
    ipcMain.handle('flash:job-log', (event, id) => (jobs.get(id) || {}).log || '');
    ipcMain.handle('flash:production-start', (event, config) => startProduction(config || {}));
    ipcMain.handle('flash:production-stop', () => stopProduction());
    ipcMain.handle('flash:production-state', () => productionState());
    ipcMain.handle('flash:partitions-parse-csv', (event, text) => {
        try {
            return { success: true, rows: partitions.parseCsv(text) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('flash:partitions-to-csv', (event, rows) => partitions.toCsv(rows || []));
    ipcMain.handle('flash:partitions-validate', (event, rows, flashSize) => partitions.validate(rows || [], flashSize));
    ipcMain.handle('flash:partitions-to-binary', (event, rows) => Array.from(partitions.toBinary(rows || [])));
    ipcMain.handle('flash:partitions-parse-binary', (event, filePath) => {
        try {
            return { success: true, rows: partitions.parseBinary(fs.readFileSync(filePath)) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

function cancelAll() {
    for (const job of jobs.values()) if (job.status === 'queued' || job.status === 'running') cancel(job.id);
}

module.exports = { register, cancelAll };
