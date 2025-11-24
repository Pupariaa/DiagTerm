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
  }
});

