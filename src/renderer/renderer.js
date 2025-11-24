let tabs = [];
let activeTabId = null;
let ports = [];
let timelineData = new Map();
let timelineCanvas = null;
let timelineCtx = null;
let messageHistory = new Map();
let historyIndex = new Map();
let selectedMessage = null;
let selectedMessageIndex = null;

const timelineHeight = 150;
const timelinePadding = 20;
const timelineWindowSeconds = 10;

document.getElementById('refreshPorts').addEventListener('click', refreshPorts);
document.getElementById('newTab').addEventListener('click', createNewTab);
document.getElementById('flashMenu').addEventListener('click', openFlashModal);
document.getElementById('aboutMenu').addEventListener('click', openAboutModal);

if (window.electronAPI) {
    document.getElementById('window-minimize').addEventListener('click', () => {
        window.electronAPI.windowMinimize();
    });

    document.getElementById('window-maximize').addEventListener('click', () => {
        window.electronAPI.windowMaximize();
    });

    document.getElementById('window-close').addEventListener('click', () => {
        window.electronAPI.windowClose();
    });
}

if (window.electronAPI) {
    window.electronAPI.onPortData((portPath, type, data) => {
        handlePortData(portPath, type, data);
    });

    if (window.electronAPI.onPortOpened) {
        window.electronAPI.onPortOpened((portPath) => {
            const tab = tabs.find(t => t.portPath === portPath);
            if (tab) {
                tab.isOpen = true;
                updateTabStatus(tab.id);
                if (activeTabId === tab.id) {
                    renderTabContent(tab.id);
                }
            }
        });
    }
}

function refreshPorts() {
    if (!window.electronAPI) {
        console.error('electronAPI not available');
        return;
    }

    window.electronAPI.listPorts().then(portList => {
        console.log('Ports found:', portList);
        ports = portList;
        updatePortSelectors();
        updateFlashModalPorts();

        if (portList.length === 0) {
            console.warn('No serial ports found');
        }
    }).catch(error => {
        console.error('Error listing ports:', error);
        alert('Error listing ports: ' + error.message);
    });
}

function updatePortSelectors() {
    document.querySelectorAll('.port-select').forEach(select => {
        const currentValue = select.value;
        select.innerHTML = '<option value="">Select port</option>';

        if (ports.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No ports available - Click Refresh';
            option.disabled = true;
            select.appendChild(option);
        } else {
            ports.forEach(port => {
                const option = document.createElement('option');
                option.value = port.path;
                option.textContent = port.path + (port.manufacturer ? ` (${port.manufacturer})` : '');
                if (option.value === currentValue) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        }
    });
}

function getDefaultUSBConverter(devboard) {
    const defaults = {
        'ESP32-DevKitC': 'CP2102',
        'ESP32-DevKitV1': 'CP2102',
        'ESP32-WROOM-DevKit': 'CP2102',
        'ESP32-WROVER-Kit': 'FT2232',
        'ESP32-S2-DevKitM': 'CP2104',
        'ESP32-S2-Saola': 'CP2104',
        'ESP32-S3-DevKitC': 'CP2102',
        'ESP32-S3-DevKitM': 'CP2102',
        'ESP32-C3-DevKitM': 'CP2102',
        'ESP32-C3-DevKitC': 'CP2102',
        'ESP32-C6-DevKitC': 'CP2102',
        'ESP32-PICO-Kit': 'CP2102',
        'ESP8266-NodeMCU': 'CP2102',
        'ESP8266-NodeMCU-v2': 'CP2102',
        'ESP8266-NodeMCU-v3': 'CH340',
        'ESP8266-WeMos-D1': 'CH340',
        'ESP8266-WeMos-D1-Mini': 'CH340',
        'ESP8266-ESP-12E': 'CP2102',
        'ESP8266-ESP-12F': 'CP2102',
        'Arduino-Uno': 'ATmega16U2',
        'Arduino-Nano': 'FT232',
        'Arduino-Nano-v3': 'FT232',
        'Arduino-Mega-2560': 'ATmega16U2',
        'Arduino-Leonardo': 'ATmega32U4',
        'Arduino-Micro': 'ATmega32U4',
        'Arduino-Pro-Mini': 'FT232',
        'Arduino-ESP32': 'CP2102',
        'Generic': 'Generic'
    };
    return defaults[devboard] || 'Generic';
}

function createNewTab() {
    const tabId = Date.now();
    const tab = {
        id: tabId,
        portPath: '',
        baudRate: 115200,
        isOpen: false,
        content: '',
        contentLines: [],
        autoScroll: true,
        lineEnding: 'NL',
        showTimestamps: false,
        searchFilter: '',
        filterType: 'ALL',
        statistics: { rxCount: 0, txCount: 0, rxBytes: 0, txBytes: 0, startTime: null },
        alerts: [],
        alertPatterns: [],
        flashFile: null,
        deviceType: 'ESP32',
        devboard: 'ESP32-DevKitC',
        usbConverter: 'CP2102',
        flashAddress: '0x10000'
    };

    tab.usbConverter = getDefaultUSBConverter(tab.devboard);

    tabs.push(tab);
    activeTabId = tabId;
    messageHistory.set(tabId, []);
    historyIndex.set(tabId, -1);

    renderTabs();
    renderTabContent(tabId);
    refreshPorts();
    startTimelineAnimation();
}

async function removeTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);

    if (tab && tab.portPath && window.electronAPI) {
        try {
            const checkResult = await window.electronAPI.checkPortOpen(tab.portPath);
            if (checkResult.isOpen) {
                await window.electronAPI.closePort(tab.portPath);
            }
        } catch (error) {
            console.error('Error closing port when removing tab:', error);
        }
    }

    tabs = tabs.filter(t => t.id !== tabId);
    timelineData.delete(tabId);
    messageHistory.delete(tabId);
    historyIndex.delete(tabId);

    if (activeTabId === tabId) {
        activeTabId = tabs.length > 0 ? tabs[0].id : null;
    }

    renderTabs();
    if (activeTabId) {
        renderTabContent(activeTabId);
        startTimelineAnimation();
    } else {
        document.getElementById('mainContent').innerHTML = '<div class="empty-state"><p>No tabs open. Click \'+ New Tab\' to create one.</p></div>';
        document.getElementById('timelineContainer').style.display = 'none';
        stopTimelineAnimation();
    }
}

function setActiveTab(tabId) {
    activeTabId = tabId;
    renderTabs();
    renderTabContent(tabId);
    startTimelineAnimation();
}

function updateTabStatus(tabId) {
    const container = document.getElementById('tabsContainer');
    if (!container) return;

    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const tabEl = container.querySelector(`[data-tab-id="${tabId}"]`);
    if (tabEl) {
        const statusEl = tabEl.querySelector('.tab-status');
        if (statusEl) {
            if (tab.isOpen) {
                statusEl.classList.add('open');
            } else {
                statusEl.classList.remove('open');
            }
        }
    } else {
        renderTabs();
    }
}

