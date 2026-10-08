import { crc16Modbus, CHECKSUMS, checksumBytes } from './checksums.js';
import { toHex, parseHexString } from '../core/format.js';

const MODBUS_FUNCTIONS = {
    1: 'Read Coils',
    2: 'Read Discrete Inputs',
    3: 'Read Holding Registers',
    4: 'Read Input Registers',
    5: 'Write Single Coil',
    6: 'Write Single Register',
    7: 'Read Exception Status',
    8: 'Diagnostics',
    11: 'Get Comm Event Counter',
    12: 'Get Comm Event Log',
    15: 'Write Multiple Coils',
    16: 'Write Multiple Registers',
    17: 'Report Server ID',
    20: 'Read File Record',
    21: 'Write File Record',
    22: 'Mask Write Register',
    23: 'Read/Write Multiple Registers',
    24: 'Read FIFO Queue',
    43: 'Encapsulated Interface Transport'
};

const MODBUS_EXCEPTIONS = {
    1: 'Illegal Function',
    2: 'Illegal Data Address',
    3: 'Illegal Data Value',
    4: 'Server Device Failure',
    5: 'Acknowledge',
    6: 'Server Device Busy',
    8: 'Memory Parity Error',
    10: 'Gateway Path Unavailable',
    11: 'Gateway Target Failed to Respond'
};

function u16be(bytes, i) {
    return (bytes[i] << 8) | bytes[i + 1];
}

function hex2(n) {
    return '0x' + n.toString(16).toUpperCase().padStart(2, '0');
}

function hex4(n) {
    return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}

function decodeModbusPdu(pdu, dir) {
    const fields = [];
    const fc = pdu[0];
    if (fc & 0x80) {
        const code = pdu[1];
        fields.push({ name: 'Exception', value: `${code} ${MODBUS_EXCEPTIONS[code] || 'Unknown'}`, ok: false });
        return { fields, summary: `Exception ${MODBUS_FUNCTIONS[fc & 0x7F] || hex2(fc & 0x7F)}: ${MODBUS_EXCEPTIONS[code] || code}` };
    }
    const name = MODBUS_FUNCTIONS[fc] || 'Unknown';
    const data = pdu.subarray(1);
    if (fc >= 1 && fc <= 4) {
        if (data.length === 4) {
            const start = u16be(data, 0);
            const qty = u16be(data, 2);
            fields.push({ name: 'Start address', value: `${start} (${hex4(start)})` });
            fields.push({ name: 'Quantity', value: String(qty) });
            return { fields, summary: `${name} @${start} x${qty}`, kind: 'request' };
        }
        if (data.length >= 1 && data[0] === data.length - 1) {
            const count = data[0];
            fields.push({ name: 'Byte count', value: String(count) });
            if (fc >= 3) {
                const regs = [];
                for (let i = 1; i + 1 < data.length; i += 2) regs.push(u16be(data, i));
                fields.push({ name: 'Registers', value: regs.map((r, idx) => `[${idx}] ${r} (${hex4(r)})`).join('  ') });
                return { fields, summary: `${name} response: ${regs.length} regs = ${regs.slice(0, 8).join(', ')}${regs.length > 8 ? '...' : ''}`, kind: 'response', values: regs };
            }
            const bits = [];
            for (let i = 1; i < data.length; i++) for (let b = 0; b < 8; b++) bits.push((data[i] >> b) & 1);
            fields.push({ name: 'Bits', value: bits.join('') });
            return { fields, summary: `${name} response: ${bits.slice(0, 32).join('')}`, kind: 'response' };
        }
    }
    if ((fc === 5 || fc === 6) && data.length === 4) {
        const addr = u16be(data, 0);
        const value = u16be(data, 2);
        fields.push({ name: 'Address', value: `${addr} (${hex4(addr)})` });
        fields.push({ name: 'Value', value: fc === 5 ? (value === 0xFF00 ? 'ON' : value === 0 ? 'OFF' : hex4(value)) : `${value} (${hex4(value)})` });
        return { fields, summary: `${name} @${addr} = ${fc === 5 ? (value === 0xFF00 ? 'ON' : 'OFF') : value}` };
    }
    if ((fc === 15 || fc === 16) && data.length >= 4) {
        const addr = u16be(data, 0);
        const qty = u16be(data, 2);
        fields.push({ name: 'Start address', value: `${addr} (${hex4(addr)})` });
        fields.push({ name: 'Quantity', value: String(qty) });
        if (data.length > 5) {
            fields.push({ name: 'Byte count', value: String(data[4]) });
            if (fc === 16) {
                const regs = [];
                for (let i = 5; i + 1 < data.length; i += 2) regs.push(u16be(data, i));
                fields.push({ name: 'Values', value: regs.join(', ') });
            } else {
                fields.push({ name: 'Data', value: toHex(data.subarray(5)) });
            }
            return { fields, summary: `${name} @${addr} x${qty}`, kind: 'request' };
        }
        return { fields, summary: `${name} ack @${addr} x${qty}`, kind: 'response' };
    }
    fields.push({ name: 'Data', value: toHex(data) });
    return { fields, summary: `${name} (${hex2(fc)}) ${data.length} B` };
}

