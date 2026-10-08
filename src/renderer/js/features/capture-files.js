import { invoke } from '../core/api.js';
import { toast, openModal } from '../core/dialogs.js';
import { escapeHtml } from '../core/dom.js';
import { formatClock, formatDuration, formatBytes } from '../core/format.js';
import { t } from '../core/i18n.js';
import { createSession } from '../serial/sessions.js';
import { mainNow } from '../serial/clock.js';
import { uid } from '../core/dom.js';

function headerFor(session) {
    return {
        port: session.path,
        title: session.displayName,
        options: session.options,
        framing: session.framing,
        markers: session.capture.markers.length,
        app: 'DiagTerm'
    };
}

export async function saveCapture(session) {
    const chunks = session.capture.serialize();
    if (!chunks.length) {
        toast(t('Nothing to save'), { type: 'warn' });
        return;
    }
    const name = `${(session.path || session.displayName).replace(/[^a-zA-Z0-9]/g, '_')}_${formatClock(Date.now(), 'YYYY-MM-DD_HH-mm-ss')}.dtcap`;
    const res = await invoke('capture:save', headerFor(session), chunks, name);
    if (res.success) toast(t('Capture saved: {file}', { file: res.filePath }), { type: 'success' });
    else if (res.error) toast(res.error, { type: 'error' });
}

export async function snapshotCapture(session, name) {
    const chunks = session.capture.serialize();
    if (!chunks.length) return;
    const res = await invoke('capture:snapshot', headerFor(session), chunks, name || session.displayName);
    if (res.success) toast(t('Snapshot saved: {file}', { file: res.filePath }), { type: 'success' });
}

class ReplayController {
    constructor(session, data, name) {
        this.session = session;
        this.chunks = data.chunks.filter(c => c.d === 'RX' || c.d === 'TX' || c.k === 'marker' || c.d === 'SYS').sort((a, b) => a.t - b.t);
        this.header = data.header || {};
        this.name = name;
        this.index = 0;
        this.speed = 1;
        this.playing = false;
        this.timer = null;
        this.offset = 0;
        this.startT = this.chunks.length ? this.chunks[0].t : 0;
        this.endT = this.chunks.length ? this.chunks[this.chunks.length - 1].t : 0;
        this.listeners = new Set();
    }

    onChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    changed() {
        for (const cb of this.listeners) cb(this);
    }

    feed(chunk, shift) {
        const tt = chunk.t + shift;
        if (chunk.k === 'marker' || chunk.d === 'SYS') {
            this.session.addMarker(chunk.l || t('Marker'), { t: tt });
            return;
        }
        this.session.ingest(chunk.d, tt, new Uint8Array(chunk.b));
    }

    loadAll() {
        this.stop();
        this.session.clear();
        for (const chunk of this.chunks) this.feed(chunk, 0);
        this.index = this.chunks.length;
        this.session.capture.closePending('RX');
        this.session.capture.closePending('TX');
        this.session.emit('data', { created: [], closed: [], touched: null }, null);
        this.changed();
    }

    play() {
        if (this.index >= this.chunks.length) {
            this.session.clear();
            this.index = 0;
        }
        this.playing = true;
        const anchorReal = mainNow();
        const anchorCap = this.chunks[this.index] ? this.chunks[this.index].t : this.endT;
        this.shift = anchorReal - anchorCap;
        this.anchorReal = anchorReal;
        this.anchorCap = anchorCap;
        const tick = () => {
            if (!this.playing) return;
            const elapsed = (mainNow() - this.anchorReal) * this.speed;
            const capNow = this.anchorCap + elapsed;
            let fed = 0;
            while (this.index < this.chunks.length && this.chunks[this.index].t <= capNow && fed < 5000) {
                const chunk = this.chunks[this.index];
                const realT = this.anchorReal + (chunk.t - this.anchorCap) / this.speed;
                this.feed(chunk, realT - chunk.t);
                this.index++;
                fed++;
            }
            if (fed) this.session.emit('batch');
            if (this.index >= this.chunks.length) {
                this.playing = false;
                this.changed();
                return;
            }
            this.changed();
            this.timer = setTimeout(tick, 15);
        };
        tick();
        this.changed();
    }

    stop() {
        this.playing = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.changed();
    }

    setSpeed(speed) {
        const wasPlaying = this.playing;
        this.stop();
        this.speed = speed;
        if (wasPlaying) this.play();
    }

    get progress() {
        return this.chunks.length ? this.index / this.chunks.length : 0;
    }
}

export async function openCaptureFile(filePath) {
    const res = await invoke('capture:open', filePath || null);
    if (!res.success) {
        if (res.error) toast(res.error, { type: 'error' });
        return null;
    }
    const name = res.filePath.split(/[\\/]/).pop();
    const header = res.header || {};
    const session = createSession({
        id: uid(),
        kind: 'replay',
        path: `replay:${uid()}`,
        title: name,
        options: header.options || undefined,
        framing: header.framing || undefined
    });
    const controller = new ReplayController(session, res, name);
    session.replay = controller;
    controller.stop = controller.stop.bind(controller);
    const total = res.chunks.reduce((s, c) => s + (c.b ? c.b.length : 0), 0);
    const duration = controller.endT - controller.startT;
    openModal({
        title: t('Open capture'),
        width: 480,
        body: `
            <table class="kv">
                <tr><th>${escapeHtml(t('File'))}</th><td>${escapeHtml(res.filePath)}</td></tr>
                <tr><th>${escapeHtml(t('Port'))}</th><td>${escapeHtml(header.port || '-')}</td></tr>
                <tr><th>${escapeHtml(t('Recorded'))}</th><td>${controller.chunks.length ? formatClock(controller.startT, 'YYYY-MM-DD HH:mm:ss') : '-'}</td></tr>
                <tr><th>${escapeHtml(t('Duration'))}</th><td>${formatDuration(duration)}</td></tr>
                <tr><th>${escapeHtml(t('Data'))}</th><td>${formatBytes(total)} - ${controller.chunks.length} ${escapeHtml(t('chunks'))}</td></tr>
            </table>
            <p class="dim">${escapeHtml(t('Load everything instantly with original timestamps, or replay it in real time (with speed control) to watch triggers, plotter and decoders react.'))}</p>`,
        buttons: [
            { label: t('Replay in real time'), action: () => controller.play() },
            { label: t('Load instantly'), primary: true, action: () => controller.loadAll() }
        ],
        onClose: (value) => {
            if (value === undefined && !controller.playing && controller.index === 0) controller.loadAll();
        }
    });
    return session;
}