function renderTabs() {
    const container = document.getElementById('tabsContainer');
    container.innerHTML = '';

    tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.id === activeTabId ? 'active' : ''}`;
        tabEl.setAttribute('data-tab-id', tab.id);
        tabEl.innerHTML = `
            <span class="tab-status ${tab.isOpen ? 'open' : ''}"></span>
            <span>${tab.portPath || 'New Tab'}</span>
            <span class="tab-close" onclick="event.stopPropagation(); removeTab(${tab.id})">×</span>
        `;
        tabEl.addEventListener('click', () => setActiveTab(tab.id));
        container.appendChild(tabEl);
    });

    if (activeTabId) {
        const activeTab = container.querySelector(`.tab.active`);
        if (activeTab) {
            activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }
}

function renderTabContent(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const mainContent = document.getElementById('mainContent');
    mainContent.innerHTML = `
        <div class="tab-content active">
            <div class="controls">
                <div class="control-group">
                    <label>Port:</label>
                    <select class="port-select" onchange="changePort(${tabId}, this.value)">
                        <option value="">Select port</option>
                    </select>
                </div>
                <div class="control-group">
                    <label>Baud Rate:</label>
                    <select onchange="changeBaudRate(${tabId}, this.value)">
                        <option value="300" ${tab.baudRate === 300 ? 'selected' : ''}>300</option>
                        <option value="600" ${tab.baudRate === 600 ? 'selected' : ''}>600</option>
                        <option value="1200" ${tab.baudRate === 1200 ? 'selected' : ''}>1200</option>
                        <option value="2400" ${tab.baudRate === 2400 ? 'selected' : ''}>2400</option>
                        <option value="4800" ${tab.baudRate === 4800 ? 'selected' : ''}>4800</option>
                        <option value="9600" ${tab.baudRate === 9600 ? 'selected' : ''}>9600</option>
                        <option value="19200" ${tab.baudRate === 19200 ? 'selected' : ''}>19200</option>
                        <option value="38400" ${tab.baudRate === 38400 ? 'selected' : ''}>38400</option>
                        <option value="57600" ${tab.baudRate === 57600 ? 'selected' : ''}>57600</option>
                        <option value="115200" ${tab.baudRate === 115200 ? 'selected' : ''}>115200</option>
                        <option value="230400" ${tab.baudRate === 230400 ? 'selected' : ''}>230400</option>
                        <option value="460800" ${tab.baudRate === 460800 ? 'selected' : ''}>460800</option>
                        <option value="921600" ${tab.baudRate === 921600 ? 'selected' : ''}>921600</option>
                    </select>
                </div>
                <div class="control-group">
                    <button class="btn" onclick="clearTerminal(${tabId})">Clear</button>
                </div>
                <div class="control-group">
                    <button class="btn" onclick="exportLogs(${tabId})">Export</button>
                </div>
                <div class="control-group">
                    <label>
                        <input type="checkbox" ${tab.autoScroll ? 'checked' : ''} 
                               onchange="toggleAutoScroll(${tabId}, this.checked)">
                        Auto Scroll
                    </label>
                </div>
                <div class="control-group">
                    <label>Line Ending:</label>
                    <select onchange="changeLineEnding(${tabId}, this.value)">
                        <option value="NL" ${tab.lineEnding === 'NL' ? 'selected' : ''}>New Line (\\n)</option>
                        <option value="CR" ${tab.lineEnding === 'CR' ? 'selected' : ''}>Carriage Return (\\r)</option>
                        <option value="NLCR" ${tab.lineEnding === 'NLCR' ? 'selected' : ''}>NL & CR (\\n\\r)</option>
                        <option value="CRNL" ${tab.lineEnding === 'CRNL' ? 'selected' : ''}>CR & NL (\\r\\n)</option>
                        <option value="NONE" ${tab.lineEnding === 'NONE' ? 'selected' : ''}>None</option>
                    </select>
                </div>
                <div class="control-group">
                    <span class="status-indicator ${tab.isOpen ? 'open' : 'closed'}">
                        ${tab.isOpen ? 'Open' : 'Closed'}
                    </span>
                </div>
                <div class="control-group">
                    ${tab.isOpen
            ? `<button class="btn" onclick="closePort(${tabId})">Close Port</button>`
            : `<button class="btn" onclick="openPort(${tabId})">Open Port</button>`
        }
                </div>
            </div>
            <div style="padding: 8px 12px; background: #252526; border-bottom: 1px solid #3e3e42; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <div class="control-group" style="flex: 1; min-width: 200px;">
                    <input type="text" id="search-input-${tabId}" placeholder="Search in logs..." 
                           style="width: 100%; padding: 4px 8px; background: #3c3c3c; border: 1px solid #3e3e42; color: #cccccc; border-radius: 3px; font-size: 13px;"
                           oninput="filterLogs(${tabId})">
                </div>
                <div class="control-group">
                    <label>Filter:</label>
                    <select id="filter-type-${tabId}" onchange="filterLogs(${tabId})" style="padding: 4px 8px; background: #3c3c3c; border: 1px solid #3e3e42; color: #cccccc; border-radius: 3px; font-size: 13px;">
                        <option value="ALL" ${tab.filterType === 'ALL' ? 'selected' : ''}>All</option>
                        <option value="RX" ${tab.filterType === 'RX' ? 'selected' : ''}>RX Only</option>
                        <option value="TX" ${tab.filterType === 'TX' ? 'selected' : ''}>TX Only</option>
                    </select>
                </div>
                <div class="control-group">
                    <button class="btn" onclick="compareLogs(${tabId})" style="padding: 4px 8px; font-size: 12px;">Compare</button>
                </div>
            </div>
            <div class="terminal" id="terminal-${tabId}" 
                 oncontextmenu="event.preventDefault(); showContextMenu(event, ${tabId})"
                 onclick="hideContextMenu()"></div>
            <div class="send-container">
                <label>Send:</label>
                <input type="text" id="send-input-${tabId}" 
                       placeholder="Type message and press Enter..."
                       onkeydown="handleSendInputKeydown(${tabId}, event)"
                       onkeypress="if(event.key === 'Enter') sendData(${tabId})">
                <button class="btn" onclick="sendData(${tabId})">Send</button>
            </div>
        </div>
    `;

    updatePortSelectors();
    const portSelect = mainContent.querySelector('.port-select');
    if (portSelect && tab.portPath) {
        portSelect.value = tab.portPath;
    }

    if (!tab.contentLines) {
        tab.contentLines = [];
        if (tab.content) {
            const lines = tab.content.split('\n');
            const timestamp = new Date();
            const timestampMs = timestamp.getTime();
            const timestampStr = timestamp.toISOString();

            lines.forEach((line, index) => {
                if (index < lines.length - 1) {
                    tab.contentLines.push({
                        type: 'RX',
                        text: line + '\n',
                        timestamp: timestampMs,
                        timestampStr: timestampStr
                    });
                } else if (line.length > 0) {
                    tab.contentLines.push({
                        type: 'RX',
                        text: line,
                        timestamp: timestampMs,
                        timestampStr: timestampStr
                    });
                }
            });
        }
    }

    updateTerminalDisplay(tabId);

    const sendInput = document.getElementById(`send-input-${tabId}`);
    if (sendInput) {
        sendInput.focus();
    }

    const flashBtn = document.getElementById(`flash-btn-${tabId}`);
    if (flashBtn && tab.portPath && tab.flashFile) {
        flashBtn.disabled = false;
    } else if (flashBtn) {
        flashBtn.disabled = true;
    }

    updateTimeline();
    startTimelineAnimation();
}

function changePort(tabId, portPath) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    if (tab.isOpen) {
        closePort(tabId).then(() => {
            tab.portPath = portPath;
            updateFlashButton(tabId);
            renderTabs();
            renderTabContent(tabId);
        });
    } else {
        tab.portPath = portPath;
        updateFlashButton(tabId);
        renderTabs();
        renderTabContent(tabId);
    }
}

function updateFlashButton(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const flashBtn = document.getElementById(`flash-btn-${tabId}`);
    if (flashBtn) {
        flashBtn.disabled = !tab.portPath || !tab.flashFile;
    }
}

function changeBaudRate(tabId, baudRate) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    if (tab.isOpen) {
        closePort(tabId).then(() => {
            tab.baudRate = parseInt(baudRate);
            renderTabContent(tabId);
        });
    } else {
        tab.baudRate = parseInt(baudRate);
        renderTabContent(tabId);
    }
}

function clearTerminal(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.content = '';
    tab.contentLines = [];
    timelineData.set(tabId, []);
    renderTabContent(tabId);
    updateTimeline();
}

function toggleAutoScroll(tabId, enabled) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.autoScroll = enabled;
}

function changeLineEnding(tabId, lineEnding) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.lineEnding = lineEnding;
}

async function openPort(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.portPath || !window.electronAPI) return;

    try {
        const checkResult = await window.electronAPI.checkPortOpen(tab.portPath);
        if (checkResult.isOpen) {
            tab.isOpen = true;
            const statusIndicator = document.querySelector(`#mainContent .status-indicator`);
            const closeButton = document.querySelector(`#mainContent .control-group:last-child button`);

            if (statusIndicator) {
                statusIndicator.className = 'status-indicator open';
                statusIndicator.textContent = 'Open';
            }

            if (closeButton) {
                closeButton.textContent = 'Close Port';
                closeButton.onclick = () => closePort(tabId);
            }

            updateTabStatus(tabId);
            return;
        }

        const result = await window.electronAPI.openPort(tab.portPath, tab.baudRate);
        if (result.success) {
            tab.isOpen = true;
            const statusIndicator = document.querySelector(`#mainContent .status-indicator`);
            const closeButton = document.querySelector(`#mainContent .control-group:last-child button`);

            if (statusIndicator) {
                statusIndicator.className = 'status-indicator open';
                statusIndicator.textContent = 'Open';
            }

            if (closeButton) {
                closeButton.textContent = 'Close Port';
                closeButton.onclick = () => closePort(tabId);
            }

            updateTabStatus(tabId);
        } else {
            alert(`Error opening port: ${result.error}`);
        }
    } catch (error) {
        console.error('Error opening port:', error);
        alert(`Error opening port: ${error.message}`);
    }
}

async function closePort(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.isOpen || !window.electronAPI) return Promise.resolve();

    try {
        const result = await window.electronAPI.closePort(tab.portPath);
        if (result.success) {
            tab.isOpen = false;
            const statusIndicator = document.querySelector(`#mainContent .status-indicator`);
            const openButton = document.querySelector(`#mainContent .control-group:last-child button`);

            if (statusIndicator) {
                statusIndicator.className = 'status-indicator closed';
                statusIndicator.textContent = 'Closed';
            }

            if (openButton) {
                openButton.textContent = 'Open Port';
                openButton.onclick = () => openPort(tabId);
            }

            updateTabStatus(tabId);
        } else {
            alert(`Error closing port: ${result.error}`);
        }
    } catch (error) {
        console.error('Error closing port:', error);
        alert(`Error closing port: ${error.message}`);
    }
}

function handleSendInputKeydown(tabId, event) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const history = messageHistory.get(tabId) || [];
        const currentIndex = historyIndex.get(tabId) || -1;
        const input = document.getElementById(`send-input-${tabId}`);

        if (!input) return;

        let newIndex = currentIndex;

        if (event.key === 'ArrowUp') {
            if (currentIndex === -1) {
                newIndex = history.length - 1;
            } else if (currentIndex > 0) {
                newIndex = currentIndex - 1;
            }
        } else if (event.key === 'ArrowDown') {
            if (currentIndex < history.length - 1) {
                newIndex = currentIndex + 1;
            } else {
                newIndex = -1;
            }
        }

        historyIndex.set(tabId, newIndex);

        if (newIndex >= 0 && newIndex < history.length) {
            input.value = history[newIndex];
        } else {
            input.value = '';
        }
    }
}

function getLineEnding(lineEnding) {
    switch (lineEnding) {
        case 'NL':
            return '\n';
        case 'CR':
            return '\r';
        case 'NLCR':
            return '\n\r';
        case 'CRNL':
            return '\r\n';
        case 'NONE':
            return '';
        default:
            return '\n';
    }
}

