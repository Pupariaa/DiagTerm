import { escapeHtml } from '../core/dom.js';
import { on, invoke } from '../core/api.js';
import { onEvent } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { formatBytes, formatRate } from '../core/format.js';
import { activeSession } from '../serial/sessions.js';
import { activeBridges, openBridges } from '../features/bridges.js';
import { runCommand } from '../core/commands.js';
import { icon } from './icons.js';

let root;
let spark;
const flashJobs = new Map();
const loggers = new Map();
let boardTask = null;
let boardTaskTimer = null;

function parityLetter(p) {
    return { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[p] || 'N';
}

function stateText(state) {
    switch (state) {
        case 'open': return t('Connected');
        case 'opening': return t('Opening...');
        case 'lost': return t('Lost');
        case 'reconnecting': return t('Reconnecting');
        case 'given-up': return t('Abandoned');
        case 'suspended': return t('Flashing');
        default: return t('Disconnected');
    }
}

function drawSpark(session) {
    if (!spark) return;
    const ctx = spark.getContext('2d');
    const w = spark.width;
    const h = spark.height;
    ctx.clearRect(0, 0, w, h);
    if (!session) return;
    const hist = session.stats.history || [];
    if (!hist.length) return;
    const max = Math.max(1, ...hist.map(p => Math.max(p.rx, p.tx)));
    const css = getComputedStyle(document.documentElement);
    const draw = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        hist.forEach((p, i) => {
            const x = w - (hist.length - 1 - i) * (w / 59);
            const y = h - 1 - (p[key] / max) * (h - 2);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    };
    draw('rx', css.getPropertyValue('--rx').trim() || '#4caf50');
    draw('tx', css.getPropertyValue('--tx').trim() || '#2196f3');
}

function render() {
    if (!root) return;
    const s = activeSession();
    const running = Array.from(flashJobs.values()).filter(j => j.status === 'running').length;
    const queued = Array.from(flashJobs.values()).filter(j => j.status === 'queued').length;
    const bridges = activeBridges().filter(b => b.state === 'running' || b.state === 'listening' || b.state === 'connected').length;
    const logging = Array.from(loggers.values()).filter(Boolean).length;
    let left = '';
    if (s) {
        const o = s.options || {};
        left = `
            <span class="sb-item sb-state st-${s.state}"><span class="dot"></span>${escapeHtml(s.kind === 'replay' ? t('Replay') : s.kind === 'bridge' ? t('Sniffer') : stateText(s.state))}</span>
            <span class="sb-item">${escapeHtml(s.path || '-')}</span>
            ${s.kind === 'serial' ? `<span class="sb-item">${escapeHtml(`${o.baudRate || 115200} ${o.dataBits || 8}${parityLetter(o.parity)}${o.stopBits || 1}`)}${o.flowControl === 'rtscts' ? ' RTS/CTS' : o.flowControl === 'xonxoff' ? ' XON/XOFF' : ''}</span>` : ''}
            <span class="sb-item sb-rate" title="${escapeHtml(t('Receive / transmit rate'))}"><span class="rx">RX ${escapeHtml(formatRate(s.stats.rxRate || 0))}</span> <span class="tx">TX ${escapeHtml(formatRate(s.stats.txRate || 0))}</span></span>
            <canvas class="sb-spark" width="80" height="16"></canvas>
            <span class="sb-item dim" title="${escapeHtml(t('Total received / sent'))}">${escapeHtml(formatBytes(s.stats.rxBytes))} / ${escapeHtml(formatBytes(s.stats.txBytes))}</span>
            <span class="sb-item dim">${escapeHtml(t('{n} frames', { n: s.capture.entries.length }))}</span>
            ${s.stats.errors ? `<span class="sb-item err">${escapeHtml(t('{n} errors', { n: s.stats.errors }))}</span>` : ''}
            ${s.stats.reconnects ? `<span class="sb-item warn">${escapeHtml(t('{n} reconnections', { n: s.stats.reconnects }))}</span>` : ''}`;
    } else {
        left = `<span class="sb-item dim">${escapeHtml(t('No active terminal'))}</span>`;
    }
    root.innerHTML = `
        <div class="sb-left">${left}</div>
        <div class="sb-right">
            ${boardTask ? `<span class="sb-item sb-click" data-sb="boards" title="${escapeHtml(boardTask.message || '')}">${icon('download', 12)}${escapeHtml(boardTask.label)}</span>` : ''}
            ${logging ? `<span class="sb-item sb-click rec" data-sb="logs" title="${escapeHtml(Array.from(loggers.entries()).filter(([, f]) => f).map(([p, f]) => `${p}: ${f}`).join('\n'))}">${icon('record', 12)}${escapeHtml(t('Recording {n}', { n: logging }))}</span>` : ''}
            ${bridges ? `<span class="sb-item sb-click" data-sb="bridges">${icon('bridge', 12)}${escapeHtml(t('{n} bridges', { n: bridges }))}</span>` : ''}
            ${running || queued ? `<span class="sb-item sb-click flash" data-sb="flash">${icon('flash', 12)}${escapeHtml(t('Flash {r} running, {q} queued', { r: running, q: queued }))}</span>` : ''}
        </div>`;
    spark = root.querySelector('.sb-spark');
    drawSpark(s);
}

export function initStatusbar(host) {
    root = host;
    root.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-sb]');
        if (!item) return;
        switch (item.dataset.sb) {
            case 'logs': {
                const folder = await invoke('logger:folder');
                if (folder) invoke('files:open-path', folder);
                break;
            }
            case 'bridges': openBridges(activeSession()); break;
            case 'flash': runCommand('view.flash'); break;
            case 'boards': runCommand('flash.board-manager'); break;
            default: break;
        }
    });
    on('flash:job', (job) => {
        flashJobs.set(job.id, job);
        if (flashJobs.size > 500) {
            for (const [id, j] of flashJobs) {
                if (j.status !== 'running' && j.status !== 'queued') flashJobs.delete(id);
                if (flashJobs.size <= 300) break;
            }
        }
        render();
    });
    on('logger:state', ({ path, active, file }) => {
        loggers.set(path, active ? file : null);
        render();
    });
    on('boards:progress', (p) => {
        const pct = p.percent !== null && p.percent !== undefined && p.phase === 'download' ? ` ${p.percent}%` : '';
        boardTask = p.phase === 'done' || p.phase === 'error' ? null : { label: `${p.message || t('Board manager')}${pct}`, message: p.message };
        clearTimeout(boardTaskTimer);
        boardTaskTimer = setTimeout(() => { boardTask = null; render(); }, 15000);
        render();
    });
    invoke('logger:status').then(list => {
        for (const w of list || []) loggers.set(w.path, w.file);
        render();
    }).catch(() => { });
    invoke('flash:jobs').then(list => {
        for (const j of list || []) flashJobs.set(j.id, j);
        render();
    }).catch(() => { });
    onEvent('stats:tick', render);
    onEvent('session:active', render);
    onEvent('session:state', render);
    onEvent('bridges:changed', render);
    onEvent('settings:changed', render);
    render();
}
