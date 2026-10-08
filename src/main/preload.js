const { contextBridge, ipcRenderer, webFrame } = require('electron');

const INVOKE_CHANNELS = new Set([
    'settings:get-all', 'settings:set', 'settings:replace', 'settings:reset',
    'store:get', 'store:set', 'app:paths',
    'serial:list', 'serial:open', 'serial:close', 'serial:write', 'serial:set-signals', 'serial:reset',
    'serial:update', 'serial:set-auto-reconnect', 'serial:status', 'serial:now',
    'comnex:list', 'comnex:command',
    'filesend:select', 'filesend:preview', 'filesend:start', 'filesend:control',
    'bridge:start', 'bridge:stop', 'bridge:list',
    'logger:set-port', 'logger:status', 'logger:folder',
    'capture:save', 'capture:snapshot', 'capture:open',
    'files:save-text', 'files:save-binary', 'files:select-file', 'files:select-folder', 'files:read-text',
    'files:stat', 'files:list-dir', 'files:read-dir', 'files:open-path', 'files:show-item', 'files:copy-folder', 'files:open-external',
    'get-app-version', 'check-for-updates', 'download-update', 'install-update',
    'boards:catalog', 'boards:fetch-indexes', 'boards:install', 'boards:uninstall', 'boards:root', 'boards:update-now', 'boards:installed-tools',
    'flash:boards', 'flash:describe-target', 'flash:detect-board', 'flash:programmers', 'flash:describe-input',
    'flash:enqueue', 'flash:cancel', 'flash:cancel-all', 'flash:retry', 'flash:clear', 'flash:jobs', 'flash:job-log',
    'flash:production-start', 'flash:production-stop', 'flash:production-state',
    'flash:partitions-parse-csv', 'flash:partitions-to-csv', 'flash:partitions-validate', 'flash:partitions-to-binary', 'flash:partitions-parse-binary',
    'window-minimize', 'window-maximize', 'window-close', 'app:confirm-close', 'app:toggle-devtools', 'app:reload'
]);

const EVENT_CHANNELS = new Set([
    'settings:changed',
    'serial:data', 'serial:state', 'serial:ports', 'serial:signals', 'serial:error',
    'filesend:progress', 'bridge:state', 'logger:state',
    'boards:progress', 'boards:changed', 'boards:auto-updated',
    'flash:job', 'flash:log', 'flash:production',
    'update-checking', 'update-available', 'update-not-available', 'update-error', 'update-download-progress', 'update-downloaded',
    'window:maximized', 'app:close-requested'
]);

contextBridge.exposeInMainWorld('electronAPI', {
    invoke: (channel, ...args) => {
        if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
        return ipcRenderer.invoke(channel, ...args);
    },
    on: (channel, callback) => {
        if (!EVENT_CHANNELS.has(channel)) throw new Error(`Event not allowed: ${channel}`);
        const listener = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
    setZoomFactor: (factor) => {
        const value = Number(factor);
        if (value >= 0.5 && value <= 3) webFrame.setZoomFactor(value);
    },
    platform: process.platform
});