async function sendData(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.isOpen || !window.electronAPI) return;

    const input = document.getElementById(`send-input-${tabId}`);
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    const lineEnding = getLineEnding(tab.lineEnding);
    const data = message + lineEnding;
    const result = await window.electronAPI.writePort(tab.portPath, data);

    if (result.success) {
        const displayMessage = `> ${message}`;
        tab.content += displayMessage + '\n';

        if (!tab.contentLines) {
            tab.contentLines = [];
        }

        const timestamp = new Date();
        tab.contentLines.push({
            type: 'TX',
            text: displayMessage + '\n',
            timestamp: timestamp.getTime(),
            timestampStr: timestamp.toISOString()
        });

        if (tab.contentLines.length > 10000) {
            tab.contentLines = tab.contentLines.slice(-5000);
        }

        const history = messageHistory.get(tabId) || [];
        if (history.length === 0 || history[history.length - 1] !== message) {
            history.push(message);
            if (history.length > 50) {
                history.shift();
            }
            messageHistory.set(tabId, history);
        }
        historyIndex.set(tabId, -1);

        input.value = '';
        input.focus();

        updateTerminalDisplay(tabId);
    } else {
        alert(`Error sending data: ${result.error}`);
        input.focus();
    }
}

let updateTerminalTimeouts = new Map();
const MAX_TERMINAL_LENGTH = 1000000;
const TERMINAL_UPDATE_INTERVAL = 100;

function handlePortData(portPath, type, data) {
    const tab = tabs.find(t => t.portPath === portPath);
    if (!tab) return;

    if (type === 'RX') {
        tab.content += data;

        if (!tab.contentLines) {
            tab.contentLines = [];
        }

        const timestamp = new Date();
        const timestampMs = timestamp.getTime();
        const timestampStr = timestamp.toISOString();

        const lines = data.split('\n');
        lines.forEach((line, index) => {
            if (index < lines.length - 1) {
                tab.contentLines.push({
                    type: 'RX',
                    text: line + '\n',
                    timestamp: timestampMs,
                    timestampStr: timestampStr
                });
            } else if (line.length > 0 || data.endsWith('\n')) {
                tab.contentLines.push({
                    type: 'RX',
                    text: line + (data.endsWith('\n') ? '\n' : ''),
                    timestamp: timestampMs,
                    timestampStr: timestampStr
                });
            }
        });

        if (tab.content.length > MAX_TERMINAL_LENGTH) {
            tab.content = tab.content.slice(-MAX_TERMINAL_LENGTH / 2);
            const linesToKeep = Math.floor(tab.contentLines.length / 2);
            tab.contentLines = tab.contentLines.slice(-linesToKeep);
        }

        if (tab.contentLines.length > 10000) {
            tab.contentLines = tab.contentLines.slice(-5000);
        }
    }

    if (!timelineData.has(tab.id)) {
        timelineData.set(tab.id, []);
    }

    const events = timelineData.get(tab.id);
    const now = Date.now();
    events.push({
        timestamp: now,
        type: type,
        bytes: data.length
    });

    const windowStart = now - (timelineWindowSeconds * 1000 * 2);
    while (events.length > 0 && events[0].timestamp < windowStart) {
        events.shift();
    }

    if (events.length > 2000) {
        events.splice(0, events.length - 1000);
    }

    if (tab.id === activeTabId) {
        scheduleTerminalUpdate(tab.id);
    }
}

function scheduleTerminalUpdate(tabId) {
    if (updateTerminalTimeouts.has(tabId)) {
        return;
    }

    updateTerminalTimeouts.set(tabId, setTimeout(() => {
        updateTerminalTimeouts.delete(tabId);
        updateTerminalDisplay(tabId);
    }, TERMINAL_UPDATE_INTERVAL));
}

function updateTerminalDisplay(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || tabId !== activeTabId) return;

    const terminal = document.getElementById(`terminal-${tabId}`);
    if (!terminal) return;

    const wasAtBottom = terminal.scrollHeight - terminal.scrollTop <= terminal.clientHeight + 10;
    const scrollTop = terminal.scrollTop;

    requestAnimationFrame(() => {
        if (tabId !== activeTabId) return;

        if (tab.contentLines && tab.contentLines.length > 0) {
            const html = tab.contentLines.map(line => {
                const escaped = escapeHtml(line.text);
                if (line.type === 'TX') {
                    return `<span class="terminal-tx">${escaped}</span>`;
                } else {
                    return `<span class="terminal-rx">${escaped}</span>`;
                }
            }).join('');
            terminal.innerHTML = html;
        } else {
            terminal.textContent = tab.content;
        }

        if (tab.autoScroll && wasAtBottom) {
            terminal.scrollTop = terminal.scrollHeight;
        } else {
            terminal.scrollTop = scrollTop;
        }
    });
}

