const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { bus, send } = require('../context');
const manager = require('./manager');
const { ByteQueue, sendXmodem, sendYmodem } = require('./xmodem');

const jobs = new Map();
let nextId = 1;

function parseHex(hex) {
    const clean = String(hex || '').replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    const out = [];
    for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
    return Buffer.from(out);
}

function lineEndingBytes(kind) {
    switch (kind) {
        case 'NL': return Buffer.from('\n');
        case 'CR': return Buffer.from('\r');
        case 'CRLF': return Buffer.from('\r\n');
        case 'LFCR': return Buffer.from('\n\r');
        case 'none': return Buffer.alloc(0);
        default: return null;
    }
}

function splitByDelimiter(data, delimiter, include) {
    const frames = [];
    if (!delimiter || delimiter.length === 0) return [data];
    let start = 0;
    let idx = data.indexOf(delimiter, start);
    while (idx >= 0) {
        const end = include ? idx + delimiter.length : idx;
        frames.push(data.subarray(start, end));
        start = idx + delimiter.length;
        idx = data.indexOf(delimiter, start);
    }
    if (start < data.length) frames.push(data.subarray(start));
    return frames;
}

function buildFrames(data, options) {
    const mode = options.mode || 'raw';
    if (mode === 'raw') {
        const frames = [];
        for (let i = 0; i < data.length; i += 4096) frames.push(data.subarray(i, i + 4096));
        return frames;
    }
    if (mode === 'chunks') {
        const size = Math.max(1, parseInt(options.chunkSize, 10) || 64);
        const frames = [];
        for (let i = 0; i < data.length; i += size) frames.push(data.subarray(i, i + size));
        return frames;
    }
    if (mode === 'lines') {
        const encoding = options.encoding === 'latin1' ? 'latin1' : 'utf8';
        const text = data.toString(encoding);
        const parts = text.split(/(\r\n|\n|\r)/);
        const ending = lineEndingBytes(options.lineEnding || 'keep');
        const frames = [];
        for (let i = 0; i < parts.length; i += 2) {
            const content = parts[i];
            const originalEnding = parts[i + 1] || '';
            if (content === '' && originalEnding === '' && i === parts.length - 1) continue;
            if (options.skipEmptyLines && content.trim() === '') continue;
            const body = Buffer.from(content, encoding);
            const end = ending === null ? Buffer.from(originalEnding, encoding) : ending;
            frames.push(Buffer.concat([body, end]));
        }
        return frames;
    }
    if (mode === 'frames') {
        if (options.frameLength && parseInt(options.frameLength, 10) > 0 && !options.delimiterHex) {
            const size = parseInt(options.frameLength, 10);
            const frames = [];
            for (let i = 0; i < data.length; i += size) frames.push(data.subarray(i, i + size));
            return frames;
        }
        return splitByDelimiter(data, parseHex(options.delimiterHex || '0A'), options.includeDelimiter !== false);
    }
    return [data];
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function emitProgress(job, force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - job.lastEmit < 100) return;
    job.lastEmit = nowMs;
    const elapsed = Math.max(1, nowMs - job.startedAt);
    send('filesend:progress', {
        jobId: job.id,
        path: job.path,
        state: job.state,
        sentBytes: job.sentBytes,
        totalBytes: job.totalBytes,
        frameIndex: job.frameIndex,
        frameCount: job.frameCount,
        iteration: job.iteration,
        repeat: job.repeat,
        rate: Math.round(job.sentBytes * 1000 / elapsed),
        elapsedMs: elapsed,
        error: job.error || null,
        log: job.lastLog || null
    });
}

async function waitIfPaused(job) {
    while (job.paused && !job.cancelled) await sleep(50);
}

function waitForAck(job, regex, timeoutMs, nakRegex) {
    return new Promise((resolve) => {
        let text = '';
        const onData = (portPath, dir, t, buffer) => {
            if (portPath !== job.path || dir !== 'RX') return;
            text += buffer.toString('latin1');
            if (nakRegex && nakRegex.test(text)) {
                cleanup();
                resolve('nak');
                return;
            }
            if (regex.test(text)) {
                cleanup();
                resolve('ack');
            }
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve('timeout');
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            bus.off('serial-data', onData);
        };
        bus.on('serial-data', onData);
    });
}

