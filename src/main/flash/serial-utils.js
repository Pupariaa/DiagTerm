const fs = require('fs');
const os = require('os');
const path = require('path');
const { SerialPort } = require('serialport');
const manager = require('../serial/manager');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function touch1200(portPath) {
    return new Promise((resolve) => {
        let port;
        try {
            port = new SerialPort({ path: portPath, baudRate: 1200, autoOpen: false, hupcl: true });
        } catch (error) {
            resolve({ success: false, error: error.message });
            return;
        }
        port.open((err) => {
            if (err) {
                resolve({ success: false, error: err.message });
                return;
            }
            port.set({ dtr: false, rts: true }, () => {
                setTimeout(() => {
                    port.close(() => resolve({ success: true }));
                }, 100);
            });
        });
    });
}

async function waitForUploadPort(originalPath, beforePaths, timeoutMs = 10000, log) {
    const deadline = Date.now() + timeoutMs;
    let disappeared = false;
    while (Date.now() < deadline) {
        const list = await manager.listPorts();
        const current = list.map(p => p.path);
        const appeared = current.filter(p => !beforePaths.includes(p));
        if (appeared.length > 0) {
            if (log) log(`Upload port detected: ${appeared[0]}\n`);
            return appeared[0];
        }
        if (!current.includes(originalPath)) disappeared = true;
        else if (disappeared) {
            if (log) log(`Upload port back: ${originalPath}\n`);
            return originalPath;
        }
        await sleep(250);
    }
    const list = await manager.listPorts();
    if (list.some(p => p.path === originalPath)) return originalPath;
    return null;
}

async function waitForPortReturn(originalPath, identity, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const list = await manager.listPorts();
        if (identity && identity.serialNumber) {
            const match = list.find(p => p.serialNumber === identity.serialNumber && (!identity.vendorId || p.vendorId === identity.vendorId));
            if (match) return match.path;
        }
        if (list.some(p => p.path === originalPath)) return originalPath;
        await sleep(300);
    }
    return null;
}

function uf2Roots() {
    const roots = [];
    if (process.platform === 'win32') {
        for (let c = 68; c <= 90; c++) roots.push(`${String.fromCharCode(c)}:\\`);
        return roots;
    }
    const candidates = process.platform === 'darwin'
        ? ['/Volumes']
        : [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, '/media', '/mnt'];
    for (const base of candidates) {
        try {
            for (const name of fs.readdirSync(base)) roots.push(path.join(base, name));
        } catch (error) {
            continue;
        }
    }
    return roots;
}

function findUf2Drives() {
    const drives = [];
    for (const root of uf2Roots()) {
        const info = path.join(root, 'INFO_UF2.TXT');
        try {
            if (fs.existsSync(info)) {
                const text = fs.readFileSync(info, 'utf8');
                const boardId = (text.match(/Board-ID:\s*(\S+)/i) || [])[1] || '';
                drives.push({ root, info: text, boardId });
            }
        } catch (error) {
            continue;
        }
    }
    return drives;
}

async function waitForUf2Drive(beforeRoots, timeoutMs = 15000, allowExisting = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const drives = findUf2Drives();
        const fresh = drives.find(d => !beforeRoots.includes(d.root));
        if (fresh) return fresh;
        if (allowExisting && drives.length > 0) return drives[0];
        await sleep(300);
    }
    return null;
}

async function waitForDriveGone(root, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(path.join(root, 'INFO_UF2.TXT'))) return true;
        await sleep(300);
    }
    return false;
}

module.exports = { sleep, touch1200, waitForUploadPort, waitForPortReturn, findUf2Drives, waitForUf2Drive, waitForDriveGone };
