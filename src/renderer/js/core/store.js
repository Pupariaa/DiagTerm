import { invoke } from './api.js';
import { emit } from './bus.js';

const cache = new Map();
const timers = new Map();

export async function loadStore(name, fallback) {
    if (cache.has(name)) return cache.get(name);
    const value = await invoke('store:get', name, fallback === undefined ? null : fallback);
    const resolved = value === null || value === undefined ? fallback : value;
    cache.set(name, resolved);
    return resolved;
}

export function getStore(name, fallback) {
    return cache.has(name) ? cache.get(name) : fallback;
}

export function saveStore(name, value, { debounce = 0 } = {}) {
    cache.set(name, value);
    emit(`store:${name}`, value);
    if (timers.has(name)) clearTimeout(timers.get(name));
    if (debounce > 0) {
        timers.set(name, setTimeout(() => {
            timers.delete(name);
            invoke('store:set', name, value);
        }, debounce));
        return Promise.resolve(true);
    }
    return invoke('store:set', name, value);
}
