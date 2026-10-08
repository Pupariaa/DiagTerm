import { el, escapeHtml, clamp } from '../core/dom.js';
import { formatClock, formatDuration, byteHex } from '../core/format.js';
import { getSetting } from '../core/settings.js';
import { onEvent, emit } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { mainNow } from '../serial/clock.js';
import { entryCleanText } from '../serial/entry-text.js';

const AXIS_H = 18;
const MINIMAP_H = 22;
const LABEL_W = 34;
const MIN_SPAN = 0.02;
const MAX_SPAN = 1000 * 60 * 60 * 24;

let syncEnabled = false;

export function setTimelineSync(enabled) {
    syncEnabled = !!enabled;
    emit('timeline:sync-mode', syncEnabled);
}

export function isTimelineSync() {
    return syncEnabled;
}

function niceStep(rawMs) {
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 21600000, 43200000, 86400000];
    for (const s of steps) if (s >= rawMs) return s;
    return steps[steps.length - 1];
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function parityBit(byte, dataBits, parity) {
    let ones = 0;
    for (let i = 0; i < dataBits; i++) if (byte & (1 << i)) ones++;
    switch (parity) {
        case 'even': return ones % 2;
        case 'odd': return (ones + 1) % 2;
        case 'mark': return 1;
        case 'space': return 0;
        default: return null;
    }
}

export class TimelineView {
    constructor(session, host, { onPick, onHeightChange } = {}) {
        this.session = session;
        this.host = host;
        this.onPick = onPick || (() => { });
        this.onHeightChange = onHeightChange || (() => { });
        this.viewSpan = getSetting('timeline.windowMs', 10000);
        this.viewStart = mainNow() - this.viewSpan;
        this.follow = true;
        this.cursors = { a: null, b: null };
        this.hoverX = null;
        this.highlightSeq = null;
        this.dirty = true;
        this.disposed = false;
        this.drag = null;
        this.build();
        this.loop = this.loop.bind(this);
        this.raf = requestAnimationFrame(this.loop);
        this.subscriptions = [
            session.on('data', () => { this.dirty = true; }),
            session.on('clear', () => {
                this.cursors = { a: null, b: null };
                this.dirty = true;
            }),
            session.on('state', () => {
                this.dirty = true;
                this.updateToolbar();
            }),
            onEvent('settings:changed', () => { this.dirty = true; }),
            onEvent('timeline:sync', (payload) => {
                if (!syncEnabled || payload.source === this || this.disposed) return;
                this.viewStart = payload.start;
                this.viewSpan = payload.span;
                this.follow = payload.follow;
                this.updateToolbar();
                this.dirty = true;
            }),
            onEvent('timeline:sync-mode', () => this.updateToolbar()),
            onEvent('theme:changed', () => { this.dirty = true; })
        ];
    }

