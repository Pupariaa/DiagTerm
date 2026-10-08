const { BrowserWindow } = require('electron');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

let mainWindow = null;

function setMainWindow(win) {
    mainWindow = win;
}

function getMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    const all = BrowserWindow.getAllWindows();
    return all.length > 0 ? all[0] : null;
}

function send(channel, ...args) {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args);
    }
}

module.exports = { bus, send, setMainWindow, getMainWindow };
