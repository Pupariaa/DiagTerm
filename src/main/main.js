const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

let openPorts = new Map();
let portStates = new Map();
let portCheckInterval = null;
let esptoolInstalled = false;
let esptoolInstalling = false;
let mainWindow = null;

autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://techalchemy.fr/diagterm/update'
});

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

if (process.platform === 'win32') {
    autoUpdater.requestHeaders = {
        'User-Agent': 'DiagTerm-Updater'
    };
    
    if (!app.isPackaged) {
        autoUpdater.forceDevUpdateConfig = true;
    }
    
    autoUpdater.verifySignatureAndInstall = false;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        frame: false,
        icon: path.join(__dirname, '../icons/diagTerm-256-bgt.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow = win;
    return win;
}

ipcMain.handle('list-ports', async () => {
    try {
        console.log('Listing serial ports...');
        const portList = await SerialPort.list();
        console.log('Found ports:', portList.length, portList);

        const mappedPorts = portList.map(port => ({
            path: port.path,
            manufacturer: port.manufacturer || '',
            vendorId: port.vendorId || '',
            productId: port.productId || ''
        }));

        for (const portPath of portStates.keys()) {
            const state = portStates.get(portPath);
            if (state && state.wasOpen) {
                const portExists = mappedPorts.some(p => p.path === portPath);
                if (portExists && !openPorts.has(portPath)) {
                    setTimeout(async () => {
                        const allWindows = BrowserWindow.getAllWindows();
                        if (allWindows.length > 0) {
                            const win = allWindows[0];
                            try {
                                const port = new SerialPort({
                                    path: portPath,
                                    baudRate: state.baudRate,
                                    autoOpen: false
                                });

                                port.open((err) => {
                                    if (!err) {
                                        const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
                                        openPorts.set(portPath, {
                                            port,
                                            parser,
                                            baudRate: state.baudRate,
                                            wasOpen: true
                                        });

                                        port.on('error', (error) => {
                                            console.error(`Port ${portPath} error:`, error);
                                            if (error.message.includes('disconnected') || error.message.includes('not found')) {
                                                openPorts.delete(portPath);
                                                win.webContents.send('port-disconnected', portPath);
                                            }
                                        });

                                        port.on('close', () => {
                                            openPorts.delete(portPath);
                                            win.webContents.send('port-closed', portPath);
                                        });

                                        parser.on('data', (data) => {
                                            win.webContents.send('port-data', portPath, 'RX', data.toString());
                                        });

                                        win.webContents.send('port-reconnected', portPath);
                                    }
                                });
                            } catch (reconnectError) {
                                console.error('Reconnect error:', reconnectError);
                            }
                        }
                    }, 500);
                }
            }
        }

        console.log('Mapped ports:', mappedPorts);
        return mappedPorts;
    } catch (error) {
        console.error('Error listing ports:', error);
        console.error('Error stack:', error.stack);
        return [];
    }
});

ipcMain.handle('check-port-open', async (event, portPath) => {
    return { isOpen: openPorts.has(portPath) };
});

ipcMain.handle('open-port', async (event, portPath, baudRate) => {
    try {
        if (openPorts.has(portPath)) {
            return { success: true, alreadyOpen: true };
        }

        const port = new SerialPort({
            path: portPath,
            baudRate: parseInt(baudRate),
            autoOpen: false
        });

        return new Promise((resolve) => {
            port.open((err) => {
                if (err) {
                    resolve({ success: false, error: err.message });
                    return;
                }

                const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

                const portInfo = {
                    port,
                    parser,
                    baudRate: parseInt(baudRate),
                    wasOpen: true
                };

                openPorts.set(portPath, portInfo);
                portStates.set(portPath, {
                    baudRate: parseInt(baudRate),
                    wasOpen: true
                });

                port.on('error', (err) => {
                    console.error(`Port ${portPath} error:`, err);
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-error', portPath, err.message);
                    }

                    if (err.message.includes('disconnected') || err.message.includes('not found') || err.message.includes('Access denied') || err.message.includes('cannot open')) {
                        openPorts.delete(portPath);
                        const state = portStates.get(portPath);
                        if (state) {
                            state.wasOpen = true;
                        }
                        const win2 = BrowserWindow.fromWebContents(event.sender);
                        if (win2) {
                            win2.webContents.send('port-disconnected', portPath);
                        }
                    }
                });

                port.on('close', () => {
                    console.log(`Port ${portPath} closed`);
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-closed', portPath);
                    }
                    openPorts.delete(portPath);
                });

                parser.on('data', (data) => {
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-data', portPath, 'RX', data.toString());
                    }
                });

                resolve({ success: true });
            });
        });
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('close-port', async (event, portPath) => {
    try {
        const portData = openPorts.get(portPath);
        if (!portData) {
            return { success: false, error: 'Port not open' };
        }

        const state = portStates.get(portPath);
        if (state) {
            state.wasOpen = false;
        }

        return new Promise((resolve) => {
            try {
                portData.port.close((err) => {
                    if (err) {
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    openPorts.delete(portPath);
                    resolve({ success: true });
                });
            } catch (closeError) {
                openPorts.delete(portPath);
                resolve({ success: true });
            }
        });
    } catch (error) {
        openPorts.delete(portPath);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('reset-port', async (event, portPath) => {
    try {
        const portData = openPorts.get(portPath);
        if (!portData) {
            return { success: false, error: 'Port not open' };
        }

        return new Promise((resolve) => {
            try {
                portData.port.set({ dtr: false, rts: false }, (err) => {
                    if (err) {
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    setTimeout(() => {
                        portData.port.set({ dtr: true, rts: true }, (err2) => {
                            if (err2) {
                                resolve({ success: false, error: err2.message });
                                return;
                            }
                            resolve({ success: true });
                        });
                    }, 100);
                });
            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('write-port', async (event, portPath, data) => {
    try {
        const portData = openPorts.get(portPath);
        if (!portData) {
            return { success: false, error: 'Port not open' };
        }

        return new Promise((resolve) => {
            try {
                if (!portData.port.isOpen) {
                    openPorts.delete(portPath);
                    const state = portStates.get(portPath);
                    if (state) {
                        state.wasOpen = true;
                    }
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-disconnected', portPath);
                    }
                    resolve({ success: false, error: 'Port not open' });
                    return;
                }

                portData.port.write(data, (err) => {
                    if (err) {
                        if (err.message && (err.message.includes('disconnected') || err.message.includes('not found') || err.message.includes('Access denied') || err.message.includes('cannot open'))) {
                            openPorts.delete(portPath);
                            const state = portStates.get(portPath);
                            if (state) {
                                state.wasOpen = true;
                            }
                            const win = BrowserWindow.fromWebContents(event.sender);
                            if (win) {
                                win.webContents.send('port-disconnected', portPath);
                            }
                        }
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-data', portPath, 'TX', data.toString());
                    }
                    resolve({ success: true });
                });
            } catch (writeError) {
                if (writeError.message && (writeError.message.includes('disconnected') || writeError.message.includes('not found') || writeError.message.includes('cannot open'))) {
                    openPorts.delete(portPath);
                    const state = portStates.get(portPath);
                    if (state) {
                        state.wasOpen = true;
                    }
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                        win.webContents.send('port-disconnected', portPath);
                    }
                }
                resolve({ success: false, error: writeError.message || 'Write error' });
            }
        });
    } catch (error) {
        return { success: false, error: error.message };
    }
});

function checkPortsStatus() {
    if (openPorts.size === 0) return;

    SerialPort.list().then(portList => {
        const availablePaths = new Set(portList.map(p => p.path));
        const allWindows = BrowserWindow.getAllWindows();

        for (const [portPath, portData] of openPorts.entries()) {
            let isDisconnected = false;

            if (!availablePaths.has(portPath)) {
                console.log(`Port ${portPath} not in available ports list`);
                isDisconnected = true;
            } else {
                try {
                    if (!portData.port.isOpen) {
                        console.log(`Port ${portPath} is not open`);
                        isDisconnected = true;
                    }
                } catch (checkError) {
                    console.log(`Port ${portPath} check error:`, checkError.message);
                    isDisconnected = true;
                }
            }

            if (isDisconnected) {
                console.log(`Port ${portPath} disconnected or closed`);
                try {
                    if (portData.port && portData.port.isOpen) {
                        portData.port.close(() => { });
                    }
                } catch (closeError) {
                    console.error('Error closing port:', closeError);
                }

                openPorts.delete(portPath);
                const state = portStates.get(portPath);
                if (state) {
                    state.wasOpen = true;
                }

                allWindows.forEach(win => {
                    win.webContents.send('port-disconnected', portPath);
                });
            }
        }
    }).catch(err => {
        console.error('Error checking ports:', err);
    });
}

app.whenReady().then(() => {
    createWindow();

    setTimeout(() => {
        console.log('Checking for updates on startup...');
        autoUpdater.checkForUpdates().catch(err => {
            console.error('Error checking for updates on startup:', err);
        });
    }, 3000);

    portCheckInterval = setInterval(checkPortsStatus, 2000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

ipcMain.handle('select-binary-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Binary Files', extensions: ['bin', 'hex', 'elf'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled) {
        return { success: false, filePath: null };
    }

    return { success: true, filePath: result.filePaths[0] };
});

ipcMain.handle('select-log-file', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
            { name: 'Log Files', extensions: ['json', 'txt', 'csv'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled) {
        return { success: false, filePath: null };
    }

    return { success: true, filePath: result.filePaths[0] };
});

ipcMain.handle('read-file', async (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return { success: true, content };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('export-logs', async (event, content, format, defaultFileName) => {
    const filters = [];

    switch (format) {
        case 'csv':
            filters.push({ name: 'CSV Files', extensions: ['csv'] });
            break;
        case 'txt':
            filters.push({ name: 'Text Files', extensions: ['txt'] });
            break;
        case 'html':
            filters.push({ name: 'HTML Files', extensions: ['html'] });
            break;
        case 'xml':
            filters.push({ name: 'XML Files', extensions: ['xml'] });
            break;
        case 'json':
            filters.push({ name: 'JSON Files', extensions: ['json'] });
            break;
        case 'md':
            filters.push({ name: 'Markdown Files', extensions: ['md'] });
            break;
        case 'tex':
            filters.push({ name: 'LaTeX Files', extensions: ['tex'] });
            break;
    }

    filters.push({ name: 'All Files', extensions: ['*'] });

    const result = await dialog.showSaveDialog({
        defaultPath: defaultFileName,
        filters: filters
    });

    if (result.canceled) {
        return { success: false };
    }

    try {
        fs.writeFileSync(result.filePath, content, 'utf8');
        return { success: true, filePath: result.filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('flash-binary', async (event, portPath, filePath, deviceType, devboard, usbConverter, flashAddress, baudRate) => {
    return new Promise(async (resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender);

        if (!fs.existsSync(filePath)) {
            resolve({ success: false, error: 'File not found' });
            return;
        }

        let savedBaudRate = baudRate || 115200;

        try {
            if (openPorts.has(portPath)) {
                const portData = openPorts.get(portPath);
                savedBaudRate = portData.baudRate;
                await new Promise((closeResolve) => {
                    portData.port.close((err) => {
                        openPorts.delete(portPath);
                        closeResolve();
                    });
                });
            }

            await enterBootloaderMode(portPath, deviceType, devboard, usbConverter);

            if (deviceType === 'ESP32' || deviceType === 'ESP8266') {
                flashESP32(portPath, filePath, deviceType, flashAddress || '0x10000', win, resolve, savedBaudRate);
            } else if (deviceType === 'Arduino') {
                flashArduino(portPath, filePath, win, resolve, savedBaudRate);
            } else {
                resolve({ success: false, error: 'Unsupported device type' });
            }
        } catch (error) {
            resolve({ success: false, error: error.message });
        }
    });
});

function getBootloaderSequence(deviceType, devboard, usbConverter) {
    const sequences = {
        'ESP32': {
            'CP2102': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CP2104': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CH340': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CH341': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'FT232': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'FT2232': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'PL2303': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'ATmega16U2': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'ATmega32U4': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'Generic': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } }
        },
        'ESP8266': {
            'CP2102': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CP2104': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CH340': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'CH341': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'FT232': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'FT2232': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'PL2303': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'ATmega16U2': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'ATmega32U4': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } },
            'Generic': { dtr: false, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 50 } }
        },
        'Arduino': {
            'CP2102': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'CP2104': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'CH340': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'CH341': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'FT232': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'FT2232': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'PL2303': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'ATmega16U2': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'ATmega32U4': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } },
            'Generic': { dtr: false, rts: false, delay: 100, then: { dtr: true, rts: true, delay: 100, then: { dtr: false, rts: false, delay: 100 } } }
        }
    };

    const deviceSeq = sequences[deviceType];
    if (!deviceSeq) {
        return sequences['ESP32']['Generic'];
    }

    const converterSeq = deviceSeq[usbConverter] || deviceSeq['Generic'];
    return converterSeq;
}

function enterBootloaderMode(portPath, deviceType, devboard, usbConverter) {
    return new Promise((resolve, reject) => {
        let bootloaderPort = null;

        try {
            bootloaderPort = new SerialPort({
                path: portPath,
                baudRate: 115200,
                autoOpen: false
            });

            bootloaderPort.open((err) => {
                if (err) {
                    reject(new Error(`Failed to open port for bootloader: ${err.message}`));
                    return;
                }

                const sequence = getBootloaderSequence(deviceType, devboard, usbConverter);

                function applySequence(seq, callback) {
                    if (!seq) {
                        callback();
                        return;
                    }

                    bootloaderPort.set({ dtr: seq.dtr, rts: seq.rts }, (err) => {
                        if (err) {
                            bootloaderPort.close();
                            reject(new Error(`Failed to set DTR/RTS: ${err.message}`));
                            return;
                        }

                        setTimeout(() => {
                            if (seq.then) {
                                if (seq.then.then) {
                                    applySequence(seq.then, () => {
                                        applySequence(seq.then.then, callback);
                                    });
                                } else {
                                    applySequence(seq.then, callback);
                                }
                            } else {
                                callback();
                            }
                        }, seq.delay || 100);
                    });
                }

                applySequence(sequence, () => {
                    bootloaderPort.close(() => {
                        setTimeout(() => resolve(), 100);
                    });
                });
            });
        } catch (error) {
            if (bootloaderPort && bootloaderPort.isOpen) {
                bootloaderPort.close();
            }
            reject(error);
        }
    });
}

function checkPythonAvailable() {
    return new Promise((resolve) => {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const checkProcess = spawn(pythonCmd, ['--version'], {
            shell: true,
            stdio: 'pipe'
        });

        checkProcess.on('close', (code) => {
            resolve(code === 0);
        });

        checkProcess.on('error', () => {
            resolve(false);
        });

        setTimeout(() => {
            checkProcess.kill();
            resolve(false);
        }, 3000);
    });
}

function checkEsptoolInstalled() {
    return new Promise((resolve) => {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const checkProcess = spawn(pythonCmd, ['-m', 'esptool', 'version'], {
            shell: true,
            stdio: 'pipe'
        });

        let output = '';
        checkProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        checkProcess.stderr.on('data', (data) => {
            output += data.toString();
        });

        checkProcess.on('close', (code) => {
            resolve(code === 0 || output.includes('esptool'));
        });

        checkProcess.on('error', () => {
            resolve(false);
        });

        setTimeout(() => {
            checkProcess.kill();
            resolve(false);
        }, 3000);
    });
}

function installEsptool(win) {
    return new Promise((resolve, reject) => {
        if (esptoolInstalling) {
            reject(new Error('Installation already in progress'));
            return;
        }

        esptoolInstalling = true;
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

        if (win) {
            win.webContents.send('flash-output', 'Installing esptool...\n');
        }

        const installProcess = spawn(pythonCmd, ['-m', 'pip', 'install', 'esptool', '--user'], {
            shell: true
        });

        let output = '';
        let errorOutput = '';

        installProcess.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            if (win) {
                win.webContents.send('flash-output', text);
            }
        });

        installProcess.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            if (win) {
                win.webContents.send('flash-output', text);
            }
        });

        installProcess.on('close', (code) => {
            esptoolInstalling = false;
            if (code === 0 || output.includes('Successfully installed') || output.includes('Requirement already satisfied')) {
                esptoolInstalled = true;
                if (win) {
                    win.webContents.send('flash-output', '\nesptool installed successfully!\n\n');
                }
                resolve();
            } else {
                reject(new Error(`Installation failed: ${errorOutput}`));
            }
        });

        installProcess.on('error', (err) => {
            esptoolInstalling = false;
            reject(err);
        });
    });
}

async function ensureEsptoolInstalled(win) {
    if (esptoolInstalled) {
        return true;
    }

    const pythonAvailable = await checkPythonAvailable();
    if (!pythonAvailable) {
        throw new Error('Python is not installed or not in PATH. Please install Python from https://www.python.org/downloads/');
    }

    const esptoolAvailable = await checkEsptoolInstalled();
    if (!esptoolAvailable) {
        await installEsptool(win);
    } else {
        esptoolInstalled = true;
    }

    return true;
}

function flashESP32(portPath, filePath, deviceType, flashAddress, win, resolve, baudRate) {
    ensureEsptoolInstalled(win).then(() => {
        runFlashESP32(portPath, filePath, deviceType, flashAddress, win, resolve, baudRate);
    }).catch((err) => {
        if (err.message.includes('Python is not installed')) {
            resolve({
                success: false,
                error: err.message
            });
        } else {
            runFlashESP32(portPath, filePath, deviceType, flashAddress, win, resolve, baudRate);
        }
    });
}

function runFlashESP32(portPath, filePath, deviceType, flashAddress, win, resolve, baudRate) {
    const args = [
        '--chip', deviceType.toLowerCase(),
        '--port', portPath,
        '--baud', '921600',
        '--before', 'default_reset',
        '--after', 'hard_reset',
        'write_flash',
        '--flash_mode', 'dio',
        '--flash_freq', '80m',
        '--flash_size', 'detect',
        flashAddress,
        filePath
    ];

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const esptoolProcess = spawn(pythonCmd, ['-m', 'esptool', ...args], {
        shell: true
    });

    executeFlashProcess(esptoolProcess, win, resolve, portPath, filePath, deviceType, flashAddress, baudRate);
}

function executeFlashProcess(esptoolProcess, win, resolve, portPath, filePath, deviceType, flashAddress, baudRate) {
    let output = '';
    let errorOutput = '';

    esptoolProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        if (win) {
            win.webContents.send('flash-output', text);
        }
    });

    esptoolProcess.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        if (win) {
            win.webContents.send('flash-output', text);
        }
    });

    esptoolProcess.on('close', async (code) => {
        if (code === 0) {
            if (win) {
                win.webContents.send('flash-output', '\n\n=== Flash completed successfully! ===\n');
                win.webContents.send('flash-output', 'Reopening port and resetting device...\n\n');
            }

            setTimeout(async () => {
                try {
                    await reopenPortAfterFlash(portPath, baudRate, win);
                    resolve({ success: true, output: output + errorOutput });
                } catch (err) {
                    resolve({ success: true, output: output + errorOutput + '\n\nWarning: Failed to reopen port: ' + err.message });
                }
            }, 500);
        } else {
            if (errorOutput.includes('No module named esptool') || output.includes('No module named esptool')) {
                esptoolInstalled = false;
                if (win) {
                    win.webContents.send('flash-output', '\n\n=== esptool not found. Installing automatically... ===\n\n');
                }

                installEsptool(win).then(() => {
                    if (win) {
                        win.webContents.send('flash-output', '\n=== Installation complete. Retrying flash... ===\n\n');
                    }
                    setTimeout(() => {
                        runFlashESP32(portPath, filePath, deviceType, flashAddress, win, resolve, baudRate);
                    }, 1000);
                }).catch((err) => {
                    resolve({
                        success: false,
                        error: `Failed to install esptool: ${err.message}\n\nPlease install manually: python -m pip install esptool`,
                        output: output + errorOutput
                    });
                });
            } else {
                let errorMsg = `Flash failed with code ${code}`;
                if (errorOutput.includes('command not found') || errorOutput.includes('is not recognized')) {
                    errorMsg = `Python not found in PATH.\n\n` +
                        `Please install Python from https://www.python.org/downloads/\n\n` +
                        `Make sure to check "Add Python to PATH" during installation.`;
                }
                resolve({ success: false, error: errorMsg, output: output + errorOutput });
            }
        }
    });

    esptoolProcess.on('error', (err) => {
        let errorMsg = `Failed to execute esptool: ${err.message}`;

        if (err.code === 'ENOENT') {
            errorMsg = `Python not found in PATH.\n\n` +
                `Please install Python from https://www.python.org/downloads/\n\n` +
                `Make sure to check "Add Python to PATH" during installation.`;
        }

        resolve({
            success: false,
            error: errorMsg
        });
    });
}

function flashArduino(portPath, filePath, win, resolve, baudRate) {
    const avrdudePath = process.platform === 'win32' ? 'avrdude.exe' : 'avrdude';

    const args = [
        '-C', 'avrdude.conf',
        '-p', 'atmega328p',
        '-c', 'arduino',
        '-P', portPath,
        '-b', '115200',
        '-D',
        '-U', `flash:w:${filePath}:i`
    ];

    const avrdudeProcess = spawn(avrdudePath, args, {
        shell: true
    });

    let output = '';
    let errorOutput = '';

    avrdudeProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        if (win) {
            win.webContents.send('flash-output', text);
        }
    });

    avrdudeProcess.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        if (win) {
            win.webContents.send('flash-output', text);
        }
    });

    avrdudeProcess.on('close', async (code) => {
        if (code === 0) {
            if (win) {
                win.webContents.send('flash-output', '\n\n=== Flash completed successfully! ===\n');
                win.webContents.send('flash-output', 'Reopening port and resetting device...\n\n');
            }

            setTimeout(async () => {
                try {
                    await reopenPortAfterFlash(portPath, baudRate, win);
                    resolve({ success: true, output: output + errorOutput });
                } catch (err) {
                    resolve({ success: true, output: output + errorOutput + '\n\nWarning: Failed to reopen port: ' + err.message });
                }
            }, 500);
        } else {
            resolve({ success: false, error: `Flash failed with code ${code}`, output: output + errorOutput });
        }
    });

    avrdudeProcess.on('error', (err) => {
        if (err.code === 'ENOENT') {
            resolve({ success: false, error: 'avrdude not found. Please install Arduino IDE or avrdude separately.' });
        } else {
            resolve({ success: false, error: err.message });
        }
    });
}

