const { ipcMain } = require('electron');
const manager = require('./manager');

const COMNEX_VID = 0x1209;

async function listHubs() {
    const portList = await manager.listPorts();
    const hubMap = new Map();
    for (const port of portList) {
        if (!port.vendorId || !port.productId) continue;
        if (parseInt(port.vendorId, 16) !== COMNEX_VID) continue;
        const pid = parseInt(port.productId, 16);
        const channel = pid & 0x3;
        const hubKey = pid & 0xFFFC;
        const hubKeyHex = `0x${hubKey.toString(16).toUpperCase().padStart(4, '0')}`;
        if (!hubMap.has(hubKeyHex)) {
            hubMap.set(hubKeyHex, { hubKey: hubKeyHex, channels: {}, friendlyName: port.manufacturer || '' });
        }
        hubMap.get(hubKeyHex).channels[channel] = port.path;
    }
    const hubs = [];
    for (const hub of hubMap.values()) {
        const channelCount = Object.keys(hub.channels).length;
        if (channelCount < 3) continue;
        let model = 'COMNEX 4-Port Hub';
        if ((hub.friendlyName && hub.friendlyName.toLowerCase().includes('8')) || channelCount >= 8) {
            model = 'COMNEX 8-Port Hub';
        }
        hubs.push({ hubKey: hub.hubKey, model, friendlyName: hub.friendlyName, channels: hub.channels });
    }
    return hubs;
}

function register() {
    ipcMain.handle('comnex:list', async () => {
        try {
            return await listHubs();
        } catch (error) {
            console.error('Error listing COMNEX devices:', error.message);
            return [];
        }
    });
    ipcMain.handle('comnex:command', async (event, portPath, command) => manager.write(portPath, Buffer.from(command, 'utf8'), { silent: true }));
}

module.exports = { register, listHubs };
