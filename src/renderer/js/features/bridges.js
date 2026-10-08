import { openModal, toast } from '../core/dialogs.js';
import { escapeHtml, options } from '../core/dom.js';
import { invoke, on } from '../core/api.js';
import { emit } from '../core/bus.js';
import { getSetting } from '../core/settings.js';
import { formatBytes } from '../core/format.js';
import { t } from '../core/i18n.js';
import { allSessions, createSession } from '../serial/sessions.js';
import { getPorts, sortPorts, portLabel } from '../serial/ports.js';

let bridges = [];

export function activeBridges() {
    return bridges;
}

export async function initBridges() {
    bridges = await invoke('bridge:list').catch(() => []) || [];
    on('bridge:state', (state) => {
        const idx = bridges.findIndex(b => b.id === state.id);
        if (state.state === 'stopped') {
            if (idx >= 0) bridges.splice(idx, 1);
        } else if (idx >= 0) bridges[idx] = state;
        else bridges.push(state);
        emit('bridges:changed', bridges);
    });
}

function describe(b) {
    switch (b.type) {
        case 'tcp-server': return `TCP ${t('server')} :${b.port} <-> ${b.serialPath}`;
        case 'telnet-server': return `Telnet ${t('server')} :${b.port} <-> ${b.serialPath}`;
        case 'tcp-client': return `TCP ${t('client')} ${b.host}:${b.port} <-> ${b.serialPath}`;
        case 'ws-server': return `WebSocket ws://${t('host')}:${b.port} <-> ${b.serialPath}`;
        case 'com-com': return `${b.portA} <-> ${b.portB} (${t('sniffer')})`;
        default: return b.type;
    }
}

