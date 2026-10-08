const { ipcMain } = require('electron');
const net = require('net');
const { WebSocketServer } = require('ws');
const { bus, send } = require('../context');
const manager = require('./manager');

const bridges = new Map();
let nextId = 1;

const IAC = 255;
const SB = 250;
const SE = 240;

function stripTelnet(state, buffer) {
    const out = [];
    for (const byte of buffer) {
        if (state.mode === 'data') {
            if (byte === IAC) state.mode = 'iac';
            else out.push(byte);
        } else if (state.mode === 'iac') {
            if (byte === IAC) {
                out.push(IAC);
                state.mode = 'data';
            } else if (byte >= 251 && byte <= 254) {
                state.mode = 'option';
            } else if (byte === SB) {
                state.mode = 'sub';
            } else {
                state.mode = 'data';
            }
        } else if (state.mode === 'option') {
            state.mode = 'data';
        } else if (state.mode === 'sub') {
            if (byte === IAC) state.mode = 'sub-iac';
        } else if (state.mode === 'sub-iac') {
            state.mode = byte === SE ? 'data' : 'sub';
        }
    }
    return Buffer.from(out);
}

function escapeTelnet(buffer) {
    if (!buffer.includes(IAC)) return buffer;
    const out = [];
    for (const byte of buffer) {
        out.push(byte);
        if (byte === IAC) out.push(IAC);
    }
    return Buffer.from(out);
}

function publicState(bridge) {
    return {
        id: bridge.id,
        type: bridge.type,
        serialPath: bridge.serialPath || null,
        portA: bridge.portA || null,
        portB: bridge.portB || null,
        host: bridge.host || null,
        port: bridge.port || null,
        state: bridge.state,
        clients: bridge.clients ? bridge.clients.size : 0,
        bytesIn: bridge.bytesIn,
        bytesOut: bridge.bytesOut,
        error: bridge.error || null,
        virtualPath: bridge.virtualPath || null,
        baudRate: bridge.baudRate || null
    };
}

function emit(bridge) {
    send('bridge:state', publicState(bridge));
}

function attachSerialForward(bridge, forward) {
    bridge.onSerial = (portPath, dir, t, buffer) => {
        if (portPath !== bridge.serialPath || dir !== 'RX') return;
        bridge.bytesOut += buffer.length;
        forward(buffer);
    };
    bus.on('serial-data', bridge.onSerial);
}

function toSerial(bridge, buffer) {
    if (!buffer.length) return;
    bridge.bytesIn += buffer.length;
    manager.write(bridge.serialPath, buffer).then((res) => {
        if (!res.success) {
            bridge.error = res.error;
            emit(bridge);
        }
    });
}

function startTcpServer(bridge, telnet) {
    bridge.clients = new Set();
    bridge.server = net.createServer((socket) => {
        const client = { socket, telnet: { mode: 'data' } };
        bridge.clients.add(client);
        if (telnet) socket.write(Buffer.from([IAC, 251, 1, IAC, 251, 3]));
        socket.on('data', (data) => toSerial(bridge, telnet ? stripTelnet(client.telnet, data) : data));
        socket.on('close', () => {
            bridge.clients.delete(client);
            emit(bridge);
        });
        socket.on('error', () => bridge.clients.delete(client));
        emit(bridge);
    });
    attachSerialForward(bridge, (buffer) => {
        for (const client of bridge.clients) {
            client.socket.write(telnet ? escapeTelnet(buffer) : buffer);
        }
    });
    return new Promise((resolve) => {
        bridge.server.once('error', (err) => resolve({ success: false, error: err.message }));
        bridge.server.listen(bridge.port, bridge.host || '0.0.0.0', () => {
            bridge.state = 'listening';
            resolve({ success: true });
        });
    });
}

function startTcpClient(bridge) {
    bridge.clients = new Set();
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: bridge.host, port: bridge.port }, () => {
            bridge.state = 'connected';
            bridge.clients.add({ socket });
            emit(bridge);
            resolve({ success: true });
        });
        bridge.socket = socket;
        socket.on('data', (data) => toSerial(bridge, data));
        socket.on('error', (err) => {
            bridge.error = err.message;
            bridge.state = 'error';
            emit(bridge);
            resolve({ success: false, error: err.message });
        });
        socket.on('close', () => {
            bridge.state = 'disconnected';
            bridge.clients.clear();
            emit(bridge);
        });
        attachSerialForward(bridge, (buffer) => {
            if (!socket.destroyed) socket.write(buffer);
        });
    });
}

