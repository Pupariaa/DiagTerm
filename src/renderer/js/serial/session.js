import { invoke } from '../core/api.js';
import { Emitter } from '../core/emitter.js';
import { getSetting } from '../core/settings.js';
import { uid } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { Capture } from './capture.js';
import { mainNow } from './clock.js';
import { buildPayload } from '../features/payload.js';

export const OPEN_STATES = new Set(['open']);
export const BUSY_STATES = new Set(['opening', 'lost', 'reconnecting', 'suspended']);

function serialDefaults() {
    return {
        baudRate: getSetting('serial.baudRate', 115200),
        dataBits: getSetting('serial.dataBits', 8),
        parity: getSetting('serial.parity', 'none'),
        stopBits: getSetting('serial.stopBits', 1),
        flowControl: getSetting('serial.flowControl', 'none'),
        dtrOnOpen: getSetting('serial.dtrOnOpen', true),
        rtsOnOpen: getSetting('serial.rtsOnOpen', true)
    };
}

function framingDefaults() {
    return {
        mode: getSetting('serial.framingMode', 'delimiter'),
        delimiter: getSetting('serial.framingDelimiter', '0A'),
        timeoutMs: getSetting('serial.framingTimeoutMs', 50),
        length: getSetting('serial.framingLength', 16),
        maxLength: getSetting('serial.framingMaxLength', 4096),
        flushMs: getSetting('serial.framingFlushMs', 0),
        txMode: 'write'
    };
}

function viewDefaults() {
    return {
        viewMode: getSetting('terminal.viewMode', 'ascii'),
        showControl: getSetting('terminal.showControlChars', false),
        timestampMode: getSetting('terminal.timestampMode', 'none'),
        wrap: getSetting('terminal.wrap', true),
        follow: getSetting('terminal.autoScroll', true),
        dirFilter: 'all',
        showTx: getSetting('terminal.showTx', true)
    };
}

export class Session extends Emitter {
    constructor(config = {}) {
        super();
        this.id = config.id || uid();
        this.kind = config.kind || 'serial';
        this.path = config.path || '';
        this.title = config.title || '';
        this.options = { ...serialDefaults(), ...(config.options || {}) };
        this.framing = { ...framingDefaults(), ...(config.framing || {}) };
        this.view = { ...viewDefaults(), ...(config.view || {}) };
        this.send = {
            mode: getSetting('serial.txInputMode', 'text'),
            lineEnding: getSetting('serial.lineEnding', 'NL'),
            escapes: true,
            repeatMs: 1000,
            ...(config.send || {})
        };
        this.timeline = {
            visible: getSetting('timeline.visible', true),
            mode: getSetting('timeline.mode', 'auto'),
            height: getSetting('timeline.height', 190),
            ...(config.timeline || {})
        };
        this.panels = { plotter: false, decoder: false, side: 'right', sideWidth: 420, ...(config.panels || {}) };
        this.decoder = { id: 'modbus-rtu', dir: 'any', ...(config.decoder || {}) };
        this.plotter = { source: 'RX', parser: 'auto', ...(config.plotter || {}) };
        this.autoReconnect = config.autoReconnect !== undefined ? !!config.autoReconnect : getSetting('reconnect.enabled', true);
        this.logging = config.logging === undefined ? null : config.logging;
        this.comnex = config.comnex || null;
        this.wasOpen = !!config.wasOpen;
        this.state = 'closed';
        this.stateInfo = {};
        this.signals = { dtr: false, rts: false, brk: false, cts: false, dsr: false, dcd: false, ri: false };
        this.capture = new Capture({
            framing: this.framing,
            format: this.options,
            maxEntries: getSetting('terminal.maxEntries', 200000),
            maxBytes: getSetting('terminal.maxCaptureMB', 128) * 1024 * 1024
        });
        this.stats = {
            rxBytes: 0, txBytes: 0, rxFrames: 0, txFrames: 0,
            rxRate: 0, txRate: 0, peakRx: 0, peakTx: 0,
            connectedAt: null, lastRx: null, lastTx: null,
            history: [], lastRxBytes: 0, lastTxBytes: 0, errors: 0, reconnects: 0
        };
        this.stopwatch = { running: false, startT: null, stopT: null, laps: [] };
        this.paused = false;
        this.sendHistory = Array.isArray(config.sendHistory) ? config.sendHistory.slice(-getSetting('terminal.sendHistorySize', 200)) : [];
        this.replay = null;
        this.disposed = false;
    }

