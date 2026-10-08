export const SETTINGS_SCHEMA = [
    {
        id: 'general', title: 'General', icon: 'gear',
        fields: [
            { key: 'general.language', label: 'Language', type: 'select', options: [['en', 'English'], ['fr', 'Francais']], reload: true },
            { key: 'general.theme', label: 'Theme', type: 'select', options: [['dark', 'Dark'], ['light', 'Light'], ['high-contrast', 'High contrast'], ['system', 'Follow system']] },
            { key: 'general.accentColor', label: 'Accent color', type: 'color', allowEmpty: true, help: 'Leave empty to use the theme color' },
            { key: 'general.uiScale', label: 'Interface scale', type: 'number', min: 70, max: 200, step: 5, unit: '%' },
            { key: 'general.restoreSession', label: 'Restore tabs and reopen ports on startup', type: 'bool' },
            { key: 'general.confirmOnClose', label: 'Confirm before closing when ports are open or flash jobs are running', type: 'bool' },
            { key: 'general.checkUpdatesOnStartup', label: 'Check for DiagTerm updates on startup', type: 'bool' },
            { key: 'general.refreshPortsIntervalMs', label: 'Port detection interval', type: 'number', min: 250, max: 10000, step: 250, unit: 'ms', help: 'How often new and removed serial ports are detected' }
        ]
    },
    {
        id: 'serial', title: 'Serial defaults', icon: 'plug',
        description: 'Default values applied to new tabs. Each tab can override them.',
        fields: [
            { key: 'serial.baudRate', label: 'Baud rate', type: 'number', min: 50, max: 20000000, datalist: [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000] },
            { key: 'serial.dataBits', label: 'Data bits', type: 'select', options: [[5, '5'], [6, '6'], [7, '7'], [8, '8']], numeric: true },
            { key: 'serial.parity', label: 'Parity', type: 'select', options: [['none', 'None'], ['even', 'Even'], ['odd', 'Odd'], ['mark', 'Mark'], ['space', 'Space']] },
            { key: 'serial.stopBits', label: 'Stop bits', type: 'select', options: [[1, '1'], [1.5, '1.5'], [2, '2']], numeric: true },
            { key: 'serial.flowControl', label: 'Flow control', type: 'select', options: [['none', 'None'], ['rtscts', 'Hardware (RTS/CTS)'], ['xonxoff', 'Software (XON/XOFF)']] },
            { key: 'serial.dtrOnOpen', label: 'Assert DTR on open', type: 'bool' },
            { key: 'serial.rtsOnOpen', label: 'Assert RTS on open', type: 'bool', help: 'Disable both DTR and RTS to avoid resetting ESP32/Arduino boards when connecting' },
            { key: 'serial.encoding', label: 'Text encoding', type: 'select', options: [['utf-8', 'UTF-8'], ['latin1', 'ISO-8859-1 (Latin-1)'], ['windows-1252', 'Windows-1252'], ['ascii', 'ASCII'], ['utf-16le', 'UTF-16 LE']] },
            { key: 'serial.lineEnding', label: 'Default line ending', type: 'select', options: [['none', 'None'], ['NL', 'LF (\\n)'], ['CR', 'CR (\\r)'], ['CRLF', 'CR+LF (\\r\\n)']] },
            { key: 'serial.txInputMode', label: 'Default send mode', type: 'select', options: [['text', 'Text'], ['hex', 'Hex']] },
            { key: 'serial.framingMode', label: 'Frame splitting', type: 'select', options: [['delimiter', 'Delimiter'], ['timeout', 'Idle timeout'], ['fixed', 'Fixed length'], ['chunk', 'As received']], help: 'How received bytes are grouped into frames in the terminal and timeline' },
            { key: 'serial.framingDelimiter', label: 'Delimiter (hex)', type: 'text', placeholder: '0A', when: { 'serial.framingMode': 'delimiter' } },
            { key: 'serial.framingTimeoutMs', label: 'Idle timeout', type: 'number', min: 1, max: 10000, unit: 'ms', when: { 'serial.framingMode': 'timeout' } },
            { key: 'serial.framingLength', label: 'Frame length', type: 'number', min: 1, max: 65536, unit: 'bytes', when: { 'serial.framingMode': 'fixed' } },
            { key: 'serial.framingMaxLength', label: 'Maximum frame length', type: 'number', min: 16, max: 1048576, unit: 'bytes' },
            { key: 'serial.framingFlushMs', label: 'Flush incomplete frame after', type: 'number', min: 0, max: 60000, unit: 'ms', help: '0 keeps incomplete frames open until the delimiter arrives' },
            { key: 'serial.batchIntervalMs', label: 'Data batching interval', type: 'number', min: 4, max: 200, unit: 'ms', advanced: true, help: 'Lower values reduce latency, higher values reduce CPU usage at high baud rates' }
        ]
    },
    {
        id: 'terminal', title: 'Terminal', icon: 'terminal',
        fields: [
            { key: 'terminal.fontFamily', label: 'Font family', type: 'font' },
            { key: 'terminal.fontSize', label: 'Font size', type: 'number', min: 8, max: 32, unit: 'px' },
            { key: 'terminal.lineHeight', label: 'Line height', type: 'number', min: 1, max: 2.5, step: 0.05 },
            { key: 'terminal.viewMode', label: 'Default view', type: 'select', options: [['ascii', 'Text'], ['hex', 'Hex'], ['mixed', 'Hex dump (hex + text)']] },
            { key: 'terminal.timestampMode', label: 'Default timestamps', type: 'select', options: [['none', 'Hidden'], ['absolute', 'Absolute time'], ['relative', 'Since connection'], ['delta', 'Since previous frame'], ['gap', 'Gap with previous frame'], ['chrono', 'Chronometer']] },
            { key: 'terminal.timestampFormat', label: 'Absolute time format', type: 'select', options: [['HH:mm:ss', 'HH:mm:ss'], ['HH:mm:ss.SSS', 'HH:mm:ss.SSS'], ['HH:mm:ss.SSSuuu', 'HH:mm:ss.SSSuuu (microseconds)'], ['YYYY-MM-DD HH:mm:ss.SSS', 'YYYY-MM-DD HH:mm:ss.SSS']] },
            { key: 'terminal.wrap', label: 'Wrap long lines', type: 'bool' },
            { key: 'terminal.showControlChars', label: 'Show control characters', type: 'bool' },
            { key: 'terminal.showTx', label: 'Show transmitted data', type: 'bool' },
            { key: 'terminal.showDirection', label: 'Show direction column (RX/TX)', type: 'bool' },
            { key: 'terminal.autoScroll', label: 'Follow live data by default', type: 'bool' },
            { key: 'terminal.clearOnConnect', label: 'Clear terminal on connect', type: 'bool' },
            { key: 'terminal.rxColor', label: 'RX text color', type: 'color' },
            { key: 'terminal.txColor', label: 'TX text color', type: 'color' },
            { key: 'terminal.maxEntries', label: 'Maximum frames kept in memory per tab', type: 'number', min: 1000, max: 5000000, step: 1000 },
            { key: 'terminal.maxCaptureMB', label: 'Maximum capture size per tab', type: 'number', min: 4, max: 4096, unit: 'MB' },
            { key: 'terminal.persistSendHistory', label: 'Remember sent commands between sessions', type: 'bool' },
            { key: 'terminal.sendHistorySize', label: 'Send history size', type: 'number', min: 10, max: 5000 }
        ]
    },
    {
        id: 'timeline', title: 'Timeline', icon: 'wave',
        fields: [
            { key: 'timeline.visible', label: 'Show timeline in new tabs', type: 'bool' },
            { key: 'timeline.mode', label: 'Default mode', type: 'select', options: [['auto', 'Automatic'], ['activity', 'Frames'], ['logic', 'Logic analyzer']] },
            { key: 'timeline.height', label: 'Default height', type: 'number', min: 80, max: 800, unit: 'px' },
            { key: 'timeline.windowMs', label: 'Default visible window', type: 'number', min: 1, max: 3600000, unit: 'ms' },
            { key: 'timeline.frameGapMs', label: 'Frame grouping gap', type: 'number', min: 0, max: 1000, unit: 'ms' },
            { key: 'timeline.showMinimap', label: 'Show minimap', type: 'bool' },
            { key: 'timeline.rxColor', label: 'RX color', type: 'color' },
            { key: 'timeline.txColor', label: 'TX color', type: 'color' },
            { key: 'timeline.markerColor', label: 'Marker color', type: 'color' }
        ]
    },
    {
        id: 'reconnect', title: 'Reconnection', icon: 'replay',
        fields: [
            { key: 'reconnect.enabled', label: 'Automatically reconnect lost ports', type: 'bool' },
            { key: 'reconnect.matchBySerialNumber', label: 'Follow the device by USB serial number when its COM number changes', type: 'bool' },
            { key: 'reconnect.intervalMs', label: 'Retry interval', type: 'number', min: 100, max: 60000, unit: 'ms' },
            { key: 'reconnect.reopenDelayMs', label: 'Delay before reopening', type: 'number', min: 0, max: 10000, unit: 'ms', help: 'Gives the USB driver time to settle after the device reappears' },
            { key: 'reconnect.maxAttempts', label: 'Maximum attempts', type: 'number', min: 0, max: 100000, help: '0 means unlimited' }
        ]
    },
    {
        id: 'logging', title: 'Disk logging', icon: 'record',
        fields: [
            { key: 'logging.enabled', label: 'Record every port to disk', type: 'bool', help: 'Each tab can override this with the Rec button' },
            { key: 'logging.folder', label: 'Log folder', type: 'folder', placeholder: 'Documents/DiagTerm Logs' },
            { key: 'logging.format', label: 'File format', type: 'select', options: [['txt', 'Text with timestamps'], ['csv', 'CSV'], ['dtcap', 'DiagTerm capture (replayable)'], ['raw', 'Raw RX bytes']] },
            { key: 'logging.fileNameTemplate', label: 'File name', type: 'text', help: 'Variables: {port} {date} {time} {datetime}' },
            { key: 'logging.rotateSizeMB', label: 'Start a new file after', type: 'number', min: 0, max: 100000, unit: 'MB', help: '0 disables size rotation' },
            { key: 'logging.rotateMinutes', label: 'Start a new file every', type: 'number', min: 0, max: 100000, unit: 'min', help: '0 disables time rotation' }
        ],
        actions: [{ id: 'open-log-folder', label: 'Open log folder' }]
    },
    {
        id: 'flash', title: 'Flash and boards', icon: 'flash',
        fields: [
            { key: 'flash.autoUpdate', label: 'Keep installed board packages up to date automatically', type: 'bool' },
            { key: 'flash.updateIntervalHours', label: 'Update check interval', type: 'number', min: 1, max: 720, unit: 'h' },
            { key: 'flash.indexUrls', label: 'Board manager URLs', type: 'lines', help: 'One package index URL per line, same format as the Arduino IDE' },
            { key: 'flash.reuseArduino15', label: 'Also use packages installed by the Arduino IDE (Arduino15)', type: 'bool' },
            { key: 'flash.toolsFolder', label: 'Packages folder', type: 'folder', placeholder: 'Default (application data)' },
            { key: 'flash.keepOldVersions', label: 'Keep previous package versions after an update', type: 'bool' },
            { key: 'flash.concurrency', label: 'Boards flashed in parallel', type: 'number', min: 1, max: 32 },
            { key: 'flash.retries', label: 'Retries per step', type: 'number', min: 0, max: 10 },
            { key: 'flash.verify', label: 'Verify after upload', type: 'bool' },
            { key: 'flash.reopenPortAfterFlash', label: 'Reopen the terminal port after flashing', type: 'bool' },
            { key: 'flash.uploadSpeedOverride', label: 'Upload speed override', type: 'text', placeholder: 'Board default', help: 'Applies to every board when set (for example 921600)' },
            { key: 'flash.productionCooldownMs', label: 'Production mode: ignore a board for', type: 'number', min: 1000, max: 600000, unit: 'ms', help: 'Prevents flashing the same board twice when it re-enumerates after reset' },
            { key: 'flash.productionFilters', label: 'Production mode USB filters', type: 'filters' }
        ],
        actions: [{ id: 'board-manager', label: 'Open board manager' }, { id: 'boards-update', label: 'Check board updates now' }]
    },
    {
        id: 'plotter', title: 'Plotter', icon: 'chart',
        fields: [
            { key: 'plotter.maxPoints', label: 'Points kept per series', type: 'number', min: 100, max: 1000000 },
            { key: 'plotter.windowSeconds', label: 'Visible window', type: 'number', min: 1, max: 3600, unit: 's' }
        ]
    },
    {
        id: 'bridges', title: 'Bridges', icon: 'bridge',
        fields: [
            { key: 'bridges.defaultTcpPort', label: 'Default TCP port', type: 'number', min: 1, max: 65535 }
        ]
    },
    {
        id: 'notifications', title: 'Notifications', icon: 'trigger',
        fields: [
            { key: 'notifications.enabled', label: 'Enable notifications', type: 'bool' },
            { key: 'notifications.sound', label: 'Play sounds', type: 'bool' },
            { key: 'notifications.soundVolume', label: 'Sound volume', type: 'range', min: 0, max: 1, step: 0.05 },
            { key: 'notifications.notifyOnFlashDone', label: 'Notify when flash jobs finish', type: 'bool' },
            { key: 'notifications.notifyOnDisconnect', label: 'Notify when a port is lost', type: 'bool' }
        ],
        actions: [{ id: 'test-sound', label: 'Test sound' }]
    },
    { id: 'shortcuts', title: 'Keyboard shortcuts', icon: 'keyboard', custom: 'shortcuts' },
    { id: 'data', title: 'Data and automation', icon: 'macro', custom: 'data' },
    {
        id: 'advanced', title: 'Advanced', icon: 'cpu',
        fields: [
            { key: 'advanced.devTools', label: 'Allow developer tools (F12)', type: 'bool' }
        ],
        actions: [{ id: 'devtools', label: 'Toggle developer tools' }, { id: 'reload', label: 'Reload interface' }, { id: 'data-folder', label: 'Open data folder' }]
    }
];