function updateTimeline() {
    if (activeTabId === null) {
        document.getElementById('timelineContainer').style.display = 'none';
        return;
    }

    document.getElementById('timelineContainer').style.display = 'flex';

    if (!timelineCanvas) {
        timelineCanvas = document.getElementById('timelineCanvas');
        timelineCtx = timelineCanvas.getContext('2d');

        const resizeCanvas = () => {
            timelineCanvas.width = timelineCanvas.offsetWidth;
            timelineCanvas.height = timelineCanvas.offsetHeight - timelinePadding;
            updateTimeline();
        };

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    const events = timelineData.get(activeTabId) || [];
    const width = timelineCanvas.width;
    const height = timelineCanvas.height;
    const ctx = timelineCtx;

    ctx.clearRect(0, 0, width, height);

    const rxY = height / 4;
    const txY = (height * 3) / 4;

    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rxY);
    ctx.lineTo(width, rxY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, txY);
    ctx.lineTo(width, txY);
    ctx.stroke();

    if (events.length > 0) {
        const now = Date.now();
        const windowStart = now - (timelineWindowSeconds * 1000);

        events.forEach(event => {
            if (event.timestamp < windowStart) return;

            const elapsed = event.timestamp - windowStart;
            const timeRange = timelineWindowSeconds * 1000;
            const x = (elapsed / timeRange) * width;

            if (x >= 0 && x <= width) {
                const y = event.type === 'RX' ? rxY : txY;
                const barHeight = Math.min(Math.max(event.bytes * 2, 5), 30);

                ctx.fillStyle = event.type === 'RX' ? '#4caf50' : '#f44336';
                ctx.fillRect(x - 1, y - barHeight / 2, 2, barHeight);
            }
        });

        const currentTimeX = width;
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(currentTimeX, 0);
        ctx.lineTo(currentTimeX, height);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

let timelineAnimationId = null;

function startTimelineAnimation() {
    if (timelineAnimationId) return;

    function animate() {
        if (activeTabId !== null) {
            updateTimeline();
            timelineAnimationId = requestAnimationFrame(animate);
        } else {
            timelineAnimationId = null;
        }
    }

    timelineAnimationId = requestAnimationFrame(animate);
}

function stopTimelineAnimation() {
    if (timelineAnimationId) {
        cancelAnimationFrame(timelineAnimationId);
        timelineAnimationId = null;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showContextMenu(event, tabId) {
    const contextMenu = document.getElementById('contextMenu');
    const terminal = document.getElementById(`terminal-${tabId}`);

    if (!terminal) return;

    const selection = window.getSelection();
    let selectedText = selection.toString().trim();
    let messageType = 'RX';

    if (selectedText) {
        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        let element = commonAncestor.nodeType === Node.TEXT_NODE ? commonAncestor.parentElement : commonAncestor;

        while (element && element !== terminal) {
            if (element.classList && element.classList.contains('terminal-tx')) {
                messageType = 'TX';
                break;
            } else if (element.classList && element.classList.contains('terminal-rx')) {
                messageType = 'RX';
                break;
            }
            element = element.parentElement;
        }

        selectedMessage = { text: selectedText, type: messageType };
        selectedMessageIndex = null;
    } else {
        const tab = tabs.find(t => t.id === tabId);
        if (tab && tab.contentLines && tab.contentLines.length > 0) {
            const rect = terminal.getBoundingClientRect();
            const clickY = event.clientY - rect.top + terminal.scrollTop;
            const lineHeight = parseFloat(getComputedStyle(terminal).lineHeight) || 20;
            const lineIndex = Math.floor(clickY / lineHeight);

            if (lineIndex >= 0 && lineIndex < tab.contentLines.length) {
                const line = tab.contentLines[lineIndex];
                selectedText = line.text.trim();
                selectedMessage = line;
                selectedMessageIndex = lineIndex;
            } else {
                const lastLine = tab.contentLines[tab.contentLines.length - 1];
                if (lastLine) {
                    selectedText = lastLine.text.trim();
                    selectedMessage = lastLine;
                    selectedMessageIndex = tab.contentLines.length - 1;
                }
            }
        }
    }

    if (selectedText) {
        contextMenu.style.display = 'block';
        contextMenu.style.left = event.pageX + 'px';
        contextMenu.style.top = event.pageY + 'px';
    }
}

function hideContextMenu() {
    const contextMenu = document.getElementById('contextMenu');
    contextMenu.style.display = 'none';
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) {
        hideContextMenu();
    }
});

function analyzeMessage() {
    if (!selectedMessage) return;

    const text = selectedMessage.text;
    const bytes = new TextEncoder().encode(text);

    let hex = '';
    let binary = '';
    let ascii = '';
    let stats = {
        length: bytes.length,
        printable: 0,
        control: 0,
        whitespace: 0,
        digits: 0,
        letters: 0,
        symbols: 0
    };

    let patterns = [];
    let structure = [];

    bytes.forEach((byte, index) => {
        hex += byte.toString(16).padStart(2, '0').toUpperCase() + ' ';
        if ((index + 1) % 16 === 0) hex += '\n';

        binary += byte.toString(2).padStart(8, '0') + ' ';
        if ((index + 1) % 8 === 0) binary += '\n';

        if (byte >= 32 && byte <= 126) {
            ascii += String.fromCharCode(byte);
            stats.printable++;
            if (byte >= 48 && byte <= 57) stats.digits++;
            else if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) stats.letters++;
            else stats.symbols++;
        } else if (byte === 9 || byte === 10 || byte === 13 || byte === 32) {
            ascii += '.';
            stats.whitespace++;
        } else {
            ascii += '.';
            stats.control++;
        }

        if (byte === 0x00) structure.push({ pos: index, type: 'NULL', desc: 'Null byte' });
        if (byte === 0xFF) structure.push({ pos: index, type: 'FF', desc: '0xFF marker' });
        if (byte === 0x0A) structure.push({ pos: index, type: 'LF', desc: 'Line Feed (\\n)' });
        if (byte === 0x0D) structure.push({ pos: index, type: 'CR', desc: 'Carriage Return (\\r)' });
        if (byte === 0x09) structure.push({ pos: index, type: 'TAB', desc: 'Tab (\\t)' });
        if (byte === 0x20) structure.push({ pos: index, type: 'SPACE', desc: 'Space' });
    });

    if (bytes.length >= 2) {
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) patterns.push('Possible BOM (UTF-16 LE)');
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) patterns.push('Possible BOM (UTF-16 BE)');
        if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) patterns.push('UTF-8 BOM');
    }

    if (text.startsWith('AT')) patterns.push('Possible AT command');
    if (text.match(/^[0-9A-Fa-f]+$/)) patterns.push('Hexadecimal string');
    if (text.match(/^[01]+$/)) patterns.push('Binary string');
    if (text.includes('{') && text.includes('}')) patterns.push('Possible JSON');
    if (text.includes('<') && text.includes('>')) patterns.push('Possible XML/HTML');
    if (text.match(/^[A-Z]+\s+[0-9]/)) patterns.push('Possible command format');

    const hasStartByte = bytes[0] < 32 || bytes[0] > 126;
    const hasEndByte = bytes[bytes.length - 1] < 32 || bytes[bytes.length - 1] > 126;
    if (hasStartByte && hasEndByte) patterns.push('Possible frame with start/end markers');

    if (bytes.length >= 4) {
        const firstTwo = (bytes[0] << 8) | bytes[1];
        const lastTwo = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
        if (firstTwo === lastTwo) patterns.push('Possible checksum or frame markers');
    }

    const protocolDecode = decodeProtocol(selectedMessage);
    let protocolSection = '';

    if (protocolDecode.modbus || protocolDecode.nmea) {
        protocolSection = '<div class="analysis-section"><h3>Protocol Decoding</h3>';

        if (protocolDecode.modbus) {
            const modbus = protocolDecode.modbus;
            const funcNames = {
                1: 'Read Coils',
                2: 'Read Discrete Inputs',
                3: 'Read Holding Registers',
                4: 'Read Input Registers',
                5: 'Write Single Coil',
                6: 'Write Single Register',
                15: 'Write Multiple Coils',
                16: 'Write Multiple Registers'
            };
            protocolSection += `
                <div class="analysis-item" style="margin-bottom: 12px;">
                    <div class="analysis-label" style="display: block; margin-bottom: 4px; color: #4ec9b0;">Modbus RTU:</div>
                    <div class="analysis-value" style="margin-left: 8px;">
                        <div>Function Code: ${modbus.functionCode} (${funcNames[modbus.functionCode] || 'Unknown'})</div>
                        <div>Address: ${modbus.address}</div>
                        <div>Data Length: ${modbus.data.length} bytes</div>
                        <div>Data: ${modbus.data.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}</div>
                        <div>CRC: 0x${modbus.crc.toString(16).padStart(4, '0').toUpperCase()}</div>
                    </div>
                </div>
            `;
        }

        if (protocolDecode.nmea) {
            const nmea = protocolDecode.nmea;
            protocolSection += `
                <div class="analysis-item" style="margin-bottom: 12px;">
                    <div class="analysis-label" style="display: block; margin-bottom: 4px; color: #4ec9b0;">NMEA:</div>
                    <div class="analysis-value" style="margin-left: 8px;">
                        <div>Sentence Type: ${nmea.sentence}</div>
                        <div>Fields: ${nmea.fields.length}</div>
                        <div style="margin-top: 4px;">${nmea.fields.map((f, i) => `[${i}]: ${f}`).join('<br>')}</div>
                    </div>
                </div>
            `;
        }

        protocolSection += '</div>';
    }

    const content = `
        <div class="analysis-section">
            <h3>Raw Content</h3>
            <div class="analysis-item">
                <span class="analysis-label">Type:</span>
                <span class="analysis-value">${selectedMessage.type}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Length:</span>
                <span class="analysis-value">${stats.length} bytes</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Text:</span>
                <div class="analysis-value" style="margin-top: 4px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(text)}</div>
            </div>
        </div>
        
        <div class="analysis-section">
            <h3>Hexadecimal</h3>
            <div class="hex-display">${hex.trim()}</div>
        </div>
        
        <div class="analysis-section">
            <h3>Binary</h3>
            <div class="binary-display">${binary.trim()}</div>
        </div>
        
        <div class="analysis-section">
            <h3>ASCII Representation</h3>
            <div class="hex-display">${ascii}</div>
        </div>
        
        ${protocolSection}
        
        <div class="analysis-section">
            <h3>Topology & Patterns</h3>
            ${patterns.length > 0 ? `
                <div class="analysis-item" style="margin-bottom: 12px;">
                    <div class="analysis-label" style="display: block; margin-bottom: 4px;">Detected Patterns:</div>
                    ${patterns.map(p => `<div class="analysis-value" style="margin-left: 8px; margin-bottom: 2px;">• ${p}</div>`).join('')}
                </div>
            ` : '<div class="analysis-item">No specific patterns detected</div>'}
            ${structure.length > 0 ? `
                <div class="analysis-item" style="margin-top: 12px;">
                    <div class="analysis-label" style="display: block; margin-bottom: 4px;">Special Characters:</div>
                    ${structure.map(s => `<div class="analysis-value" style="margin-left: 8px; margin-bottom: 2px;">Byte ${s.pos}: ${s.desc}</div>`).join('')}
                </div>
            ` : ''}
        </div>
        
        <div class="analysis-section">
            <h3>Statistics</h3>
            <div class="analysis-item">
                <span class="analysis-label">Total Bytes:</span>
                <span class="analysis-value">${stats.length}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Printable:</span>
                <span class="analysis-value">${stats.printable} (${stats.length > 0 ? ((stats.printable / stats.length) * 100).toFixed(1) : 0}%)</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Control Chars:</span>
                <span class="analysis-value">${stats.control}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Whitespace:</span>
                <span class="analysis-value">${stats.whitespace}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Digits:</span>
                <span class="analysis-value">${stats.digits}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Letters:</span>
                <span class="analysis-value">${stats.letters}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Symbols:</span>
                <span class="analysis-value">${stats.symbols}</span>
            </div>
        </div>
    `;

    document.getElementById('analysisContent').innerHTML = content;
    document.getElementById('analysisModal').style.display = 'flex';
    hideContextMenu();
}

function closeAnalysisModal() {
    document.getElementById('analysisModal').style.display = 'none';
    selectedMessage = null;
    selectedMessageIndex = null;
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeAnalysisModal();
        hideContextMenu();
    }

    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'f') {
            e.preventDefault();
            const searchInput = document.getElementById(`search-input-${activeTabId}`);
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
        } else if (e.key === 'n') {
            e.preventDefault();
            createNewTab();
        } else if (e.key === 'w') {
            e.preventDefault();
            if (activeTabId) {
                removeTab(activeTabId);
            }
        } else if (e.key === 'e') {
            e.preventDefault();
            if (activeTabId) {
                exportLogs(activeTabId);
            }
        } else if (e.key === 'k') {
            e.preventDefault();
            if (activeTabId) {
                clearTerminal(activeTabId);
            }
        }
    }
});

function updateFlashButton(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const flashBtn = document.getElementById(`flash-btn-${tabId}`);
    if (flashBtn) {
        flashBtn.disabled = !tab.portPath || !tab.flashFile;
    }
}

function changeDeviceType(tabId, deviceType) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.deviceType = deviceType;

    if (deviceType === 'Arduino') {
        tab.flashAddress = '0x0';
        if (!tab.devboard.startsWith('Arduino')) {
            tab.devboard = 'Arduino-Uno';
        }
    } else if (deviceType === 'ESP32') {
        if (!tab.devboard.startsWith('ESP32')) {
            tab.devboard = 'ESP32-DevKitC';
        }
    } else if (deviceType === 'ESP8266') {
        if (!tab.devboard.startsWith('ESP8266')) {
            tab.devboard = 'ESP8266-NodeMCU';
        }
    }

    tab.usbConverter = getDefaultUSBConverter(tab.devboard);

    const addressInput = document.getElementById(`flash-address-${tabId}`);
    if (addressInput) {
        addressInput.value = tab.flashAddress;
    }

    renderTabContent(tabId);
}

