const { ipcMain } = require('electron');
const { SerialPort } = require('serialport');
const { bus, send } = require('../context');
const settings = require('../settings');

const hrBase = process.hrtime.bigint();
const epochBase = Date.now();

function now() {
    return epochBase + Number(process.hrtime.bigint() - hrBase) / 1e6;
}

const records = new Map();
let portCache = [];
let portSignature = '';
let listTimer = null;
let batch = [];
let batchTimer = null;

function normalizeId(value) {
    if (value === undefined || value === null || value === '') return '';
    return String(value).toLowerCase().replace(/^0x/, '').padStart(4, '0');
}

function mapPort(port) {
    return {
        path: port.path,
        manufacturer: port.manufacturer || '',
        serialNumber: port.serialNumber || '',
        pnpId: port.pnpId || '',
        locationId: port.locationId || '',
        friendlyName: port.friendlyName || '',
        vendorId: normalizeId(port.vendorId),
        productId: normalizeId(port.productId)
    };
}

async function listPorts() {
    try {
        const list = await SerialPort.list();
        portCache = list.map(mapPort);
    } catch (error) {
        console.error('Error listing ports:', error.message);
    }
    return portCache;
}

function getCachedPorts() {
    return portCache;
}

function identityOf(portPath) {
    const info = portCache.find(p => p.path === portPath);
    if (!info) return { path: portPath };
    return {
        path: portPath,
        serialNumber: info.serialNumber,
        vendorId: info.vendorId,
        productId: info.productId,
        pnpId: info.pnpId,
        locationId: info.locationId
    };
}

function queueData(portPath, dir, t, buffer) {
    batch.push({ p: portPath, d: dir, t, b: buffer });
    if (!batchTimer) {
        const interval = Math.max(4, Number(settings.get('serial.batchIntervalMs')) || 16);
        batchTimer = setTimeout(flushBatch, interval);
    }
}

function flushBatch() {
    batchTimer = null;
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    send('serial:data', out);
}

function emitData(portPath, dir, buffer, t = now()) {
    bus.emit('serial-data', portPath, dir, t, buffer);
    queueData(portPath, dir, t, buffer);
}

function emitState(record, state, extra = {}) {
    record.state = state;
    const payload = { path: record.path, state, ...extra };
    bus.emit('serial-state', payload);
    send('serial:state', payload);
}

function buildPortOptions(portPath, options) {
    const flow = options.flowControl || 'none';
    return {
        path: portPath,
        baudRate: parseInt(options.baudRate, 10) || 115200,
        dataBits: parseInt(options.dataBits, 10) || 8,
        stopBits: parseFloat(options.stopBits) || 1,
        parity: options.parity || 'none',
        rtscts: flow === 'rtscts',
        xon: flow === 'xonxoff',
        xoff: flow === 'xonxoff',
        hupcl: options.hupcl !== false,
        autoOpen: false
    };
}

function isDisconnectError(err) {
    if (!err) return false;
    if (err.disconnected) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('disconnected') || msg.includes('not found') || msg.includes('access denied') ||
        msg.includes('cannot open') || msg.includes('device not configured') || msg.includes('the device does not recognize') ||
        msg.includes('operation aborted') || msg.includes('i/o error') || msg.includes('no such file');
}

function attachPort(record, port) {
    record.port = port;
    port.on('data', (data) => {
        record.rxBytes += data.length;
        emitData(record.path, 'RX', data);
    });
    port.on('error', (err) => {
        console.error(`Port ${record.path} error:`, err.message);
        send('serial:error', { path: record.path, error: err.message });
        if (isDisconnectError(err)) markLost(record, err.message);
    });
    port.on('close', (err) => {
        stopSignalPolling(record);
        if (record.port !== port) return;
        record.port = null;
        if (record.userClosed || record.suspended) {
            return;
        }
        markLost(record, err ? err.message : 'Port closed unexpectedly');
    });
}

