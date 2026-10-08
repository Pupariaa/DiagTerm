export function crc16Modbus(bytes, start = 0, end = bytes.length) {
    let crc = 0xFFFF;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
    return crc & 0xFFFF;
}

export function crc16CcittFalse(bytes, start = 0, end = bytes.length) {
    let crc = 0xFFFF;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

export function crc16Xmodem(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

export function crc16Kermit(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
    return crc & 0xFFFF;
}

export function crc8(bytes, start = 0, end = bytes.length, poly = 0x07, init = 0x00) {
    let crc = init;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc;
}

export function crc8Maxim(bytes, start = 0, end = bytes.length) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= bytes[i];
        for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0x8C : crc >>> 1;
    }
    return crc & 0xFF;
}

let crc32Table = null;

export function crc32(bytes, start = 0, end = bytes.length) {
    if (!crc32Table) {
        crc32Table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crc32Table[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = start; i < end; i++) crc = crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function sum8(bytes, start = 0, end = bytes.length) {
    let s = 0;
    for (let i = start; i < end; i++) s = (s + bytes[i]) & 0xFF;
    return s;
}

export function sum8TwosComplement(bytes, start = 0, end = bytes.length) {
    return (0x100 - sum8(bytes, start, end)) & 0xFF;
}

export function xor8(bytes, start = 0, end = bytes.length) {
    let x = 0;
    for (let i = start; i < end; i++) x ^= bytes[i];
    return x;
}

export const CHECKSUMS = {
    'crc16-modbus': { label: 'CRC-16/MODBUS', size: 2, littleEndian: true, fn: crc16Modbus },
    'crc16-ccitt': { label: 'CRC-16/CCITT-FALSE', size: 2, littleEndian: false, fn: crc16CcittFalse },
    'crc16-xmodem': { label: 'CRC-16/XMODEM', size: 2, littleEndian: false, fn: crc16Xmodem },
    'crc16-kermit': { label: 'CRC-16/KERMIT', size: 2, littleEndian: true, fn: crc16Kermit },
    'crc8': { label: 'CRC-8 (0x07)', size: 1, fn: crc8 },
    'crc8-maxim': { label: 'CRC-8/MAXIM', size: 1, fn: crc8Maxim },
    'crc32': { label: 'CRC-32', size: 4, littleEndian: true, fn: crc32 },
    'sum8': { label: 'Sum (8-bit)', size: 1, fn: sum8 },
    'sum8-neg': { label: 'Sum (two\'s complement)', size: 1, fn: sum8TwosComplement },
    'xor8': { label: 'XOR (8-bit)', size: 1, fn: xor8 }
};

export function checksumBytes(id, bytes, start = 0, end = bytes.length, littleEndianOverride) {
    const def = CHECKSUMS[id];
    if (!def) return [];
    const value = def.fn(bytes, start, end);
    const le = littleEndianOverride === undefined ? def.littleEndian : littleEndianOverride;
    const out = [];
    for (let i = 0; i < def.size; i++) out.push((value >>> (8 * i)) & 0xFF);
    return le ? out : out.reverse();
}