function changeDevboard(tabId, devboard) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.devboard = devboard;
    tab.usbConverter = getDefaultUSBConverter(devboard);

    const usbSelect = document.getElementById(`usb-converter-${tabId}`);
    if (usbSelect) {
        usbSelect.value = tab.usbConverter;
    }
}

function changeUSBConverter(tabId, usbConverter) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.usbConverter = usbConverter;
}

function changeFlashAddress(tabId, address) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    tab.flashAddress = address;
}

async function selectFlashFile(tabId) {
    if (!window.electronAPI) return;

    const result = await window.electronAPI.selectBinaryFile();
    if (result.success && result.filePath) {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            tab.flashFile = result.filePath;
            const fileInput = document.getElementById(`flash-file-${tabId}`);
            if (fileInput) {
                const fileName = result.filePath.split(/[/\\]/).pop();
                fileInput.value = fileName;
            }

            updateFlashButton(tabId);
        }
    }
}

let flashProcess = null;

async function flashBinary(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.flashFile || !tab.portPath || !window.electronAPI) return;

    if (tab.isOpen) {
        const close = confirm('Port is open. It needs to be closed for flashing. Close it now?');
        if (close) {
            await closePort(tabId);
        } else {
            return;
        }
    }

    const progressDiv = document.getElementById(`flash-progress-${tabId}`);
    const progressBar = document.getElementById(`flash-progress-bar-${tabId}`);
    const flashLog = document.getElementById(`flash-log-${tabId}`);
    const flashBtn = document.getElementById(`flash-btn-${tabId}`);

    if (progressDiv) progressDiv.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';
    if (flashLog) flashLog.textContent = '';
    if (flashBtn) flashBtn.disabled = true;

    let currentProgress = 0;
    let isFlashing = true;

    if (window.electronAPI.onFlashOutput) {
        const flashOutputHandler = (data) => {
            if (!isFlashing) return;

            if (flashLog) {
                flashLog.textContent += data;
                flashLog.scrollTop = flashLog.scrollHeight;
            }

            if (progressBar) {
                const writeMatch = data.match(/Writing at 0x[\da-fA-F]+\.\.\. \((\d+)%\)/);
                const verifyMatch = data.match(/Verifying\.\.\. \((\d+)%\)/);
                const eraseMatch = data.match(/Erasing\.\.\. \((\d+)%\)/);

                let newProgress = currentProgress;

                if (writeMatch) {
                    const writePercent = parseInt(writeMatch[1]);
                    newProgress = Math.max(currentProgress, Math.min(writePercent, 90));
                } else if (verifyMatch) {
                    const verifyPercent = parseInt(verifyMatch[1]);
                    newProgress = Math.max(currentProgress, 90 + Math.min(verifyPercent / 10, 10));
                } else if (eraseMatch) {
                    const erasePercent = parseInt(eraseMatch[1]);
                    newProgress = Math.max(currentProgress, Math.min(erasePercent, 10));
                } else {
                    const genericMatch = data.match(/(\d+)%/);
                    if (genericMatch) {
                        const percent = parseInt(genericMatch[1]);
                        if (percent > currentProgress) {
                            newProgress = percent;
                        }
                    }
                }

                if (newProgress > currentProgress) {
                    currentProgress = newProgress;
                    progressBar.style.width = currentProgress + '%';
                }

                if (data.includes('Hash of data verified') || data.includes('Leaving...') || data.includes('Hard resetting')) {
                    currentProgress = 100;
                    progressBar.style.width = '100%';
                }
            }
        };

        window.electronAPI.onFlashOutput(flashOutputHandler);
    }

    try {
        const result = await window.electronAPI.flashBinary(
            tab.portPath,
            tab.flashFile,
            tab.deviceType,
            tab.devboard,
            tab.usbConverter,
            tab.flashAddress
        );

        if (result.success) {
            isFlashing = false;
            if (progressBar) {
                currentProgress = 100;
                progressBar.style.width = '100%';
            }
            if (flashLog) flashLog.textContent += '\n\nFlash completed successfully!';

            setTimeout(() => {
                if (progressDiv) progressDiv.style.display = 'none';
                if (flashBtn) flashBtn.disabled = false;

                if (tab.isOpen) {
                    renderTabContent(tabId);
                }
            }, 2000);
        } else {
            isFlashing = false;
            if (flashLog) {
                flashLog.textContent += `\n\n=== ERROR ===\n${result.error}`;
                if (result.error.includes('esptool module not found') || result.error.includes('install esptool')) {
                    flashLog.textContent += `\n\nPlease copy the command above and run it in your terminal, then restart DiagTerm.`;
                }
            }
            if (flashBtn) flashBtn.disabled = false;
        }
    } catch (error) {
        isFlashing = false;
        if (flashLog) flashLog.textContent += `\n\nError: ${error.message}`;
        if (flashBtn) flashBtn.disabled = false;
    }
}

function cancelFlash(tabId) {
    if (flashProcess) {
        flashProcess.kill();
        flashProcess = null;
    }

    const progressDiv = document.getElementById(`flash-progress-${tabId}`);
    const flashBtn = document.getElementById(`flash-btn-${tabId}`);

    if (progressDiv) progressDiv.style.display = 'none';
    if (flashBtn) flashBtn.disabled = false;
}

let flashModalFile = null;
let flashModalConfig = {
    deviceType: 'ESP32',
    devboard: 'ESP32-DevKitC',
    usbConverter: 'CP2102',
    flashAddress: '0x10000'
};

function openFlashModal() {
    document.getElementById('flashModal').style.display = 'flex';
    const configView = document.getElementById('flash-config-view');
    const logsView = document.getElementById('flash-logs-view');
    const logsContent = document.getElementById('flash-logs-content');
    const modalTitle = document.getElementById('flash-modal-title');
    const closeBtn = document.getElementById('flash-close-btn');

    configView.style.display = 'flex';
    logsView.style.display = 'none';
    modalTitle.textContent = 'Flash Binary';
    closeBtn.style.display = 'none';
    logsContent.textContent = '';

    updateFlashModalPorts();
    updateFlashDevboardOptions();
    flashModalFile = null;
    document.getElementById('flash-file-path').value = 'No file selected';
}

function closeFlashModal() {
    document.getElementById('flashModal').style.display = 'none';
}

function updateFlashModalPorts() {
    const portsList = document.getElementById('flash-ports-list');
    if (!portsList) return;

    portsList.innerHTML = '';

    if (ports.length === 0) {
        portsList.innerHTML = '<div style="color: #858585; padding: 8px;">No ports available. Click "Refresh Ports" first.</div>';
        return;
    }

    ports.forEach(port => {
        const portDiv = document.createElement('div');
        portDiv.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 4px 0;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `flash-port-${port.path}`;
        checkbox.value = port.path;
        checkbox.style.cssText = 'cursor: pointer;';
        const label = document.createElement('label');
        label.htmlFor = `flash-port-${port.path}`;
        label.textContent = port.path + (port.manufacturer ? ` (${port.manufacturer})` : '');
        label.style.cssText = 'cursor: pointer; color: #cccccc; flex: 1;';
        portDiv.appendChild(checkbox);
        portDiv.appendChild(label);
        portsList.appendChild(portDiv);
    });
}

function updateFlashDevboardOptions() {
    const deviceType = document.getElementById('flash-device-type').value;
    const devboardSelect = document.getElementById('flash-devboard');
    const usbSelect = document.getElementById('flash-usb-converter');

    if (!devboardSelect || !usbSelect) return;

    flashModalConfig.deviceType = deviceType;

    let devboardOptions = '';
    if (deviceType === 'ESP32') {
        devboardOptions = `
            <option value="ESP32-DevKitC">ESP32 DevKitC</option>
            <option value="ESP32-DevKitV1">ESP32 DevKit V1</option>
            <option value="ESP32-WROOM-DevKit">ESP32-WROOM DevKit</option>
            <option value="ESP32-WROVER-Kit">ESP32-WROVER Kit</option>
            <option value="ESP32-S2-DevKitM">ESP32-S2 DevKitM</option>
            <option value="ESP32-S2-Saola">ESP32-S2 Saola</option>
            <option value="ESP32-S3-DevKitC">ESP32-S3 DevKitC</option>
            <option value="ESP32-S3-DevKitM">ESP32-S3 DevKitM</option>
            <option value="ESP32-C3-DevKitM">ESP32-C3 DevKitM</option>
            <option value="ESP32-C3-DevKitC">ESP32-C3 DevKitC</option>
            <option value="ESP32-C6-DevKitC">ESP32-C6 DevKitC</option>
            <option value="ESP32-PICO-Kit">ESP32-PICO Kit</option>
            <option value="Generic">Generic ESP32</option>
        `;
        flashModalConfig.flashAddress = '0x10000';
    } else if (deviceType === 'ESP8266') {
        devboardOptions = `
            <option value="ESP8266-NodeMCU">ESP8266 NodeMCU</option>
            <option value="ESP8266-NodeMCU-v2">ESP8266 NodeMCU v2</option>
            <option value="ESP8266-NodeMCU-v3">ESP8266 NodeMCU v3</option>
            <option value="ESP8266-WeMos-D1">ESP8266 WeMos D1</option>
            <option value="ESP8266-WeMos-D1-Mini">ESP8266 WeMos D1 Mini</option>
            <option value="ESP8266-ESP-12E">ESP8266 ESP-12E</option>
            <option value="ESP8266-ESP-12F">ESP8266 ESP-12F</option>
            <option value="Generic">Generic ESP8266</option>
        `;
        flashModalConfig.flashAddress = '0x10000';
    } else {
        devboardOptions = `
            <option value="Arduino-Uno">Arduino Uno</option>
            <option value="Arduino-Nano">Arduino Nano</option>
            <option value="Arduino-Nano-v3">Arduino Nano v3</option>
            <option value="Arduino-Mega-2560">Arduino Mega 2560</option>
            <option value="Arduino-Leonardo">Arduino Leonardo</option>
            <option value="Arduino-Micro">Arduino Micro</option>
            <option value="Arduino-Pro-Mini">Arduino Pro Mini</option>
            <option value="Arduino-ESP32">Arduino ESP32</option>
            <option value="Generic">Generic Arduino</option>
        `;
        flashModalConfig.flashAddress = '0x0';
    }

    devboardSelect.innerHTML = devboardOptions;
    devboardSelect.value = flashModalConfig.devboard;

    usbSelect.innerHTML = `
        <option value="CP2102">CP2102</option>
        <option value="CP2104">CP2104</option>
        <option value="CH340">CH340</option>
        <option value="CH341">CH341</option>
        <option value="FT232">FT232</option>
        <option value="FT2232">FT2232</option>
        <option value="PL2303">PL2303</option>
        <option value="ATmega16U2">ATmega16U2</option>
        <option value="ATmega32U4">ATmega32U4</option>
        <option value="Generic">Generic</option>
    `;

    devboardSelect.onchange = () => {
        flashModalConfig.devboard = devboardSelect.value;
        flashModalConfig.usbConverter = getDefaultUSBConverter(devboardSelect.value);
        usbSelect.value = flashModalConfig.usbConverter;
    };

    usbSelect.onchange = () => {
        flashModalConfig.usbConverter = usbSelect.value;
    };

    flashModalConfig.usbConverter = getDefaultUSBConverter(devboardSelect.value);
    usbSelect.value = flashModalConfig.usbConverter;

    document.getElementById('flash-address').value = flashModalConfig.flashAddress;
}

