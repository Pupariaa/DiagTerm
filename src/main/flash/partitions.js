const crypto = require('crypto');
const { parseNumber } = require('./properties');

const TYPES = { app: 0x00, data: 0x01, bootloader: 0x02, partition_table: 0x03 };
const APP_SUBTYPES = { factory: 0x00, test: 0x20 };
const DATA_SUBTYPES = { ota: 0x00, phy: 0x01, nvs: 0x02, coredump: 0x03, nvs_keys: 0x04, efuse: 0x05, undefined: 0x06, esphttpd: 0x80, fat: 0x81, spiffs: 0x82, littlefs: 0x83 };
const TABLE_OFFSET = 0x8000;
const TABLE_SIZE = 0xC00;

function typeCode(type) {
    const t = String(type).trim().toLowerCase();
    if (t in TYPES) return TYPES[t];
    const n = parseNumber(t);
    if (Number.isNaN(n)) throw new Error(`Unknown partition type: ${type}`);
    return n;
}

function subtypeCode(typeValue, subtype) {
    const s = String(subtype).trim().toLowerCase();
    if (typeValue === TYPES.app) {
        if (s in APP_SUBTYPES) return APP_SUBTYPES[s];
        const ota = s.match(/^ota_(\d+)$/);
        if (ota) return 0x10 + parseInt(ota[1], 10);
    } else if (typeValue === TYPES.data) {
        if (s in DATA_SUBTYPES) return DATA_SUBTYPES[s];
    }
    if (s === '') return 0;
    const n = parseNumber(s);
    if (Number.isNaN(n)) throw new Error(`Unknown partition subtype: ${subtype}`);
    return n;
}

function typeName(code) {
    return Object.keys(TYPES).find(k => TYPES[k] === code) || `0x${code.toString(16)}`;
}

function subtypeName(typeValue, code) {
    if (typeValue === TYPES.app) {
        if (code === 0x00) return 'factory';
        if (code === 0x20) return 'test';
        if (code >= 0x10 && code < 0x20) return `ota_${code - 0x10}`;
    } else if (typeValue === TYPES.data) {
        const name = Object.keys(DATA_SUBTYPES).find(k => DATA_SUBTYPES[k] === code);
        if (name) return name;
    }
    return `0x${code.toString(16)}`;
}

function alignUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

function parseCsv(text, { tableOffset = TABLE_OFFSET } = {}) {
    const rows = [];
    let next = tableOffset + 0x1000;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.trim());
        if (cols.length < 5) continue;
        const [name, type, subtype, offsetStr, sizeStr, flags = ''] = cols;
        const typeValue = typeCode(type);
        const subtypeValue = subtypeCode(typeValue, subtype);
        const align = typeValue === TYPES.app ? 0x10000 : 0x1000;
        let offset = offsetStr ? parseNumber(offsetStr) : alignUp(next, align);
        if (Number.isNaN(offset)) offset = alignUp(next, align);
        const size = parseNumber(sizeStr);
        if (Number.isNaN(size)) throw new Error(`Invalid size for partition ${name}`);
        rows.push({ name, type: typeName(typeValue), subtype: subtypeName(typeValue, subtypeValue), typeValue, subtypeValue, offset, size, flags });
        next = offset + size;
    }
    return rows;
}

function parseBinary(buffer) {
    const rows = [];
    for (let i = 0; i + 32 <= buffer.length; i += 32) {
        const magic = buffer.readUInt16LE(i);
        if (magic === 0xEBEB || magic === 0xFFFF) break;
        if (magic !== 0x50AA) break;
        const typeValue = buffer[i + 2];
        const subtypeValue = buffer[i + 3];
        const offset = buffer.readUInt32LE(i + 4);
        const size = buffer.readUInt32LE(i + 8);
        const name = buffer.subarray(i + 12, i + 28).toString('latin1').replace(/\0.*$/, '');
        const flagValue = buffer.readUInt32LE(i + 28);
        rows.push({ name, type: typeName(typeValue), subtype: subtypeName(typeValue, subtypeValue), typeValue, subtypeValue, offset, size, flags: flagValue & 1 ? 'encrypted' : '' });
    }
    return rows;
}

function normalizeRows(rows) {
    return rows.map(row => {
        const typeValue = typeCode(row.type);
        const subtypeValue = subtypeCode(typeValue, row.subtype);
        const offset = typeof row.offset === 'number' ? row.offset : parseNumber(row.offset);
        const size = typeof row.size === 'number' ? row.size : parseNumber(row.size);
        if (Number.isNaN(offset) || Number.isNaN(size)) throw new Error(`Invalid offset or size for ${row.name}`);
        return { ...row, typeValue, subtypeValue, offset, size, type: typeName(typeValue), subtype: subtypeName(typeValue, subtypeValue) };
    });
}

function toBinary(input) {
    const rows = normalizeRows(input);
    const out = Buffer.alloc(TABLE_SIZE, 0xFF);
    let pos = 0;
    for (const row of rows) {
        const typeValue = row.typeValue;
        const subtypeValue = row.subtypeValue;
        out.writeUInt16LE(0x50AA, pos);
        out[pos + 2] = typeValue;
        out[pos + 3] = subtypeValue;
        out.writeUInt32LE(row.offset >>> 0, pos + 4);
        out.writeUInt32LE(row.size >>> 0, pos + 8);
        const label = Buffer.alloc(16, 0);
        label.write(String(row.name).slice(0, 16), 'latin1');
        label.copy(out, pos + 12);
        out.writeUInt32LE(/encrypted/.test(row.flags || '') ? 1 : 0, pos + 28);
        pos += 32;
    }
    const md5 = crypto.createHash('md5').update(out.subarray(0, pos)).digest();
    out.writeUInt16LE(0xEBEB, pos);
    out.fill(0xFF, pos + 2, pos + 16);
    md5.copy(out, pos + 16);
    return out;
}

function hex(n) {
    return '0x' + n.toString(16);
}

function toCsv(input) {
    const rows = normalizeRows(input);
    const lines = ['# Name,   Type, SubType, Offset,  Size, Flags'];
    for (const row of rows) {
        lines.push(`${row.name},${row.type},${row.subtype},${hex(row.offset)},${hex(row.size)},${row.flags || ''}`);
    }
    return lines.join('\n') + '\n';
}

function validate(input, flashSize) {
    const errors = [];
    let rows;
    try {
        rows = normalizeRows(input);
    } catch (error) {
        return [error.message];
    }
    const sorted = [...rows].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        if (row.typeValue === TYPES.app && row.offset % 0x10000 !== 0) errors.push(`${row.name}: app partitions must be 64K aligned`);
        if (row.offset % 0x1000 !== 0) errors.push(`${row.name}: offset must be 4K aligned`);
        if (i > 0 && sorted[i - 1].offset + sorted[i - 1].size > row.offset) errors.push(`${row.name} overlaps ${sorted[i - 1].name}`);
        if (flashSize && row.offset + row.size > flashSize) errors.push(`${row.name} exceeds flash size`);
        if (row.name.length > 16) errors.push(`${row.name}: name longer than 16 characters`);
    }
    return errors;
}

function findFsPartition(rows, fsType) {
    if (fsType === 'ffat') return rows.find(r => r.type === 'data' && r.subtype === 'fat') || null;
    return rows.find(r => r.type === 'data' && (r.subtype === 'spiffs' || r.subtype === 'littlefs')) || null;
}

module.exports = { parseCsv, parseBinary, toBinary, toCsv, validate, findFsPartition, TABLE_OFFSET, TABLE_SIZE };
