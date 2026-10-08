const { ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { send } = require('./context');
const settings = require('./settings');

let lastUpdateInfo = null;

function configure() {
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: 'https://techalchemy.fr/diagterm/update'
    });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    if (process.platform === 'win32') {
        autoUpdater.requestHeaders = { 'User-Agent': 'DiagTerm-Updater' };
        autoUpdater.forceDevUpdateConfig = true;
        autoUpdater.verifySignatureAndInstall = false;
        if (autoUpdater.channel) autoUpdater.channel = null;
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('Checking for update...');
        send('update-checking');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info && info.version);
        lastUpdateInfo = info;
        send('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('Update not available');
        send('update-not-available', info);
    });

    autoUpdater.on('error', (err) => {
        console.error('Error in auto-updater:', err && err.message);
        const errorStr = err ? (err.message || err.toString() || 'Unknown error') : 'Unknown error';
        const errorObj = err ? (err.rawInfo || err) : {};
        if (errorStr.includes('not signed') || errorStr.includes('signature') ||
            (errorObj.StatusMessage && errorObj.StatusMessage.includes('certificat'))) {
            console.warn('Update file signature verification failed, continuing');
            if (lastUpdateInfo) {
                send('update-available', lastUpdateInfo);
            } else {
                const updateInfo = err && err.version ? { version: err.version } : null;
                if (updateInfo) {
                    send('update-available', updateInfo);
                } else {
                    send('update-error', 'Update available but requires manual installation due to self-signed certificate.');
                }
            }
            return;
        }
        send('update-error', errorStr);
    });

    autoUpdater.on('download-progress', (progressObj) => send('update-download-progress', progressObj));
    autoUpdater.on('update-downloaded', (info) => send('update-downloaded', info));
}

function register() {
    configure();

    ipcMain.handle('check-for-updates', async () => {
        try {
            await autoUpdater.checkForUpdates();
            return { success: true };
        } catch (error) {
            console.error('Error checking for updates:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('download-update', async () => {
        try {
            const downloadPromise = autoUpdater.downloadUpdate();
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Download timeout')), 5000));
            try {
                await Promise.race([downloadPromise, timeoutPromise]);
                return { success: true };
            } catch (raceError) {
                if (raceError.message.includes('timeout')) {
                    return { success: true, warning: 'Download may be blocked by signature' };
                }
                throw raceError;
            }
        } catch (error) {
            const errorMessage = error ? (error.message || error.toString()) : 'Unknown error';
            if (/not signed|signature|certificat|timeout/.test(errorMessage)) {
                return { success: false, error: errorMessage, useFallback: true };
            }
            return { success: false, error: errorMessage };
        }
    });

    ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
}

function checkOnStartup() {
    if (!settings.get('general.checkUpdatesOnStartup')) return;
    setTimeout(() => {
        console.log('Checking for updates on startup...');
        autoUpdater.checkForUpdates().catch(err => console.error('Error checking for updates on startup:', err.message));
    }, 3000);
}

module.exports = { register, checkOnStartup };