async function selectFlashFileForModal() {
    if (!window.electronAPI) return;

    const result = await window.electronAPI.selectBinaryFile();
    if (result.success && result.filePath) {
        flashModalFile = result.filePath;
        const fileName = result.filePath.split(/[/\\]/).pop();
        document.getElementById('flash-file-path').value = fileName;
    }
}

async function startMultiFlash() {
    if (!flashModalFile || !window.electronAPI) {
        alert('Please select a binary file first');
        return;
    }

    const selectedPorts = Array.from(document.querySelectorAll('#flash-ports-list input[type="checkbox"]:checked'))
        .map(cb => cb.value);

    if (selectedPorts.length === 0) {
        alert('Please select at least one port');
        return;
    }

    flashModalConfig.deviceType = document.getElementById('flash-device-type').value;
    flashModalConfig.devboard = document.getElementById('flash-devboard').value;
    flashModalConfig.usbConverter = document.getElementById('flash-usb-converter').value;
    flashModalConfig.flashAddress = document.getElementById('flash-address').value;

    const configView = document.getElementById('flash-config-view');
    const logsView = document.getElementById('flash-logs-view');
    const logsContent = document.getElementById('flash-logs-content');
    const modalTitle = document.getElementById('flash-modal-title');
    const closeBtn = document.getElementById('flash-close-btn');

    configView.style.display = 'none';
    logsView.style.display = 'flex';
    modalTitle.textContent = 'Flash Progress';
    closeBtn.style.display = 'none';

    logsContent.innerHTML = `Starting flash on ${selectedPorts.length} port(s)...\n\n`;
    logsContent.scrollTop = logsContent.scrollHeight;

    const portLogs = new Map();
    selectedPorts.forEach(port => {
        portLogs.set(port, '');
    });

    let allLogs = logsContent.textContent;

    const flashOutputHandler = (data) => {
        const text = data.toString();
        allLogs += text;
        logsContent.textContent = allLogs;
        logsContent.scrollTop = logsContent.scrollHeight;
    };

    window.electronAPI.onFlashOutput(flashOutputHandler);

    const flashPromises = selectedPorts.map(async (portPath) => {
        const portResult = { port: portPath, success: false, output: '', error: '' };

        try {
            allLogs += `\n[${portPath}] Starting flash...\n`;
            logsContent.textContent = allLogs;
            logsContent.scrollTop = logsContent.scrollHeight;

            const result = await window.electronAPI.flashBinary(
                portPath,
                flashModalFile,
                flashModalConfig.deviceType,
                flashModalConfig.devboard,
                flashModalConfig.usbConverter,
                flashModalConfig.flashAddress,
                115200
            );

            portResult.success = result.success;
            portResult.output = result.output || '';
            portResult.error = result.error || '';

            if (result.success) {
                allLogs += `\n[${portPath}] ✓ Flash completed successfully!\n`;
            } else {
                allLogs += `\n[${portPath}] ✗ Flash failed: ${result.error}\n`;
            }
            logsContent.textContent = allLogs;
        } catch (error) {
            portResult.success = false;
            portResult.error = error.message;
            allLogs += `\n[${portPath}] ✗ Error: ${error.message}\n`;
            logsContent.textContent = allLogs;
        }

        logsContent.scrollTop = logsContent.scrollHeight;
        return portResult;
    });

    const results = await Promise.all(flashPromises);

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const successfulPorts = results.filter(r => r.success).map(r => r.port);

    allLogs += `\n\n=== Summary ===\n`;
    allLogs += `Success: ${successCount}\n`;
    allLogs += `Failed: ${failCount}\n`;
    logsContent.textContent = allLogs;
    logsContent.scrollTop = logsContent.scrollHeight;

    closeBtn.style.display = 'block';

    if (window.electronAPI && window.electronAPI.removeFlashOutputListener) {
        window.electronAPI.removeFlashOutputListener();
    }

    setTimeout(() => {
        closeFlashModal();

        successfulPorts.forEach(portPath => {
            const existingTab = tabs.find(t => t.portPath === portPath);
            if (!existingTab) {
                const tabId = Date.now();
                const tab = {
                    id: tabId,
                    portPath: portPath,
                    baudRate: 115200,
                    isOpen: false,
                    content: '',
                    contentLines: [],
                    autoScroll: true,
                    lineEnding: 'NL',
                    flashFile: null,
                    deviceType: 'ESP32',
                    devboard: 'ESP32-DevKitC',
                    usbConverter: 'CP2102',
                    flashAddress: '0x10000'
                };

                tab.usbConverter = getDefaultUSBConverter(tab.devboard);

                tabs.push(tab);
                activeTabId = tabId;
                messageHistory.set(tabId, []);
                historyIndex.set(tabId, -1);

                renderTabs();
                renderTabContent(tabId);
                openPort(tabId);
            } else if (!existingTab.isOpen) {
                openPort(existingTab.id);
            }
        });

        if (successfulPorts.length > 0) {
            refreshPorts();
        }
    }, 2000);
}

let exportTabId = null;

function exportLogs(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.contentLines || tab.contentLines.length === 0) {
        alert('No logs to export');
        return;
    }

    exportTabId = tabId;
    document.getElementById('exportModal').style.display = 'flex';
}

function closeExportModal() {
    document.getElementById('exportModal').style.display = 'none';
    exportTabId = null;
}

function confirmExport() {
    if (!exportTabId || !window.electronAPI) return;

    const tab = tabs.find(t => t.id === exportTabId);
    if (!tab || !tab.contentLines || tab.contentLines.length === 0) {
        alert('No logs to export');
        return;
    }

    const format = document.getElementById('export-format').value;
    const portName = tab.portPath ? tab.portPath.replace(/[^a-zA-Z0-9]/g, '_') : 'logs';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const defaultFileName = `DiagTerm_${portName}_${timestamp}`;

    let content = '';
    let extension = '';

    switch (format) {
        case 'csv':
            content = convertToCSV(tab.contentLines);
            extension = '.csv';
            break;
        case 'txt':
            content = convertToDelimitedText(tab.contentLines);
            extension = '.txt';
            break;
        case 'html':
            content = convertToHTML(tab.contentLines);
            extension = '.html';
            break;
        case 'xml':
            content = convertToXML(tab.contentLines);
            extension = '.xml';
            break;
        case 'json':
            content = convertToJSON(tab.contentLines);
            extension = '.json';
            break;
        case 'md':
            content = convertToMarkdown(tab.contentLines);
            extension = '.md';
            break;
        case 'tex':
            content = convertToLaTeX(tab.contentLines);
            extension = '.tex';
            break;
    }

    window.electronAPI.exportLogs(content, format, defaultFileName + extension).then(result => {
        if (result.success) {
            closeExportModal();
        } else if (result.error) {
            alert(`Export failed: ${result.error}`);
        }
    });
}

function convertToCSV(lines) {
    let csv = 'Type,Timestamp,Content\n';
    lines.forEach(line => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const text = (line.text || '').replace(/"/g, '""').replace(/\n/g, '\\n');
        csv += `"${type}","${timestamp}","${text}"\n`;
    });
    return csv;
}

function convertToDelimitedText(lines) {
    let text = 'Type\tTimestamp\tContent\n';
    lines.forEach(line => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const content = (line.text || '').replace(/\n/g, '\\n');
        text += `${type}\t${timestamp}\t${content}\n`;
    });
    return text;
}

