# DiagTerm

A powerful UART terminal application for debugging and communicating with microcontrollers, with built-in binary flashing capabilities.

![Main Interface](https://www.noelshack.com/2025-48-1-1763985957-s1.png)

## What is DiagTerm?

DiagTerm is a cross-platform terminal application designed for working with serial devices. Whether you're debugging an ESP32, flashing an Arduino, or just monitoring serial communication, DiagTerm provides a clean interface with powerful features.

The app runs on Windows, Linux, and macOS, and handles everything from basic serial communication to complex multi-device flashing operations.

## Key Features

### Multi-Tab Terminal Interface

Work with multiple serial ports simultaneously. Each tab is independent, so you can monitor different devices at the same time. The interface shows a clear status indicator (green dot when connected) and gives you full control over baud rates, port opening/closing, and data transmission.

### RX/TX Timeline Visualization

See your data flow in real-time with the timeline at the bottom of each tab. It shows when data is received (RX) and transmitted (TX), giving you a visual representation of the communication pattern. The timeline is always visible, even when there's no data yet.

### Binary Flashing

Flash firmware to your devices directly from the application. Supports ESP32, ESP8266, and Arduino boards with automatic bootloader mode entry.

![Multi-Flash Dialog](https://www.noelshack.com/2025-48-1-1763985957-s3.png)

The multi-flash feature lets you flash multiple devices at once. Each port can have its own USB-Serial converter selection, which is useful when working with different board generations.

![Multi-Flash in Progress](https://www.noelshack.com/2025-48-1-1763985957-s4.png)

### Message Analysis

Right-click on any message in the terminal to get a detailed analysis:

![Message Analysis](https://www.noelshack.com/2025-48-1-1763986111-s9.png)

The analysis shows:
- Raw content (exact bytes received)
- Hexadecimal representation
- Binary breakdown
- ASCII interpretation
- Statistics (length, character distribution)
- Pattern detection
- Protocol decoding (Modbus RTU, NMEA, etc.)

### Log Comparison

Compare two log files side by side to spot differences:

![Log Comparison](https://www.noelshack.com/2025-48-1-1763985957-s2.png)

Useful for debugging communication issues or verifying firmware behavior across different versions.

### Export Capabilities

Export your terminal data in multiple formats:
- **CSV** - For spreadsheet analysis
- **TXT** - Plain text backup
- **HTML** - Formatted web view
- **XML** - Structured data
- **JSON** - For programmatic processing
- **Markdown** - Documentation-friendly
- **LaTeX** - Academic papers

### Advanced Features

- **Search and Filter**: Find specific messages quickly
- **Message Templates**: Save and reuse common commands
- **Communication Statistics**: Track data rates, message counts, and more
- **Pattern-Based Alerts**: Get notified when specific patterns appear
- **Keyboard Shortcuts**: Work faster with hotkeys
- **Line Ending Options**: Choose between None, LF, CR, or CRLF

![Line Ending Options](https://www.noelshack.com/2025-48-1-1763986052-s8.png)

## Supported Devices

### ESP32 Family
- ESP32 DevKitC
- ESP32 DevKit V1
- ESP32-WROOM DevKit
- ESP32-WROVER Kit
- ESP32-S2 DevKitM
- ESP32-S2 Saola
- ESP32-S3 DevKitC
- ESP32-S3 DevKitM
- ESP32-C3 DevKitM
- ESP32-C3 DevKitC
- ESP32-C6 DevKitC
- ESP32-PICO Kit
- Generic ESP32

### ESP8266
- NodeMCU
- ESP8266 DevKit
- Generic ESP8266

### Arduino
- Arduino Uno
- Arduino Nano / Nano v3
- Arduino Mega 2560
- Arduino Leonardo
- Arduino Micro
- Arduino Pro Mini
- Arduino ESP32
- Generic Arduino

### USB-Serial Converters

The application supports various USB-Serial converters with automatic detection:
- CP2102 / CP2104
- FT232 / FT2232
- CH340 / CH341
- ATmega16U2 / ATmega32U4
- Generic converters

![Available Ports](https://www.noelshack.com/2025-48-1-1763986052-s7.png)

## Installation

### Pre-built Releases

Download the latest version from the [releases page](https://github.com/your-repo/releases) or check for updates directly in the application.

### From Source

```bash
git clone https://github.com/your-repo/DiagTerm.git
cd DiagTerm
npm install
npm run rebuild
npm start
```

## Usage

### Basic Serial Communication

1. Click "New Tab" to create a new terminal tab
2. Select a port from the dropdown
3. Choose your baud rate (common values: 9600, 115200, etc.)
4. Click "Open Port"
5. Start sending and receiving data

### Sending Data

Type your message in the "Send" input field and press Enter. You can also use the up arrow key to recall previous messages. Choose your line ending mode (None, LF, CR, or CRLF) depending on what your device expects.

### Flashing Firmware

1. Click the "Flash" button in the top menu
2. Select your device type (ESP32, ESP8266, or Arduino)
3. Choose the specific devboard model
4. Select the USB-Serial converter (or leave as "Default")
5. Browse for your binary file
6. Optionally set a flash address (default: 0x10000 for ESP32)
7. Click "Start Flash"

For multi-flashing:
1. Open the Flash dialog
2. Select multiple ports from the list
3. Each port can have its own USB-Serial converter selection
4. Start the flash operation

The application will automatically:
- Enter bootloader mode using DTR/RTS signals
- Flash the binary using esptool (ESP32/ESP8266) or avrdude (Arduino)
- Reopen the port after flashing
- Send a reset signal to boot the new firmware

### Analyzing Messages

Right-click on any message in the terminal to open the analysis dialog. This gives you detailed information about the message content, including hex, binary, ASCII, and protocol-specific decoding.

### Exporting Logs

1. Use the export button or press `Ctrl+E` (Windows/Linux) or `Cmd+E` (macOS)
2. Choose your export format
3. Select a save location
4. Optionally filter messages before exporting

## Keyboard Shortcuts

- `Ctrl+F` / `Cmd+F`: Focus search bar
- `Ctrl+N` / `Cmd+N`: New tab
- `Ctrl+W` / `Cmd+W`: Close current tab
- `Ctrl+E` / `Cmd+E`: Export logs
- `Ctrl+K` / `Cmd+K`: Clear terminal
- `↑`: Recall previous message
- `Escape`: Close modals

## Requirements

- **Windows**: Windows 10 or later
- **Linux**: Most modern distributions
- **macOS**: macOS 10.13 or later
- **Python 3.x**: Required for ESP32/ESP8266 flashing (auto-installed if missing)
- **esptool**: Automatically installed if not present

## Limitations

### Code Signing

The application uses a self-signed certificate for code signing. This means:
- Windows will show a security warning during installation
- Users need to click "More info" then "Run anyway" to install
- Auto-updates require manual approval due to signature verification

For production use, consider purchasing a code signing certificate from a trusted Certificate Authority.

### Flashing Requirements

- **ESP32/ESP8266**: Requires Python and esptool (automatically installed)
- **Arduino**: Requires avrdude (usually comes with Arduino IDE)
- Some USB-Serial converters may need specific drivers installed

### Port Detection

- Ports are detected automatically when the application starts
- Use the refresh button to rescan for new devices
- Disconnected ports are automatically detected and marked

## Troubleshooting

### Port Not Appearing

- Make sure the device is connected and powered
- Check if drivers are installed for your USB-Serial converter
- Try clicking the refresh button
- On Linux, you may need to add your user to the `dialout` group

### Flashing Fails

- Verify the binary file is correct for your device
- Check that the port is not open in another application
- Ensure the correct USB-Serial converter is selected
- Try a different baud rate (lower rates are more reliable)
- Some devices require holding a button during bootloader entry

### Update Not Working

- The application checks for updates on startup
- If updates are blocked by Windows security, use the manual download option
- Updates are signed with a self-signed certificate, so manual approval is required

## Development

### Building

```bash
npm run build:bugfix    # Increment bugfix version and build
npm run build:release  # Increment release version and build
npm run build:win      # Build for Windows only
npm run build:linux    # Build for Linux only
npm run build:mac      # Build for macOS only
```

### Generating Code Signing Certificate

```bash
npm run generate-cert
```

This creates a self-signed certificate in `certificates/diagterm-cert.pfx`. For production, use a certificate from a trusted CA.

### Deployment

```bash
npm run deploy:win     # Build and upload to FTP server
npm run deploy:all     # Build for all platforms and upload
```

## License

MIT License - see LICENSE file for details

## Credits

Developed by Techalchemy

---

**Note**: This application is designed for development and debugging purposes. Always verify firmware before flashing to production devices.