function markLost(record, reason) {
    if (record.state === 'lost' || record.state === 'reconnecting') return;
    stopSignalPolling(record);
    if (record.port) {
        const port = record.port;
        record.port = null;
        try {
            if (port.isOpen) port.close(() => { });
        } catch (error) {
            console.error('Error closing lost port:', error.message);
        }
    }
    record.lostAt = Date.now();
    record.attempts = 0;
    emitState(record, 'lost', { reason, autoReconnect: record.autoReconnect });
    bus.emit('serial-lost', record);
}

function openRaw(portPath, options) {
    return new Promise((resolve) => {
        let port;
        try {
            port = new SerialPort(buildPortOptions(portPath, options));
        } catch (error) {
            resolve({ success: false, error: error.message });
            return;
        }
        port.open((err) => {
            if (err) {
                resolve({ success: false, error: err.message });
                return;
            }
            const dtr = options.dtrOnOpen !== false;
            const rts = options.rtsOnOpen !== false;
            port.set({ dtr, rts }, (setErr) => {
                if (setErr) console.warn(`Unable to set DTR/RTS on ${portPath}:`, setErr.message);
                resolve({ success: true, port, dtr, rts });
            });
        });
    });
}

async function open(portPath, options = {}, meta = {}) {
    const existing = records.get(portPath);
    if (existing && existing.port && existing.port.isOpen) {
        return { success: true, alreadyOpen: true };
    }
    if (!portCache.some(p => p.path === portPath)) await listPorts();
    const result = await openRaw(portPath, options);
    if (!result.success) return result;
    const record = existing || {
        path: portPath,
        rxBytes: 0,
        txBytes: 0,
        attempts: 0
    };
    record.options = { ...options };
    record.identity = identityOf(portPath);
    record.autoReconnect = meta.autoReconnect !== undefined ? !!meta.autoReconnect : (record.autoReconnect !== undefined ? record.autoReconnect : true);
    record.owner = meta.owner || record.owner || 'tab';
    record.userClosed = false;
    record.suspended = false;
    record.signals = { dtr: result.dtr, rts: result.rts, brk: false, cts: false, dsr: false, dcd: false, ri: false };
    records.set(portPath, record);
    attachPort(record, result.port);
    startSignalPolling(record);
    emitState(record, 'open', { signals: record.signals, identity: record.identity });
    return { success: true, identity: record.identity };
}

function closePort(port) {
    return new Promise((resolve) => {
        try {
            if (!port || !port.isOpen) {
                resolve();
                return;
            }
            port.close(() => resolve());
        } catch (error) {
            resolve();
        }
    });
}

async function close(portPath, { forget = true } = {}) {
    const record = records.get(portPath);
    if (!record) return { success: true };
    record.userClosed = true;
    stopSignalPolling(record);
    const port = record.port;
    record.port = null;
    await closePort(port);
    emitState(record, 'closed', {});
    if (forget) records.delete(portPath);
    return { success: true };
}

async function reopenRecord(record, newPath) {
    const target = newPath || record.path;
    const result = await openRaw(target, record.options || {});
    if (!result.success) return result;
    const previousPath = record.path;
    if (target !== previousPath) {
        records.delete(previousPath);
        record.path = target;
        records.set(target, record);
    }
    record.identity = identityOf(target);
    record.userClosed = false;
    record.suspended = false;
    record.signals = { ...(record.signals || {}), dtr: result.dtr, rts: result.rts };
    attachPort(record, result.port);
    startSignalPolling(record);
    emitState(record, 'open', {
        reconnected: true,
        previousPath: target !== previousPath ? previousPath : undefined,
        signals: record.signals,
        identity: record.identity
    });
    return { success: true, path: target };
}

