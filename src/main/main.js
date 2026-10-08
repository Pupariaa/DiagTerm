const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { setMainWindow } = require('./context');
const settings = require('./settings');
const updater = require('./updater');
const files = require('./files');
const logger = require('./logger');
const serialManager = require('./serial/manager');
const reconnect = require('./serial/reconnect');
const comnex = require('./serial/comnex');
const fileSender = require('./serial/file-sender');
const bridge = require('./serial/bridge');
const flashJobs = require('./flash/jobs');

let mainWindow = null;
let allowClose = false;

function createWindow() {
    const bounds = settings.storeGet('window-state', null) || {};
    const win = new BrowserWindow({
        width: bounds.width || 1400,
        height: bounds.height || 900,
        x: bounds.x,
        y: bounds.y,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        backgroundColor: '#1e1e1e',
        icon: path.join(__dirname, '../icons/diagTerm-256-bgt.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    if (bounds.maximized) win.maximize();

    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow = win;
    setMainWindow(win);

    const saveBounds = () => {
        if (win.isDestroyed()) return;
        const b = win.getNormalBounds();
        settings.storeSet('window-state', { ...b, maximized: win.isMaximized() });
    };
    win.on('resize', debounce(saveBounds, 500));
    win.on('move', debounce(saveBounds, 500));
    win.on('maximize', () => win.webContents.send('window:maximized', true));
    win.on('unmaximize', () => win.webContents.send('window:maximized', false));

    win.on('close', (event) => {
        if (allowClose || !settings.get('general.confirmOnClose')) {
            saveBounds();
            return;
        }
        event.preventDefault();
        win.webContents.send('app:close-requested');
    });

    if (settings.get('advanced.devTools')) win.webContents.openDevTools({ mode: 'detach' });
    return win;
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function registerWindowIpc() {
    ipcMain.handle('window-minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.minimize();
    });
    ipcMain.handle('window-maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    });
    ipcMain.handle('window-close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.close();
    });
    ipcMain.handle('app:confirm-close', () => {
        allowClose = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
    ipcMain.handle('app:toggle-devtools', (event) => {
        event.sender.toggleDevTools();
    });
    ipcMain.handle('app:reload', (event) => {
        event.sender.reload();
    });
}

app.whenReady().then(() => {
    settings.register();
    files.register();
    updater.register();
    serialManager.register();
    reconnect.register();
    comnex.register();
    fileSender.register();
    bridge.register();
    logger.register();
    flashJobs.register();
    registerWindowIpc();

    createWindow();
    serialManager.startPolling();
    updater.checkOnStartup();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', async () => {
    allowClose = true;
    settings.saveNow();
});

app.on('window-all-closed', async () => {
    reconnect.stop();
    flashJobs.cancelAll();
    logger.closeAll();
    await bridge.stopAll();
    await serialManager.closeAll();
    settings.saveNow();
    if (process.platform !== 'darwin') app.quit();
});
