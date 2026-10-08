import { openModal } from '../core/dialogs.js';
import { escapeHtml } from '../core/dom.js';
import { formatBytes, formatRate, formatDuration, formatClock } from '../core/format.js';
import { t } from '../core/i18n.js';

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
}

function compute(session) {
    const entries = session.capture.entries;
    const res = { RX: { frames: 0, bytes: 0, lens: [], gaps: [] }, TX: { frames: 0, bytes: 0, lens: [], gaps: [] }, responses: [], markers: 0, sys: 0, errors: 0 };
    const last = { RX: null, TX: null };
    let lastTx = null;
    for (const e of entries) {
        if (e.kind === 'marker') {
            res.markers++;
            continue;
        }
        if (e.kind !== 'data') {
            res.sys++;
            if (e.level === 'error') res.errors++;
            continue;
        }
        const d = res[e.dir];
        d.frames++;
        d.bytes += e.len;
        d.lens.push(e.len);
        if (last[e.dir]) d.gaps.push(e.t - last[e.dir].t);
        last[e.dir] = e;
        if (e.dir === 'TX') lastTx = e;
        else if (lastTx) {
            res.responses.push(e.t - lastTx.tEnd);
            lastTx = null;
        }
    }
    for (const dir of ['RX', 'TX']) {
        res[dir].lens.sort((a, b) => a - b);
        res[dir].gaps.sort((a, b) => a - b);
    }
    res.responses.sort((a, b) => a - b);
    const first = entries.find(e => e.kind === 'data');
    const lastE = [...entries].reverse().find(e => e.kind === 'data');
    res.span = first && lastE ? lastE.tEnd - first.t : 0;
    res.first = first ? first.t : null;
    const bt = session.capture.bt;
    res.busyRx = res.RX.bytes * bt;
    res.busyTx = res.TX.bytes * bt;
    return res;
}

function dist(sorted, fmt) {
    if (!sorted.length) return '-';
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return `${escapeHtml(t('min'))} ${fmt(sorted[0])} / ${escapeHtml(t('avg'))} ${fmt(avg)} / p50 ${fmt(percentile(sorted, 0.5))} / p95 ${fmt(percentile(sorted, 0.95))} / ${escapeHtml(t('max'))} ${fmt(sorted[sorted.length - 1])}`;
}

export function openStats(session) {
    const render = () => {
        const r = compute(session);
        const st = session.stats;
        const busy = (b) => (r.span > 0 ? ((b / r.span) * 100).toFixed(2) + '%' : '-');
        const lenFmt = (v) => `${Math.round(v)} B`;
        const durFmt = (v) => formatDuration(v);
        return `
            <table class="kv stats-table">
                <tr><th>${escapeHtml(t('Port'))}</th><td>${escapeHtml(session.path || session.displayName)} - ${session.options.baudRate} baud</td></tr>
                <tr><th>${escapeHtml(t('Connected since'))}</th><td>${st.connectedAt ? formatClock(st.connectedAt, 'YYYY-MM-DD HH:mm:ss') + ' (' + formatDuration(Date.now() - st.connectedAt) + ')' : '-'}</td></tr>
                <tr><th>${escapeHtml(t('Capture span'))}</th><td>${r.first ? formatClock(r.first, 'HH:mm:ss.SSS') : '-'} - ${formatDuration(r.span)}</td></tr>
                <tr><th>${escapeHtml(t('Reconnections'))}</th><td>${st.reconnects}</td></tr>
                <tr><th>${escapeHtml(t('Errors'))}</th><td>${st.errors}</td></tr>
                <tr><th>${escapeHtml(t('Markers'))}</th><td>${r.markers}</td></tr>
            </table>
            <div class="cols-2">
                ${['RX', 'TX'].map(dir => `
                <div>
                    <h3 class="${dir.toLowerCase()}">${dir}</h3>
                    <table class="kv">
                        <tr><th>${escapeHtml(t('Frames'))}</th><td>${r[dir].frames}</td></tr>
                        <tr><th>${escapeHtml(t('Bytes'))}</th><td>${formatBytes(r[dir].bytes)} (${escapeHtml(t('total since open'))}: ${formatBytes(dir === 'RX' ? st.rxBytes : st.txBytes)})</td></tr>
                        <tr><th>${escapeHtml(t('Current rate'))}</th><td>${formatRate(dir === 'RX' ? st.rxRate : st.txRate)} (${escapeHtml(t('peak'))} ${formatRate(dir === 'RX' ? st.peakRx : st.peakTx)})</td></tr>
                        <tr><th>${escapeHtml(t('Line occupancy'))}</th><td>${busy(dir === 'RX' ? r.busyRx : r.busyTx)}</td></tr>
                        <tr><th>${escapeHtml(t('Frame length'))}</th><td>${dist(r[dir].lens, lenFmt)}</td></tr>
                        <tr><th>${escapeHtml(t('Frame period'))}</th><td>${dist(r[dir].gaps, durFmt)}</td></tr>
                    </table>
                </div>`).join('')}
            </div>
            <h3>${escapeHtml(t('Response time (TX end to next RX start)'))}</h3>
            <div>${r.responses.length ? dist(r.responses, durFmt) + ` (${r.responses.length} ${escapeHtml(t('pairs'))})` : `<span class="dim">${escapeHtml(t('No TX/RX exchanges yet'))}</span>`}</div>`;
    };
    const modal = openModal({
        title: t('Statistics - {name}', { name: session.displayName }),
        width: 820,
        body: render(),
        buttons: [{ label: t('Refresh'), keepOpen: true, action: (m) => m.setBody(render()) }, { label: t('Close'), primary: true }]
    });
    const timer = setInterval(() => {
        if (modal.closed) clearInterval(timer);
        else modal.setBody(render());
    }, 2000);
}
