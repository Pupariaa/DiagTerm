import { escapeHtml } from '../core/dom.js';
import { invoke, on } from '../core/api.js';
import { t } from '../core/i18n.js';
import { openModal, toast } from '../core/dialogs.js';

let appVersion = '';
let updateInfo = null;
let updateModal = null;
let manualCheck = false;

const UPDATE_BASE = 'https://techalchemy.fr/diagterm/update/';

export async function getAppVersion() {
    if (!appVersion) {
        try {
            appVersion = await invoke('get-app-version');
        } catch (error) {
            appVersion = '';
        }
    }
    return appVersion;
}

function downloadUrl(info) {
    if (info && info.path && /^https?:/i.test(info.path)) return info.path;
    if (info && info.path) return `${UPDATE_BASE}${info.path}`;
    if (info && info.version) return `${UPDATE_BASE}DiagTerm Setup ${info.version}.exe`;
    return UPDATE_BASE;
}

function releaseNotesText(notes) {
    if (!notes) return '';
    if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '');
    if (Array.isArray(notes)) return notes.map(n => `${n.version || ''}\n${String(n.note || '').replace(/<[^>]+>/g, '')}`).join('\n\n');
    return '';
}

function ensureUpdateModal() {
    if (updateModal && !updateModal.closed) return updateModal;
    updateModal = openModal({
        title: t('Updates'),
        width: 600,
        className: 'update-modal',
        body: `
            <p class="update-message"></p>
            <div class="update-progress hidden">
                <div class="progress"><div class="progress-bar"></div></div>
                <span class="update-percent">0%</span>
            </div>
            <div class="update-notes hidden">
                <h4>${escapeHtml(t('Release notes'))}</h4>
                <pre class="update-notes-content"></pre>
            </div>`,
        onClose: () => { updateModal = null; },
        buttons: []
    });
    return updateModal;
}

function setUpdateState(state, data = {}) {
    const modal = ensureUpdateModal();
    const msg = modal.body.querySelector('.update-message');
    const progress = modal.body.querySelector('.update-progress');
    const notes = modal.body.querySelector('.update-notes');
    progress.classList.add('hidden');
    switch (state) {
        case 'checking':
            msg.textContent = t('Checking for updates...');
            modal.setButtons([{ label: t('Close') }]);
            break;
        case 'available': {
            msg.textContent = t('A new version ({version}) is available. You are using {current}.', { version: data.version || '?', current: appVersion || '?' });
            const text = releaseNotesText(data.releaseNotes);
            notes.classList.toggle('hidden', !text);
            notes.querySelector('.update-notes-content').textContent = text;
            modal.setButtons([
                { label: t('Later') },
                {
                    label: t('Download in browser'), keepOpen: true, action: async () => {
                        await invoke('files:open-external', downloadUrl(data));
                        msg.innerHTML = escapeHtml(t('Download opened in your browser. Run the installer once downloaded. If Windows shows a security warning, click "More info" then "Run anyway".'));
                        return false;
                    }
                },
                {
                    label: t('Download and install'), primary: true, keepOpen: true, action: async () => {
                        progress.classList.remove('hidden');
                        msg.textContent = t('Downloading update...');
                        const res = await invoke('download-update');
                        if (!res.success && res.useFallback) {
                            await invoke('files:open-external', downloadUrl(data));
                            msg.textContent = t('The update requires a manual installation (self-signed certificate). The download has been opened in your browser.');
                        } else if (!res.success) {
                            msg.textContent = t('Download failed: {error}', { error: res.error || '' });
                        }
                        return false;
                    }
                }
            ]);
            break;
        }
        case 'progress': {
            progress.classList.remove('hidden');
            const pct = Math.max(0, Math.min(100, data.percent || 0));
            progress.querySelector('.progress-bar').style.width = `${pct}%`;
            progress.querySelector('.update-percent').textContent = `${Math.round(pct)}%${data.bytesPerSecond ? ` - ${(data.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s` : ''}`;
            msg.textContent = t('Downloading update...');
            break;
        }
        case 'downloaded':
            msg.textContent = t('Update {version} downloaded. Restart DiagTerm to install it.', { version: data.version || '' });
            modal.setButtons([
                { label: t('Later') },
                { label: t('Install and restart'), primary: true, action: () => invoke('install-update') }
            ]);
            break;
        case 'manual':
            msg.innerHTML = escapeHtml(t('A new version is available but requires a manual installation (self-signed certificate). Windows will show a security warning: click "More info" then "Run anyway".'));
            modal.setButtons([
                { label: t('Close') },
                { label: t('Download in browser'), primary: true, action: () => invoke('files:open-external', downloadUrl(updateInfo)) }
            ]);
            break;
        case 'error':
            msg.textContent = t('Update error: {error}', { error: data.error || '' });
            modal.setButtons([{ label: t('Close') }]);
            break;
        default: break;
    }
}

export async function checkForUpdates() {
    manualCheck = true;
    const res = await invoke('check-for-updates');
    if (!res.success) {
        setUpdateState('error', { error: res.error });
        manualCheck = false;
    }
}

export function initUpdates() {
    getAppVersion();
    on('update-checking', () => {
        if (manualCheck) setUpdateState('checking');
    });
    on('update-available', (info) => {
        updateInfo = info || {};
        manualCheck = false;
        setUpdateState('available', updateInfo);
    });
    on('update-not-available', () => {
        if (manualCheck) {
            if (updateModal) updateModal.close();
            toast(t('DiagTerm is up to date ({version})', { version: appVersion }), { type: 'success' });
        }
        manualCheck = false;
    });
    on('update-error', (error) => {
        const message = typeof error === 'string' ? error : (error && error.message) || t('Unknown error');
        if (/signed|signature|certificat/i.test(message)) setUpdateState('manual');
        else if (manualCheck || updateModal) setUpdateState('error', { error: message });
        else console.error('Update error:', message);
        manualCheck = false;
    });
    on('update-download-progress', (p) => setUpdateState('progress', p || {}));
    on('update-downloaded', (info) => setUpdateState('downloaded', info || {}));
}

export async function openAbout() {
    const version = await getAppVersion();
    const features = [
        t('Multi-tab, split-view serial terminal with automatic reconnection'),
        t('Text, hex and mixed views, timestamps, search, highlights and filters'),
        t('Scrollable RX/TX timeline with UART logic analyzer view'),
        t('Macros, triggers, file sending with XMODEM/YMODEM and ACK handshake'),
        t('Serial plotter and protocol decoders (Modbus, NMEA, SLIP, COBS, custom)'),
        t('Standalone board manager and bulk flashing without the Arduino IDE'),
        t('LittleFS, SPIFFS and FFat filesystem images, partition editor'),
        t('Disk logging, capture replay, TCP/WebSocket bridges and port sniffer')
    ];
    openModal({
        title: t('About DiagTerm'),
        width: 560,
        className: 'about-modal',
        body: `
            <div class="about">
                <img class="about-logo" src="../icons/diagTerm.svg" alt="">
                <h1>DiagTerm</h1>
                <p class="dim">${escapeHtml(t('Version {version}', { version }))}</p>
                <p>${escapeHtml(t('DiagTerm is a serial terminal, protocol analyzer and multi-board flasher for embedded development.'))}</p>
                <ul>${features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
                <p class="dim small">${escapeHtml(t('Built with Electron'))} - &copy; ${new Date().getFullYear()} Techalchemy</p>
            </div>`,
        buttons: [
            { label: t('Check for updates'), left: true, keepOpen: true, action: async () => { await checkForUpdates(); return false; } },
            { label: t('Close'), primary: true }
        ]
    });
}