function decodeModbusRtu(bytes, ctx = {}) {
    if (bytes.length < 4) return { ok: false, error: 'Too short for Modbus RTU' };
    const crcCalc = crc16Modbus(bytes, 0, bytes.length - 2);
    const crcFrame = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
    const crcOk = crcCalc === crcFrame;
    const addr = bytes[0];
    const pdu = bytes.subarray(1, bytes.length - 2);
    const result = decodeModbusPdu(pdu, ctx.dir);
    const fields = [
        { name: 'Slave address', value: `${addr} (${hex2(addr)})` },
        { name: 'Function', value: `${pdu[0]} ${MODBUS_FUNCTIONS[pdu[0] & 0x7F] || 'Unknown'}` },
        ...result.fields,
        { name: 'CRC', value: `${hex4(crcFrame)} ${crcOk ? 'OK' : `expected ${hex4(crcCalc)}`}`, ok: crcOk }
    ];
    return { ok: crcOk, summary: `#${addr} ${result.summary}${crcOk ? '' : ' [CRC ERROR]'}`, fields, values: result.values, error: crcOk ? null : 'CRC mismatch' };
}

function lrc(bytes) {
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xFF;
    return ((~sum + 1) & 0xFF);
}

function decodeModbusAscii(bytes) {
    const text = new TextDecoder('latin1').decode(bytes).trim();
    if (!text.startsWith(':')) return { ok: false, error: 'Modbus ASCII frames start with ":"' };
    const hex = text.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length < 6) return { ok: false, error: 'Invalid Modbus ASCII payload' };
    const raw = parseHexString(hex);
    const body = raw.subarray(0, raw.length - 1);
    const expected = lrc(body);
    const ok = expected === raw[raw.length - 1];
    const result = decodeModbusPdu(body.subarray(1));
    return {
        ok,
        summary: `#${body[0]} ${result.summary}${ok ? '' : ' [LRC ERROR]'}`,
        fields: [
            { name: 'Slave address', value: String(body[0]) },
            ...result.fields,
            { name: 'LRC', value: `${hex2(raw[raw.length - 1])} ${ok ? 'OK' : `expected ${hex2(expected)}`}`, ok }
        ]
    };
}

