const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { bus, send } = require('./context');

const DEFAULT_INDEX_URLS = [
    'https://downloads.arduino.cc/packages/package_index.json',
    'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
    'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
    'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
    'https://raw.githubusercontent.com/DeqingSun/ch55xduino/ch55xduino/package_ch55xduino_mcs51_index.json',
    'https://github.com/openwch/board_manager_files/raw/main/package_ch32v_index.json'
];

const DEFAULTS = {
    general: {
        restoreSession: true,
        confirmOnClose: true,
        checkUpdatesOnStartup: true,
        theme: 'dark',
        language: 'en',
        uiScale: 100,
        accentColor: '',
        refreshPortsIntervalMs: 1000
    },
    serial: {
        baudRate: 115200,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        flowControl: 'none',
        dtrOnOpen: true,
        rtsOnOpen: true,
        encoding: 'utf-8',
        lineEnding: 'NL',
        txInputMode: 'text',
        framingMode: 'delimiter',
        framingDelimiter: '0A',
        framingTimeoutMs: 50,
        framingLength: 16,
        framingMaxLength: 4096,
        framingFlushMs: 0,
        batchIntervalMs: 16
    },
    terminal: {
        fontFamily: "Consolas, 'Cascadia Mono', Monaco, monospace",
        fontSize: 13,
        lineHeight: 1.45,
        wrap: true,
        maxEntries: 200000,
        maxCaptureMB: 128,
        viewMode: 'ascii',
        showControlChars: false,
        rxColor: '#d4d4d4',
        txColor: '#4ec9b0',
        showTx: true,
        showDirection: true,
        autoScroll: true,
        clearOnConnect: false,
        timestampMode: 'none',
        timestampFormat: 'HH:mm:ss.SSS',
        persistSendHistory: true,
        sendHistorySize: 200
    },
    timeline: {
        visible: true,
        height: 190,
        windowMs: 10000,
        mode: 'auto',
        rxColor: '#4caf50',
        txColor: '#f44336',
        markerColor: '#ffb300',
        frameGapMs: 5,
        showMinimap: true
    },
    reconnect: {
        enabled: true,
        intervalMs: 1000,
        maxAttempts: 0,
        reopenDelayMs: 300,
        matchBySerialNumber: true
    },
    logging: {
        enabled: false,
        folder: '',
        format: 'txt',
        rotateSizeMB: 50,
        rotateMinutes: 0,
        fileNameTemplate: '{port}_{date}_{time}'
    },
    flash: {
        indexUrls: DEFAULT_INDEX_URLS,
        autoUpdate: true,
        updateIntervalHours: 12,
        toolsFolder: '',
        reuseArduino15: true,
        keepOldVersions: false,
        concurrency: 4,
        retries: 1,
        verify: false,
        reopenPortAfterFlash: true,
        uploadSpeedOverride: '',
        productionFilters: [],
        productionCooldownMs: 15000
    },
    plotter: {
        maxPoints: 5000,
        windowSeconds: 30
    },
    bridges: {
        defaultTcpPort: 7000
    },
    notifications: {
        enabled: true,
        sound: true,
        soundVolume: 0.5,
        notifyOnFlashDone: true,
        notifyOnDisconnect: false
    },
    shortcuts: {},
    advanced: {
        devTools: false
    }
};

let settings = null;
let saveTimer = null;
let settingsFile = null;
let dataDir = null;

function deepMerge(base, override) {
    if (Array.isArray(base)) return Array.isArray(override) ? override : base;
    if (typeof base !== 'object' || base === null) return override === undefined ? base : override;
    const out = { ...base };
    if (override && typeof override === 'object') {
        for (const key of Object.keys(override)) {
            if (key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])) {
                out[key] = deepMerge(base[key], override[key]);
            } else {
                out[key] = override[key];
            }
        }
    }
    return out;
}

function getPaths() {
    if (!settingsFile) {
        const root = app.getPath('userData');
        settingsFile = path.join(root, 'settings.json');
        dataDir = path.join(root, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return { settingsFile, dataDir };
}

function load() {
    const { settingsFile } = getPaths();
    let stored = {};
    try {
        if (fs.existsSync(settingsFile)) {
            stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        }
    } catch (error) {
        console.error('Failed to read settings, using defaults:', error.message);
    }
    settings = deepMerge(DEFAULTS, stored);
    return settings;
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const { settingsFile } = getPaths();
    try {
        const tmp = settingsFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
        fs.renameSync(tmp, settingsFile);
    } catch (error) {
        console.error('Failed to save settings:', error.message);
    }
}

function getAll() {
    if (!settings) load();
    return settings;
}

function get(keyPath) {
    const parts = keyPath.split('.');
    let node = getAll();
    for (const part of parts) {
        if (node == null) return undefined;
        node = node[part];
    }
    return node;
}

function set(keyPath, value) {
    const parts = keyPath.split('.');
    let node = getAll();
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    scheduleSave();
    bus.emit('settings-changed', keyPath, value);
    send('settings:changed', { keyPath, value, settings });
}

function replaceAll(next) {
    settings = deepMerge(DEFAULTS, next || {});
    scheduleSave();
    bus.emit('settings-changed', '*', settings);
    send('settings:changed', { keyPath: '*', value: settings, settings });
}

function resetCategory(category) {
    if (!category) {
        replaceAll({});
        return;
    }
    if (DEFAULTS[category] !== undefined) {
        set(category, JSON.parse(JSON.stringify(DEFAULTS[category])));
    }
}

function storeFile(name) {
    const safe = String(name).replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(getPaths().dataDir, safe + '.json');
}

function storeGet(name, fallback = null) {
    try {
        const file = storeFile(name);
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        console.error(`Failed to read store ${name}:`, error.message);
        return fallback;
    }
}

function storeSet(name, value) {
    try {
        const file = storeFile(name);
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tmp, file);
        bus.emit('store-changed', name, value);
        return true;
    } catch (error) {
        console.error(`Failed to write store ${name}:`, error.message);
        return false;
    }
}

function register() {
    load();
    ipcMain.handle('settings:get-all', () => ({ settings: getAll(), defaults: DEFAULTS }));
    ipcMain.handle('settings:set', (event, keyPath, value) => {
        set(keyPath, value);
        return true;
    });
    ipcMain.handle('settings:replace', (event, next) => {
        replaceAll(next);
        return true;
    });
    ipcMain.handle('settings:reset', (event, category) => {
        resetCategory(category);
        return getAll();
    });
    ipcMain.handle('store:get', (event, name, fallback) => storeGet(name, fallback));
    ipcMain.handle('store:set', (event, name, value) => storeSet(name, value));
    ipcMain.handle('app:paths', () => ({
        userData: app.getPath('userData'),
        data: getPaths().dataDir,
        documents: app.getPath('documents')
    }));
}

module.exports = { register, get, set, getAll, saveNow, storeGet, storeSet, DEFAULTS, DEFAULT_INDEX_URLS };
