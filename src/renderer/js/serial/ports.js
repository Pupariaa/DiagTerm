import { invoke, on } from '../core/api.js';
import { emit } from '../core/bus.js';

let ports = [];

export async function initPorts() {
    ports = await invoke('serial:list').catch(() => []) || [];
    on('serial:ports', ({ list, added, removed }) => {
        ports = list || [];
        emit('ports:changed', { list: ports, added: added || [], removed: removed || [] });
    });
    emit('ports:changed', { list: ports, added: [], removed: [] });
}

export async function refreshPorts() {
    ports = await invoke('serial:list').catch(() => ports) || ports;
    emit('ports:changed', { list: ports, added: [], removed: [] });
    return ports;
}

export function getPorts() {
    return ports;
}

export function portInfo(path) {
    return ports.find(p => p.path === path) || null;
}

export function isComnexPort(path) {
    const info = portInfo(path);
    return !!(info && parseInt(info.vendorId, 16) === 0x1209);
}

export function comnexChannel(path) {
    const info = portInfo(path);
    if (!info || parseInt(info.vendorId, 16) !== 0x1209) return null;
    return parseInt(info.productId, 16) & 0x3;
}

export function portLabel(info) {
    if (!info) return '';
    const parts = [info.path];
    const desc = info.friendlyName ? info.friendlyName.replace(/\s*\(COM\d+\)\s*$/i, '') : info.manufacturer;
    if (desc) parts.push(desc);
    if (info.vendorId && info.productId) parts.push(`${info.vendorId.toUpperCase()}:${info.productId.toUpperCase()}`);
    return parts.join(' - ');
}

export function sortPorts(list) {
    return [...list].sort((a, b) => {
        const na = parseInt(String(a.path).replace(/\D/g, ''), 10);
        const nb = parseInt(String(b.path).replace(/\D/g, ''), 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
        return String(a.path).localeCompare(String(b.path));
    });
}
