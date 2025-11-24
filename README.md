# DiagTerm

UART terminal with RX/TX timeline visualization for ESP32, Arduino and other microcontrollers.

## Installation

```bash
npm install
npm run rebuild
```

## Usage

```bash
npm start
```

## Project Structure

```
DiagTerm/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.js
│   │   └── preload.js
│   └── renderer/       # UI
│       ├── index.html
│       ├── renderer.js
│       └── styles.css
└── package.json
```

## Features

- Multi-tab UART terminal
- RX/TX timeline visualization
- Binary flashing for ESP32, Arduino, etc.
- Multi-flash support
- Log export (CSV, TXT, HTML, XML, JSON, Markdown, LaTeX)
- Search and filter logs
- Message templates
- Communication statistics
- Pattern-based alerts
- Protocol decoding (Modbus RTU, NMEA)
- Log comparison
- Keyboard shortcuts

## Keyboard Shortcuts

- `Ctrl+F` / `Cmd+F`: Focus search bar
- `Ctrl+N` / `Cmd+N`: New tab
- `Ctrl+W` / `Cmd+W`: Close current tab
- `Ctrl+E` / `Cmd+E`: Export logs
- `Ctrl+K` / `Cmd+K`: Clear terminal
- `Escape`: Close modals

## Requirements

- Node.js 16+
- Python 3.x (for ESP32 flashing)
- esptool (auto-installed if missing)

## License

MIT

© 2025 Techalchemy