async function reopenPortAfterFlash(portPath, baudRate, win) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            const port = new SerialPort({
                path: portPath,
                baudRate: parseInt(baudRate),
                autoOpen: false
            });

            port.open((err) => {
                if (err) {
                    reject(err);
                    return;
                }

                port.set({ dtr: false, rts: false }, (err) => {
                    if (err) {
                        port.close();
                        reject(err);
                        return;
                    }

                    setTimeout(() => {
                        port.set({ dtr: false, rts: true }, (err) => {
                            if (err) {
                                port.close();
                                reject(err);
                                return;
                            }

                            setTimeout(() => {
                                port.set({ dtr: false, rts: false }, (err) => {
                                    if (err) {
                                        port.close();
                                        reject(err);
                                        return;
                                    }

                                    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

                                    openPorts.set(portPath, {
                                        port,
                                        parser,
                                        baudRate: parseInt(baudRate)
                                    });

                                    parser.on('data', (data) => {
                                        if (win) {
                                            win.webContents.send('port-data', portPath, 'RX', data.toString());
                                        }
                                    });

                                    if (win) {
                                        win.webContents.send('port-opened', portPath);
                                    }

                                    resolve();
                                });
                            }, 100);
                        });
                    }, 100);
                });
            });
        }, 500);
    });
}

ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.handle('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
});

ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