function startWsServer(bridge) {
    bridge.clients = new Set();
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: bridge.port, host: bridge.host || '0.0.0.0' });
        bridge.wss = wss;
        wss.on('connection', (ws) => {
            bridge.clients.add(ws);
            ws.on('message', (data) => toSerial(bridge, Buffer.isBuffer(data) ? data : Buffer.from(data)));
            ws.on('close', () => {
                bridge.clients.delete(ws);
                emit(bridge);
            });
            emit(bridge);
        });
        wss.on('listening', () => {
            bridge.state = 'listening';
            resolve({ success: true });
        });
        wss.on('error', (err) => resolve({ success: false, error: err.message }));
        attachSerialForward(bridge, (buffer) => {
            for (const ws of bridge.clients) {
                if (ws.readyState === 1) ws.send(bridge.wsText ? buffer.toString('utf8') : buffer);
            }
        });
    });
}

async function startComCom(bridge, optionsA, optionsB) {
    const a = await manager.open(bridge.portA, optionsA || {}, { owner: 'bridge', autoReconnect: true });
    if (!a.success) return { success: false, error: `${bridge.portA}: ${a.error}` };
    const b = await manager.open(bridge.portB, optionsB || optionsA || {}, { owner: 'bridge', autoReconnect: true });
    if (!b.success) {
        await manager.close(bridge.portA);
        return { success: false, error: `${bridge.portB}: ${b.error}` };
    }
    bridge.virtualPath = `bridge:${bridge.id}`;
    bridge.onSerial = (portPath, dir, t, buffer) => {
        if (dir !== 'RX') return;
        if (portPath === bridge.portA) {
            bridge.bytesIn += buffer.length;
            manager.write(bridge.portB, buffer, { silent: true });
            manager.emitData(bridge.virtualPath, 'RX', buffer, t);
        } else if (portPath === bridge.portB) {
            bridge.bytesOut += buffer.length;
            manager.write(bridge.portA, buffer, { silent: true });
            manager.emitData(bridge.virtualPath, 'TX', buffer, t);
        }
    };
    bus.on('serial-data', bridge.onSerial);
    bridge.state = 'running';
    return { success: true };
}

async function start(config) {
    const bridge = {
        id: nextId++,
        type: config.type,
        serialPath: config.serialPath,
        host: config.host,
        port: parseInt(config.port, 10),
        portA: config.portA,
        portB: config.portB,
        wsText: !!config.wsText,
        baudRate: config.optionsA ? parseInt(config.optionsA.baudRate, 10) || null : null,
        state: 'starting',
        bytesIn: 0,
        bytesOut: 0
    };
    if (['tcp-server', 'telnet-server', 'tcp-client', 'ws-server'].includes(bridge.type) && !manager.isOpen(bridge.serialPath)) {
        return { success: false, error: 'Serial port must be open' };
    }
    let result;
    if (bridge.type === 'tcp-server') result = await startTcpServer(bridge, false);
    else if (bridge.type === 'telnet-server') result = await startTcpServer(bridge, true);
    else if (bridge.type === 'tcp-client') result = await startTcpClient(bridge);
    else if (bridge.type === 'ws-server') result = await startWsServer(bridge);
    else if (bridge.type === 'com-com') result = await startComCom(bridge, config.optionsA, config.optionsB);
    else result = { success: false, error: 'Unknown bridge type' };
    if (!result.success) {
        await stop(bridge.id, bridge);
        return result;
    }
    bridges.set(bridge.id, bridge);
    emit(bridge);
    return { success: true, bridge: publicState(bridge) };
}

async function stop(id, provided) {
    const bridge = provided || bridges.get(id);
    if (!bridge) return { success: false };
    if (bridge.onSerial) bus.off('serial-data', bridge.onSerial);
    try {
        if (bridge.server) {
            for (const client of bridge.clients || []) client.socket.destroy();
            bridge.server.close();
        }
        if (bridge.socket) bridge.socket.destroy();
        if (bridge.wss) {
            for (const ws of bridge.clients || []) ws.terminate();
            bridge.wss.close();
        }
        if (bridge.type === 'com-com') {
            await manager.close(bridge.portA);
            await manager.close(bridge.portB);
        }
    } catch (error) {
        console.error('Error stopping bridge:', error.message);
    }
    bridge.state = 'stopped';
    bridges.delete(bridge.id);
    emit(bridge);
    return { success: true };
}

function register() {
    ipcMain.handle('bridge:start', async (event, config) => start(config || {}));
    ipcMain.handle('bridge:stop', async (event, id) => stop(id));
    ipcMain.handle('bridge:list', async () => Array.from(bridges.values()).map(publicState));
    bus.on('serial-state', (payload) => {
        if (!payload.previousPath) return;
        for (const bridge of bridges.values()) {
            if (bridge.serialPath === payload.previousPath) bridge.serialPath = payload.path;
            if (bridge.portA === payload.previousPath) bridge.portA = payload.path;
            if (bridge.portB === payload.previousPath) bridge.portB = payload.path;
        }
    });
}

async function stopAll() {
    for (const id of Array.from(bridges.keys())) await stop(id);
}

module.exports = { register, stopAll };
