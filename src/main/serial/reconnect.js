const { bus } = require('../context');
const settings = require('../settings');
const manager = require('./manager');

let busy = false;

function config() {
    return settings.get('reconnect') || {};
}

function findCandidate(record, list) {
    const identity = record.identity || {};
    const cfg = config();
    const free = list.filter(p => !manager.isOpen(p.path) || p.path === record.path);
    if (cfg.matchBySerialNumber !== false && identity.serialNumber) {
        const bySerial = free.find(p => p.serialNumber === identity.serialNumber &&
            (!identity.vendorId || p.vendorId === identity.vendorId) &&
            (!identity.productId || p.productId === identity.productId));
        if (bySerial) return bySerial.path;
    }
    const samePath = free.find(p => p.path === record.path);
    if (samePath) {
        if (!identity.vendorId || !samePath.vendorId || samePath.vendorId === identity.vendorId) return samePath.path;
    }
    if (identity.pnpId) {
        const byPnp = free.find(p => p.pnpId && p.pnpId === identity.pnpId);
        if (byPnp) return byPnp.path;
    }
    if (identity.locationId) {
        const byLocation = free.find(p => p.locationId && p.locationId === identity.locationId &&
            p.vendorId === identity.vendorId && p.productId === identity.productId);
        if (byLocation) return byLocation.path;
    }
    return null;
}

async function attempt(record, list) {
    const cfg = config();
    if (record.state !== 'lost' && record.state !== 'reconnecting') return;
    if (!cfg.enabled || !record.autoReconnect || record.suspended) return;
    const candidate = findCandidate(record, list);
    if (!candidate) return;
    if (cfg.maxAttempts > 0 && record.attempts >= cfg.maxAttempts) {
        if (record.state !== 'given-up') manager.emitState(record, 'given-up', { attempts: record.attempts });
        return;
    }
    record.attempts = (record.attempts || 0) + 1;
    manager.emitState(record, 'reconnecting', { attempts: record.attempts, candidate });
    await new Promise(r => setTimeout(r, Math.max(0, Number(cfg.reopenDelayMs) || 0)));
    if (record.suspended || record.userClosed) return;
    const result = await manager.reopenRecord(record, candidate);
    if (!result.success) {
        console.log(`Reconnect attempt ${record.attempts} on ${candidate} failed: ${result.error}`);
        record.state = 'lost';
        manager.emitState(record, 'lost', { reason: result.error, attempts: record.attempts, autoReconnect: record.autoReconnect });
    } else {
        console.log(`Port reconnected on ${result.path}`);
    }
}

async function tick() {
    if (busy) return;
    const lost = manager.getRecords().filter(r => (r.state === 'lost' || r.state === 'reconnecting') && r.autoReconnect && !r.suspended);
    if (lost.length === 0) return;
    busy = true;
    try {
        const list = await manager.listPorts();
        for (const record of lost) {
            await attempt(record, list);
        }
    } catch (error) {
        console.error('Reconnect tick error:', error.message);
    } finally {
        busy = false;
    }
}

let timer = null;

function start() {
    stop();
    const interval = Math.max(250, Number(config().intervalMs) || 1000);
    timer = setInterval(tick, interval);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

function register() {
    start();
    bus.on('settings-changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('reconnect')) start();
    });
    bus.on('ports-changed', () => tick());
}

module.exports = { register, stop };