    get displayName() {
        if (this.title) return this.title;
        if (this.kind === 'replay') return this.replay && this.replay.name ? this.replay.name : t('Replay');
        if (this.kind === 'bridge') return this.bridgeLabel || t('Sniffer');
        return this.path || t('New tab');
    }

    get isOpen() {
        return this.state === 'open';
    }

    get isVirtual() {
        return this.kind !== 'serial';
    }

    get canWrite() {
        return this.kind === 'serial' && this.state === 'open';
    }

    setState(state, info = {}) {
        this.state = state;
        this.stateInfo = info;
        this.emit('state', state, info);
    }

    async open() {
        if (this.isVirtual) return { success: false };
        if (!this.path) return { success: false, error: t('Select a port first') };
        if (this.state === 'open' || this.state === 'opening') return { success: true };
        this.setState('opening');
        if (getSetting('terminal.clearOnConnect', false)) this.clear();
        if (this.logging !== null) await invoke('logger:set-port', this.path, this.logging).catch(() => null);
        const result = await invoke('serial:open', this.path, this.options, { autoReconnect: this.autoReconnect, owner: 'tab' })
            .catch(error => ({ success: false, error: error.message }));
        if (!result.success) {
            this.setState('closed', { error: result.error });
            this.stats.errors++;
            return result;
        }
        if (this.state === 'opening') this.setState('open', {});
        return result;
    }

    async close() {
        if (this.isVirtual || !this.path) return { success: true };
        const result = await invoke('serial:close', this.path).catch(error => ({ success: false, error: error.message }));
        this.setState('closed', {});
        return result;
    }

    async toggle() {
        if (this.state === 'closed' || this.state === 'given-up') return this.open();
        return this.close();
    }

    async setPath(path) {
        if (path === this.path) return;
        const wasActive = this.state !== 'closed';
        if (wasActive) await this.close();
        const previous = this.path;
        this.path = path;
        this.emit('path', path, previous);
        if (this.comnex && !path) this.comnex = null;
    }

    async updateOptions(partial) {
        this.options = { ...this.options, ...partial };
        this.capture.setFormat(this.options);
        this.emit('options', this.options);
        if (this.state === 'open') {
            const result = await invoke('serial:update', this.path, partial).catch(error => ({ success: false, error: error.message }));
            if (!result.success) this.addSystem(t('Failed to apply settings: {error}', { error: result.error }), 'error');
            return result;
        }
        return { success: true };
    }

    updateFraming(partial) {
        this.framing = { ...this.framing, ...partial };
        this.capture.closePending('RX');
        this.capture.closePending('TX');
        this.capture.setFraming(this.framing);
        this.emit('framing', this.framing);
    }

    updateView(partial) {
        this.view = { ...this.view, ...partial };
        this.emit('view', this.view, partial);
    }

    async setAutoReconnect(enabled) {
        this.autoReconnect = !!enabled;
        if (this.path && !this.isVirtual) await invoke('serial:set-auto-reconnect', this.path, this.autoReconnect).catch(() => null);
        this.emit('auto-reconnect', this.autoReconnect);
    }

    async setLogging(enabled) {
        this.logging = enabled;
        if (this.path && !this.isVirtual) await invoke('logger:set-port', this.path, enabled).catch(() => null);
        this.emit('logging', enabled);
    }

    effectiveLogging() {
        if (this.logging !== null && this.logging !== undefined) return !!this.logging;
        return !!getSetting('logging.enabled', false);
    }

    async write(bytes) {
        if (!this.canWrite) return { success: false, error: t('Port not open') };
        const result = await invoke('serial:write', this.path, bytes).catch(error => ({ success: false, error: error.message }));
        if (!result.success) {
            this.stats.errors++;
            this.addSystem(t('Write failed: {error}', { error: result.error }), 'error');
        }
        return result;
    }

