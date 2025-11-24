const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  listPorts: async () => {
    return await ipcRenderer.invoke('list-ports');
  },

  checkPortOpen: async (path) => {
    return await ipcRenderer.invoke('check-port-open', path);
  },

  openPort: async (path, baudRate) => {
    return await ipcRenderer.invoke('open-port', path, baudRate);
  },

  closePort: async (path) => {
    return await ipcRenderer.invoke('close-port', path);
  },

  writePort: async (path, data) => {
    return await ipcRenderer.invoke('write-port', path, data);
  },

  onPortData: (callback) => {
    ipcRenderer.on('port-data', (event, portPath, type, data) => {
      callback(portPath, type, data);
    });
  },

  selectBinaryFile: async () => {
    return await ipcRenderer.invoke('select-binary-file');
  },

  flashBinary: async (portPath, filePath, deviceType, devboard, usbConverter, flashAddress, baudRate) => {
    return await ipcRenderer.invoke('flash-binary', portPath, filePath, deviceType, devboard, usbConverter, flashAddress, baudRate);
  },

  onPortOpened: (callback) => {
    ipcRenderer.on('port-opened', (event, portPath) => {
      callback(portPath);
    });
  },

  onFlashOutput: (callback) => {
    ipcRenderer.on('flash-output', (event, data) => {
      callback(data);
    });
  },

  removeFlashOutputListener: () => {
    ipcRenderer.removeAllListeners('flash-output');
  },

  windowMinimize: () => {
    ipcRenderer.invoke('window-minimize');
  },

  windowMaximize: () => {
    ipcRenderer.invoke('window-maximize');
  },

  windowClose: () => {
    ipcRenderer.invoke('window-close');
  },

  exportLogs: async (content, format, defaultFileName) => {
    return await ipcRenderer.invoke('export-logs', content, format, defaultFileName);
  },

  selectLogFile: async () => {
    return await ipcRenderer.invoke('select-log-file');
  },

  readFile: async (filePath) => {
    return await ipcRenderer.invoke('read-file', filePath);
  },

  resetPort: async (portPath) => {
    return await ipcRenderer.invoke('reset-port', portPath);
  },

  onPortDisconnected: (callback) => {
    ipcRenderer.on('port-disconnected', (event, portPath) => {
      callback(portPath);
    });
  },

  onPortReconnected: (callback) => {
    ipcRenderer.on('port-reconnected', (event, portPath) => {
      callback(portPath);
    });
  },

  onPortError: (callback) => {
    ipcRenderer.on('port-error', (event, portPath, error) => {
      callback(portPath, error);
    });
  },

  onPortClosed: (callback) => {
    ipcRenderer.on('port-closed', (event, portPath) => {
      callback(portPath);
    });
  },

  checkForUpdates: async () => {
    return await ipcRenderer.invoke('check-for-updates');
  },

  downloadUpdate: async () => {
    return await ipcRenderer.invoke('download-update');
  },

  installUpdate: async () => {
    return await ipcRenderer.invoke('install-update');
  },

  getAppVersion: async () => {
    return await ipcRenderer.invoke('get-app-version');
  },

  onUpdateChecking: (callback) => {
    ipcRenderer.on('update-checking', () => {
      callback();
    });
  },

  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => {
      callback(info);
    });
  },

  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on('update-not-available', (event, info) => {
      callback(info);
    });
  },

  onUpdateError: (callback) => {
    ipcRenderer.on('update-error', (event, error) => {
      callback(error);
    });
  },

  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (event, progress) => {
      callback(progress);
    });
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', (event, info) => {
      callback(info);
    });
  }
});

