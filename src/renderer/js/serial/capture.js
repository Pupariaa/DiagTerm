import { parseHexString } from '../core/format.js';

function frameBits(format) {
    const dataBits = parseInt(format.dataBits, 10) || 8;
    const parity = format.parity && format.parity !== 'none' ? 1 : 0;
    const stopBits = parseFloat(format.stopBits) || 1;
    return 1 + dataBits + parity + stopBits;
}

export function byteTimeMs(format) {
    const baud = parseInt(format.baudRate, 10) || 115200;
    return (frameBits(format) / baud) * 1000;
}

function makeBuffer(capacity) {
    return new Uint8Array(Math.max(16, capacity));
}

function appendToEntry(entry, bytes, start, end) {
    const needed = entry.len + (end - start);
    if (needed > entry.buf.length) {
        let cap = entry.buf.length * 2;
        while (cap < needed) cap *= 2;
        const next = makeBuffer(cap);
        next.set(entry.buf.subarray(0, entry.len));
        entry.buf = next;
    }
    entry.buf.set(bytes.subarray(start, end), entry.len);
    entry.len = needed;
    entry.version++;
}

export function entryBytes(entry) {
    return entry.buf ? entry.buf.subarray(0, entry.len) : new Uint8Array(0);
}

export class Capture {
    constructor({ framing, format, maxEntries = 200000, maxBytes = 128 * 1024 * 1024 } = {}) {
        this.entries = [];
        this.chunks = { RX: [], TX: [] };
        this.markers = [];
        this.seq = 1;
        this.removed = 0;
        this.bytes = 0;
        this.firstT = null;
        this.lastT = null;
        this.pending = { RX: null, TX: null };
        this.lastEnd = { RX: 0, TX: 0 };
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.version = 0;
        this.setFraming(framing || { mode: 'delimiter', delimiter: '0A' });
        this.setFormat(format || { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 });
    }

    setFraming(framing) {
        this.framing = { ...framing };
        try {
            this.delimiter = parseHexString(framing.delimiter || '0A');
        } catch (error) {
            this.delimiter = new Uint8Array([0x0A]);
        }
        if (this.delimiter.length === 0) this.delimiter = new Uint8Array([0x0A]);
    }

    setFormat(format) {
        this.format = { ...format };
        this.bt = byteTimeMs(this.format);
    }

    newEntry(dir, t, kind = 'data', capacity = 64) {
        const entry = {
            seq: this.seq++,
            dir,
            kind,
            t,
            tEnd: t,
            buf: kind === 'data' ? makeBuffer(capacity) : null,
            len: 0,
            open: kind === 'data',
            version: 0,
            color: null,
            label: null
        };
        this.entries.push(entry);
        return entry;
    }

    closePending(dir) {
        const entry = this.pending[dir];
        if (entry) {
            entry.open = false;
            entry.version++;
            this.pending[dir] = null;
        }
        return entry;
    }

    addChunk(dir, t, bytes) {
        const n = bytes.length;
        if (n === 0) return { created: [], closed: [], touched: null };
        const bt = this.bt;
        let start;
        if (dir === 'TX') start = Math.max(t, this.lastEnd.TX);
        else start = Math.max(t - n * bt, this.lastEnd.RX);
        const end = start + n * bt;
        this.lastEnd[dir] = end;
        const chunk = { t, start, end, bt, dir, bytes, fmt: this.format };
        this.chunks[dir].push(chunk);
        this.bytes += n * 2;
        if (this.firstT === null || start < this.firstT) this.firstT = start;
        if (this.lastT === null || end > this.lastT) this.lastT = end;
        this.version++;

        const created = [];
        const closed = [];
        const mode = dir === 'TX' && this.framing.txMode !== 'framed' ? 'write' : (this.framing.mode || 'delimiter');
        const maxLength = Math.max(16, parseInt(this.framing.maxLength, 10) || 4096);

        if (mode === 'write' || mode === 'chunk') {
            const prev = this.closePending(dir);
            if (prev) closed.push(prev);
            const entry = this.newEntry(dir, start, 'data', n);
            appendToEntry(entry, bytes, 0, n);
            entry.tEnd = end;
            entry.open = false;
            created.push(entry);
            closed.push(entry);
            this.trim();
            return { created, closed, touched: null };
        }

        if (mode === 'timeout') {
            const gap = Math.max(1, parseFloat(this.framing.timeoutMs) || 50);
            const pend = this.pending[dir];
            if (pend && start - pend.tEnd > gap) closed.push(this.closePending(dir));
        }

        let touched = this.pending[dir];
        let i = 0;
        while (i < n) {
            let entry = this.pending[dir];
            if (!entry) {
                entry = this.newEntry(dir, start + i * bt, 'data');
                this.pending[dir] = entry;
                created.push(entry);
            }
            let cut = n;
            let closeAfter = false;
            if (mode === 'delimiter') {
                const idx = this.findDelimiter(entry, bytes, i);
                if (idx >= 0) {
                    cut = idx;
                    closeAfter = true;
                }
            } else if (mode === 'fixed') {
                const size = Math.max(1, parseInt(this.framing.length, 10) || 16);
                const remaining = size - entry.len;
                if (n - i >= remaining) {
                    cut = i + remaining;
                    closeAfter = true;
                }
            }
            if (entry.len + (cut - i) >= maxLength) {
                cut = i + Math.max(1, maxLength - entry.len);
                closeAfter = true;
            }
            appendToEntry(entry, bytes, i, cut);
            entry.tEnd = start + cut * bt;
            if (closeAfter) closed.push(this.closePending(dir));
            i = cut;
        }
        if (touched && !created.includes(touched)) touched.version++;
        else touched = null;
        this.trim();
        return { created, closed, touched };
    }

