import { encodeText, parseHexString, unescapeText, lineEndingBytes, formatClock, concatBytes } from '../core/format.js';
import { CHECKSUMS, checksumBytes } from '../lib/checksums.js';

const counters = new Map();

function expandVariables(text, ctx) {
    return text.replace(/\{(counter|time|date|ts|rand|hexrand|port|baud)(?::([^}:]*))?(?::([^}]*))?\}/g, (m, name, a, b) => {
        switch (name) {
            case 'counter': {
                const key = ctx.counterKey || 'global';
                const step = a ? parseInt(a, 10) || 1 : 1;
                const value = counters.has(key) ? counters.get(key) : (b ? parseInt(b, 10) || 0 : 0);
                counters.set(key, value + step);
                return String(value);
            }
            case 'time': return formatClock(Date.now(), a || 'HH:mm:ss');
            case 'date': return formatClock(Date.now(), a || 'YYYY-MM-DD');
            case 'ts': return String(Date.now());
            case 'rand': {
                const min = a !== undefined ? parseInt(a, 10) : 0;
                const max = b !== undefined ? parseInt(b, 10) : 100;
                return String(Math.floor(min + Math.random() * (max - min + 1)));
            }
            case 'hexrand': {
                const n = Math.max(1, parseInt(a, 10) || 1);
                let out = '';
                for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
                return out;
            }
            case 'port': return ctx.port || '';
            case 'baud': return String(ctx.baud || '');
            default: return m;
        }
    });
}

export function resetCounter(key) {
    counters.delete(key || 'global');
}

const CHECKSUM_TOKEN = /\{(crc16modbus|crc16ccitt|crc16xmodem|crc16kermit|crc8|crc8maxim|crc32|sum8|sum8neg|xor8)(?::(\d+))?\}/g;
const TOKEN_TO_ID = {
    crc16modbus: 'crc16-modbus',
    crc16ccitt: 'crc16-ccitt',
    crc16xmodem: 'crc16-xmodem',
    crc16kermit: 'crc16-kermit',
    crc8: 'crc8',
    crc8maxim: 'crc8-maxim',
    crc32: 'crc32',
    sum8: 'sum8',
    sum8neg: 'sum8-neg',
    xor8: 'xor8'
};

function splitChecksumTokens(text) {
    const parts = [];
    let last = 0;
    let m;
    CHECKSUM_TOKEN.lastIndex = 0;
    while ((m = CHECKSUM_TOKEN.exec(text)) !== null) {
        if (m.index > last) parts.push({ text: text.slice(last, m.index) });
        parts.push({ checksum: TOKEN_TO_ID[m[1]], skip: m[2] ? parseInt(m[2], 10) : 0 });
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
}

export function buildPayload(input, { mode = 'text', escapes = true, lineEnding = 'none', encoding = 'utf-8', counterKey, port, baud } = {}) {
    const expanded = expandVariables(String(input), { counterKey, port, baud });
    const parts = splitChecksumTokens(expanded);
    const chunks = [];
    let total = 0;
    for (const part of parts) {
        if (part.checksum) {
            const flat = concatBytes(chunks);
            const def = CHECKSUMS[part.checksum];
            if (!def) continue;
            const bytes = new Uint8Array(checksumBytes(part.checksum, flat, Math.min(part.skip, flat.length), flat.length));
            chunks.push(bytes);
            total += bytes.length;
            continue;
        }
        let bytes;
        if (mode === 'hex') bytes = parseHexString(part.text);
        else bytes = encodeText(escapes ? unescapeText(part.text) : part.text, encoding);
        chunks.push(bytes);
        total += bytes.length;
    }
    if (mode !== 'hex') chunks.push(new Uint8Array(lineEndingBytes(lineEnding)));
    return concatBytes(chunks);
}

export const VARIABLE_HELP = [
    ['{counter}', 'Incrementing counter ({counter:step:start})'],
    ['{time}', 'Current time ({time:HH:mm:ss.SSS})'],
    ['{date}', 'Current date ({date:YYYY-MM-DD})'],
    ['{ts}', 'Epoch milliseconds'],
    ['{rand:min:max}', 'Random integer'],
    ['{hexrand:n}', 'n random bytes as hex'],
    ['{port}', 'Port name'],
    ['{baud}', 'Baud rate'],
    ['{crc16modbus}', 'CRC-16/MODBUS of preceding bytes (LE)'],
    ['{crc16ccitt}', 'CRC-16/CCITT-FALSE of preceding bytes (BE)'],
    ['{crc16xmodem}', 'CRC-16/XMODEM of preceding bytes (BE)'],
    ['{crc8}', 'CRC-8 of preceding bytes'],
    ['{crc32}', 'CRC-32 of preceding bytes (LE)'],
    ['{sum8}', '8-bit sum of preceding bytes'],
    ['{xor8}', 'XOR of preceding bytes'],
    ['{crc16modbus:1}', 'Checksum skipping the first N bytes']
];
