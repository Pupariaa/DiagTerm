import { escapeHtml, el, rafThrottle } from '../core/dom.js';
import { CONTROL_NAMES, formatClock, formatDuration, byteHex, toHex } from '../core/format.js';
import { getSetting } from '../core/settings.js';
import { onEvent } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { entryBytes } from '../serial/capture.js';
import { entryText, entryHex } from '../serial/entry-text.js';
import { highlightRanges } from '../features/highlight.js';

const OVERSCAN = 12;
let highlightGen = 0;
onEvent('highlights:changed', () => { highlightGen++; });

function escapeChar(ch) {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return ch;
}

function tokenizeAscii(text, showControl) {
    const lines = [[]];
    const n = text.length;
    for (let i = 0; i < n; i++) {
        const ch = text[i];
        const code = text.charCodeAt(i);
        const line = lines[lines.length - 1];
        if (code === 0x0A) {
            if (showControl) line.push({ h: '<span class="cc cc2">LF</span>', w: 3, i });
            if (i < n - 1) lines.push([]);
            continue;
        }
        if (code === 0x0D) {
            if (showControl) line.push({ h: '<span class="cc cc2">CR</span>', w: 3, i });
            continue;
        }
        if (code === 0x09) {
            if (showControl) line.push({ h: '<span class="cc cc3">TAB</span>', w: 4, i });
            else line.push({ h: '    ', w: 4, i });
            continue;
        }
        if (code < 0x20) {
            const name = CONTROL_NAMES[code];
            line.push({ h: `<span class="cc cc${name.length}">${name}</span>`, w: name.length + 1, i });
            continue;
        }
        if (code === 0x7F) {
            line.push({ h: '<span class="cc cc3">DEL</span>', w: 4, i });
            continue;
        }
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < n) {
            line.push({ h: ch + text[i + 1], w: 2, i });
            i++;
            continue;
        }
        line.push({ h: escapeChar(ch), w: 1, i });
    }
    return lines;
}

function asciiLineWidths(text, showControl) {
    const widths = [0];
    const n = text.length;
    for (let i = 0; i < n; i++) {
        const code = text.charCodeAt(i);
        let w;
        if (code === 0x0A) {
            if (showControl) widths[widths.length - 1] += 3;
            if (i < n - 1) widths.push(0);
            continue;
        }
        if (code === 0x0D) w = showControl ? 3 : 0;
        else if (code === 0x09) w = 4;
        else if (code < 0x20) w = CONTROL_NAMES[code].length + 1;
        else if (code === 0x7F) w = 4;
        else if (code >= 0xD800 && code <= 0xDBFF) {
            w = 2;
            i++;
        } else w = 1;
        widths[widths.length - 1] += w;
    }
    return widths;
}

function wrapTokens(tokens, cols) {
    const out = [];
    let line = [];
    let width = 0;
    for (const tok of tokens) {
        if (width + tok.w > cols && line.length > 0) {
            out.push(line);
            line = [];
            width = 0;
        }
        line.push(tok);
        width += tok.w;
    }
    out.push(line);
    return out;
}

export class TerminalView {
    constructor(session, host, { onSelect, onContextMenu, onFollowChange, onSearchUpdate } = {}) {
        this.session = session;
        this.host = host;
        this.onSelect = onSelect || (() => { });
        this.onContextMenu = onContextMenu || (() => { });
        this.onFollowChange = onFollowChange || (() => { });
        this.onSearchUpdate = onSearchUpdate || (() => { });
        this.list = [];
        this.prefix = [0];
        this.rowH = 19;
        this.charW = 7.7;
        this.cols = 120;
        this.selection = new Set();
        this.anchorSeq = null;
        this.focusSeq = null;
        this.search = { query: '', regex: false, caseSensitive: false, filterOnly: false, re: null, error: null, gen: 0 };
        this.matches = [];
        this.matchSet = new Set();
        this.matchIndex = -1;
        this.unseen = 0;
        this.programmaticScroll = false;
        this.disposed = false;
        this.htmlCache = new Map();
        this.lastRenderKey = '';
        this.build();
        this.scheduleRender = rafThrottle(() => this.render());
        this.measure();
        this.rebuild();
        this.subscriptions = [
            session.on('data', (result) => this.onData(result)),
            session.on('clear', () => this.rebuild()),
            session.on('view', (view, partial) => this.onViewChange(partial)),
            session.on('paused', (paused) => {
                if (!paused) this.rebuild();
            }),
            session.on('stopwatch', () => {
                if (session.view.timestampMode === 'chrono') this.invalidate();
            }),
            onEvent('highlights:changed', () => this.invalidate()),
            onEvent('settings:changed', (keyPath) => {
                if (keyPath === '*' || keyPath.startsWith('terminal.font') || keyPath.startsWith('terminal.lineHeight')) {
                    this.applyFont();
                    this.measure();
                    this.relayout();
                } else if (keyPath.startsWith('terminal.timestampFormat') || keyPath.startsWith('terminal.showDirection') || keyPath.startsWith('serial.encoding')) {
                    this.relayout();
                }
            })
        ];
    }

