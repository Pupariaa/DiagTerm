import { decodeBytes, toHex } from '../core/format.js';
import { getSetting } from '../core/settings.js';
import { entryBytes } from './capture.js';

let encodingCache = null;

export function currentEncoding() {
    if (!encodingCache) encodingCache = getSetting('serial.encoding', 'utf-8');
    return encodingCache;
}

export function invalidateEncoding() {
    encodingCache = null;
}

export function entryText(entry) {
    if (entry.kind !== 'data') return entry.label || '';
    if (entry._txtV === entry.version && entry._txt !== undefined) return entry._txt;
    entry._txt = decodeBytes(entryBytes(entry), currentEncoding());
    entry._txtV = entry.version;
    return entry._txt;
}

export function entryCleanText(entry) {
    return entryText(entry).replace(/[\r\n]+$/, '');
}

export function entryHex(entry) {
    if (entry.kind !== 'data') return '';
    if (entry._hexV === entry.version && entry._hex !== undefined) return entry._hex;
    entry._hex = toHex(entryBytes(entry));
    entry._hexV = entry.version;
    return entry._hex;
}

export function resetEntryCaches(entries) {
    for (const entry of entries) {
        entry._txt = undefined;
        entry._txtV = -1;
        entry._fmt = undefined;
    }
}