ipcMain.handle('get-app-version', () => {
    const version = app.getVersion();
    return { version: version };
});

autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
    if (mainWindow) {
        mainWindow.webContents.send('update-checking');
    }
});

let lastUpdateInfo = null;

autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info);
    lastUpdateInfo = info;
    if (mainWindow) {
        mainWindow.webContents.send('update-available', info);
    }
});

autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available:', info);
    if (mainWindow) {
        mainWindow.webContents.send('update-not-available', info);
    }
});

autoUpdater.on('error', (err) => {
    console.error('Error in auto-updater:', err);
    
    const errorStr = err ? (err.message || err.toString() || 'Unknown error') : 'Unknown error';
    const errorObj = err ? (err.rawInfo || err) : {};
    
    if (errorStr.includes('not signed') || errorStr.includes('signature') || 
        (errorObj.StatusMessage && errorObj.StatusMessage.includes('certificat'))) {
        console.warn('⚠ Update file signature verification failed. This is expected with a self-signed certificate.');
        console.warn('   The update is available but Windows requires manual approval.');
        
        if (mainWindow) {
            const updateInfo = lastUpdateInfo || (err && err.version ? { version: err.version } : null);
            if (updateInfo) {
                mainWindow.webContents.send('update-available', {
                    ...updateInfo,
                    requiresManualInstall: true,
                    message: 'Update available (self-signed certificate - manual installation required)'
                });
            } else {
                mainWindow.webContents.send('update-error', 
                    'Update available but requires manual installation due to self-signed certificate. ' +
                    'Windows will show a security warning - click "More info" then "Run anyway" to install.');
            }
        }
    } else {
        if (mainWindow) {
            mainWindow.webContents.send('update-error', errorStr);
        }
    }
});

autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) {
        mainWindow.webContents.send('update-download-progress', progressObj);
    }
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info);
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', info);
    }
});

ipcMain.handle('check-for-updates', async () => {
    try {
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (error) {
        console.error('Error checking for updates:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('download-update', async () => {
    try {
        await autoUpdater.downloadUpdate();
        return { success: true };
    } catch (error) {
        console.error('Error downloading update:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => {
    if (portCheckInterval) {
        clearInterval(portCheckInterval);
        portCheckInterval = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