    build() {
        this.root = el(`
            <div class="term">
                <div class="term-scroller" tabindex="0">
                    <div class="term-spacer"></div>
                    <div class="term-rows"></div>
                </div>
                <button class="term-live hidden" type="button"></button>
                <span class="term-measure">MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM</span>
            </div>`);
        this.scroller = this.root.querySelector('.term-scroller');
        this.spacer = this.root.querySelector('.term-spacer');
        this.rowsEl = this.root.querySelector('.term-rows');
        this.liveBtn = this.root.querySelector('.term-live');
        this.measureEl = this.root.querySelector('.term-measure');
        this.host.appendChild(this.root);
        this.applyFont();

        this.scroller.addEventListener('scroll', () => this.onScroll());
        this.scroller.addEventListener('wheel', (e) => {
            if (e.deltaY < 0 && this.session.view.follow) this.setFollow(false);
        }, { passive: true });
        this.scroller.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.offsetX > this.scroller.clientWidth) this.userDraggingScrollbar = true;
            const row = e.target.closest('.row');
            if (row) this.handleRowClick(row, e);
        });
        window.addEventListener('mouseup', this.onMouseUp = () => { this.userDraggingScrollbar = false; });
        this.scroller.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('.row');
            if (!row) return;
            e.preventDefault();
            const entry = this.entryBySeq(parseInt(row.dataset.seq, 10));
            if (!entry) return;
            if (!this.selection.has(entry.seq)) {
                this.selection.clear();
                this.selection.add(entry.seq);
                this.anchorSeq = entry.seq;
                this.invalidate();
            }
            this.onContextMenu(entry, e, this.getSelectedEntries());
        });
        this.scroller.addEventListener('dblclick', (e) => {
            const row = e.target.closest('.row');
            if (!row) return;
            const entry = this.entryBySeq(parseInt(row.dataset.seq, 10));
            if (entry) this.onSelect(entry, { open: true });
        });
        this.scroller.addEventListener('keydown', (e) => this.onKey(e));
        this.liveBtn.addEventListener('click', () => this.setFollow(true));
        this.resizeObserver = new ResizeObserver(() => {
            const w = this.scroller.clientWidth;
            if (w !== this.lastWidth) {
                this.lastWidth = w;
                this.relayout();
            } else {
                this.scheduleRender();
            }
        });
        this.resizeObserver.observe(this.scroller);
    }

    applyFont() {
        const family = getSetting('terminal.fontFamily', "Consolas, 'Cascadia Mono', 'Courier New', monospace");
        const size = getSetting('terminal.fontSize', 13);
        const lh = getSetting('terminal.lineHeight', 1.45);
        this.root.style.setProperty('--term-font', family);
        this.root.style.setProperty('--term-size', `${size}px`);
        this.rowH = Math.round(size * lh);
        this.root.style.setProperty('--row-h', `${this.rowH}px`);
    }

    measure() {
        const width = this.measureEl.getBoundingClientRect().width;
        if (width > 0) this.charW = width / 100;
        this.root.style.setProperty('--ch', `${this.charW}px`);
    }

    prefixChars() {
        const mode = this.session.view.timestampMode;
        let ts = 0;
        if (mode === 'absolute') ts = getSetting('terminal.timestampFormat', 'HH:mm:ss.SSS').length + 1;
        else if (mode === 'relative' || mode === 'chrono') ts = 13;
        else if (mode === 'delta' || mode === 'gap') ts = 11;
        const dir = getSetting('terminal.showDirection', true) ? 4 : 1;
        return { ts, dir };
    }

    computeCols() {
        const { ts, dir } = this.prefixChars();
        this.root.style.setProperty('--ts-ch', String(ts));
        this.root.style.setProperty('--dir-ch', String(dir));
        const available = this.scroller.clientWidth - 16 - (ts + dir) * this.charW;
        this.cols = Math.max(8, Math.floor(available / this.charW));
    }

    isVisible(entry) {
        const view = this.session.view;
        if (entry.kind === 'data') {
            if (view.dirFilter !== 'all' && entry.dir !== view.dirFilter) return false;
            if (entry.dir === 'TX' && view.showTx === false) return false;
            if (this.search.filterOnly && this.search.re && !this.entryMatches(entry)) return false;
            return true;
        }
        if (this.search.filterOnly && this.search.re) return entry.kind === 'marker';
        return view.dirFilter === 'all';
    }

    layoutKey() {
        const v = this.session.view;
        return `${v.viewMode}|${v.showControl ? 1 : 0}|${getSetting('serial.encoding', 'utf-8')}`;
    }

    entryLayout(entry) {
        const key = this.layoutKey();
        if (entry._lay && entry._layK === key && entry._layV === entry.version) return entry._lay;
        let lay;
        const mode = this.session.view.viewMode;
        if (entry.kind !== 'data') {
            lay = { type: 'label', width: (entry.label || '').length + 4 };
        } else if (mode === 'hex') {
            lay = { type: 'hex', bytes: entry.len };
        } else if (mode === 'mixed') {
            lay = { type: 'mixed', lines: Math.max(1, Math.ceil(entry.len / 16)) };
        } else {
            lay = { type: 'ascii', widths: asciiLineWidths(entryText(entry), this.session.view.showControl) };
        }
        entry._lay = lay;
        entry._layK = key;
        entry._layV = entry.version;
        return lay;
    }

    hexBytesPerLine() {
        return Math.max(1, Math.floor((this.cols + 1) / 3));
    }

    rowsFor(entry) {
        const lay = this.entryLayout(entry);
        const wrap = this.session.view.wrap;
        switch (lay.type) {
            case 'label': return 1;
            case 'hex': return wrap ? Math.max(1, Math.ceil(lay.bytes / this.hexBytesPerLine())) : 1;
            case 'mixed': return lay.lines;
            default: {
                if (!wrap) return lay.widths.length;
                let rows = 0;
                for (const w of lay.widths) rows += Math.max(1, Math.ceil(w / this.cols));
                return rows;
            }
        }
    }

    rebuild() {
        const entries = this.session.capture.entries;
        this.list = [];
        for (const entry of entries) {
            if (this.isVisible(entry)) this.list.push(entry);
        }
        this.relayout();
    }

    relayout() {
        this.computeCols();
        this.htmlCache.clear();
        const prefix = new Array(this.list.length + 1);
        prefix[0] = 0;
        for (let i = 0; i < this.list.length; i++) prefix[i + 1] = prefix[i] + this.rowsFor(this.list[i]);
        this.prefix = prefix;
        this.updateSpacer();
        if (this.session.view.follow) this.scrollToBottom();
        this.lastRenderKey = '';
        this.scheduleRender();
    }

    invalidate() {
        this.htmlCache.clear();
        this.lastRenderKey = '';
        this.scheduleRender();
    }

    updateSpacer() {
        const total = this.prefix[this.list.length] || 0;
        this.spacer.style.height = `${total * this.rowH + 8}px`;
    }

    indexOfSeq(seq) {
        const list = this.list;
        let lo = 0;
        let hi = list.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = list[mid].seq;
            if (v === seq) return mid;
            if (v < seq) lo = mid + 1;
            else hi = mid - 1;
        }
        return -1;
    }

    entryBySeq(seq) {
        const idx = this.indexOfSeq(seq);
        return idx >= 0 ? this.list[idx] : null;
    }

    recomputeFrom(index) {
        const prefix = this.prefix;
        prefix.length = this.list.length + 1;
        for (let i = Math.max(0, index); i < this.list.length; i++) prefix[i + 1] = prefix[i] + this.rowsFor(this.list[i]);
    }

    onData(result) {
        if (this.disposed || this.session.paused) return;
        const capture = this.session.capture;
        if (this.list.length && capture.entries.length && this.list[0].seq < capture.entries[0].seq) {
            this.trimFront(capture.entries[0].seq);
        }
        let dirtyFrom = Infinity;
        if (result.touched) {
            const idx = this.indexOfSeq(result.touched.seq);
            if (idx >= 0) {
                dirtyFrom = Math.min(dirtyFrom, idx);
                this.htmlCache.delete(result.touched.seq);
            }
        }
        for (const entry of result.closed) {
            if (!entry) continue;
            if (this.search.re) this.testMatch(entry);
            const idx = this.indexOfSeq(entry.seq);
            if (idx >= 0) {
                dirtyFrom = Math.min(dirtyFrom, idx);
                this.htmlCache.delete(entry.seq);
            } else if (this.search.filterOnly && this.isVisible(entry)) {
                this.insertSorted(entry);
                dirtyFrom = Math.min(dirtyFrom, this.indexOfSeq(entry.seq));
            }
        }
        let appended = 0;
        for (const entry of result.created) {
            if (!this.isVisible(entry)) continue;
            this.list.push(entry);
            appended++;
            dirtyFrom = Math.min(dirtyFrom, this.list.length - 1);
        }
        if (this.search.filterOnly && this.search.re) {
            for (const entry of result.closed) {
                if (!entry) continue;
                const idx = this.indexOfSeq(entry.seq);
                if (idx >= 0 && !this.isVisible(entry)) {
                    this.list.splice(idx, 1);
                    dirtyFrom = Math.min(dirtyFrom, idx);
                }
            }
        }
        if (dirtyFrom !== Infinity) {
            this.recomputeFrom(dirtyFrom);
            this.updateSpacer();
        }
        if (this.session.view.follow) {
            this.scrollToBottom();
        } else if (appended) {
            this.unseen += appended;
            this.updateLiveButton();
        }
        if (dirtyFrom !== Infinity) this.lastRenderKey = '';
        this.scheduleRender();
    }

    insertSorted(entry) {
        let lo = 0;
        let hi = this.list.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.list[mid].seq < entry.seq) lo = mid + 1;
            else hi = mid;
        }
        this.list.splice(lo, 0, entry);
    }

    trimFront(minSeq) {
        let drop = 0;
        while (drop < this.list.length && this.list[drop].seq < minSeq) drop++;
        if (drop === 0) return;
        const removedRows = this.prefix[drop];
        this.list.splice(0, drop);
        this.recomputeFrom(0);
        this.updateSpacer();
        if (!this.session.view.follow) {
            this.programmaticScroll = true;
            this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop - removedRows * this.rowH);
        }
        if (this.matches.length && this.matches[0] < minSeq) {
            this.matches = this.matches.filter(s => s >= minSeq);
            this.matchSet = new Set(this.matches);
            this.matchIndex = Math.min(this.matchIndex, this.matches.length - 1);
            this.emitSearch();
        }
        for (const seq of Array.from(this.selection)) if (seq < minSeq) this.selection.delete(seq);
    }

    onViewChange(partial) {
        if (!partial) return;
        if ('follow' in partial) {
            if (partial.follow) {
                this.unseen = 0;
                this.scrollToBottom();
            }
            this.updateLiveButton();
            this.scheduleRender();
        }
        if ('dirFilter' in partial || 'showTx' in partial) this.rebuild();
        else if ('viewMode' in partial || 'showControl' in partial || 'wrap' in partial || 'timestampMode' in partial) {
            if ('viewMode' in partial && this.search.re) this.runSearch();
            this.relayout();
        }
    }

    setFollow(follow) {
        if (this.session.view.follow === follow) {
            if (follow) this.scrollToBottom();
            return;
        }
        this.session.updateView({ follow });
        this.onFollowChange(follow);
    }

    updateLiveButton() {
        const show = !this.session.view.follow;
        this.liveBtn.classList.toggle('hidden', !show);
        this.liveBtn.textContent = this.unseen > 0 ? t('Jump to live ({n} new)', { n: this.unseen }) : t('Jump to live');
    }

    scrollToBottom() {
        this.programmaticScroll = true;
        this.scroller.scrollTop = this.scroller.scrollHeight;
    }

    onScroll() {
        if (this.programmaticScroll) {
            this.programmaticScroll = false;
            this.scheduleRender();
            return;
        }
        const atBottom = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - this.rowH * 1.5;
        if (this.session.view.follow && !atBottom) this.setFollow(false);
        else if (!this.session.view.follow && atBottom && !this.userDraggingScrollbar && this.scroller.scrollTop > 0) {
            this.unseen = 0;
            this.setFollow(true);
        }
        this.scheduleRender();
    }

    rowIndexAt(row) {
        const prefix = this.prefix;
        let lo = 0;
        let hi = this.list.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (prefix[mid] <= row) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return ans;
    }

    timestampFor(entry, index) {
        const mode = this.session.view.timestampMode;
        if (mode === 'none') return '';
        const tt = entry.t;
        switch (mode) {
            case 'absolute': return formatClock(tt, getSetting('terminal.timestampFormat', 'HH:mm:ss.SSS'));
            case 'relative': {
                const first = this.session.capture.entries[0];
                return first ? formatDuration(tt - first.t, { signed: true }) : '';
            }
            case 'chrono': {
                const sw = this.session.stopwatch;
                if (sw.startT === null) return '';
                return formatDuration(tt - sw.startT, { signed: true });
            }
            case 'delta':
            case 'gap': {
                for (let i = index - 1; i >= 0 && i > index - 64; i--) {
                    const prev = this.list[i];
                    if (prev.kind !== 'data') continue;
                    return formatDuration(mode === 'delta' ? tt - prev.t : tt - prev.tEnd, { signed: true });
                }
                return '';
            }
            default: return '';
        }
    }

    markRanges(entry, subject) {
        const marks = [];
        if (this.search.re && this.matchSet.has(entry.seq)) {
            const re = this.search.re;
            re.lastIndex = 0;
            let m;
            let guard = 0;
            while ((m = re.exec(subject)) !== null && guard++ < 500) {
                if (m[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                marks.push([m.index, m.index + m[0].length]);
            }
        }
        return marks;
    }

    renderTokens(lines, styleAt) {
        let html = '';
        for (let li = 0; li < lines.length; li++) {
            if (li > 0) html += '\n';
            let current = null;
            for (const tok of lines[li]) {
                const style = styleAt(tok.i);
                if (style !== current) {
                    if (current) html += '</span>';
                    if (style) html += `<span ${style}>`;
                    current = style;
                }
                html += tok.h;
            }
            if (current) html += '</span>';
        }
        return html;
    }

    styleResolver(subjectLength, marks, ranges) {
        if (!marks.length && !ranges.length) return () => null;
        const styles = new Array(subjectLength).fill(null);
        for (const r of ranges) {
            const rule = r.rule;
            const css = `style="${rule.color ? `color:${escapeHtml(rule.color)};` : ''}${rule.background ? `background:${escapeHtml(rule.background)};` : ''}${rule.bold ? 'font-weight:600;' : ''}"`;
            for (let i = r.start; i < r.end && i < subjectLength; i++) styles[i] = css;
        }
        for (const [s, e] of marks) for (let i = s; i < e && i < subjectLength; i++) styles[i] = 'class="hit"';
        return (i) => styles[i] || null;
    }

    contentHtml(entry) {
        const cacheKey = entry.seq;
        const key = `${entry.version}|${this.layoutKey()}|${this.cols}|${this.session.view.wrap ? 1 : 0}|${this.search.gen}|${highlightGen}`;
        const cached = this.htmlCache.get(cacheKey);
        if (cached && cached.key === key) return cached;
        let html;
        let lineStyle = null;
        const mode = this.session.view.viewMode;
        if (entry.kind !== 'data') {
            html = escapeHtml(entry.label || '');
        } else if (mode === 'hex') {
            const hex = entryHex(entry);
            const marks = this.markRanges(entry, hex);
            const style = this.styleResolver(hex.length, marks, []);
            const bpl = this.session.view.wrap ? this.hexBytesPerLine() : Infinity;
            const lines = [];
            let line = [];
            for (let i = 0; i < hex.length; i++) {
                const byteIdx = Math.floor(i / 3);
                if (line.length && byteIdx % bpl === 0 && i % 3 === 0) {
                    lines.push(line);
                    line = [];
                }
                if (i % 3 === 2 && (byteIdx + 1) % bpl === 0) continue;
                line.push({ h: hex[i], w: 1, i });
            }
            lines.push(line);
            html = this.renderTokens(lines, style);
        } else if (mode === 'mixed') {
            const bytes = entryBytes(entry);
            const parts = [];
            for (let off = 0; off < Math.max(1, bytes.length); off += 16) {
                const slice = bytes.subarray(off, off + 16);
                let hex = '';
                let asc = '';
                for (let k = 0; k < 16; k++) {
                    if (k < slice.length) {
                        hex += byteHex(slice[k]) + (k === 7 ? '  ' : ' ');
                        const b = slice[k];
                        asc += b >= 0x20 && b < 0x7F ? escapeChar(String.fromCharCode(b)) : '<span class="dim">.</span>';
                    } else {
                        hex += k === 7 ? '    ' : '   ';
                    }
                }
                parts.push(`<span class="dim">${off.toString(16).padStart(4, '0').toUpperCase()}</span>  ${hex} <span class="asc">${asc}</span>`);
            }
            html = parts.join('\n');
        } else {
            const text = entryText(entry);
            const marks = this.markRanges(entry, text);
            const hl = highlightRanges(text);
            lineStyle = hl.line;
            const style = this.styleResolver(text.length, marks, hl.ranges);
            const raw = tokenizeAscii(text, this.session.view.showControl);
            const lines = [];
            for (const line of raw) {
                if (this.session.view.wrap) lines.push(...wrapTokens(line, this.cols));
                else lines.push(line);
            }
            html = this.renderTokens(lines, style);
        }
        const out = { key, html, lineStyle };
        this.htmlCache.set(cacheKey, out);
        if (this.htmlCache.size > 3000) {
            const first = this.htmlCache.keys().next().value;
            this.htmlCache.delete(first);
        }
        return out;
    }

    render() {
        if (this.disposed) return;
        if (!this.root.isConnected || this.scroller.clientHeight === 0) return;
        const top = this.scroller.scrollTop;
        const height = this.scroller.clientHeight;
        const firstRow = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
        const lastRow = Math.ceil((top + height) / this.rowH) + OVERSCAN;
        if (this.list.length === 0) {
            this.rowsEl.innerHTML = `<div class="term-empty">${escapeHtml(this.session.isOpen ? t('Waiting for data...') : t('No data'))}</div>`;
            this.lastRenderKey = '';
            return;
        }
        const i0 = this.rowIndexAt(firstRow);
        const i1 = Math.min(this.list.length - 1, this.rowIndexAt(lastRow));
        const tsMode = this.session.view.timestampMode;
        const renderKey = `${i0}|${i1}|${this.list[i0].seq}|${this.list[i1].seq}|${this.list[i1].version}|${this.selection.size}|${this.focusSeq}|${this.matchIndex}|${tsMode}|${this.cols}`;
        const sw = this.session.stopwatch;
        const fullKey = `${renderKey}|${sw.startT}`;
        if (fullKey === this.lastRenderKey) return;
        this.lastRenderKey = fullKey;
        const showDir = getSetting('terminal.showDirection', true);
        const currentMatch = this.matchIndex >= 0 ? this.matches[this.matchIndex] : null;
        let html = '';
        for (let i = i0; i <= i1; i++) {
            const entry = this.list[i];
            const rows = this.prefix[i + 1] - this.prefix[i];
            const content = this.contentHtml(entry);
            const ts = this.timestampFor(entry, i);
            let cls = 'row';
            let style = `top:${this.prefix[i] * this.rowH}px;height:${rows * this.rowH}px;`;
            if (entry.kind === 'data') {
                cls += entry.dir === 'RX' ? ' rx' : ' tx';
                if (entry.open) cls += ' open';
            } else {
                cls += entry.kind === 'marker' ? ' marker' : ` sys lvl-${entry.level || 'info'}`;
            }
            if (this.selection.has(entry.seq)) cls += ' sel';
            if (entry.seq === this.focusSeq) cls += ' focus';
            if (entry.seq === currentMatch) cls += ' cur';
            if (entry.color && entry.kind === 'data') {
                style += `--row-accent:${escapeHtml(entry.color)};`;
                cls += ' accent';
            } else if (content.lineStyle) {
                if (content.lineStyle.background) style += `background:${escapeHtml(content.lineStyle.background)};`;
                if (content.lineStyle.color) style += `color:${escapeHtml(content.lineStyle.color)};`;
            }
            if (entry.kind === 'marker' && entry.color) style += `--marker-color:${escapeHtml(entry.color)};`;
            const dirLabel = entry.kind === 'data' ? entry.dir : (entry.kind === 'marker' ? '\u25C6' : '--');
            html += `<div class="${cls}" data-seq="${entry.seq}" style="${style}">`;
            if (tsMode !== 'none') html += `<span class="ts">${escapeHtml(ts)}</span>`;
            if (showDir) html += `<span class="dir">${dirLabel}</span>`;
            else html += '<span class="dir-bar"></span>';
            html += `<span class="txt">${content.html}</span></div>`;
        }
        this.rowsEl.innerHTML = html;
    }

    handleRowClick(row, e) {
        const seq = parseInt(row.dataset.seq, 10);
        const entry = this.entryBySeq(seq);
        if (!entry) return;
        if (e.shiftKey && this.anchorSeq !== null) {
            const a = this.indexOfSeq(this.anchorSeq);
            const b = this.indexOfSeq(seq);
            if (a >= 0 && b >= 0) {
                if (!e.ctrlKey) this.selection.clear();
                for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selection.add(this.list[i].seq);
            }
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selection.has(seq)) this.selection.delete(seq);
            else this.selection.add(seq);
            this.anchorSeq = seq;
        } else {
            this.selection.clear();
            this.selection.add(seq);
            this.anchorSeq = seq;
        }
        this.focusSeq = seq;
        this.lastRenderKey = '';
        this.scheduleRender();
        this.onSelect(entry, {});
    }

    onKey(e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && this.root.contains(sel.anchorNode)) return;
            if (this.selection.size) {
                e.preventDefault();
                this.copySelection('text');
            }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            this.selection = new Set(this.list.map(en => en.seq));
            this.lastRenderKey = '';
            this.scheduleRender();
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            this.setFollow(true);
        } else if (e.key === 'Home') {
            e.preventDefault();
            this.setFollow(false);
            this.programmaticScroll = true;
            this.scroller.scrollTop = 0;
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const idx = this.focusSeq !== null ? this.indexOfSeq(this.focusSeq) : this.list.length;
            const next = Math.max(0, Math.min(this.list.length - 1, idx + (e.key === 'ArrowUp' ? -1 : 1)));
            const entry = this.list[next];
            if (entry) {
                this.selection.clear();
                this.selection.add(entry.seq);
                this.anchorSeq = entry.seq;
                this.focusSeq = entry.seq;
                this.scrollToEntry(entry, { center: false });
                this.onSelect(entry, {});
            }
        } else if (e.key === 'PageUp') {
            this.setFollow(false);
        } else if (e.key === 'Escape') {
            this.selection.clear();
            this.focusSeq = null;
            this.lastRenderKey = '';
            this.scheduleRender();
        }
    }

    scrollToEntry(entry, { center = true, select = false } = {}) {
        const idx = this.indexOfSeq(entry.seq);
        if (idx < 0) return false;
        if (this.session.view.follow) this.setFollow(false);
        const y = this.prefix[idx] * this.rowH;
        const h = (this.prefix[idx + 1] - this.prefix[idx]) * this.rowH;
        const top = this.scroller.scrollTop;
        const viewH = this.scroller.clientHeight;
        this.programmaticScroll = true;
        if (center) this.scroller.scrollTop = Math.max(0, y - viewH / 2 + h / 2);
        else if (y < top) this.scroller.scrollTop = y;
        else if (y + h > top + viewH) this.scroller.scrollTop = y + h - viewH;
        else this.programmaticScroll = false;
        if (select) {
            this.selection.clear();
            this.selection.add(entry.seq);
            this.anchorSeq = entry.seq;
            this.focusSeq = entry.seq;
        }
        this.lastRenderKey = '';
        this.scheduleRender();
        return true;
    }

    getSelectedEntries() {
        if (!this.selection.size) return [];
        return this.list.filter(e => this.selection.has(e.seq));
    }

    selectionText(format = 'text', entries = this.getSelectedEntries()) {
        const fmt = getSetting('terminal.timestampFormat', 'HH:mm:ss.SSS');
        return entries.map(entry => {
            if (entry.kind !== 'data') return format === 'text' ? '' : `[${formatClock(entry.t, fmt)}] -- ${entry.label}`;
            const body = format === 'hex' ? toHex(entryBytes(entry)) : entryText(entry).replace(/[\r\n]+$/, '');
            if (format === 'full') return `[${formatClock(entry.t, fmt)}] ${entry.dir}: ${body}`;
            return body;
        }).filter(line => line !== '' || format !== 'text').join('\n');
    }

    copySelection(format = 'text', entries) {
        const text = this.selectionText(format, entries);
        if (text) navigator.clipboard.writeText(text).catch(() => null);
    }

    visibleTimeRange() {
        if (!this.list.length) return null;
        const top = this.scroller.scrollTop;
        const height = this.scroller.clientHeight;
        const i0 = this.rowIndexAt(Math.floor(top / this.rowH));
        const i1 = Math.min(this.list.length - 1, this.rowIndexAt(Math.ceil((top + height) / this.rowH)));
        return { start: this.list[i0].t, end: this.list[i1].tEnd, first: this.list[i0], last: this.list[i1] };
    }

    entryMatches(entry) {
        return this.matchSet.has(entry.seq);
    }

    testMatch(entry) {
        if (!this.search.re || entry.kind !== 'data') return false;
        const subject = this.session.view.viewMode === 'hex' ? entryHex(entry) : entryText(entry);
        this.search.re.lastIndex = 0;
        const ok = this.search.re.test(subject);
        if (ok && !this.matchSet.has(entry.seq)) {
            this.matchSet.add(entry.seq);
            if (!this.matches.length || this.matches[this.matches.length - 1] < entry.seq) this.matches.push(entry.seq);
            else {
                this.matches.push(entry.seq);
                this.matches.sort((a, b) => a - b);
            }
            this.emitSearch();
        }
        return ok;
    }

    setSearch({ query, regex, caseSensitive, filterOnly }) {
        const s = this.search;
        if (query !== undefined) s.query = query;
        if (regex !== undefined) s.regex = regex;
        if (caseSensitive !== undefined) s.caseSensitive = caseSensitive;
        if (filterOnly !== undefined) s.filterOnly = filterOnly;
        this.runSearch();
        this.rebuild();
        if (this.matches.length && this.matchIndex >= 0) this.revealMatch();
    }

    runSearch() {
        const s = this.search;
        s.gen++;
        s.error = null;
        s.re = null;
        this.matches = [];
        this.matchSet = new Set();
        this.matchIndex = -1;
        if (s.query) {
            try {
                let source = s.regex ? s.query : s.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (this.session.view.viewMode === 'hex' && !s.regex) source = source.replace(/\s+/g, ' ').toUpperCase();
                s.re = new RegExp(source, s.caseSensitive ? 'g' : 'gi');
            } catch (error) {
                s.error = error.message;
            }
        }
        if (s.re) {
            const hexMode = this.session.view.viewMode === 'hex';
            for (const entry of this.session.capture.entries) {
                if (entry.kind !== 'data') continue;
                const subject = hexMode ? entryHex(entry) : entryText(entry);
                s.re.lastIndex = 0;
                if (s.re.test(subject)) {
                    this.matches.push(entry.seq);
                    this.matchSet.add(entry.seq);
                }
            }
            if (this.matches.length) this.matchIndex = this.matches.length - 1;
        }
        this.htmlCache.clear();
        this.emitSearch();
    }

    emitSearch() {
        this.onSearchUpdate({
            count: this.matches.length,
            index: this.matchIndex,
            error: this.search.error,
            active: !!this.search.re
        });
    }

    searchStep(delta) {
        if (!this.matches.length) return;
        if (this.matchIndex < 0) this.matchIndex = delta > 0 ? 0 : this.matches.length - 1;
        else this.matchIndex = (this.matchIndex + delta + this.matches.length) % this.matches.length;
        this.revealMatch();
        this.emitSearch();
    }

    revealMatch() {
        const seq = this.matches[this.matchIndex];
        const entry = this.entryBySeq(seq);
        if (entry) {
            this.scrollToEntry(entry, { center: true });
            this.onSelect(entry, { fromSearch: true });
        }
    }

    focus() {
        this.scroller.focus({ preventScroll: true });
    }

    dispose() {
        this.disposed = true;
        for (const off of this.subscriptions) off();
        this.resizeObserver.disconnect();
        window.removeEventListener('mouseup', this.onMouseUp);
        this.root.remove();
    }
}
