import { el, escapeHtml, options } from '../core/dom.js';
import { formatClock } from '../core/format.js';
import { getSetting } from '../core/settings.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { entryCleanText } from '../serial/entry-text.js';
import { entryBytes } from '../serial/capture.js';
import { getStore } from '../core/store.js';
import { runDecoder } from '../lib/decoders.js';

const PALETTE = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292', '#a1887f', '#90a4ae', '#aed581', '#7986cb'];
const NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const PAIR_RE = /([A-Za-z_][\w.\-]*)\s*[:=]\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

export class PlotterPanel {
    constructor(session, host, { onClose } = {}) {
        this.session = session;
        this.host = host;
        this.onClose = onClose || (() => { });
        this.series = new Map();
        this.paused = false;
        this.dirty = true;
        this.disposed = false;
        this.yMode = 'auto';
        this.yMin = 0;
        this.yMax = 100;
        this.hoverX = null;
        this.build();
        this.subscriptions = [
            session.on('frame', (entry) => this.onFrame(entry)),
            session.on('clear', () => this.clear())
        ];
        this.loop = this.loop.bind(this);
        this.raf = requestAnimationFrame(this.loop);
    }

    build() {
        const p = this.session.plotter;
        this.root = el(`
            <div class="side-panel plotter-panel">
                <div class="panel-head">
                    <span class="panel-title">${escapeHtml(t('Plotter'))}</span>
                    <select class="input sm" data-role="source">${options([['RX', 'RX'], ['TX', 'TX'], ['any', t('All')]], p.source)}</select>
                    <select class="input sm" data-role="parser">${options([
                        ['auto', t('Auto (key:value or CSV)')],
                        ['csv', t('Numbers (CSV / spaces)')],
                        ['pairs', t('key:value pairs')],
                        ['regex', t('Regex groups')],
                        ['decoder', t('Decoder values')]
                    ], p.parser)}</select>
                    <input class="input sm" data-role="regex" placeholder="${escapeHtml(t('Regex with groups, e.g. T=(?<temp>[\\d.]+)'))}" value="${escapeHtml(p.regex || '')}">
                    <span class="spacer"></span>
                    <button class="tb-btn" data-act="pause">${escapeHtml(t('Pause'))}</button>
                    <button class="tb-btn" data-act="clear">${escapeHtml(t('Clear'))}</button>
                    <button class="tb-btn" data-act="csv">CSV</button>
                    <button class="tb-btn" data-act="png">PNG</button>
                    <button class="icon-btn" data-act="close" title="${escapeHtml(t('Close'))}">&times;</button>
                </div>
                <div class="plot-options">
                    <label>${escapeHtml(t('Window'))} <input class="input xs" type="number" min="1" data-role="window" value="${getSetting('plotter.windowSeconds', 30)}"> s</label>
                    <select class="input sm" data-role="ymode">${options([['auto', t('Auto scale')], ['fixed', t('Fixed scale')]], this.yMode)}</select>
                    <input class="input xs" type="number" data-role="ymin" value="${this.yMin}" title="Y min">
                    <input class="input xs" type="number" data-role="ymax" value="${this.yMax}" title="Y max">
                    <div class="plot-legend"></div>
                </div>
                <div class="plot-canvas-wrap"><canvas></canvas></div>
            </div>`);
        this.canvas = this.root.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.legend = this.root.querySelector('.plot-legend');
        this.wrap = this.root.querySelector('.plot-canvas-wrap');
        this.host.appendChild(this.root);
        this.syncRegexVisibility();

        this.root.querySelector('[data-role="source"]').addEventListener('change', (e) => { p.source = e.target.value; });
        this.root.querySelector('[data-role="parser"]').addEventListener('change', (e) => {
            p.parser = e.target.value;
            this.syncRegexVisibility();
        });
        this.root.querySelector('[data-role="regex"]').addEventListener('change', (e) => {
            p.regex = e.target.value;
            this.compiledRegex = null;
        });
        this.root.querySelector('[data-role="window"]').addEventListener('change', () => { this.dirty = true; });
        this.root.querySelector('[data-role="ymode"]').addEventListener('change', (e) => {
            this.yMode = e.target.value;
            this.dirty = true;
        });
        this.root.querySelector('[data-role="ymin"]').addEventListener('change', (e) => {
            this.yMin = parseFloat(e.target.value) || 0;
            this.dirty = true;
        });
        this.root.querySelector('[data-role="ymax"]').addEventListener('change', (e) => {
            this.yMax = parseFloat(e.target.value) || 0;
            this.dirty = true;
        });
        this.root.querySelector('.panel-head').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            switch (btn.dataset.act) {
                case 'close': this.onClose(); break;
                case 'clear': this.clear(); break;
                case 'pause':
                    this.paused = !this.paused;
                    btn.classList.toggle('active', this.paused);
                    btn.textContent = this.paused ? t('Resume') : t('Pause');
                    break;
                case 'csv': this.exportCsv(); break;
                case 'png': this.exportPng(); break;
                default: break;
            }
        });
        this.legend.addEventListener('click', (e) => {
            const item = e.target.closest('[data-series]');
            if (!item) return;
            const s = this.series.get(item.dataset.series);
            if (s) {
                s.visible = !s.visible;
                this.renderLegend();
                this.dirty = true;
            }
        });
        this.canvas.addEventListener('mousemove', (e) => {
            this.hoverX = e.offsetX;
            this.dirty = true;
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.hoverX = null;
            this.dirty = true;
        });
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.wrap);
    }

    syncRegexVisibility() {
        this.root.querySelector('[data-role="regex"]').style.display = this.session.plotter.parser === 'regex' ? '' : 'none';
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.width = this.wrap.clientWidth;
        this.height = this.wrap.clientHeight;
        this.canvas.width = Math.floor(this.width * dpr);
        this.canvas.height = Math.floor(this.height * dpr);
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.dirty = true;
    }

    clear() {
        this.series.clear();
        this.renderLegend();
        this.dirty = true;
    }

    parse(entry) {
        const p = this.session.plotter;
        if (p.parser === 'decoder') {
            const result = runDecoder(this.session.decoder.id, entryBytes(entry), getStore('decoders-custom', []) || []);
            if (!result || !result.ok) return [];
            if (result.values && !Array.isArray(result.values)) return Object.entries(result.values).map(([k, v]) => [k, v]);
            if (Array.isArray(result.values)) return result.values.map((v, i) => [`reg${i}`, v]);
            return [];
        }
        const text = entryCleanText(entry);
        if (!text) return [];
        if (p.parser === 'regex') {
            if (!this.compiledRegex) {
                try {
                    this.compiledRegex = new RegExp(p.regex || '([-+]?\\d+\\.?\\d*)');
                } catch (error) {
                    return [];
                }
            }
            const m = this.compiledRegex.exec(text);
            if (!m) return [];
            if (m.groups) return Object.entries(m.groups).filter(([, v]) => v !== undefined).map(([k, v]) => [k, parseFloat(v)]);
            return m.slice(1).map((v, i) => [`g${i + 1}`, parseFloat(v)]);
        }
        if (p.parser === 'pairs' || p.parser === 'auto') {
            const pairs = [];
            PAIR_RE.lastIndex = 0;
            let m;
            while ((m = PAIR_RE.exec(text)) !== null) pairs.push([m[1], parseFloat(m[2])]);
            if (pairs.length || p.parser === 'pairs') return pairs;
        }
        const nums = text.match(NUMBER_RE);
        if (!nums) return [];
        return nums.slice(0, 16).map((v, i) => [`v${i + 1}`, parseFloat(v)]);
    }

    onFrame(entry) {
        if (this.paused || entry.kind !== 'data') return;
        const src = this.session.plotter.source;
        if (src !== 'any' && entry.dir !== src) return;
        const values = this.parse(entry);
        if (!values.length) return;
        const maxPoints = getSetting('plotter.maxPoints', 5000);
        let added = false;
        for (const [name, value] of values) {
            if (!Number.isFinite(value)) continue;
            let s = this.series.get(name);
            if (!s) {
                s = { name, color: PALETTE[this.series.size % PALETTE.length], points: [], visible: true, last: null };
                this.series.set(name, s);
                added = true;
            }
            s.points.push({ t: entry.tEnd, v: value });
            s.last = value;
            if (s.points.length > maxPoints) s.points.splice(0, s.points.length - maxPoints);
        }
        if (added) this.renderLegend();
        else this.legendDirty = true;
        this.dirty = true;
    }

    renderLegend() {
        this.legend.innerHTML = Array.from(this.series.values()).map(s => `
            <span class="legend-item ${s.visible ? '' : 'off'}" data-series="${escapeHtml(s.name)}">
                <i style="background:${s.color}"></i>${escapeHtml(s.name)} <b>${s.last === null ? '' : formatValue(s.last)}</b>
            </span>`).join('');
        this.legendDirty = false;
    }

    loop() {
        if (this.disposed) return;
        this.raf = requestAnimationFrame(this.loop);
        const now = performance.now();
        if (!this.dirty || now - (this.lastFrame || 0) < 33) return;
        this.lastFrame = now;
        this.dirty = false;
        if (this.legendDirty) this.renderLegend();
        this.render();
    }

    render() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        if (!w || !h) return;
        const styles = getComputedStyle(document.documentElement);
        const bg = styles.getPropertyValue('--tl-bg').trim() || '#141414';
        const grid = styles.getPropertyValue('--tl-grid').trim() || '#2a2a2a';
        const text = styles.getPropertyValue('--text-dim').trim() || '#888';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        const windowMs = Math.max(1, parseFloat(this.root.querySelector('[data-role="window"]').value) || 30) * 1000;
        let tMax = -Infinity;
        for (const s of this.series.values()) if (s.points.length) tMax = Math.max(tMax, s.points[s.points.length - 1].t);
        if (!Number.isFinite(tMax)) {
            ctx.fillStyle = text;
            ctx.font = '12px Segoe UI, sans-serif';
            ctx.fillText(t('Waiting for numeric data...'), 12, 22);
            return;
        }
        const tMin = tMax - windowMs;
        let yMin = Infinity;
        let yMax = -Infinity;
        if (this.yMode === 'fixed') {
            yMin = this.yMin;
            yMax = this.yMax;
        } else {
            for (const s of this.series.values()) {
                if (!s.visible) continue;
                for (let i = s.points.length - 1; i >= 0; i--) {
                    const pt = s.points[i];
                    if (pt.t < tMin) break;
                    if (pt.v < yMin) yMin = pt.v;
                    if (pt.v > yMax) yMax = pt.v;
                }
            }
            if (!Number.isFinite(yMin)) {
                yMin = 0;
                yMax = 1;
            }
            if (yMin === yMax) {
                yMin -= 1;
                yMax += 1;
            }
            const pad = (yMax - yMin) * 0.08;
            yMin -= pad;
            yMax += pad;
        }
        const left = 54;
        const right = w - 8;
        const top = 8;
        const bottom = h - 20;
        const xOf = (tt) => left + ((tt - tMin) / windowMs) * (right - left);
        const yOf = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
        ctx.strokeStyle = grid;
        ctx.fillStyle = text;
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.lineWidth = 1;
        const ySteps = 5;
        for (let i = 0; i <= ySteps; i++) {
            const v = yMin + ((yMax - yMin) * i) / ySteps;
            const y = Math.round(yOf(v)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatValue(v), left - 4, y);
        }
        const xSteps = Math.max(2, Math.floor((right - left) / 110));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= xSteps; i++) {
            const tt = tMin + (windowMs * i) / xSteps;
            const x = Math.round(xOf(tt)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            ctx.fillText(formatClock(tt, 'HH:mm:ss'), x, bottom + 4);
        }
        ctx.textAlign = 'left';
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        ctx.lineWidth = 1.5;
        for (const s of this.series.values()) {
            if (!s.visible || !s.points.length) continue;
            ctx.strokeStyle = s.color;
            ctx.beginPath();
            let started = false;
            let lo = 0;
            let hi = s.points.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (s.points[mid].t < tMin) lo = mid + 1;
                else hi = mid;
            }
            for (let i = Math.max(0, lo - 1); i < s.points.length; i++) {
                const pt = s.points[i];
                const x = xOf(pt.t);
                const y = yOf(pt.v);
                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        if (this.hoverX !== null && this.hoverX > left) {
            const tt = tMin + ((this.hoverX - left) / (right - left)) * windowMs;
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(this.hoverX + 0.5, top);
            ctx.lineTo(this.hoverX + 0.5, bottom);
            ctx.stroke();
            let ty = top + 4;
            ctx.font = '11px Consolas, monospace';
            ctx.textBaseline = 'top';
            for (const s of this.series.values()) {
                if (!s.visible || !s.points.length) continue;
                let best = null;
                let bestD = Infinity;
                for (let i = s.points.length - 1; i >= 0; i--) {
                    const d = Math.abs(s.points[i].t - tt);
                    if (d < bestD) {
                        bestD = d;
                        best = s.points[i];
                    } else if (s.points[i].t < tt) break;
                }
                if (!best) continue;
                const label = `${s.name}: ${formatValue(best.v)}`;
                const tw = ctx.measureText(label).width + 8;
                const x = this.hoverX + 8 + tw > right ? this.hoverX - tw - 8 : this.hoverX + 8;
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(x, ty, tw, 15);
                ctx.fillStyle = s.color;
                ctx.fillText(label, x + 4, ty + 2);
                ty += 17;
            }
        }
        ctx.restore();
    }

    async exportCsv() {
        const names = Array.from(this.series.keys());
        const rows = [];
        for (const s of this.series.values()) for (const p of s.points) rows.push({ t: p.t, name: s.name, v: p.v });
        rows.sort((a, b) => a.t - b.t);
        const lines = [`timestamp,${names.join(',')}`];
        for (const r of rows) {
            const cols = names.map(n => (n === r.name ? r.v : ''));
            lines.push(`${new Date(r.t).toISOString()},${cols.join(',')}`);
        }
        await invoke('files:save-text', lines.join('\n'), 'csv', `plot_${Date.now()}.csv`);
    }

    async exportPng() {
        const dataUrl = this.canvas.toDataURL('image/png');
        const binary = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await invoke('files:save-binary', bytes, 'png', `plot_${Date.now()}.png`);
    }

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        for (const off of this.subscriptions) off();
        this.resizeObserver.disconnect();
        this.root.remove();
    }
}

function formatValue(v) {
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 3);
}