    build() {
        this.root = el(`
            <div class="tl">
                <div class="tl-resize" title="${escapeHtml(t('Drag to resize'))}"></div>
                <div class="tl-toolbar">
                    <div class="seg" data-role="mode">
                        <button data-mode="auto">${escapeHtml(t('Auto'))}</button>
                        <button data-mode="activity">${escapeHtml(t('Frames'))}</button>
                        <button data-mode="logic">${escapeHtml(t('Logic'))}</button>
                    </div>
                    <button class="tb-btn" data-act="follow" title="${escapeHtml(t('Follow live data'))}">${escapeHtml(t('Live'))}</button>
                    <button class="tb-btn" data-act="fit" title="${escapeHtml(t('Fit whole capture'))}">${escapeHtml(t('Fit'))}</button>
                    <button class="tb-btn" data-act="zoom-in" title="${escapeHtml(t('Zoom in'))}">+</button>
                    <button class="tb-btn" data-act="zoom-out" title="${escapeHtml(t('Zoom out'))}">-</button>
                    <button class="tb-btn" data-act="zoom-sel" title="${escapeHtml(t('Zoom to selected frame'))}">${escapeHtml(t('Frame'))}</button>
                    <span class="tl-sep"></span>
                    <button class="tb-btn" data-act="cursor-a" title="${escapeHtml(t('Place cursor A (Shift+click)'))}">A</button>
                    <button class="tb-btn" data-act="cursor-b" title="${escapeHtml(t('Place cursor B (Alt+click)'))}">B</button>
                    <button class="tb-btn" data-act="cursor-clear" title="${escapeHtml(t('Clear cursors'))}">${escapeHtml(t('Clear'))}</button>
                    <span class="tl-readout"></span>
                    <span class="tl-spacer"></span>
                    <span class="tl-span"></span>
                    <button class="tb-btn" data-act="sync" title="${escapeHtml(t('Synchronize timelines across split panes'))}">${escapeHtml(t('Sync'))}</button>
                    <button class="tb-btn" data-act="png" title="${escapeHtml(t('Export timeline as PNG'))}">PNG</button>
                    <span class="tl-info" title="${escapeHtml(t('Timing is reconstructed from host timestamps: each USB chunk is spread at line rate (baud, data bits, parity, stop bits). Gaps inside a chunk are not observable, inter-chunk gaps are accurate to the USB latency (typically 1-16 ms).'))}">i</span>
                </div>
                <div class="tl-canvas-wrap">
                    <canvas class="tl-canvas"></canvas>
                    <div class="tl-tooltip hidden"></div>
                </div>
            </div>`);
        this.canvas = this.root.querySelector('.tl-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.tooltip = this.root.querySelector('.tl-tooltip');
        this.readout = this.root.querySelector('.tl-readout');
        this.spanLabel = this.root.querySelector('.tl-span');
        this.wrap = this.root.querySelector('.tl-canvas-wrap');
        this.host.appendChild(this.root);
        this.root.style.height = `${this.session.timeline.height}px`;

        this.root.querySelector('[data-role="mode"]').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mode]');
            if (!btn) return;
            this.session.timeline.mode = btn.dataset.mode;
            this.updateToolbar();
            this.dirty = true;
        });
        this.root.querySelector('.tl-toolbar').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            this.action(btn.dataset.act);
        });
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onHover(e));
        this.canvas.addEventListener('mouseleave', () => {
            this.hoverX = null;
            this.tooltip.classList.add('hidden');
            this.dirty = true;
        });
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const tt = this.timeAt(this.localX(e));
            if (tt === null) return;
            this.cursors.b = tt;
            this.updateReadout();
            this.dirty = true;
        });
        this.onWindowMove = (e) => this.onDragMove(e);
        this.onWindowUp = (e) => this.onDragEnd(e);
        window.addEventListener('mousemove', this.onWindowMove);
        window.addEventListener('mouseup', this.onWindowUp);

        const resize = this.root.querySelector('.tl-resize');
        resize.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.drag = { type: 'resize', startY: e.clientY, startH: this.root.offsetHeight };
        });
        this.resizeObserver = new ResizeObserver(() => {
            this.resizeCanvas();
            this.dirty = true;
        });
        this.resizeObserver.observe(this.wrap);
        this.updateToolbar();
    }

    resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.wrap.clientWidth;
        const h = this.wrap.clientHeight;
        if (w === 0 || h === 0) return;
        this.width = w;
        this.height = h;
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    updateToolbar() {
        const mode = this.session.timeline.mode;
        for (const btn of this.root.querySelectorAll('[data-mode]')) btn.classList.toggle('active', btn.dataset.mode === mode);
        this.root.querySelector('[data-act="follow"]').classList.toggle('active', this.follow);
        this.root.querySelector('[data-act="sync"]').classList.toggle('active', syncEnabled);
        this.updateReadout();
    }

    updateReadout() {
        const { a, b } = this.cursors;
        let text = '';
        if (a !== null) text += `A ${this.formatTime(a)}`;
        if (b !== null) text += `${text ? '  ' : ''}B ${this.formatTime(b)}`;
        if (a !== null && b !== null) {
            const d = Math.abs(b - a);
            const counts = this.session.capture.bytesBetween(Math.min(a, b), Math.max(a, b));
            const freq = d > 0 ? 1000 / d : 0;
            text += `  \u0394 ${formatDuration(d)}  ${freq >= 1000 ? (freq / 1000).toFixed(2) + ' kHz' : freq.toFixed(2) + ' Hz'}  RX ${counts.RX}B  TX ${counts.TX}B`;
        }
        this.readout.textContent = text;
    }

    formatTime(tt) {
        if (this.session.view.timestampMode === 'chrono' && this.session.stopwatch.startT !== null) {
            return formatDuration(tt - this.session.stopwatch.startT, { signed: true });
        }
        return formatClock(tt, 'HH:mm:ss.SSS');
    }

    action(act) {
        const capture = this.session.capture;
        switch (act) {
            case 'follow':
                this.follow = !this.follow;
                break;
            case 'fit': {
                if (capture.firstT === null) return;
                const end = this.liveEnd();
                const span = Math.max(MIN_SPAN, end - capture.firstT);
                this.viewStart = capture.firstT - span * 0.02;
                this.viewSpan = span * 1.04;
                this.follow = false;
                break;
            }
            case 'zoom-in':
                this.zoomAround(this.viewStart + this.viewSpan / 2, 0.5);
                break;
            case 'zoom-out':
                this.zoomAround(this.viewStart + this.viewSpan / 2, 2);
                break;
            case 'zoom-sel': {
                const seq = this.highlightSeq;
                if (seq === null) return;
                const idx = capture.indexOfSeq(seq);
                if (idx < 0) return;
                const entry = capture.entries[idx];
                const span = Math.max(MIN_SPAN * 10, (entry.tEnd - entry.t) * 1.3 + capture.bt * 4);
                this.viewStart = (entry.t + entry.tEnd) / 2 - span / 2;
                this.viewSpan = span;
                this.follow = false;
                break;
            }
            case 'cursor-a':
                this.cursors.a = this.viewStart + this.viewSpan * 0.4;
                break;
            case 'cursor-b':
                this.cursors.b = this.viewStart + this.viewSpan * 0.6;
                break;
            case 'cursor-clear':
                this.cursors = { a: null, b: null };
                break;
            case 'sync':
                setTimelineSync(!syncEnabled);
                this.broadcast();
                break;
            case 'png':
                this.exportPng();
                return;
            default:
                return;
        }
        this.updateToolbar();
        this.broadcast();
        this.dirty = true;
    }

    async exportPng() {
        this.render();
        const dataUrl = this.canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const { invoke } = await import('../core/api.js');
        await invoke('files:save-binary', bytes, 'png', `timeline_${Date.now()}.png`);
    }

    broadcast() {
        if (!syncEnabled) return;
        emit('timeline:sync', { source: this, start: this.viewStart, span: this.viewSpan, follow: this.follow });
    }

    liveEnd() {
        const capture = this.session.capture;
        if (this.session.isOpen || this.session.replay?.playing) return mainNow();
        return capture.lastT !== null ? capture.lastT : mainNow();
    }

    laneGeometry() {
        const top = AXIS_H;
        const bottom = this.height - MINIMAP_H - 2;
        const laneH = Math.max(18, (bottom - top) / 2);
        return {
            left: LABEL_W,
            right: this.width - 4,
            rx: { top, bottom: top + laneH },
            tx: { top: top + laneH, bottom: top + laneH * 2 },
            minimap: { top: this.height - MINIMAP_H, bottom: this.height }
        };
    }

    localX(e) {
        const rect = this.canvas.getBoundingClientRect();
        return e.clientX - rect.left;
    }

    localY(e) {
        const rect = this.canvas.getBoundingClientRect();
        return e.clientY - rect.top;
    }

    timeAt(x) {
        const g = this.laneGeometry();
        if (x < g.left) return null;
        return this.viewStart + ((x - g.left) / (g.right - g.left)) * this.viewSpan;
    }

    xAt(tt) {
        const g = this.laneGeometry();
        return g.left + ((tt - this.viewStart) / this.viewSpan) * (g.right - g.left);
    }

    zoomAround(tt, factor) {
        const span = clamp(this.viewSpan * factor, MIN_SPAN, MAX_SPAN);
        const ratio = (tt - this.viewStart) / this.viewSpan;
        this.viewStart = tt - ratio * span;
        this.viewSpan = span;
        if (factor < 1) this.follow = false;
        this.updateToolbar();
        this.broadcast();
        this.dirty = true;
    }

    onWheel(e) {
        e.preventDefault();
        const x = this.localX(e);
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            const delta = (e.shiftKey ? e.deltaY : e.deltaX) / (this.width || 1) * this.viewSpan;
            this.viewStart += delta;
            this.follow = false;
            this.updateToolbar();
            this.broadcast();
            this.dirty = true;
            return;
        }
        const tt = this.timeAt(Math.max(LABEL_W, x));
        const factor = Math.pow(1.0015, e.deltaY);
        if (this.follow && factor < 1) {
            const end = this.liveEnd();
            const span = clamp(this.viewSpan * factor, MIN_SPAN, MAX_SPAN);
            this.viewSpan = span;
            this.viewStart = end - span;
            this.dirty = true;
            this.broadcast();
            return;
        }
        this.zoomAround(tt, factor);
    }

    hitCursor(x) {
        for (const key of ['a', 'b']) {
            const value = this.cursors[key];
            if (value === null) continue;
            if (Math.abs(this.xAt(value) - x) < 5) return key;
        }
        return null;
    }

    onMouseDown(e) {
        if (e.button !== 0) return;
        const x = this.localX(e);
        const y = this.localY(e);
        const g = this.laneGeometry();
        if (y >= g.minimap.top) {
            this.drag = { type: 'minimap' };
            this.moveFromMinimap(x);
            return;
        }
        const tt = this.timeAt(x);
        if (tt === null) return;
        if (e.shiftKey) {
            this.cursors.a = tt;
            this.drag = { type: 'cursor', key: 'a' };
            this.updateReadout();
            this.dirty = true;
            return;
        }
        if (e.altKey) {
            this.cursors.b = tt;
            this.drag = { type: 'cursor', key: 'b' };
            this.updateReadout();
            this.dirty = true;
            return;
        }
        const cursor = this.hitCursor(x);
        if (cursor) {
            this.drag = { type: 'cursor', key: cursor };
            return;
        }
        this.drag = { type: 'pan', startX: e.clientX, startView: this.viewStart, moved: false, x, y };
    }

    onDragMove(e) {
        if (!this.drag) return;
        if (this.drag.type === 'resize') {
            const h = clamp(this.drag.startH - (e.clientY - this.drag.startY), 90, 900);
            this.root.style.height = `${h}px`;
            this.session.timeline.height = h;
            return;
        }
        if (this.drag.type === 'minimap') {
            this.moveFromMinimap(this.localX(e));
            return;
        }
        if (this.drag.type === 'cursor') {
            const tt = this.timeAt(Math.max(LABEL_W, this.localX(e)));
            this.cursors[this.drag.key] = tt;
            this.updateReadout();
            this.dirty = true;
            return;
        }
        if (this.drag.type === 'pan') {
            const dx = e.clientX - this.drag.startX;
            if (Math.abs(dx) > 3) this.drag.moved = true;
            if (!this.drag.moved) return;
            const g = this.laneGeometry();
            this.viewStart = this.drag.startView - (dx / (g.right - g.left)) * this.viewSpan;
            if (this.follow) {
                this.follow = false;
                this.updateToolbar();
            }
            this.broadcast();
            this.dirty = true;
        }
    }

    onDragEnd() {
        if (!this.drag) return;
        const drag = this.drag;
        this.drag = null;
        if (drag.type === 'resize') {
            this.onHeightChange(this.session.timeline.height);
            return;
        }
        if (drag.type === 'pan' && !drag.moved) this.pickAt(drag.x, drag.y, false);
    }

    onDoubleClick(e) {
        this.pickAt(this.localX(e), this.localY(e), true);
    }

    pickAt(x, y, zoom) {
        const g = this.laneGeometry();
        const tt = this.timeAt(x);
        if (tt === null) return;
        let dir = null;
        if (y >= g.rx.top && y < g.rx.bottom) dir = 'RX';
        else if (y >= g.tx.top && y < g.tx.bottom) dir = 'TX';
        if (!dir) return;
        const tolerance = 4 * this.viewSpan / Math.max(1, g.right - g.left);
        const entry = this.session.capture.entryAtTime(tt, dir);
        if (!entry) return;
        if (tt < entry.t - tolerance || tt > entry.tEnd + tolerance) return;
        this.highlightSeq = entry.seq;
        this.dirty = true;
        if (zoom) {
            const span = Math.max(MIN_SPAN * 10, (entry.tEnd - entry.t) * 1.3 + this.session.capture.bt * 4);
            this.viewStart = (entry.t + entry.tEnd) / 2 - span / 2;
            this.viewSpan = span;
            this.follow = false;
            this.updateToolbar();
            this.broadcast();
        }
        this.onPick(entry);
    }

    moveFromMinimap(x) {
        const range = this.minimapRange();
        if (!range) return;
        const g = this.laneGeometry();
        const ratio = clamp((x - g.left) / (g.right - g.left), 0, 1);
        const center = range.start + ratio * (range.end - range.start);
        this.viewStart = center - this.viewSpan / 2;
        this.follow = false;
        this.updateToolbar();
        this.broadcast();
        this.dirty = true;
    }

    minimapRange() {
        const capture = this.session.capture;
        if (capture.firstT === null) return null;
        const end = Math.max(this.liveEnd(), this.viewStart + this.viewSpan);
        const start = Math.min(capture.firstT, this.viewStart);
        return { start, end: Math.max(end, start + 1) };
    }

    onHover(e) {
        const x = this.localX(e);
        const y = this.localY(e);
        this.hoverX = x;
        this.dirty = true;
        const cursor = this.hitCursor(x);
        this.canvas.style.cursor = cursor ? 'ew-resize' : (this.drag && this.drag.type === 'pan' ? 'grabbing' : 'crosshair');
        const tt = this.timeAt(x);
        const g = this.laneGeometry();
        if (tt === null || y >= g.minimap.top) {
            this.tooltip.classList.add('hidden');
            return;
        }
        const dir = y < g.rx.bottom ? 'RX' : 'TX';
        let html = `<div>${escapeHtml(this.formatTime(tt))}</div>`;
        const byteInfo = this.byteAt(dir, tt);
        if (byteInfo) {
            const b = byteInfo.value;
            const ch = b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.';
            html += `<div class="tt-byte"><b>${dir}</b> 0x${byteHex(b)}  ${b}  '${escapeHtml(ch)}'  ${b.toString(2).padStart(8, '0')}</div>`;
            html += `<div class="dim">${escapeHtml(t('Byte at'))} ${escapeHtml(this.formatTime(byteInfo.t))}</div>`;
        }
        const entry = this.session.capture.entryAtTime(tt, dir);
        if (entry && tt >= entry.t - 1 && tt <= entry.tEnd + 1) {
            html += `<div class="dim">${escapeHtml(t('Frame'))} #${entry.seq} - ${entry.len} B - ${escapeHtml(formatDuration(entry.tEnd - entry.t))}</div>`;
            html += `<div class="tt-text">${escapeHtml(entryCleanText(entry).slice(0, 80))}</div>`;
        }
        if (this.cursors.a !== null) html += `<div class="dim">A\u2192 ${escapeHtml(formatDuration(tt - this.cursors.a, { signed: true }))}</div>`;
        this.tooltip.innerHTML = html;
        this.tooltip.classList.remove('hidden');
        const tw = this.tooltip.offsetWidth;
        this.tooltip.style.left = `${Math.min(this.width - tw - 4, x + 12)}px`;
        this.tooltip.style.top = `${Math.max(2, y - 10)}px`;
    }

    byteAt(dir, tt) {
        const capture = this.session.capture;
        const list = capture.chunks[dir];
        const idx = capture.chunkIndexAfter(dir, tt);
        const chunk = list[idx];
        if (!chunk || chunk.start > tt) return null;
        const k = Math.floor((tt - chunk.start) / chunk.bt);
        if (k < 0 || k >= chunk.bytes.length) return null;
        return { value: chunk.bytes[k], t: chunk.start + k * chunk.bt };
    }

    highlight(entry, { center = false } = {}) {
        this.highlightSeq = entry ? entry.seq : null;
        if (entry && center) {
            const mid = (entry.t + entry.tEnd) / 2;
            if (mid < this.viewStart || mid > this.viewStart + this.viewSpan || this.follow) {
                this.follow = false;
                const span = Math.max(this.viewSpan, (entry.tEnd - entry.t) * 1.5);
                this.viewSpan = Math.min(span, MAX_SPAN);
                this.viewStart = mid - this.viewSpan / 2;
                this.updateToolbar();
                this.broadcast();
            }
        }
        this.dirty = true;
    }

    setCursorAt(key, tt) {
        this.cursors[key] = tt;
        this.updateReadout();
        this.dirty = true;
    }

    loop() {
        if (this.disposed) return;
        this.raf = requestAnimationFrame(this.loop);
        if (!this.root.isConnected || !this.width) {
            if (this.root.isConnected && this.wrap.clientWidth) this.resizeCanvas();
            return;
        }
        const live = this.follow && (this.session.isOpen || this.session.replay?.playing);
        const now = performance.now();
        if (live) {
            if (now - (this.lastLiveFrame || 0) < 33) return;
            this.lastLiveFrame = now;
            this.dirty = true;
        }
        if (!this.dirty) return;
        this.dirty = false;
        this.render();
    }

    effectiveMode(bt, pxPerMs) {
        const mode = this.session.timeline.mode;
        if (mode !== 'auto') return mode;
        const bitPx = (bt / 10) * pxPerMs;
        return bitPx >= 1.2 ? 'logic' : 'activity';
    }

    render() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        if (!w || !h) return;
        const capture = this.session.capture;
        if (this.follow) {
            const end = this.liveEnd();
            this.viewStart = end - this.viewSpan;
        }
        const colors = {
            bg: cssVar('--tl-bg', '#141414'),
            lane: cssVar('--tl-lane', '#1b1b1b'),
            grid: cssVar('--tl-grid', '#2a2a2a'),
            text: cssVar('--text-dim', '#8a8a8a'),
            textStrong: cssVar('--text', '#d4d4d4'),
            rx: getSetting('timeline.rxColor', '#4caf50'),
            tx: getSetting('timeline.txColor', '#f44336'),
            marker: getSetting('timeline.markerColor', '#ffb300'),
            cursor: cssVar('--accent', '#3794ff'),
            sel: cssVar('--tl-sel', '#ffffff')
        };
        const g = this.laneGeometry();
        const laneW = g.right - g.left;
        const pxPerMs = laneW / this.viewSpan;
        const viewEnd = this.viewStart + this.viewSpan;
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = colors.lane;
        ctx.fillRect(g.left, g.rx.top + 1, laneW, g.rx.bottom - g.rx.top - 2);
        ctx.fillRect(g.left, g.tx.top + 1, laneW, g.tx.bottom - g.tx.top - 2);

        this.drawAxis(ctx, g, colors, pxPerMs);

        ctx.font = '600 11px Segoe UI, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = colors.rx;
        ctx.fillText('RX', 8, (g.rx.top + g.rx.bottom) / 2);
        ctx.fillStyle = colors.tx;
        ctx.fillText('TX', 8, (g.tx.top + g.tx.bottom) / 2);

        ctx.save();
        ctx.beginPath();
        ctx.rect(g.left, AXIS_H, laneW, g.tx.bottom - AXIS_H);
        ctx.clip();
        const bt = capture.bt;
        const mode = this.effectiveMode(bt, pxPerMs);
        const bytePx = bt * pxPerMs;
        for (const dir of ['RX', 'TX']) {
            const lane = dir === 'RX' ? g.rx : g.tx;
            const color = dir === 'RX' ? colors.rx : colors.tx;
            if (bytePx < 1.5) this.drawOccupancy(ctx, dir, lane, g, color, pxPerMs);
            else if (mode === 'logic') this.drawLogic(ctx, dir, lane, color, pxPerMs, viewEnd, colors);
            else this.drawFrames(ctx, dir, lane, color, pxPerMs, viewEnd, colors);
        }
        this.drawMarkers(ctx, g, colors, viewEnd);
        this.drawCursors(ctx, g, colors);
        if (this.hoverX !== null && this.hoverX >= g.left) {
            ctx.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(Math.round(this.hoverX) + 0.5, AXIS_H);
            ctx.lineTo(Math.round(this.hoverX) + 0.5, g.tx.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.restore();
        if (getSetting('timeline.showMinimap', true)) this.drawMinimap(ctx, g, colors);
        this.spanLabel.textContent = `${formatDuration(this.viewSpan)} / ${mode === 'logic' && bytePx >= 1.5 ? t('logic') : t('frames')}`;
    }

    drawAxis(ctx, g, colors, pxPerMs) {
        const step = niceStep(80 / pxPerMs);
        const first = Math.ceil(this.viewStart / step) * step;
        ctx.strokeStyle = colors.grid;
        ctx.fillStyle = colors.text;
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1;
        const chrono = this.session.view.timestampMode === 'chrono' && this.session.stopwatch.startT !== null;
        for (let tt = first; tt <= this.viewStart + this.viewSpan; tt += step) {
            const x = Math.round(this.xAt(tt)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, AXIS_H - 4);
            ctx.lineTo(x, g.tx.bottom);
            ctx.stroke();
            let label;
            if (chrono) label = formatDuration(tt - this.session.stopwatch.startT, { signed: true });
            else if (step < 1) label = formatClock(tt, 'ss.SSSuuu');
            else if (step < 1000) label = formatClock(tt, 'mm:ss.SSS');
            else label = formatClock(tt, 'HH:mm:ss');
            ctx.fillText(label, x + 3, AXIS_H / 2);
        }
    }

    drawOccupancy(ctx, dir, lane, g, color, pxPerMs) {
        const capture = this.session.capture;
        const list = capture.chunks[dir];
        if (!list.length) return;
        const msPerPx = 1 / pxPerMs;
        ctx.fillStyle = color;
        const y = lane.top + 5;
        const hh = lane.bottom - lane.top - 10;
        let runStart = -1;
        const cols = Math.ceil(g.right - g.left);
        let idx = capture.chunkIndexAfter(dir, this.viewStart);
        for (let col = 0; col <= cols; col++) {
            const t0 = this.viewStart + col * msPerPx;
            const t1 = t0 + msPerPx;
            while (idx < list.length && list[idx].end < t0) idx++;
            const active = idx < list.length && list[idx].start <= t1;
            if (active && runStart < 0) runStart = col;
            if ((!active || col === cols) && runStart >= 0) {
                ctx.fillRect(g.left + runStart, y, Math.max(1, col - runStart), hh);
                runStart = -1;
            }
        }
        this.drawSelectedOutline(ctx, dir, lane, pxPerMs);
    }

    drawSelectedOutline(ctx, dir, lane, pxPerMs) {
        if (this.highlightSeq === null) return;
        const capture = this.session.capture;
        const idx = capture.indexOfSeq(this.highlightSeq);
        if (idx < 0) return;
        const entry = capture.entries[idx];
        if (entry.dir !== dir) return;
        const x0 = this.xAt(entry.t);
        const x1 = Math.max(x0 + 2, this.xAt(entry.tEnd));
        ctx.strokeStyle = cssVar('--tl-sel', '#ffffff');
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 - 1, lane.top + 2, x1 - x0 + 2, lane.bottom - lane.top - 4);
        ctx.lineWidth = 1;
    }

    drawFrames(ctx, dir, lane, color, pxPerMs, viewEnd, colors) {
        const capture = this.session.capture;
        const entries = capture.entries;
        let i = Math.max(0, capture.entryIndexAtTime(this.viewStart - Math.min(60000, Math.max(2000, this.viewSpan))) - 1);
        const y = lane.top + 5;
        const hh = lane.bottom - lane.top - 10;
        ctx.font = '11px Consolas, monospace';
        ctx.textBaseline = 'middle';
        let drawn = 0;
        for (; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.t > viewEnd + 1000) break;
            if (entry.kind !== 'data' || entry.dir !== dir) continue;
            if (entry.tEnd < this.viewStart) continue;
            const x0 = this.xAt(entry.t);
            const x1 = this.xAt(entry.tEnd);
            const wpx = Math.max(1.5, x1 - x0);
            ctx.fillStyle = color;
            ctx.globalAlpha = entry.open ? 0.55 : 0.85;
            ctx.fillRect(x0, y, wpx, hh);
            ctx.globalAlpha = 1;
            if (entry.color) {
                ctx.fillStyle = entry.color;
                ctx.fillRect(x0, y, wpx, 3);
            }
            if (wpx > 36) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(x0 + 2, y, wpx - 4, hh);
                ctx.clip();
                ctx.fillStyle = '#000';
                ctx.globalAlpha = 0.85;
                ctx.fillText(entryCleanText(entry).slice(0, Math.ceil(wpx / 6)), Math.max(x0 + 3, 36), y + hh / 2);
                ctx.restore();
            }
            if (entry.seq === this.highlightSeq) {
                ctx.strokeStyle = colors.sel;
                ctx.lineWidth = 2;
                ctx.strokeRect(x0 - 1, y - 2, wpx + 2, hh + 4);
                ctx.lineWidth = 1;
            }
            if (++drawn > 20000) break;
        }
    }

    drawLogic(ctx, dir, lane, color, pxPerMs, viewEnd, colors) {
        const capture = this.session.capture;
        const chunks = capture.chunksInRange(dir, this.viewStart - capture.bt * 2, viewEnd + capture.bt * 2);
        const labelH = 12;
        const yHigh = lane.top + labelH + 4;
        const yLow = lane.bottom - 5;
        const g = this.laneGeometry();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(g.left, yHigh);
        let level = 1;
        const labels = [];
        const bitTicks = [];
        let count = 0;
        for (const chunk of chunks) {
            const fmt = chunk.fmt || capture.format;
            const dataBits = parseInt(fmt.dataBits, 10) || 8;
            const parity = fmt.parity || 'none';
            const stopBits = parseFloat(fmt.stopBits) || 1;
            const frameBits = 1 + dataBits + (parity !== 'none' ? 1 : 0) + stopBits;
            const bitT = chunk.bt / frameBits;
            const first = Math.max(0, Math.floor((this.viewStart - chunk.start) / chunk.bt) - 1);
            const last = Math.min(chunk.bytes.length - 1, Math.ceil((viewEnd - chunk.start) / chunk.bt) + 1);
            for (let k = first; k <= last; k++) {
                const byte = chunk.bytes[k];
                const t0 = chunk.start + k * chunk.bt;
                const bits = [0];
                for (let b = 0; b < dataBits; b++) bits.push((byte >> b) & 1);
                const p = parityBit(byte, dataBits, parity);
                if (p !== null) bits.push(p);
                for (let bi = 0; bi < bits.length; bi++) {
                    const x = this.xAt(t0 + bi * bitT);
                    const v = bits[bi];
                    if (v !== level) {
                        ctx.lineTo(x, level ? yHigh : yLow);
                        ctx.lineTo(x, v ? yHigh : yLow);
                        level = v;
                    }
                    if (bitT * pxPerMs > 9) bitTicks.push(x);
                }
                const xStop = this.xAt(t0 + bits.length * bitT);
                if (level !== 1) {
                    ctx.lineTo(xStop, yLow);
                    ctx.lineTo(xStop, yHigh);
                    level = 1;
                }
                const bytePx = chunk.bt * pxPerMs;
                if (bytePx > 20) {
                    labels.push({
                        x: this.xAt(t0 + (bits.length * bitT) / 2),
                        x0: this.xAt(t0),
                        x1: xStop,
                        byte,
                        wide: bytePx > 40,
                        bitPx: bitT * pxPerMs,
                        t0,
                        bitT,
                        bits,
                        dataBits
                    });
                }
                if (++count > 6000) break;
            }
            if (count > 6000) break;
        }
        ctx.lineTo(g.right, level ? yHigh : yLow);
        ctx.stroke();
        ctx.lineWidth = 1;
        if (bitTicks.length) {
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.beginPath();
            for (const x of bitTicks) {
                ctx.moveTo(Math.round(x) + 0.5, yHigh);
                ctx.lineTo(Math.round(x) + 0.5, yLow);
            }
            ctx.stroke();
        }
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const lab of labels) {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(lab.x0, lane.top + 2, lab.x1 - lab.x0 - 1, labelH);
            ctx.fillStyle = colors.textStrong;
            const ch = lab.byte >= 0x20 && lab.byte < 0x7F ? String.fromCharCode(lab.byte) : '';
            ctx.fillText(lab.wide && ch ? `${byteHex(lab.byte)} '${ch}'` : byteHex(lab.byte), lab.x, lane.top + 2 + labelH / 2);
            if (lab.bitPx > 14) {
                ctx.fillStyle = colors.text;
                for (let bi = 0; bi < lab.bits.length; bi++) {
                    const name = bi === 0 ? 'S' : (bi <= lab.dataBits ? String(bi - 1) : 'P');
                    ctx.fillText(name, this.xAt(lab.t0 + (bi + 0.5) * lab.bitT), (yHigh + yLow) / 2);
                }
            }
        }
        ctx.textAlign = 'left';
        this.drawSelectedOutline(ctx, dir, lane, pxPerMs);
    }

    drawMarkers(ctx, g, colors, viewEnd) {
        const capture = this.session.capture;
        const entries = capture.entries;
        let i = Math.max(0, capture.entryIndexAtTime(this.viewStart) - 50);
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textBaseline = 'top';
        let lastLabelX = -Infinity;
        for (; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.t > viewEnd + 100) break;
            if (entry.kind === 'data' || entry.t < this.viewStart) continue;
            const x = Math.round(this.xAt(entry.t)) + 0.5;
            const isMarker = entry.kind === 'marker';
            const color = entry.color || (isMarker ? colors.marker : (entry.level === 'error' ? '#f44336' : entry.level === 'success' ? '#4caf50' : colors.text));
            ctx.strokeStyle = color;
            ctx.setLineDash(isMarker ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, AXIS_H);
            ctx.lineTo(x, g.tx.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            if (x - lastLabelX > 60) {
                const label = (entry.label || '').slice(0, 28);
                const tw = ctx.measureText(label).width + 6;
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(x + 1, AXIS_H + 1, tw, 13);
                ctx.fillStyle = color;
                ctx.fillText(label, x + 4, AXIS_H + 2);
                lastLabelX = x + tw;
            }
        }
        const sw = this.session.stopwatch;
        if (sw.startT !== null) {
            const x0 = this.xAt(sw.startT);
            const x1 = this.xAt(sw.running ? this.liveEnd() : sw.stopT);
            ctx.fillStyle = colors.marker;
            ctx.globalAlpha = 0.08;
            ctx.fillRect(x0, AXIS_H, x1 - x0, g.tx.bottom - AXIS_H);
            ctx.globalAlpha = 1;
        }
    }

    drawCursors(ctx, g, colors) {
        const { a, b } = this.cursors;
        if (a !== null && b !== null) {
            const xa = this.xAt(a);
            const xb = this.xAt(b);
            ctx.fillStyle = colors.cursor;
            ctx.globalAlpha = 0.12;
            ctx.fillRect(Math.min(xa, xb), AXIS_H, Math.abs(xb - xa), g.tx.bottom - AXIS_H);
            ctx.globalAlpha = 1;
        }
        ctx.font = '600 10px Segoe UI, sans-serif';
        ctx.textBaseline = 'bottom';
        for (const [key, value] of [['A', a], ['B', b]]) {
            if (value === null) continue;
            const x = Math.round(this.xAt(value)) + 0.5;
            ctx.strokeStyle = colors.cursor;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, AXIS_H);
            ctx.lineTo(x, g.tx.bottom);
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.fillStyle = colors.cursor;
            ctx.fillRect(x - 6, g.tx.bottom - 13, 12, 13);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText(key, x, g.tx.bottom - 1);
            ctx.textAlign = 'left';
        }
    }

    drawMinimap(ctx, g, colors) {
        const range = this.minimapRange();
        const top = g.minimap.top;
        const hh = MINIMAP_H - 4;
        ctx.fillStyle = colors.lane;
        ctx.fillRect(g.left, top + 2, g.right - g.left, hh);
        if (!range) return;
        const capture = this.session.capture;
        const cols = Math.ceil(g.right - g.left);
        const msPerPx = (range.end - range.start) / cols;
        for (const dir of ['RX', 'TX']) {
            const list = capture.chunks[dir];
            if (!list.length) continue;
            ctx.fillStyle = dir === 'RX' ? colors.rx : colors.tx;
            const y = dir === 'RX' ? top + 3 : top + 2 + hh / 2;
            let idx = 0;
            for (let col = 0; col < cols; col++) {
                const t0 = range.start + col * msPerPx;
                const t1 = t0 + msPerPx;
                while (idx < list.length && list[idx].end < t0) idx++;
                if (idx < list.length && list[idx].start <= t1) ctx.fillRect(g.left + col, y, 1, hh / 2 - 1);
            }
        }
        const x0 = g.left + ((this.viewStart - range.start) / (range.end - range.start)) * (g.right - g.left);
        const x1 = g.left + ((this.viewStart + this.viewSpan - range.start) / (range.end - range.start)) * (g.right - g.left);
        ctx.strokeStyle = colors.textStrong;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x0, top + 1, Math.max(2, x1 - x0), hh + 2);
        ctx.strokeRect(x0 + 0.5, top + 1.5, Math.max(2, x1 - x0), hh + 1);
    }

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        for (const off of this.subscriptions) off();
        this.resizeObserver.disconnect();
        window.removeEventListener('mousemove', this.onWindowMove);
        window.removeEventListener('mouseup', this.onWindowUp);
        this.root.remove();
    }
}