const NMEA_FIELDS = {
    GGA: ['Time', 'Latitude', 'N/S', 'Longitude', 'E/W', 'Fix quality', 'Satellites', 'HDOP', 'Altitude', 'Unit', 'Geoid sep.', 'Unit', 'DGPS age', 'DGPS station'],
    RMC: ['Time', 'Status', 'Latitude', 'N/S', 'Longitude', 'E/W', 'Speed (kn)', 'Course', 'Date', 'Mag. var.', 'E/W', 'Mode'],
    GSA: ['Mode', 'Fix type', 'SV1', 'SV2', 'SV3', 'SV4', 'SV5', 'SV6', 'SV7', 'SV8', 'SV9', 'SV10', 'SV11', 'SV12', 'PDOP', 'HDOP', 'VDOP'],
    GSV: ['Messages', 'Message #', 'Satellites in view'],
    VTG: ['Course (T)', 'T', 'Course (M)', 'M', 'Speed (kn)', 'N', 'Speed (km/h)', 'K', 'Mode'],
    GLL: ['Latitude', 'N/S', 'Longitude', 'E/W', 'Time', 'Status', 'Mode'],
    ZDA: ['Time', 'Day', 'Month', 'Year', 'Zone h', 'Zone m']
};

function nmeaCoord(value, hemi) {
    if (!value) return '';
    const dot = value.indexOf('.');
    const degLen = dot - 2;
    const deg = parseInt(value.slice(0, degLen), 10);
    const min = parseFloat(value.slice(degLen));
    let dec = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') dec = -dec;
    return dec.toFixed(6);
}

function decodeNmea(bytes) {
    const text = new TextDecoder('latin1').decode(bytes).trim();
    if (!text.startsWith('$') && !text.startsWith('!')) return { ok: false, error: 'NMEA sentences start with $ or !' };
    const star = text.lastIndexOf('*');
    const body = star > 0 ? text.slice(1, star) : text.slice(1);
    let ok = true;
    let checksumField = null;
    if (star > 0) {
        let x = 0;
        for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
        const given = parseInt(text.slice(star + 1, star + 3), 16);
        ok = x === given;
        checksumField = { name: 'Checksum', value: `${hex2(given)} ${ok ? 'OK' : `expected ${hex2(x)}`}`, ok };
    }
    const parts = body.split(',');
    const talkerType = parts[0];
    const type = talkerType.slice(-3);
    const names = NMEA_FIELDS[type] || [];
    const fields = [{ name: 'Sentence', value: talkerType }];
    parts.slice(1).forEach((value, i) => fields.push({ name: names[i] || `Field ${i + 1}`, value }));
    if (type === 'GGA' && parts.length > 5) {
        fields.push({ name: 'Position', value: `${nmeaCoord(parts[2], parts[3])}, ${nmeaCoord(parts[4], parts[5])}` });
    } else if (type === 'RMC' && parts.length > 6) {
        fields.push({ name: 'Position', value: `${nmeaCoord(parts[3], parts[4])}, ${nmeaCoord(parts[5], parts[6])}` });
    }
    if (checksumField) fields.push(checksumField);
    return { ok, summary: `${talkerType} ${parts.slice(1, 5).join(',')}${ok ? '' : ' [CHECKSUM ERROR]'}`, fields };
}

export function slipDecode(bytes) {
    const out = [];
    let esc = false;
    for (const b of bytes) {
        if (b === 0xC0) continue;
        if (esc) {
            out.push(b === 0xDC ? 0xC0 : b === 0xDD ? 0xDB : b);
            esc = false;
        } else if (b === 0xDB) {
            esc = true;
        } else {
            out.push(b);
        }
    }
    return new Uint8Array(out);
}

export function slipEncode(bytes) {
    const out = [0xC0];
    for (const b of bytes) {
        if (b === 0xC0) out.push(0xDB, 0xDC);
        else if (b === 0xDB) out.push(0xDB, 0xDD);
        else out.push(b);
    }
    out.push(0xC0);
    return new Uint8Array(out);
}

export function cobsDecode(bytes) {
    const out = [];
    let i = 0;
    let end = bytes.length;
    if (end && bytes[end - 1] === 0) end--;
    while (i < end) {
        const code = bytes[i++];
        if (code === 0) throw new Error('Unexpected zero in COBS data');
        for (let k = 1; k < code; k++) {
            if (i >= end) throw new Error('Truncated COBS block');
            out.push(bytes[i++]);
        }
        if (code < 0xFF && i < end) out.push(0);
    }
    return new Uint8Array(out);
}