    payloadFrom(text, overrides = {}) {
        return buildPayload(text, {
            mode: overrides.mode || this.send.mode,
            escapes: overrides.escapes !== undefined ? overrides.escapes : this.send.escapes,
            lineEnding: overrides.lineEnding !== undefined ? overrides.lineEnding : this.send.lineEnding,
            encoding: getSetting('serial.encoding', 'utf-8'),
            counterKey: overrides.counterKey || this.id,
            port: this.path,
            baud: this.options.baudRate
        });
    }

    async sendText(text, overrides = {}) {
        let bytes;
        try {
            bytes = this.payloadFrom(text, overrides);
        } catch (error) {
            this.addSystem(error.message, 'error');
            return { success: false, error: error.message };
        }
        if (bytes.length === 0) return { success: false, error: t('Nothing to send') };
        const result = await this.write(bytes);
        if (result.success && overrides.remember !== false) this.rememberSent(text);
        return result;
    }

    rememberSent(text) {
        if (!text) return;
        const idx = this.sendHistory.lastIndexOf(text);
        if (idx >= 0) this.sendHistory.splice(idx, 1);
        this.sendHistory.push(text);
        const max = getSetting('terminal.sendHistorySize', 200);
        if (this.sendHistory.length > max) this.sendHistory.splice(0, this.sendHistory.length - max);
        this.emit('history', this.sendHistory);
    }

    async reset() {
        if (!this.canWrite) return { success: false };
        this.addMarker(t('Reset'), { kind: 'sys', level: 'info' });
        return invoke('serial:reset', this.path).catch(error => ({ success: false, error: error.message }));
    }

    async setSignals(signals) {
        if (!this.canWrite) return { success: false };
        return invoke('serial:set-signals', this.path, signals).catch(error => ({ success: false, error: error.message }));
    }

    async sendBreak(durationMs = 250) {
        if (!this.canWrite) return;
        await this.setSignals({ brk: true });
        await new Promise(r => setTimeout(r, durationMs));
        await this.setSignals({ brk: false });
        this.addMarker(t('Break'), { kind: 'sys' });
    }

    ingest(dir, t0, bytes) {
        const result = this.capture.addChunk(dir, t0, bytes);
        if (dir === 'RX') {
            this.stats.rxBytes += bytes.length;
            this.stats.lastRx = t0;
        } else {
            this.stats.txBytes += bytes.length;
            this.stats.lastTx = t0;
        }
        this.countClosed(result.closed);
        this.emit('data', result, dir);
        for (const entry of result.closed) this.emit('frame', entry);
        return result;
    }

    countClosed(list) {
        for (const entry of list) {
            if (!entry) continue;
            if (entry.dir === 'RX') this.stats.rxFrames++;
            else if (entry.dir === 'TX') this.stats.txFrames++;
        }
    }

    flushIdle(now) {
        const closed = this.capture.flushIdle(now);
        if (closed.length === 0) return;
        this.countClosed(closed);
        this.emit('data', { created: [], closed, touched: null }, null);
        for (const entry of closed) this.emit('frame', entry);
    }

    addSystem(text, level = 'info') {
        return this.addMarker(text, { kind: 'sys', level });
    }

    addMarker(label, options = {}) {
        const entry = this.capture.addMarker(label, options.t || mainNow(), options);
        this.emit('data', { created: [entry], closed: [], touched: null }, 'SYS');
        this.emit('marker', entry);
        return entry;
    }