export function openBridges(session) {
    const openSerial = allSessions().filter(s => s.kind === 'serial' && s.isOpen);
    const ports = sortPorts(getPorts());
    const modal = openModal({
        title: t('Bridges'),
        width: 760,
        body: `
            <p class="dim">${escapeHtml(t('Expose a serial port over the network (TCP, Telnet, WebSocket), connect it to a remote TCP server, or insert DiagTerm between two COM ports to sniff both directions.'))}</p>
            <div class="bridge-list"></div>
            <div class="form-sep">${escapeHtml(t('New bridge'))}</div>
            <div class="form-grid wide">
                <label>${escapeHtml(t('Type'))}</label>
                <select class="input" data-b="type">${options([
                    ['tcp-server', t('TCP server (raw socket)')],
                    ['telnet-server', t('Telnet server')],
                    ['ws-server', t('WebSocket server')],
                    ['tcp-client', t('TCP client (connect to host)')],
                    ['com-com', t('COM to COM sniffer (man in the middle)')]
                ], 'tcp-server')}</select>
                <label class="b-net">${escapeHtml(t('Serial port'))}</label>
                <select class="input b-net" data-b="serialPath">${openSerial.length ? options(openSerial.map(s => [s.path, s.displayName]), session && session.isOpen ? session.path : '') : `<option value="">${escapeHtml(t('Open a port first'))}</option>`}</select>
                <label class="b-host">${escapeHtml(t('Host'))}</label>
                <input class="input b-host" data-b="host" value="127.0.0.1">
                <label class="b-net">${escapeHtml(t('TCP port'))}</label>
                <input class="input b-net" type="number" min="1" max="65535" data-b="port" value="${getSetting('bridges.defaultTcpPort', 7000)}">
                <label class="b-ws">${escapeHtml(t('WebSocket frames'))}</label>
                <select class="input b-ws" data-b="wsText">${options([['0', t('Binary')], ['1', t('Text (UTF-8)')]], '0')}</select>
                <label class="b-com">${escapeHtml(t('Port A (device side)'))}</label>
                <select class="input b-com" data-b="portA">${options(ports.map(p => [p.path, portLabel(p)]), '')}</select>
                <label class="b-com">${escapeHtml(t('Port B (host side)'))}</label>
                <select class="input b-com" data-b="portB">${options(ports.map(p => [p.path, portLabel(p)]), ports[1] ? ports[1].path : '')}</select>
                <label class="b-com">${escapeHtml(t('Baud rate'))}</label>
                <input class="input b-com" type="number" data-b="baud" value="${session ? session.options.baudRate : 115200}">
            </div>`,
        buttons: [
            { label: t('Close') },
            { label: t('Start bridge'), primary: true, keepOpen: true, action: () => start() }
        ]
    });
    const body = modal.body;
    const listEl = body.querySelector('.bridge-list');
    const sync = () => {
        const type = body.querySelector('[data-b="type"]').value;
        for (const n of body.querySelectorAll('.b-net')) n.style.display = type === 'com-com' ? 'none' : '';
        for (const n of body.querySelectorAll('.b-host')) n.style.display = type === 'tcp-client' ? '' : 'none';
        for (const n of body.querySelectorAll('.b-ws')) n.style.display = type === 'ws-server' ? '' : 'none';
        for (const n of body.querySelectorAll('.b-com')) n.style.display = type === 'com-com' ? '' : 'none';
    };
    const renderList = () => {
        listEl.innerHTML = bridges.length ? bridges.map(b => `
            <div class="bridge-row st-${b.state}">
                <span class="bridge-desc">${escapeHtml(describe(b))}</span>
                <span class="dim">${escapeHtml(b.state)}${b.clients ? ` - ${b.clients} ${escapeHtml(t('client(s)'))}` : ''} - ${escapeHtml(t('in'))} ${formatBytes(b.bytesIn)} / ${escapeHtml(t('out'))} ${formatBytes(b.bytesOut)}</span>
                ${b.error ? `<span class="err">${escapeHtml(b.error)}</span>` : ''}
                ${b.virtualPath ? `<button class="btn sm" data-view="${b.id}">${escapeHtml(t('Open sniffer tab'))}</button>` : ''}
                <button class="btn sm btn-danger" data-stop="${b.id}">${escapeHtml(t('Stop'))}</button>
            </div>`).join('') : `<div class="dim">${escapeHtml(t('No active bridge'))}</div>`;
    };
    async function start() {
        const cfg = {};
        for (const input of body.querySelectorAll('[data-b]')) cfg[input.dataset.b] = input.value;
        cfg.wsText = cfg.wsText === '1';
        if (cfg.type === 'com-com') {
            if (!cfg.portA || !cfg.portB || cfg.portA === cfg.portB) {
                toast(t('Choose two different ports'), { type: 'warn' });
                return;
            }
            const busy = allSessions().find(s => s.kind === 'serial' && s.state !== 'closed' && (s.path === cfg.portA || s.path === cfg.portB));
            if (busy) {
                toast(t('{port} is open in a tab. Close it first.', { port: busy.path }), { type: 'warn' });
                return;
            }
            const baud = parseInt(cfg.baud, 10) || 115200;
            cfg.optionsA = { baudRate: baud };
            cfg.optionsB = { baudRate: baud };
        } else if (!cfg.serialPath) {
            toast(t('Open a serial port first'), { type: 'warn' });
            return;
        }
        const res = await invoke('bridge:start', cfg);
        if (!res.success) {
            toast(res.error || t('Failed to start bridge'), { type: 'error' });
            return;
        }
        toast(t('Bridge started: {d}', { d: describe(res.bridge) }), { type: 'success' });
        if (res.bridge.virtualPath) openSnifferTab(res.bridge);
        const s = allSessions().find(x => x.path === cfg.serialPath);
        if (s) s.addSystem(t('Bridge started: {d}', { d: describe(res.bridge) }), 'info');
    }
    listEl.addEventListener('click', async (e) => {
        const stop = e.target.closest('[data-stop]');
        if (stop) await invoke('bridge:stop', parseInt(stop.dataset.stop, 10));
        const view = e.target.closest('[data-view]');
        if (view) {
            const b = bridges.find(x => x.id === parseInt(view.dataset.view, 10));
            if (b) openSnifferTab(b);
        }
    });
    body.querySelector('[data-b="type"]').addEventListener('change', sync);
    const off = on('bridge:state', () => {
        if (modal.closed) {
            off();
            return;
        }
        setTimeout(renderList, 0);
    });
    sync();
    renderList();
}

export function openSnifferTab(bridge) {
    const existing = allSessions().find(s => s.path === bridge.virtualPath);
    if (existing) return existing;
    const session = createSession({
        kind: 'bridge',
        path: bridge.virtualPath,
        title: `${bridge.portA} \u2194 ${bridge.portB}`,
        options: bridge.baudRate ? { baudRate: bridge.baudRate } : undefined
    });
    session.bridgeLabel = `${bridge.portA} \u2194 ${bridge.portB}`;
    session.addSystem(t('Sniffer: RX = {a} to {b}, TX = {b} to {a}', { a: bridge.portA, b: bridge.portB }), 'info');
    return session;
}