export function cobsEncode(bytes) {
    const out = [0];
    let codeIdx = 0;
    let code = 1;
    for (const b of bytes) {
        if (b === 0) {
            out[codeIdx] = code;
            codeIdx = out.length;
            out.push(0);
            code = 1;
        } else {
            out.push(b);
            code++;
            if (code === 0xFF) {
                out[codeIdx] = code;
                codeIdx = out.length;
                out.push(0);
                code = 1;
            }
        }
    }
    out[codeIdx] = code;
    out.push(0);
    return new Uint8Array(out);
}

function decodeSlip(bytes) {
    const payload = slipDecode(bytes);
    return { ok: true, summary: `SLIP ${payload.length} B: ${toHex(payload.subarray(0, 24))}${payload.length > 24 ? '...' : ''}`, fields: [{ name: 'Payload length', value: String(payload.length) }, { name: 'Payload', value: toHex(payload) }], payload };
}

function decodeCobs(bytes) {
    try {
        const payload = cobsDecode(bytes);
        return { ok: true, summary: `COBS ${payload.length} B: ${toHex(payload.subarray(0, 24))}${payload.length > 24 ? '...' : ''}`, fields: [{ name: 'Payload length', value: String(payload.length) }, { name: 'Payload', value: toHex(payload) }], payload };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

export function identifyChecksum(bytes) {
    const matches = [];
    for (const [id, def] of Object.entries(CHECKSUMS)) {
        if (bytes.length <= def.size) continue;
        for (let skip = 0; skip <= Math.min(3, bytes.length - def.size - 1); skip++) {
            const payloadEnd = bytes.length - def.size;
            for (const le of def.size > 1 ? [true, false] : [true]) {
                const expected = checksumBytes(id, bytes, skip, payloadEnd, le);
                let ok = true;
                for (let k = 0; k < def.size; k++) {
                    if (bytes[payloadEnd + k] !== expected[k]) {
                        ok = false;
                        break;
                    }
                }
                if (ok) matches.push({ id, label: def.label, skip, littleEndian: le, size: def.size });
            }
        }
    }
    return matches;
}

function decodeChecksum(bytes) {
    const matches = identifyChecksum(bytes);
    if (!matches.length) return { ok: false, summary: 'No known checksum matches the trailing bytes', fields: [{ name: 'Result', value: 'No match', ok: false }] };
    return {
        ok: true,
        summary: matches.map(m => `${m.label}${m.skip ? ` skip ${m.skip}` : ''}${m.size > 1 ? (m.littleEndian ? ' LE' : ' BE') : ''}`).join(' | '),
        fields: matches.map(m => ({ name: m.label, value: `bytes ${m.skip}..${bytes.length - m.size - 1}, ${m.size} B ${m.size > 1 ? (m.littleEndian ? 'little-endian' : 'big-endian') : ''}`, ok: true }))
    };
}

function decodeJson(bytes) {
    const text = new TextDecoder('utf-8').decode(bytes).trim();
    const start = text.search(/[[{]/);
    if (start < 0) return { ok: false, error: 'No JSON object found' };
    try {
        const obj = JSON.parse(text.slice(start));
        const fields = [];
        const walk = (value, prefix) => {
            if (value && typeof value === 'object' && fields.length < 200) {
                for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
            } else {
                fields.push({ name: prefix || 'value', value: String(value) });
            }
        };
        walk(obj, '');
        return { ok: true, summary: JSON.stringify(obj).slice(0, 160), fields, json: obj };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function decodeAt(bytes) {
    const text = new TextDecoder('latin1').decode(bytes).trim();
    if (/^AT/i.test(text)) {
        const m = text.match(/^AT([+&]?[A-Z0-9#%$]*)(\?|=\?|=(.*))?$/i);
        const fields = [{ name: 'Command', value: m ? `AT${m[1]}` : text }];
        if (m && m[2] === '?') fields.push({ name: 'Type', value: 'Read' });
        else if (m && m[2] === '=?') fields.push({ name: 'Type', value: 'Test' });
        else if (m && m[3] !== undefined) {
            fields.push({ name: 'Type', value: 'Set' });
            m[3].split(',').forEach((v, i) => fields.push({ name: `Param ${i + 1}`, value: v }));
        } else fields.push({ name: 'Type', value: 'Execute' });
        return { ok: true, summary: text, fields };
    }
    if (/^(OK|ERROR|\+CME ERROR|\+CMS ERROR|NO CARRIER|CONNECT|RING|BUSY)/i.test(text)) {
        return { ok: !/ERROR/i.test(text), summary: text, fields: [{ name: 'Result code', value: text, ok: !/ERROR/i.test(text) }] };
    }
    const urc = text.match(/^\+([A-Z0-9]+):\s*(.*)$/i);
    if (urc) {
        const fields = [{ name: 'Response', value: `+${urc[1]}` }];
        urc[2].split(',').forEach((v, i) => fields.push({ name: `Value ${i + 1}`, value: v.trim() }));
        return { ok: true, summary: text, fields };
    }
    return { ok: false, error: 'Not an AT command or response' };
}

const TYPE_SIZES = { u8: 1, i8: 1, u16le: 2, u16be: 2, i16le: 2, i16be: 2, u32le: 4, u32be: 4, i32le: 4, i32be: 4, f32le: 4, f32be: 4, f64le: 8, f64be: 8 };

export const FIELD_TYPES = [...Object.keys(TYPE_SIZES), 'hex', 'ascii', 'bits'];

function readField(bytes, offset, type, length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
        case 'u8': return view.getUint8(offset);
        case 'i8': return view.getInt8(offset);
        case 'u16le': return view.getUint16(offset, true);
        case 'u16be': return view.getUint16(offset, false);
        case 'i16le': return view.getInt16(offset, true);
        case 'i16be': return view.getInt16(offset, false);
        case 'u32le': return view.getUint32(offset, true);
        case 'u32be': return view.getUint32(offset, false);
        case 'i32le': return view.getInt32(offset, true);
        case 'i32be': return view.getInt32(offset, false);
        case 'f32le': return view.getFloat32(offset, true);
        case 'f32be': return view.getFloat32(offset, false);
        case 'f64le': return view.getFloat64(offset, true);
        case 'f64be': return view.getFloat64(offset, false);
        case 'ascii': return new TextDecoder('latin1').decode(bytes.subarray(offset, offset + length));
        case 'bits': return Array.from(bytes.subarray(offset, offset + length)).map(b => b.toString(2).padStart(8, '0')).join(' ');
        default: return toHex(bytes.subarray(offset, offset + length));
    }
}

export function fieldSize(field) {
    return TYPE_SIZES[field.type] || Math.max(1, parseInt(field.length, 10) || 1);
}

export function decodeCustom(bytes, def) {
    let data = bytes;
    const fields = [];
    if (def.sync) {
        let sync;
        try {
            sync = parseHexString(def.sync);
        } catch (error) {
            return { ok: false, error: 'Invalid sync pattern' };
        }
        let found = -1;
        for (let i = 0; i + sync.length <= data.length; i++) {
            let ok = true;
            for (let k = 0; k < sync.length; k++) if (data[i + k] !== sync[k]) {
                ok = false;
                break;
            }
            if (ok) {
                found = i;
                break;
            }
        }
        if (found < 0) return { ok: false, error: 'Sync pattern not found' };
        data = data.subarray(found);
    }
    let ok = true;
    if (def.lengthField && def.lengthField.type) {
        const lf = def.lengthField;
        const size = TYPE_SIZES[lf.type] || 1;
        if (data.length >= lf.offset + size) {
            const declared = Number(readField(data, lf.offset, lf.type)) + (parseInt(lf.adjust, 10) || 0);
            const lenOk = declared === data.length;
            fields.push({ name: 'Length', value: `${declared}${lenOk ? '' : ` (frame is ${data.length})`}`, ok: lenOk });
            if (!lenOk) ok = false;
        }
    }
    const values = {};
    for (const field of def.fields || []) {
        const size = fieldSize(field);
        const offset = parseInt(field.offset, 10) || 0;
        const realOffset = offset < 0 ? data.length + offset : offset;
        if (realOffset < 0 || realOffset + size > data.length) {
            fields.push({ name: field.name, value: 'out of range', ok: false });
            continue;
        }
        let value = readField(data, realOffset, field.type, size);
        if (typeof value === 'number') {
            if (field.mask) value &= parseInt(field.mask, 16);
            if (field.shift) value >>= parseInt(field.shift, 10);
            if (field.scale && Number(field.scale) !== 1) value = value * Number(field.scale);
            if (field.offsetValue) value += Number(field.offsetValue);
            values[field.name] = value;
            const display = Number.isInteger(value) ? String(value) : value.toFixed(field.decimals !== undefined ? field.decimals : 3);
            fields.push({ name: field.name, value: `${display}${field.unit ? ' ' + field.unit : ''}` });
        } else {
            fields.push({ name: field.name, value: String(value) });
        }
    }
    if (def.checksum && def.checksum.type && CHECKSUMS[def.checksum.type]) {
        const cs = CHECKSUMS[def.checksum.type];
        const from = parseInt(def.checksum.from, 10) || 0;
        const position = data.length - cs.size;
        const le = def.checksum.endian ? def.checksum.endian === 'le' : cs.littleEndian;
        const expected = checksumBytes(def.checksum.type, data, from, position, le);
        let csOk = position > from;
        for (let k = 0; k < cs.size && csOk; k++) if (data[position + k] !== expected[k]) csOk = false;
        fields.push({ name: cs.label, value: `${toHex(data.subarray(position))} ${csOk ? 'OK' : `expected ${toHex(new Uint8Array(expected))}`}`, ok: csOk });
        if (!csOk) ok = false;
    }
    const summaryFields = fields.filter(f => !['Length'].includes(f.name)).slice(0, 6).map(f => `${f.name}=${f.value}`).join(' ');
    return { ok, summary: `${def.name || 'Custom'}: ${summaryFields}`, fields, values };
}

export const BUILTIN_DECODERS = [
    { id: 'modbus-rtu', label: 'Modbus RTU', decode: decodeModbusRtu, binary: true },
    { id: 'modbus-ascii', label: 'Modbus ASCII', decode: decodeModbusAscii },
    { id: 'nmea', label: 'NMEA 0183', decode: decodeNmea },
    { id: 'at', label: 'AT commands', decode: decodeAt },
    { id: 'json', label: 'JSON', decode: decodeJson },
    { id: 'slip', label: 'SLIP', decode: decodeSlip, binary: true },
    { id: 'cobs', label: 'COBS', decode: decodeCobs, binary: true },
    { id: 'checksum', label: 'Checksum finder', decode: decodeChecksum, binary: true }
];

export function allDecoders(customDefs = []) {
    return [
        ...BUILTIN_DECODERS,
        ...customDefs.map(def => ({ id: `custom:${def.id}`, label: def.name || 'Custom', decode: (bytes) => decodeCustom(bytes, def), custom: def }))
    ];
}

export function runDecoder(id, bytes, customDefs = [], ctx = {}) {
    const decoder = allDecoders(customDefs).find(d => d.id === id);
    if (!decoder) return { ok: false, error: 'Unknown decoder' };
    try {
        return decoder.decode(bytes, ctx);
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

export function autoDecode(bytes, customDefs = []) {
    const results = [];
    for (const decoder of allDecoders(customDefs)) {
        if (decoder.id === 'checksum') continue;
        try {
            const r = decoder.decode(bytes, {});
            if (r && r.ok) results.push({ decoder, result: r });
        } catch (error) {
            continue;
        }
    }
    return results;
}
