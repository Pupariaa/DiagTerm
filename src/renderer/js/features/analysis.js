import { openModal } from '../core/dialogs.js';
import { escapeHtml } from '../core/dom.js';
import { formatClock, formatDuration, byteHex, toHex, CONTROL_NAMES } from '../core/format.js';
import { getStore } from '../core/store.js';
import { t } from '../core/i18n.js';
import { entryBytes } from '../serial/capture.js';
import { entryText } from '../serial/entry-text.js';
import { autoDecode, identifyChecksum } from '../lib/decoders.js';

function statsOf(bytes) {
    const s = { length: bytes.length, printable: 0, control: 0, whitespace: 0, digits: 0, letters: 0, symbols: 0, high: 0, unique: 0, entropy: 0 };
    const counts = new Array(256).fill(0);
    for (const b of bytes) {
        counts[b]++;
        if (b === 9 || b === 10 || b === 13 || b === 32) s.whitespace++;
        else if (b >= 33 && b <= 126) {
            s.printable++;
            if (b >= 48 && b <= 57) s.digits++;
            else if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) s.letters++;
            else s.symbols++;
        } else if (b >= 128) s.high++;
        else s.control++;
    }
    for (const c of counts) {
        if (!c) continue;
        s.unique++;
        const p = c / bytes.length;
        s.entropy -= p * Math.log2(p);
    }
    return s;
}

function patternsOf(bytes, text) {
    const out = [];
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) out.push(t('UTF-8 BOM'));
    if (/^AT/i.test(text)) out.push(t('AT command'));
    if (/^[0-9A-Fa-f\s]+$/.test(text.trim()) && text.trim().length > 1) out.push(t('Hexadecimal string'));
    if (/^\s*[{[]/.test(text) && /[}\]]\s*$/.test(text)) out.push(t('JSON-like'));
    if (/^\s*</.test(text) && />\s*$/.test(text)) out.push(t('XML/HTML-like'));
    if (/^\$[A-Z]{5},/.test(text)) out.push(t('NMEA sentence'));
    if (/^:[0-9A-F]+\r?\n?$/i.test(text)) out.push(t('Intel HEX / Modbus ASCII record'));
    if (bytes[0] === 0xC0 && bytes[bytes.length - 1] === 0xC0) out.push(t('SLIP framed'));
    if (bytes[bytes.length - 1] === 0x00 && bytes.length > 2) out.push(t('Zero-terminated (COBS / C string)'));
    if (/\x1b\[[0-9;]*[A-Za-z]/.test(text)) out.push(t('ANSI escape sequences'));
    if (/(-?\d+(\.\d+)?)([,;\s]+-?\d+(\.\d+)?)+/.test(text)) out.push(t('Numeric series (plottable)'));
    if (/[A-Za-z_]\w*\s*[:=]\s*-?\d/.test(text)) out.push(t('key:value pairs (plottable)'));
    return out;
}

function inspector(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const avail = bytes.length - offset;
    const rows = [];
    const add = (name, size, fn) => rows.push([name, avail >= size ? fn() : '-']);
    add('uint8', 1, () => view.getUint8(offset));
    add('int8', 1, () => view.getInt8(offset));
    add('uint16 LE', 2, () => view.getUint16(offset, true));
    add('uint16 BE', 2, () => view.getUint16(offset, false));
    add('int16 LE', 2, () => view.getInt16(offset, true));
    add('int16 BE', 2, () => view.getInt16(offset, false));
    add('uint32 LE', 4, () => view.getUint32(offset, true));
    add('uint32 BE', 4, () => view.getUint32(offset, false));
    add('int32 LE', 4, () => view.getInt32(offset, true));
    add('int32 BE', 4, () => view.getInt32(offset, false));
    add('float32 LE', 4, () => view.getFloat32(offset, true).toPrecision(7));
    add('float32 BE', 4, () => view.getFloat32(offset, false).toPrecision(7));
    add('float64 LE', 8, () => view.getFloat64(offset, true).toPrecision(15));
    add('float64 BE', 8, () => view.getFloat64(offset, false).toPrecision(15));
    add('binary', 1, () => view.getUint8(offset).toString(2).padStart(8, '0'));
    add('char', 1, () => {
        const b = view.getUint8(offset);
        return b < 32 ? CONTROL_NAMES[b] : b === 127 ? 'DEL' : String.fromCharCode(b);
    });
    return rows;
}