function convertToHTML(lines) {
    let html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>DiagTerm Logs</title>\n';
    html += '<style>body{font-family:monospace;background:#1e1e1e;color:#d4d4d4;padding:20px;}';
    html += 'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #3e3e42;padding:8px;text-align:left;}';
    html += 'th{background:#252526;}tr.rx{color:#d4d4d4;}tr.tx{color:#4ec9b0;}</style>\n';
    html += '</head>\n<body>\n<h1>DiagTerm Logs</h1>\n<table>\n<thead><tr><th>Type</th><th>Timestamp</th><th>Content</th></tr></thead>\n<tbody>\n';

    lines.forEach(line => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const content = (line.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        html += `<tr class="${type.toLowerCase()}"><td>${type}</td><td>${timestamp}</td><td>${content}</td></tr>\n`;
    });

    html += '</tbody>\n</table>\n</body>\n</html>';
    return html;
}

function convertToXML(lines) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<logs>\n';
    lines.forEach((line, index) => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const content = (line.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        xml += `  <entry id="${index}">\n    <type>${type}</type>\n    <timestamp>${timestamp}</timestamp>\n    <content><![CDATA[${content}]]></content>\n  </entry>\n`;
    });
    xml += '</logs>';
    return xml;
}

function convertToJSON(lines) {
    const data = {
        exportDate: new Date().toISOString(),
        entries: lines.map((line, index) => ({
            id: index,
            type: line.type || 'RX',
            timestamp: line.timestamp || null,
            timestampStr: line.timestampStr || null,
            content: line.text || ''
        }))
    };
    return JSON.stringify(data, null, 2);
}

function convertToMarkdown(lines) {
    let md = '# DiagTerm Logs\n\n';
    md += '| Type | Timestamp | Content |\n';
    md += '|------|-----------|----------|\n';
    lines.forEach(line => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const content = (line.text || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        md += `| ${type} | ${timestamp} | ${content} |\n`;
    });
    return md;
}

function convertToLaTeX(lines) {
    let tex = '\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{longtable}\n\\begin{document}\n';
    tex += '\\title{DiagTerm Logs}\n\\maketitle\n';
    tex += '\\begin{longtable}{|l|l|p{8cm}|}\n\\hline\n\\textbf{Type} & \\textbf{Timestamp} & \\textbf{Content} \\\\\n\\hline\n\\endfirsthead\n';
    tex += '\\hline\n\\textbf{Type} & \\textbf{Timestamp} & \\textbf{Content} \\\\\n\\hline\n\\endhead\n';

    lines.forEach(line => {
        const type = line.type || 'RX';
        const timestamp = line.timestampStr || (line.timestamp ? new Date(line.timestamp).toISOString() : '');
        const content = (line.text || '').replace(/\\/g, '\\textbackslash{}').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/#/g, '\\#').replace(/\$/g, '\\$').replace(/%/g, '\\%').replace(/&/g, '\\&').replace(/_/g, '\\_').replace(/\n/g, '\\\\');
        const timestampEscaped = timestamp.replace(/\\/g, '\\textbackslash{}').replace(/{/g, '\\{').replace(/}/g, '\\}');
        tex += `${type} & ${timestampEscaped} & ${content} \\\\\n\\hline\n`;
    });

    tex += '\\end{longtable}\n\\end{document}';
    return tex;
}

function openAboutModal() {
    document.getElementById('aboutModal').style.display = 'flex';
}

function closeAboutModal() {
    document.getElementById('aboutModal').style.display = 'none';
}

let messageTemplates = JSON.parse(localStorage.getItem('diagterm_templates') || '[]');
let alertPatterns = JSON.parse(localStorage.getItem('diagterm_alert_patterns') || '[]');

