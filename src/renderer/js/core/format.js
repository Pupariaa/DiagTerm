const decoders = new Map();

export function getDecoder(encoding) {
    const key = encoding || 'utf-8';
    if (!decoders.has(key)) {
        try {
            decoders.set(key, new TextDecoder(key === 'ascii' ? 'windows-1252' : key, { fatal: false }));
        } catch (error) {
            decoders.set(key, new TextDecoder('utf-8'));
        }
    }
    return decoders.get(key);
}

export function decodeBytes(bytes, encoding) {
    if (encoding === 'ascii') {
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0x7F);
        return out;
    }
    return getDecoder(encoding).decode(bytes);
}

export function encodeText(text, encoding) {
    if (encoding === 'latin1' || encoding === 'windows-1252' || encoding === 'ascii') {
        const out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xFF;
        return out;
    }
    return new TextEncoder().encode(text);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase());

export function byteHex(b) {
    return HEX[b];
}

export function toHex(bytes, separator = ' ') {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        if (i > 0) out += separator;
        out += HEX[bytes[i]];
    }
    return out;
}

export function parseHexString(text) {
    const clean = String(text).replace(/0x/gi, ' ').replace(/[,;:\-]/g, ' ').trim();
    if (!clean) return new Uint8Array(0);
    const tokens = clean.split(/\s+/);
    const out = [];
    for (const token of tokens) {
        if (!/^[0-9a-fA-F]+$/.test(token)) throw new Error(`Invalid hex: ${token}`);
        const padded = token.length % 2 ? '0' + token : token;
        for (let i = 0; i < padded.length; i += 2) out.push(parseInt(padded.substr(i, 2), 16));
    }
    return new Uint8Array(out);
}

export function unescapeText(text) {
    return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrt0\\abefv])/g, (m, code) => {
        switch (code[0]) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '0': return '\0';
            case 'a': return '\x07';
            case 'b': return '\b';
            case 'e': return '\x1b';
            case 'f': return '\f';
            case 'v': return '\v';
            case '\\': return '\\';
            case 'x': return String.fromCharCode(parseInt(code.slice(1), 16));
            case 'u': return String.fromCharCode(parseInt(code.slice(1), 16));
            default: return m;
        }
    });
}

export const CONTROL_NAMES = ['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'TAB', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'];

export function lineEndingBytes(kind) {
    switch (kind) {
        case 'NL': return [0x0A];
        case 'CR': return [0x0D];
        case 'CRNL': return [0x0D, 0x0A];
        case 'NLCR': return [0x0A, 0x0D];
        default: return [];
    }
}

function pad(n, len = 2) {
    return String(n).padStart(len, '0');
}

export function formatClock(t, format = 'HH:mm:ss.SSS') {
    const d = new Date(t);
    const micro = Math.floor((t - Math.floor(t)) * 1000);
    return format
        .replace('YYYY', d.getFullYear())
        .replace('MM', pad(d.getMonth() + 1))
        .replace('DD', pad(d.getDate()))
        .replace('HH', pad(d.getHours()))
        .replace('mm', pad(d.getMinutes()))
        .replace('ss', pad(d.getSeconds()))
        .replace('SSS', pad(d.getMilliseconds(), 3))
        .replace('uuu', pad(micro, 3));
}

export function formatDuration(ms, { signed = false, precision = 3 } = {}) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '--';
    const sign = ms < 0 ? '-' : (signed ? '+' : '');
    const abs = Math.abs(ms);
    if (abs < 1) return `${sign}${(abs * 1000).toFixed(0)}us`;
    if (abs < 1000) return `${sign}${abs.toFixed(abs < 10 ? 2 : 1)}ms`;
    if (abs < 60000) return `${sign}${(abs / 1000).toFixed(precision)}s`;
    const minutes = Math.floor(abs / 60000);
    const seconds = (abs % 60000) / 1000;
    if (minutes < 60) return `${sign}${minutes}:${seconds.toFixed(precision).padStart(precision + 3, '0')}`;
    const hours = Math.floor(minutes / 60);
    return `${sign}${hours}:${pad(minutes % 60)}:${seconds.toFixed(precision).padStart(precision + 3, '0')}`;
}

export function formatStopwatch(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--.---';
    const sign = ms < 0 ? '-' : '';
    const abs = Math.abs(ms);
    const minutes = Math.floor(abs / 60000);
    const seconds = Math.floor((abs % 60000) / 1000);
    const millis = Math.floor(abs % 1000);
    const hours = Math.floor(minutes / 60);
    const core = `${pad(minutes % 60)}:${pad(seconds)}.${pad(millis, 3)}`;
    return sign + (hours > 0 ? `${hours}:${core}` : core);
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRate(bytesPerSecond) {
    return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

export function hexOffset(n) {
    return '0x' + Number(n).toString(16).toUpperCase();
}

export function parseNumberInput(value) {
    const str = String(value).trim();
    if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16);
    const m = str.match(/^(\d+(?:\.\d+)?)\s*([KkMm])?[Bb]?$/);
    if (m) {
        const base = parseFloat(m[1]);
        if (!m[2]) return Math.round(base);
        return Math.round(base * (m[2].toUpperCase() === 'K' ? 1024 : 1048576));
    }
    return NaN;
}

export function concatBytes(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