async function runStream(job, data, options) {
    const frames = buildFrames(data, options);
    job.frameCount = frames.length;
    job.totalBytes = frames.reduce((s, f) => s + f.length, 0) * job.repeat;
    const delay = Math.max(0, parseInt(options.delayMs, 10) || 0);
    const ack = options.ack && options.ack.enabled ? options.ack : null;
    let ackRegex = null;
    let nakRegex = null;
    if (ack) {
        ackRegex = new RegExp(ack.pattern || 'OK', ack.caseSensitive ? '' : 'i');
        if (ack.nakPattern) nakRegex = new RegExp(ack.nakPattern, ack.caseSensitive ? '' : 'i');
    }
    for (job.iteration = 1; job.iteration <= job.repeat; job.iteration++) {
        for (job.frameIndex = 0; job.frameIndex < frames.length; job.frameIndex++) {
            if (job.cancelled) throw new Error('Cancelled');
            await waitIfPaused(job);
            const frame = frames[job.frameIndex];
            let tries = 0;
            const maxTries = ack ? Math.max(1, (parseInt(ack.retries, 10) || 0) + 1) : 1;
            while (true) {
                tries++;
                const ackPromise = ack ? waitForAck(job, ackRegex, Math.max(10, parseInt(ack.timeoutMs, 10) || 1000), nakRegex) : null;
                const res = await manager.write(job.path, frame);
                if (!res.success) throw new Error(res.error || 'Write failed');
                if (!ack) break;
                const outcome = await ackPromise;
                if (outcome === 'ack') break;
                if (tries >= maxTries) {
                    if (ack.onTimeout === 'continue') {
                        job.lastLog = `Frame ${job.frameIndex + 1}: no ACK, continuing`;
                        break;
                    }
                    throw new Error(`Frame ${job.frameIndex + 1}: ${outcome === 'nak' ? 'NAK received' : 'ACK timeout'} after ${tries} attempt(s)`);
                }
                job.lastLog = `Frame ${job.frameIndex + 1}: ${outcome}, retry ${tries}`;
            }
            job.sentBytes += frame.length;
            emitProgress(job);
            if (delay > 0) await sleep(delay);
        }
        if (job.iteration < job.repeat && options.repeatDelayMs) await sleep(parseInt(options.repeatDelayMs, 10) || 0);
    }
}

async function runProtocol(job, data, options) {
    const queue = new ByteQueue();
    const onData = (portPath, dir, t, buffer) => {
        if (portPath === job.path && dir === 'RX') queue.push(buffer);
    };
    bus.on('serial-data', onData);
    job.totalBytes = data.length * job.repeat;
    job.frameCount = 1;
    const ctx = {
        queue,
        cancelled: () => job.cancelled,
        waitIfPaused: () => waitIfPaused(job),
        write: (buffer) => manager.write(job.path, buffer),
        log: (text) => {
            job.lastLog = text;
            emitProgress(job, true);
        },
        progress: (sent) => {
            job.sentBytes = (job.iteration - 1) * data.length + sent;
            emitProgress(job);
        }
    };
    try {
        for (job.iteration = 1; job.iteration <= job.repeat; job.iteration++) {
            job.lastLog = 'Waiting for receiver...';
            emitProgress(job, true);
            if (options.protocol === 'ymodem') await sendYmodem(data, job.filePath, ctx);
            else await sendXmodem(data, ctx, options.protocol);
        }
    } finally {
        bus.off('serial-data', onData);
    }
}

async function start(portPath, filePath, options = {}) {
    if (!manager.isOpen(portPath)) return { success: false, error: 'Port not open' };
    let data;
    try {
        data = fs.readFileSync(filePath);
    } catch (error) {
        return { success: false, error: error.message };
    }
    const job = {
        id: nextId++,
        path: portPath,
        filePath,
        state: 'running',
        paused: false,
        cancelled: false,
        sentBytes: 0,
        totalBytes: data.length,
        frameIndex: 0,
        frameCount: 0,
        iteration: 1,
        repeat: Math.max(1, parseInt(options.repeat, 10) || 1),
        startedAt: Date.now(),
        lastEmit: 0
    };
    jobs.set(job.id, job);
    emitProgress(job, true);
    (async () => {
        try {
            if (options.protocol && options.protocol !== 'none') await runProtocol(job, data, options);
            else await runStream(job, data, options);
            job.state = 'done';
        } catch (error) {
            job.state = job.cancelled ? 'cancelled' : 'error';
            job.error = error.message;
        }
        emitProgress(job, true);
        jobs.delete(job.id);
    })();
    return { success: true, jobId: job.id, size: data.length };
}

function control(jobId, action) {
    const job = jobs.get(jobId);
    if (!job) return { success: false, error: 'Unknown job' };
    if (action === 'pause') {
        job.paused = true;
        job.state = 'paused';
    } else if (action === 'resume') {
        job.paused = false;
        job.state = 'running';
    } else if (action === 'cancel') {
        job.cancelled = true;
        job.paused = false;
    }
    emitProgress(job, true);
    return { success: true };
}

function register() {
    ipcMain.handle('filesend:select', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'All Files', extensions: ['*'] }] });
        if (result.canceled || !result.filePaths.length) return null;
        const filePath = result.filePaths[0];
        let size = 0;
        try {
            size = fs.statSync(filePath).size;
        } catch (error) {
            size = 0;
        }
        return { filePath, size };
    });
    ipcMain.handle('filesend:preview', async (event, filePath, options) => {
        try {
            const data = fs.readFileSync(filePath);
            const frames = buildFrames(data, options || {});
            return {
                success: true,
                size: data.length,
                frameCount: frames.length,
                sample: frames.slice(0, 20).map(f => Array.from(f.subarray(0, 64)))
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('filesend:start', async (event, portPath, filePath, options) => start(portPath, filePath, options));
    ipcMain.handle('filesend:control', async (event, jobId, action) => control(jobId, action));
}

module.exports = { register };
