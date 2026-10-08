import { invoke, on } from './api.js';
import { emit } from './bus.js';

let current = {};
let defaults = {};

export async function loadSettings() {
    const result = await invoke('settings:get-all');
    current = result.settings || {};
    defaults = result.defaults || {};
    on('settings:changed', ({ keyPath, settings }) => {
        current = settings;
        emit('settings:changed', keyPath);
    });
    return current;
}

export function getSetting(keyPath, fallback) {
    const parts = keyPath.split('.');
    let node = current;
    for (const part of parts) {
        if (node == null) return fallback;
        node = node[part];
    }
    return node === undefined ? fallback : node;
}

export function getDefault(keyPath) {
    const parts = keyPath.split('.');
    let node = defaults;
    for (const part of parts) {
        if (node == null) return undefined;
        node = node[part];
    }
    return node;
}

export function allSettings() {
    return current;
}

export function allDefaults() {
    return defaults;
}

export async function setSetting(keyPath, value) {
    const parts = keyPath.split('.');
    let node = current;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    await invoke('settings:set', keyPath, value);
}

export async function replaceSettings(next) {
    await invoke('settings:replace', next);
}

export async function resetSettings(category) {
    current = await invoke('settings:reset', category);
}