function showStatistics(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    const stats = calculateStatistics(tab);
    const content = document.getElementById('statisticsContent');

    const sessionDuration = stats.startTime ?
        Math.floor((Date.now() - stats.startTime) / 1000) : 0;
    const hours = Math.floor(sessionDuration / 3600);
    const minutes = Math.floor((sessionDuration % 3600) / 60);
    const seconds = sessionDuration % 60;
    const durationStr = hours > 0 ? `${hours}h ${minutes}m ${seconds}s` :
        minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    const rxRate = sessionDuration > 0 ? (stats.rxBytes / sessionDuration).toFixed(2) : '0';
    const txRate = sessionDuration > 0 ? (stats.txBytes / sessionDuration).toFixed(2) : '0';

    content.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div>
                <h3 style="color: #4ec9b0; margin-bottom: 12px; font-size: 14px;">RX Statistics</h3>
                <div style="color: #d4d4d4; line-height: 1.8;">
                    <div><span style="color: #858585;">Messages:</span> ${stats.rxCount}</div>
                    <div><span style="color: #858585;">Bytes:</span> ${stats.rxBytes.toLocaleString()}</div>
                    <div><span style="color: #858585;">Rate:</span> ${rxRate} bytes/s</div>
                </div>
            </div>
            <div>
                <h3 style="color: #4ec9b0; margin-bottom: 12px; font-size: 14px;">TX Statistics</h3>
                <div style="color: #d4d4d4; line-height: 1.8;">
                    <div><span style="color: #858585;">Messages:</span> ${stats.txCount}</div>
                    <div><span style="color: #858585;">Bytes:</span> ${stats.txBytes.toLocaleString()}</div>
                    <div><span style="color: #858585;">Rate:</span> ${txRate} bytes/s</div>
                </div>
            </div>
        </div>
        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #3e3e42;">
            <div style="color: #d4d4d4; line-height: 1.8;">
                <div><span style="color: #858585;">Total Messages:</span> ${stats.rxCount + stats.txCount}</div>
                <div><span style="color: #858585;">Total Bytes:</span> ${(stats.rxBytes + stats.txBytes).toLocaleString()}</div>
                <div><span style="color: #858585;">Session Duration:</span> ${durationStr}</div>
            </div>
        </div>
    `;

    document.getElementById('statisticsModal').style.display = 'flex';
}

function closeStatisticsModal() {
    document.getElementById('statisticsModal').style.display = 'none';
}

function calculateStatistics(tab) {
    if (!tab.statistics.startTime) {
        tab.statistics.startTime = Date.now();
    }

    if (!tab.contentLines || tab.contentLines.length === 0) {
        return tab.statistics;
    }

    let rxCount = 0;
    let txCount = 0;
    let rxBytes = 0;
    let txBytes = 0;

    tab.contentLines.forEach(line => {
        if (line.type === 'RX') {
            rxCount++;
            rxBytes += new Blob([line.text]).size;
        } else if (line.type === 'TX') {
            txCount++;
            txBytes += new Blob([line.text]).size;
        }
    });

    tab.statistics.rxCount = rxCount;
    tab.statistics.txCount = txCount;
    tab.statistics.rxBytes = rxBytes;
    tab.statistics.txBytes = txBytes;

    return tab.statistics;
}

function showTemplates(tabId) {
    renderTemplatesList();
    document.getElementById('templatesModal').style.display = 'flex';
}

function closeTemplatesModal() {
    document.getElementById('templatesModal').style.display = 'none';
}

function renderTemplatesList() {
    const list = document.getElementById('templates-list');
    if (!list) return;

    if (messageTemplates.length === 0) {
        list.innerHTML = '<div style="color: #858585; padding: 20px; text-align: center;">No templates. Click "Add Template" to create one.</div>';
        return;
    }

    list.innerHTML = messageTemplates.map((template, index) => `
        <div style="padding: 12px; border: 1px solid #3e3e42; border-radius: 3px; margin-bottom: 8px; background: #252526;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <strong style="color: #4ec9b0;">${escapeHtml(template.name || 'Unnamed')}</strong>
                <div style="display: flex; gap: 4px;">
                    <button class="btn" onclick="useTemplate(${index})" style="padding: 2px 8px; font-size: 11px;">Use</button>
                    <button class="btn" onclick="editTemplate(${index})" style="padding: 2px 8px; font-size: 11px;">Edit</button>
                    <button class="btn" onclick="deleteTemplate(${index})" style="padding: 2px 8px; font-size: 11px; background: #d32f2f;">Delete</button>
                </div>
            </div>
            <div style="color: #d4d4d4; font-family: monospace; font-size: 12px; background: #1e1e1e; padding: 8px; border-radius: 3px; word-break: break-all;">
                ${escapeHtml(template.content || '')}
            </div>
        </div>
    `).join('');
}

function addTemplate() {
    const name = prompt('Template name:');
    if (!name) return;

    const content = prompt('Template content:');
    if (content === null) return;

    messageTemplates.push({ name, content });
    localStorage.setItem('diagterm_templates', JSON.stringify(messageTemplates));
    renderTemplatesList();
}

function useTemplate(index) {
    if (!activeTabId) return;
    const template = messageTemplates[index];
    if (!template) return;

    const input = document.getElementById(`send-input-${activeTabId}`);
    if (input) {
        input.value = template.content;
        input.focus();
    }
    closeTemplatesModal();
}

function editTemplate(index) {
    const template = messageTemplates[index];
    if (!template) return;

    const newName = prompt('Template name:', template.name);
    if (newName === null) return;

    const newContent = prompt('Template content:', template.content);
    if (newContent === null) return;

    messageTemplates[index] = { name: newName, content: newContent };
    localStorage.setItem('diagterm_templates', JSON.stringify(messageTemplates));
    renderTemplatesList();
}

function deleteTemplate(index) {
    if (confirm('Delete this template?')) {
        messageTemplates.splice(index, 1);
        localStorage.setItem('diagterm_templates', JSON.stringify(messageTemplates));
        renderTemplatesList();
    }
}

function showAlerts(tabId) {
    renderAlertsList();
    document.getElementById('alertsModal').style.display = 'flex';
}

function closeAlertsModal() {
    document.getElementById('alertsModal').style.display = 'none';
}

function renderAlertsList() {
    const list = document.getElementById('alerts-list');
    if (!list) return;

    if (alertPatterns.length === 0) {
        list.innerHTML = '<div style="color: #858585; padding: 20px; text-align: center;">No alert patterns. Click "Add Alert Pattern" to create one.</div>';
        return;
    }

    list.innerHTML = alertPatterns.map((pattern, index) => `
        <div style="padding: 12px; border: 1px solid #3e3e42; border-radius: 3px; margin-bottom: 8px; background: #252526;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div>
                    <strong style="color: #4ec9b0;">${escapeHtml(pattern.name || 'Unnamed')}</strong>
                    <span style="color: #858585; font-size: 12px; margin-left: 8px;">
                        ${pattern.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                </div>
                <div style="display: flex; gap: 4px;">
                    <button class="btn" onclick="toggleAlertPattern(${index})" style="padding: 2px 8px; font-size: 11px;">
                        ${pattern.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button class="btn" onclick="editAlertPattern(${index})" style="padding: 2px 8px; font-size: 11px;">Edit</button>
                    <button class="btn" onclick="deleteAlertPattern(${index})" style="padding: 2px 8px; font-size: 11px; background: #d32f2f;">Delete</button>
                </div>
            </div>
            <div style="color: #d4d4d4; font-size: 12px;">
                <div style="margin-bottom: 4px;"><span style="color: #858585;">Pattern:</span> <code style="background: #1e1e1e; padding: 2px 6px; border-radius: 2px;">${escapeHtml(pattern.pattern || '')}</code></div>
                <div><span style="color: #858585;">Type:</span> ${pattern.matchType || 'Contains'}</div>
            </div>
        </div>
    `).join('');
}

function addAlertPattern() {
    const name = prompt('Alert name:');
    if (!name) return;

    const pattern = prompt('Pattern to match:');
    if (!pattern) return;

    const matchType = prompt('Match type (Contains/Regex/Exact):', 'Contains');

    alertPatterns.push({
        name,
        pattern,
        matchType: matchType || 'Contains',
        enabled: true
    });
    localStorage.setItem('diagterm_alert_patterns', JSON.stringify(alertPatterns));
    renderAlertsList();
}

function toggleAlertPattern(index) {
    if (alertPatterns[index]) {
        alertPatterns[index].enabled = !alertPatterns[index].enabled;
        localStorage.setItem('diagterm_alert_patterns', JSON.stringify(alertPatterns));
        renderAlertsList();
    }
}

function editAlertPattern(index) {
    const pattern = alertPatterns[index];
    if (!pattern) return;

    const newName = prompt('Alert name:', pattern.name);
    if (newName === null) return;

    const newPattern = prompt('Pattern to match:', pattern.pattern);
    if (newPattern === null) return;

    const newMatchType = prompt('Match type (Contains/Regex/Exact):', pattern.matchType);

    alertPatterns[index] = {
        name: newName,
        pattern: newPattern,
        matchType: newMatchType || 'Contains',
        enabled: pattern.enabled
    };
    localStorage.setItem('diagterm_alert_patterns', JSON.stringify(alertPatterns));
    renderAlertsList();
}

function deleteAlertPattern(index) {
    if (confirm('Delete this alert pattern?')) {
        alertPatterns.splice(index, 1);
        localStorage.setItem('diagterm_alert_patterns', JSON.stringify(alertPatterns));
        renderAlertsList();
    }
}

function checkAlerts(tabId, line) {
    if (!alertPatterns || alertPatterns.length === 0) return;

    alertPatterns.forEach(pattern => {
        if (!pattern.enabled) return;

        let matches = false;
        if (pattern.matchType === 'Regex') {
            try {
                const regex = new RegExp(pattern.pattern);
                matches = regex.test(line.text);
            } catch (e) {
                console.error('Invalid regex pattern:', pattern.pattern);
            }
        } else if (pattern.matchType === 'Exact') {
            matches = line.text === pattern.pattern;
        } else {
            matches = line.text.includes(pattern.pattern);
        }

        if (matches) {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification(`DiagTerm Alert: ${pattern.name}`, {
                    body: `Pattern matched: ${pattern.pattern}`,
                    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%234ec9b0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
                });
            }
        }
    });
}

let compareFileData = null;

function compareLogs(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.contentLines || tab.contentLines.length === 0) {
        alert('No logs to compare in current tab');
        return;
    }

    compareFileData = null;
    const source1 = document.getElementById('compare-source1');
    if (source1) {
        source1.innerHTML = tab.contentLines.slice(0, 100).map((line, i) =>
            `<div style="color: ${line.type === 'TX' ? '#4ec9b0' : '#d4d4d4'}; margin-bottom: 2px;">[${i}] ${escapeHtml(line.text.substring(0, 100))}</div>`
        ).join('');
    }

    const source2 = document.getElementById('compare-source2');
    if (source2) {
        source2.innerHTML = '<div style="color: #858585;">No file selected</div>';
    }

    document.getElementById('compareModal').style.display = 'flex';
}

function closeCompareModal() {
    document.getElementById('compareModal').style.display = 'none';
    compareFileData = null;
}

async function selectCompareFile() {
    if (!window.electronAPI) return;

    const result = await window.electronAPI.selectLogFile();
    if (result.success && result.filePath) {
        const readResult = await window.electronAPI.readFile(result.filePath);
        if (readResult.success) {
            try {
                const data = JSON.parse(readResult.content);

                if (data.entries && Array.isArray(data.entries)) {
                    compareFileData = data.entries;
                    const source2 = document.getElementById('compare-source2');
                    if (source2) {
                        source2.innerHTML = compareFileData.slice(0, 100).map((line, i) =>
                            `<div style="color: ${line.type === 'TX' ? '#4ec9b0' : '#d4d4d4'}; margin-bottom: 2px;">[${i}] ${escapeHtml((line.content || '').substring(0, 100))}</div>`
                        ).join('');
                    }
                    performCompare();
                } else {
                    alert('Invalid log file format');
                }
            } catch (error) {
                alert(`Error parsing file: ${error.message}`);
            }
        } else {
            alert(`Error reading file: ${readResult.error}`);
        }
    }
}

function performCompare() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.contentLines || !compareFileData) return;

    const results = document.getElementById('compare-results');
    if (!results) return;

    const current = tab.contentLines;
    const file = compareFileData;

    let differences = [];
    const maxLen = Math.max(current.length, file.length);

    for (let i = 0; i < maxLen; i++) {
        const curr = current[i];
        const fileLine = file[i];

        if (!curr && fileLine) {
            differences.push({ line: i, type: 'missing', content: fileLine.content || fileLine.text });
        } else if (curr && !fileLine) {
            differences.push({ line: i, type: 'extra', content: curr.text });
        } else if (curr && fileLine) {
            const currText = curr.text.trim();
            const fileText = (fileLine.content || fileLine.text || '').trim();
            if (currText !== fileText) {
                differences.push({
                    line: i,
                    type: 'different',
                    current: currText,
                    file: fileText
                });
            }
        }
    }

    if (differences.length === 0) {
        results.innerHTML = '<div style="color: #4caf50; padding: 20px; text-align: center;">Logs are identical!</div>';
    } else {
        results.innerHTML = `
            <div style="color: #d4d4d4; margin-bottom: 12px;">
                <strong>Found ${differences.length} differences</strong>
            </div>
            ${differences.slice(0, 200).map(diff => {
            if (diff.type === 'missing') {
                return `<div style="color: #f44336; margin-bottom: 4px;">[Line ${diff.line}] Missing: ${escapeHtml(diff.content.substring(0, 200))}</div>`;
            } else if (diff.type === 'extra') {
                return `<div style="color: #ff9800; margin-bottom: 4px;">[Line ${diff.line}] Extra: ${escapeHtml(diff.content.substring(0, 200))}</div>`;
            } else {
                return `<div style="margin-bottom: 8px;">
                        <div style="color: #858585; font-size: 10px;">Line ${diff.line}:</div>
                        <div style="color: #f44336;">Current: ${escapeHtml(diff.current.substring(0, 150))}</div>
                        <div style="color: #ff9800;">File: ${escapeHtml(diff.file.substring(0, 150))}</div>
                    </div>`;
            }
        }).join('')}
        `;
    }
}

function decodeProtocol(line) {
    const text = line.text || '';
    const decoded = {
        modbus: null,
        nmea: null,
        hex: null,
        ascii: null
    };

    if (text.match(/^[0-9A-Fa-f\s]+$/)) {
        const hexBytes = text.match(/[0-9A-Fa-f]{2}/g);
        if (hexBytes && hexBytes.length >= 6) {
            decoded.hex = hexBytes.join(' ');

            const bytes = hexBytes.map(h => parseInt(h, 16));
            decoded.ascii = bytes.map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('');

            if (bytes.length >= 6 && bytes[0] === bytes[1] && bytes[0] === 0x01) {
                decoded.modbus = {
                    functionCode: bytes[2],
                    address: (bytes[3] << 8) | bytes[4],
                    data: bytes.slice(5, -2),
                    crc: (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]
                };
            }
        }
    }

    if (text.startsWith('$')) {
        const parts = text.split(',');
        if (parts.length > 0 && parts[0].startsWith('$')) {
            decoded.nmea = {
                sentence: parts[0],
                fields: parts.slice(1)
            };
        }
    }

    return decoded;
}

if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission();
}

refreshPorts();