function neighbors(session, entry) {
    const entries = session.capture.entries;
    const idx = session.capture.indexOfSeq(entry.seq);
    let prev = null;
    let prevOther = null;
    let next = null;
    for (let i = idx - 1; i >= 0 && i > idx - 500; i--) {
        const e = entries[i];
        if (e.kind !== 'data') continue;
        if (!prev) prev = e;
        if (e.dir !== entry.dir) {
            prevOther = e;
            break;
        }
    }
    for (let i = idx + 1; i < entries.length && i < idx + 500; i++) {
        if (entries[i].kind === 'data') {
            next = entries[i];
            break;
        }
    }
    return { prev, prevOther, next };
}

export function openAnalysis(session, entry) {
    const bytes = entryBytes(entry).slice();
    const text = entryText(entry);
    const st = statsOf(bytes);
    const patterns = patternsOf(bytes, text);
    const decodes = autoDecode(bytes, getStore('decoders-custom', []) || []);
    let trimmedEnd = bytes.length;
    while (trimmedEnd > 0 && (bytes[trimmedEnd - 1] === 0x0A || bytes[trimmedEnd - 1] === 0x0D)) trimmedEnd--;
    const checksums = identifyChecksum(bytes).concat(trimmedEnd < bytes.length ? identifyChecksum(bytes.subarray(0, trimmedEnd)).map(m => ({ ...m, trimmed: true })) : []);
    const nb = neighbors(session, entry);
    const duration = entry.tEnd - entry.t;
    const pct = (n) => (st.length ? ((n / st.length) * 100).toFixed(1) : '0');

    const hexRows = [];
    for (let off = 0; off < bytes.length; off += 16) {
        let hex = '';
        let asc = '';
        for (let k = 0; k < 16; k++) {
            const i = off + k;
            if (i < bytes.length) {
                hex += `<span class="hb" data-off="${i}">${byteHex(bytes[i])}</span>${k === 7 ? '  ' : ' '}`;
                const b = bytes[i];
                asc += `<span class="ha" data-off="${i}">${b >= 0x20 && b < 0x7F ? escapeHtml(String.fromCharCode(b)) : '.'}</span>`;
            } else hex += k === 7 ? '    ' : '   ';
        }
        hexRows.push(`<div><span class="dim">${off.toString(16).padStart(4, '0').toUpperCase()}</span>  ${hex} ${asc}</div>`);
    }

    const decodeHtml = decodes.length ? decodes.map(({ decoder, result }) => `
        <div class="an-decode">
            <div class="an-decode-head">${escapeHtml(decoder.label)} <span class="dim">${escapeHtml(result.summary || '')}</span></div>
            <table class="kv">${(result.fields || []).map(f => `<tr class="${f.ok === false ? 'bad' : f.ok ? 'ok' : ''}"><th>${escapeHtml(f.name)}</th><td>${escapeHtml(f.value)}</td></tr>`).join('')}</table>
        </div>`).join('') : `<div class="dim">${escapeHtml(t('No protocol recognized. Try the decoder panel or define a custom frame parser.'))}</div>`;

    const modal = openModal({
        title: t('Frame #{n} - {dir} - {len} bytes', { n: entry.seq, dir: entry.dir, len: bytes.length }),
        width: 900,
        className: 'analysis-modal',
        body: `
            <div class="an-grid">
                <section>
                    <h3>${escapeHtml(t('Timing'))}</h3>
                    <table class="kv">
                        <tr><th>${escapeHtml(t('Start'))}</th><td>${formatClock(entry.t, 'YYYY-MM-DD HH:mm:ss.SSSuuu')}</td></tr>
                        <tr><th>${escapeHtml(t('End'))}</th><td>${formatClock(entry.tEnd, 'HH:mm:ss.SSSuuu')}</td></tr>
                        <tr><th>${escapeHtml(t('Duration on the wire'))}</th><td>${formatDuration(duration)} (${session.options.baudRate} baud, ${session.options.dataBits}${(session.options.parity || 'n')[0].toUpperCase()}${session.options.stopBits})</td></tr>
                        ${nb.prev ? `<tr><th>${escapeHtml(t('Since previous frame'))}</th><td>${formatDuration(entry.t - nb.prev.t)} (${escapeHtml(t('gap'))} ${formatDuration(entry.t - nb.prev.tEnd)})</td></tr>` : ''}
                        ${nb.prevOther ? `<tr><th>${escapeHtml(entry.dir === 'RX' ? t('Response time (after TX)') : t('Since last RX'))}</th><td>${formatDuration(entry.t - nb.prevOther.tEnd)}</td></tr>` : ''}
                        ${nb.next ? `<tr><th>${escapeHtml(t('Until next frame'))}</th><td>${formatDuration(nb.next.t - entry.tEnd)}</td></tr>` : ''}
                        ${session.stopwatch.startT !== null ? `<tr><th>${escapeHtml(t('Chronometer'))}</th><td>${formatDuration(entry.t - session.stopwatch.startT, { signed: true })}</td></tr>` : ''}
                    </table>
                    <h3>${escapeHtml(t('Statistics'))}</h3>
                    <table class="kv">
                        <tr><th>${escapeHtml(t('Printable'))}</th><td>${st.printable} (${pct(st.printable)}%)</td></tr>
                        <tr><th>${escapeHtml(t('Letters / digits / symbols'))}</th><td>${st.letters} / ${st.digits} / ${st.symbols}</td></tr>
                        <tr><th>${escapeHtml(t('Whitespace'))}</th><td>${st.whitespace}</td></tr>
                        <tr><th>${escapeHtml(t('Control'))}</th><td>${st.control}</td></tr>
                        <tr><th>${escapeHtml(t('Bytes >= 0x80'))}</th><td>${st.high}</td></tr>
                        <tr><th>${escapeHtml(t('Distinct bytes'))}</th><td>${st.unique}</td></tr>
                        <tr><th>${escapeHtml(t('Entropy'))}</th><td>${st.entropy.toFixed(3)} ${escapeHtml(t('bits/byte'))}</td></tr>
                    </table>
                    <h3>${escapeHtml(t('Detected patterns'))}</h3>
                    ${patterns.length ? `<ul class="an-list">${patterns.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : `<div class="dim">${escapeHtml(t('None'))}</div>`}
                    <h3>${escapeHtml(t('Checksum candidates'))}</h3>
                    ${checksums.length ? `<ul class="an-list">${checksums.map(m => `<li>${escapeHtml(m.label)}${m.skip ? ` (${escapeHtml(t('skip {n}', { n: m.skip }))})` : ''}${m.size > 1 ? (m.littleEndian ? ' LE' : ' BE') : ''}${m.trimmed ? ` - ${escapeHtml(t('before line ending'))}` : ''}</li>`).join('')}</ul>` : `<div class="dim">${escapeHtml(t('No known checksum matches the trailing bytes'))}</div>`}
                </section>
                <section>
                    <h3>${escapeHtml(t('Hex dump'))} <span class="dim">${escapeHtml(t('(click a byte to inspect)'))}</span></h3>
                    <div class="hexdump">${hexRows.join('')}</div>
                    <h3>${escapeHtml(t('Value inspector'))} <span class="dim an-offset">@0</span></h3>
                    <table class="kv an-inspector"></table>
                    <h3>${escapeHtml(t('Text'))}</h3>
                    <pre class="an-text">${escapeHtml(text)}</pre>
                </section>
            </div>
            <h3>${escapeHtml(t('Protocol decoding'))}</h3>
            ${decodeHtml}`,
        buttons: [
            { label: t('Copy hex'), left: true, keepOpen: true, action: () => navigator.clipboard.writeText(toHex(bytes)) },
            { label: t('Copy as C array'), left: true, keepOpen: true, action: () => navigator.clipboard.writeText(`{ ${Array.from(bytes).map(b => '0x' + byteHex(b)).join(', ')} }`) },
            { label: t('Close'), primary: true }
        ]
    });

    const inspectorEl = modal.body.querySelector('.an-inspector');
    const offsetEl = modal.body.querySelector('.an-offset');
    const showInspector = (offset) => {
        offsetEl.textContent = `@${offset} (0x${offset.toString(16).toUpperCase()})`;
        inspectorEl.innerHTML = inspector(bytes, offset).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('');
        for (const node of modal.body.querySelectorAll('.hexdump .sel')) node.classList.remove('sel');
        for (const node of modal.body.querySelectorAll(`.hexdump [data-off="${offset}"]`)) node.classList.add('sel');
    };
    modal.body.querySelector('.hexdump').addEventListener('click', (e) => {
        const node = e.target.closest('[data-off]');
        if (node) showInspector(parseInt(node.dataset.off, 10));
    });
    if (bytes.length) showInspector(0);
}