    findDelimiter(entry, bytes, from) {
        const delim = this.delimiter;
        const dl = delim.length;
        const last = delim[dl - 1];
        for (let k = from; k < bytes.length; k++) {
            if (bytes[k] !== last) continue;
            if (dl === 1) return k + 1;
            let ok = true;
            for (let d = 0; d < dl - 1; d++) {
                const pos = k - (dl - 1) + d;
                const value = pos >= from ? bytes[pos] : this.tailByte(entry, pos - from);
                if (value !== delim[d]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return k + 1;
        }
        return -1;
    }

    tailByte(entry, negativeOffset) {
        const idx = entry.len + negativeOffset;
        return idx >= 0 ? entry.buf[idx] : -1;
    }

    flushIdle(now) {
        const out = [];
        const flushMs = parseFloat(this.framing.flushMs) || 0;
        const timeoutMode = this.framing.mode === 'timeout';
        const limit = timeoutMode ? Math.max(1, parseFloat(this.framing.timeoutMs) || 50) : flushMs;
        if (!limit) return out;
        for (const dir of ['RX', 'TX']) {
            const entry = this.pending[dir];
            if (entry && now - entry.tEnd > limit) out.push(this.closePending(dir));
        }
        return out;
    }

    addMarker(label, t, { kind = 'marker', level = 'info', color = null } = {}) {
        const entry = this.newEntry('SYS', t, kind);
        entry.label = label;
        entry.level = level;
        entry.color = color;
        entry.open = false;
        if (kind === 'marker') this.markers.push(entry);
        this.version++;
        this.trim();
        return entry;
    }

    clear() {
        this.entries = [];
        this.chunks = { RX: [], TX: [] };
        this.markers = [];
        this.pending = { RX: null, TX: null };
        this.lastEnd = { RX: 0, TX: 0 };
        this.bytes = 0;
        this.firstT = null;
        this.lastT = null;
        this.removed = 0;
        this.version++;
    }

    trim() {
        const maxEntries = this.maxEntries;
        if (this.entries.length > maxEntries * 1.1) {
            const drop = this.entries.length - maxEntries;
            const removed = this.entries.splice(0, drop);
            this.removed += drop;
            const minSeq = this.entries.length ? this.entries[0].seq : this.seq;
            if (this.markers.length && this.markers[0].seq < minSeq) this.markers = this.markers.filter(m => m.seq >= minSeq);
            this.trimmed = (this.trimmed || 0) + removed.length;
        }
        if (this.bytes > this.maxBytes) {
            const target = this.maxBytes * 0.8;
            while (this.bytes > target) {
                const rx = this.chunks.RX[0];
                const tx = this.chunks.TX[0];
                if (!rx && !tx) break;
                const dir = !tx || (rx && rx.start <= tx.start) ? 'RX' : 'TX';
                const chunk = this.chunks[dir].shift();
                this.bytes -= chunk.bytes.length * 2;
            }
            const firstRx = this.chunks.RX[0];
            const firstTx = this.chunks.TX[0];
            this.firstT = Math.min(firstRx ? firstRx.start : Infinity, firstTx ? firstTx.start : Infinity);
            if (!Number.isFinite(this.firstT)) this.firstT = null;
        }
    }

    indexOfSeq(seq) {
        const entries = this.entries;
        let lo = 0;
        let hi = entries.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = entries[mid].seq;
            if (v === seq) return mid;
            if (v < seq) lo = mid + 1;
            else hi = mid - 1;
        }
        return -1;
    }

    entryAtTime(t, dir) {
        const entries = this.entries;
        let lo = 0;
        let hi = entries.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (entries[mid].t <= t) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        for (let i = best; i >= 0 && i > best - 200; i--) {
            const e = entries[i];
            if (e.kind !== 'data') continue;
            if (dir && e.dir !== dir) continue;
            if (e.t <= t && e.tEnd >= t - 0.001) return e;
            if (e.tEnd < t - 50) break;
        }
        let nearest = null;
        let nearestDist = Infinity;
        for (let i = Math.max(0, best - 50); i < Math.min(entries.length, best + 50); i++) {
            const e = entries[i];
            if (e.kind !== 'data' || (dir && e.dir !== dir)) continue;
            const dist = Math.min(Math.abs(e.t - t), Math.abs(e.tEnd - t));
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = e;
            }
        }
        return nearest;
    }

    chunkIndexAfter(dir, t) {
        const list = this.chunks[dir];
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].end < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    entryIndexAtTime(t) {
        const entries = this.entries;
        let lo = 0;
        let hi = entries.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (entries[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    chunksInRange(dir, from, to) {
        const list = this.chunks[dir];
        const lo = this.chunkIndexAfter(dir, from);
        const out = [];
        for (let i = lo; i < list.length; i++) {
            const c = list[i];
            if (c.start > to) break;
            out.push(c);
        }
        return out;
    }

    bytesBetween(from, to) {
        const out = { RX: 0, TX: 0 };
        for (const dir of ['RX', 'TX']) {
            for (const chunk of this.chunksInRange(dir, from, to)) {
                const first = Math.max(0, Math.ceil((from - chunk.start) / chunk.bt));
                const last = Math.min(chunk.bytes.length, Math.floor((to - chunk.start) / chunk.bt));
                if (last > first) out[dir] += last - first;
            }
        }
        return out;
    }

    serialize() {
        const all = [...this.chunks.RX, ...this.chunks.TX].sort((a, b) => a.t - b.t);
        const out = all.map(c => ({ t: c.t, d: c.dir, b: Array.from(c.bytes) }));
        for (const marker of this.markers) out.push({ t: marker.t, d: 'SYS', b: [], k: 'marker', l: marker.label });
        out.sort((a, b) => a.t - b.t);
        return out;
    }
}