function write(portPath, data, { silent = false } = {}) {
    const record = records.get(portPath);
    if (!record || !record.port || !record.port.isOpen) {
        return Promise.resolve({ success: false, error: 'Port not open' });
    }
    const buffer = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
    const port = record.port;
    return new Promise((resolve) => {
        const t = now();
        port.write(buffer, (err) => {
            if (err) {
                if (isDisconnectError(err)) markLost(record, err.message);
                resolve({ success: false, error: err.message });
                return;
            }
            port.drain((drainErr) => {
                if (drainErr) {
                    resolve({ success: false, error: drainErr.message });
                    return;
                }
                record.txBytes += buffer.length;
                if (!silent) emitData(record.path, 'TX', buffer, t);
                resolve({ success: true, bytes: buffer.length });
            });
        });
    });
}

function setSignals(portPath, signals) {
    const record = records.get(portPath);
    if (!record || !record.port || !record.port.isOpen) return Promise.resolve({ success: false, error: 'Port not open' });
    const payload = {};
    for (const key of ['dtr', 'rts', 'brk']) {
        if (signals[key] !== undefined) payload[key] = !!signals[key];
    }
    return new Promise((resolve) => {
        record.port.set(payload, (err) => {
            if (err) {
                resolve({ success: false, error: err.message });
                return;
            }
            record.signals = { ...(record.signals || {}), ...payload };
            send('serial:signals', { path: portPath, signals: record.signals });
            resolve({ success: true, signals: record.signals });
        });
    });
}

async function pulseReset(portPath) {
    const first = await setSignals(portPath, { dtr: false, rts: true });
    if (!first.success) return first;
    await new Promise(r => setTimeout(r, 120));
    const second = await setSignals(portPath, { dtr: false, rts: false });
    if (!second.success) return second;
    await new Promise(r => setTimeout(r, 50));
    const record = records.get(portPath);
    const options = record ? record.options || {} : {};
    return setSignals(portPath, { dtr: options.dtrOnOpen !== false, rts: options.rtsOnOpen !== false });
}

async function updateOptions(portPath, options) {
    const record = records.get(portPath);
    if (!record) return { success: false, error: 'Port not open' };
    const prev = record.options || {};
    record.options = { ...prev, ...options };
    const onlyBaud = Object.keys(options).every(k => k === 'baudRate');
    if (record.port && record.port.isOpen && onlyBaud) {
        return new Promise((resolve) => {
            record.port.update({ baudRate: parseInt(options.baudRate, 10) }, (err) => {
                if (err) resolve({ success: false, error: err.message });
                else resolve({ success: true });
            });
        });
    }
    if (record.port && record.port.isOpen) {
        record.userClosed = true;
        const port = record.port;
        record.port = null;
        stopSignalPolling(record);
        await closePort(port);
        const result = await reopenRecord(record);
        return result;
    }
    return { success: true };
}

function startSignalPolling(record) {
    stopSignalPolling(record);
    let failures = 0;
    record.signalTimer = setInterval(() => {
        const port = record.port;
        if (!port || !port.isOpen) return;
        port.get((err, status) => {
            if (err || !status) {
                failures++;
                if (failures > 5) stopSignalPolling(record);
                return;
            }
            failures = 0;
            const prev = record.signals || {};
            const next = { ...prev, cts: !!status.cts, dsr: !!status.dsr, dcd: !!status.dcd, ri: !!status.ri };
            if (next.cts !== prev.cts || next.dsr !== prev.dsr || next.dcd !== prev.dcd || next.ri !== prev.ri) {
                record.signals = next;
                send('serial:signals', { path: record.path, signals: next });
            }
        });
    }, 300);
}

function stopSignalPolling(record) {
    if (record && record.signalTimer) {
        clearInterval(record.signalTimer);
        record.signalTimer = null;
    }
}

async function suspend(portPath) {
    const record = records.get(portPath);
    if (!record) return { wasOpen: false };
    const wasOpen = !!(record.port && record.port.isOpen);
    record.suspended = true;
    stopSignalPolling(record);
    const port = record.port;
    record.port = null;
    await closePort(port);
    emitState(record, 'suspended', {});
    return { wasOpen, options: record.options };
}

