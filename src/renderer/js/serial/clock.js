import { invoke } from '../core/api.js';

let offset = 0;
let synced = false;

async function sync() {
    try {
        const before = performance.now();
        const mainTime = await invoke('serial:now');
        const after = performance.now();
        const localAtMid = performance.timeOrigin + (before + after) / 2;
        offset = mainTime - localAtMid;
        synced = true;
    } catch (error) {
        console.warn('Clock sync failed:', error.message);
    }
}

export async function initClock() {
    await sync();
    setInterval(sync, 30000);
}

export function mainNow() {
    return performance.timeOrigin + performance.now() + offset;
}

export function isClockSynced() {
    return synced;
}