    handleState(payload) {
        const previous = this.state;
        if (payload.previousPath && payload.previousPath === this.path && payload.path !== this.path) {
            const old = this.path;
            this.path = payload.path;
            this.addSystem(t('Device re-enumerated: {from} -> {to}', { from: old, to: payload.path }), 'warn');
            this.emit('path', this.path, old);
        }
        switch (payload.state) {
            case 'open':
                this.stats.connectedAt = Date.now();
                if (payload.signals) this.signals = { ...this.signals, ...payload.signals };
                if (payload.reconnected) {
                    this.stats.reconnects++;
                    this.addSystem(t('Reconnected'), 'success');
                } else if (previous !== 'open') {
                    this.addSystem(t('Connected to {port} at {baud} baud', { port: this.path, baud: this.options.baudRate }), 'success');
                }
                break;
            case 'closed':
                if (previous !== 'closed') this.addSystem(t('Disconnected'), 'info');
                break;
            case 'lost':
                if (previous === 'open') this.addSystem(t('Connection lost: {reason}', { reason: payload.reason || '' }), 'error');
                break;
            case 'reconnecting':
                break;
            case 'given-up':
                this.addSystem(t('Reconnection abandoned after {n} attempts', { n: payload.attempts || 0 }), 'error');
                break;
            case 'suspended':
                this.addSystem(t('Port suspended (in use by flash job)'), 'warn');
                break;
            default:
                break;
        }
        if (payload.signals) this.signals = { ...this.signals, ...payload.signals };
        this.setState(payload.state, payload);
    }

    handleSignals(signals) {
        this.signals = { ...this.signals, ...signals };
        this.emit('signals', this.signals);
    }

    clear() {
        this.capture.clear();
        this.stats.rxBytes = 0;
        this.stats.txBytes = 0;
        this.stats.rxFrames = 0;
        this.stats.txFrames = 0;
        this.emit('clear');
    }

    setPaused(paused) {
        this.paused = !!paused;
        this.emit('paused', this.paused);
    }

    swStart(t0 = mainNow(), label) {
        this.stopwatch = { running: true, startT: t0, stopT: null, laps: [] };
        this.addMarker(label || t('Chrono start'), { t: t0, kind: 'marker', color: getSetting('timeline.markerColor', '#ffb300') });
        this.emit('stopwatch', this.stopwatch);
    }

    swStop(t0 = mainNow(), label) {
        if (!this.stopwatch.running) return;
        this.stopwatch.running = false;
        this.stopwatch.stopT = t0;
        this.addMarker(label || t('Chrono stop'), { t: t0, kind: 'marker', color: getSetting('timeline.markerColor', '#ffb300') });
        this.emit('stopwatch', this.stopwatch);
    }

    swLap(t0 = mainNow(), label) {
        if (!this.stopwatch.running) {
            this.swStart(t0, label);
            return;
        }
        const prev = this.stopwatch.laps.length ? this.stopwatch.laps[this.stopwatch.laps.length - 1].t : this.stopwatch.startT;
        this.stopwatch.laps.push({ t: t0, label: label || t('Lap {n}', { n: this.stopwatch.laps.length + 1 }), split: t0 - prev, total: t0 - this.stopwatch.startT });
        this.addMarker(label || t('Lap {n}', { n: this.stopwatch.laps.length }), { t: t0, kind: 'marker', color: getSetting('timeline.markerColor', '#ffb300') });
        this.emit('stopwatch', this.stopwatch);
    }

    swReset() {
        this.stopwatch = { running: false, startT: null, stopT: null, laps: [] };
        this.emit('stopwatch', this.stopwatch);
    }

    swToggle(t0 = mainNow()) {
        if (this.stopwatch.running) this.swStop(t0);
        else this.swStart(t0);
    }

    swElapsed(now = mainNow()) {
        if (this.stopwatch.startT === null) return null;
        const end = this.stopwatch.running ? now : this.stopwatch.stopT;
        return end - this.stopwatch.startT;
    }

    toConfig() {
        return {
            id: this.id,
            kind: this.kind,
            path: this.kind === 'serial' ? this.path : '',
            title: this.title,
            options: this.options,
            framing: this.framing,
            view: this.view,
            send: this.send,
            timeline: this.timeline,
            panels: this.panels,
            decoder: this.decoder,
            plotter: this.plotter,
            autoReconnect: this.autoReconnect,
            logging: this.logging,
            comnex: this.comnex,
            wasOpen: this.state === 'open' || this.state === 'lost' || this.state === 'reconnecting',
            sendHistory: getSetting('terminal.persistSendHistory', true) ? this.sendHistory : []
        };
    }

    dispose() {
        this.disposed = true;
        if (this.replay && this.replay.stop) this.replay.stop();
        this.emit('dispose');
        this.removeAllListeners();
    }
}