async function resume(portPath, { reopen = true, newPath = null } = {}) {
    const record = records.get(portPath);
    if (!record) return { success: false, error: 'Unknown port' };
    record.suspended = false;
    if (!reopen) {
        record.userClosed = true;
        emitState(record, 'closed', {});
        records.delete(portPath);
        return { success: true };
    }
    if (!portCache.some(p => p.path === (newPath || portPath))) await listPorts();
    const result = await reopenRecord(record, newPath);
    if (!result.success) {
        record.attempts = 0;
        record.lostAt = Date.now();
        emitState(record, 'lost', { reason: result.error, autoReconnect: record.autoReconnect });
        bus.emit('serial-lost', record);
    }
    return result;
}

function setAutoReconnect(portPath, enabled) {
    const record = records.get(portPath);
    if (record) record.autoReconnect = !!enabled;
    return { success: true };
}

function isOpen(portPath) {
    const record = records.get(portPath);
    return !!(record && record.port && record.port.isOpen);
}

function getRecord(portPath) {
    return records.get(portPath);
}

function getRecords() {
    return Array.from(records.values());
}

async function pollPorts() {
    const list = await listPorts();
    const signature = list.map(p => `${p.path}|${p.serialNumber}|${p.vendorId}|${p.productId}`).sort().join(';');
    if (signature !== portSignature) {
        const previous = portSignature ? portSignature.split(';').map(s => s.split('|')[0]) : [];
        portSignature = signature;
        const current = list.map(p => p.path);
        const added = current.filter(p => !previous.includes(p));
        const removed = previous.filter(p => !current.includes(p));
        bus.emit('ports-changed', { list, added, removed });
        send('serial:ports', { list, added, removed });
    }
    const available = new Set(list.map(p => p.path));
    for (const record of records.values()) {
        if (record.state === 'open' && record.port && !available.has(record.path)) {
            markLost(record, 'Device removed');
        }
    }
}

function startPolling() {
    if (listTimer) clearInterval(listTimer);
    const interval = Math.max(250, Number(settings.get('general.refreshPortsIntervalMs')) || 1000);
    listTimer = setInterval(pollPorts, interval);
    pollPorts();
}

function stopPolling() {
    if (listTimer) clearInterval(listTimer);
    listTimer = null;
}

async function closeAll() {
    stopPolling();
    for (const record of Array.from(records.values())) {
        record.userClosed = true;
        stopSignalPolling(record);
        await closePort(record.port);
    }
    records.clear();
}

function register() {
    ipcMain.handle('serial:list', async () => listPorts());
    ipcMain.handle('serial:open', async (event, portPath, options, meta) => open(portPath, options || {}, meta || {}));
    ipcMain.handle('serial:close', async (event, portPath) => close(portPath));
    ipcMain.handle('serial:write', async (event, portPath, data, opts) => write(portPath, Buffer.from(data), opts || {}));
    ipcMain.handle('serial:set-signals', async (event, portPath, signals) => setSignals(portPath, signals || {}));
    ipcMain.handle('serial:reset', async (event, portPath) => pulseReset(portPath));
    ipcMain.handle('serial:update', async (event, portPath, options) => updateOptions(portPath, options || {}));
    ipcMain.handle('serial:set-auto-reconnect', async (event, portPath, enabled) => setAutoReconnect(portPath, enabled));
    ipcMain.handle('serial:status', async (event, portPath) => {
        const record = records.get(portPath);
        if (!record) return { state: 'closed' };
        return { state: record.state, signals: record.signals, options: record.options, identity: record.identity };
    });
    ipcMain.handle('serial:now', () => now());

    bus.on('settings-changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('general')) startPolling();
    });
}

module.exports = {
    register,
    now,
    listPorts,
    getCachedPorts,
    open,
    close,
    write,
    setSignals,
    pulseReset,
    updateOptions,
    suspend,
    resume,
    reopenRecord,
    isOpen,
    getRecord,
    getRecords,
    emitData,
    emitState,
    startPolling,
    stopPolling,
    closeAll,
    setAutoReconnect
};
