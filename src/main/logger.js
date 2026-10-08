const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { bus, send } = require('./context');
const settings = require('./settings');

const writers = new Map();
const portOverrides = new Map();

function pad(n, len = 2) {
    return String(n).padStart(len, '0');
}

function formatStamp(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(Math.floor(d.getMilliseconds()), 3)}`;
}

function logFolder() {
    const configured = settings.get('logging.folder');
    const folder = configured || path.join(app.getPath('documents'), 'DiagTerm Logs');
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function buildFileName(portPath, format) {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const port = String(portPath).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '');
    const template = settings.get('logging.fileNameTemplate') || '{port}_{date}_{time}';
    const name = template.replace(/\{port\}/g, port).replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{datetime\}/g, `${date}_${time}`);
    const ext = format === 'raw' ? 'bin' : format;
    return `${name}.${ext}`;
}

function isEnabledFor(portPath) {
    if (portOverrides.has(portPath)) return portOverrides.get(portPath);
    return !!settings.get('logging.enabled');
}

function openWriter(portPath) {
    const format = settings.get('logging.format') || 'txt';
    const file = path.join(logFolder(), buildFileName(portPath, format));
    const stream = fs.createWriteStream(file, { flags: 'a' });
    const writer = { portPath, format, file, stream, bytes: 0, openedAt: Date.now(), lineStart: true, lastDir: null };
    if (format === 'dtcap') {
        writeRaw(writer, JSON.stringify({ format: 'dtcap', version: 1, port: portPath, created: new Date().toISOString() }) + '\n');
    } else if (format === 'csv') {
        writeRaw(writer, 'timestamp,direction,hex,text\n');
    }
    writers.set(portPath, writer);
    send('logger:state', { path: portPath, active: true, file });
    console.log(`Disk logging started for ${portPath}: ${file}`);
    return writer;
}

function writeRaw(writer, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    writer.stream.write(buf);
    writer.bytes += buf.length;
}

function closeWriter(portPath) {
    const writer = writers.get(portPath);
    if (!writer) return;
    writers.delete(portPath);
    try {
        writer.stream.end();
    } catch (error) {
        console.error('Error closing log file:', error.message);
    }
    send('logger:state', { path: portPath, active: false, file: writer.file });
}

function maybeRotate(writer) {
    const sizeLimit = (Number(settings.get('logging.rotateSizeMB')) || 0) * 1024 * 1024;
    const minuteLimit = (Number(settings.get('logging.rotateMinutes')) || 0) * 60000;
    if ((sizeLimit > 0 && writer.bytes >= sizeLimit) || (minuteLimit > 0 && Date.now() - writer.openedAt >= minuteLimit)) {
        closeWriter(writer.portPath);
        return openWriter(writer.portPath);
    }
    return writer;
}

function writeChunk(writer, dir, t, buffer) {
    if (writer.format === 'raw') {
        if (dir === 'RX') writeRaw(writer, buffer);
        return;
    }
    if (writer.format === 'dtcap') {
        writeRaw(writer, JSON.stringify({ t, d: dir, b: buffer.toString('base64') }) + '\n');
        return;
    }
    if (writer.format === 'csv') {
        const text = buffer.toString('utf8').replace(/"/g, '""');
        writeRaw(writer, `"${formatStamp(t)}","${dir}","${buffer.toString('hex')}","${text}"\n`);
        return;
    }
    let out = '';
    if (writer.lastDir && writer.lastDir !== dir && !writer.lineStart) {
        out += '\n';
        writer.lineStart = true;
    }
    writer.lastDir = dir;
    const text = buffer.toString('utf8');
    for (const ch of text) {
        if (writer.lineStart) {
            out += `[${formatStamp(t)}] ${dir}: `;
            writer.lineStart = false;
        }
        if (ch === '\r') continue;
        out += ch;
        if (ch === '\n') writer.lineStart = true;
    }
    writeRaw(writer, out);
}

function onData(portPath, dir, t, buffer) {
    if (String(portPath).startsWith('replay:')) return;
    if (!isEnabledFor(portPath)) {
        if (writers.has(portPath)) closeWriter(portPath);
        return;
    }
    let writer = writers.get(portPath) || openWriter(portPath);
    writer = maybeRotate(writer);
    writeChunk(writer, dir, t, buffer);
}

function onState(payload) {
    if (payload.state === 'closed' && writers.has(payload.path)) closeWriter(payload.path);
    if (payload.previousPath && writers.has(payload.previousPath)) closeWriter(payload.previousPath);
}

function serializeCapture(header, chunks) {
    const lines = [JSON.stringify({ format: 'dtcap', version: 1, created: new Date().toISOString(), ...header })];
    for (const chunk of chunks) {
        lines.push(JSON.stringify({ t: chunk.t, d: chunk.d, b: Buffer.from(chunk.b).toString('base64'), k: chunk.k || undefined, l: chunk.l || undefined }));
    }
    return lines.join('\n') + '\n';
}

async function readCapture(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const entries = Array.isArray(data.entries) ? data.entries : [];
        let fallbackT = Date.now();
        const chunks = entries.map((e, i) => ({
            t: typeof e.timestamp === 'number' ? e.timestamp : (e.timestampStr ? Date.parse(e.timestampStr) : fallbackT + i),
            d: e.type === 'TX' ? 'TX' : 'RX',
            b: Array.from(Buffer.from(e.content || '', 'utf8'))
        }));
        return { header: { format: 'json-export', port: data.port || '' }, chunks };
    }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header = null;
    const chunks = [];
    for await (const line of rl) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (!header && obj.format) {
            header = obj;
            continue;
        }
        chunks.push({ t: obj.t, d: obj.d, b: Array.from(Buffer.from(obj.b || '', 'base64')), k: obj.k, l: obj.l });
    }
    return { header: header || {}, chunks };
}

function register() {
    bus.on('serial-data', onData);
    bus.on('serial-state', onState);
    bus.on('settings-changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('logging')) {
            for (const portPath of Array.from(writers.keys())) closeWriter(portPath);
        }
    });

    ipcMain.handle('logger:set-port', (event, portPath, enabled) => {
        if (enabled === null || enabled === undefined) portOverrides.delete(portPath);
        else portOverrides.set(portPath, !!enabled);
        if (!isEnabledFor(portPath)) closeWriter(portPath);
        return { success: true, enabled: isEnabledFor(portPath) };
    });
    ipcMain.handle('logger:status', () => Array.from(writers.values()).map(w => ({ path: w.portPath, file: w.file, bytes: w.bytes })));
    ipcMain.handle('logger:folder', () => logFolder());

    ipcMain.handle('capture:save', async (event, header, chunks, defaultName) => {
        const result = await dialog.showSaveDialog({
            defaultPath: defaultName || 'capture.dtcap',
            filters: [{ name: 'DiagTerm Capture', extensions: ['dtcap'] }]
        });
        if (result.canceled || !result.filePath) return { success: false };
        try {
            fs.writeFileSync(result.filePath, serializeCapture(header || {}, chunks || []), 'utf8');
            return { success: true, filePath: result.filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('capture:snapshot', async (event, header, chunks, name) => {
        try {
            const file = path.join(logFolder(), `${String(name || 'snapshot').replace(/[^a-zA-Z0-9_\-]/g, '_')}_${Date.now()}.dtcap`);
            fs.writeFileSync(file, serializeCapture(header || {}, chunks || []), 'utf8');
            return { success: true, filePath: file };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('capture:open', async (event, filePath) => {
        let target = filePath;
        if (!target) {
            const result = await dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [{ name: 'Captures', extensions: ['dtcap', 'json'] }, { name: 'All Files', extensions: ['*'] }]
            });
            if (result.canceled || !result.filePaths.length) return { success: false };
            target = result.filePaths[0];
        }
        try {
            const data = await readCapture(target);
            return { success: true, filePath: target, ...data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

function closeAll() {
    for (const portPath of Array.from(writers.keys())) closeWriter(portPath);
}

module.exports = { register, closeAll };
