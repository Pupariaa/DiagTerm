import { el, escapeHtml, options, debounce } from '../core/dom.js';
import { on, invoke } from '../core/api.js';
import { onEvent } from '../core/bus.js';
import { getSetting } from '../core/settings.js';
import { t } from '../core/i18n.js';
import { popover, closePopover, contextMenu, toast, promptDialog } from '../core/dialogs.js';
import { formatStopwatch, formatDuration, formatBytes, formatRate, toHex } from '../core/format.js';
import { getPorts, portLabel, sortPorts, isComnexPort, refreshPorts } from '../serial/ports.js';
import { entryBytes } from '../serial/capture.js';
import { entryText } from '../serial/entry-text.js';
import { mainNow } from '../serial/clock.js';
import { TerminalView } from './terminal.js';
import { TimelineView } from './timeline.js';
import { PlotterPanel } from './plotter-panel.js';
import { DecoderPanel } from './decoder-panel.js';
import { icon } from './icons.js';
import { getMacros, runMacro, isRunning, startPeriodicSend, stopPeriodic, saveMacros, defaultMacro } from '../features/macros.js';
import { getTriggers, saveTriggers, defaultTrigger } from '../features/triggers.js';
import { getHighlightRules, saveHighlightRules } from '../features/highlight.js';
import { openExportModal } from '../features/export.js';
import { openSendFileModal } from '../features/send-file.js';
import { openAnalysis } from '../features/analysis.js';
import { saveCapture, snapshotCapture } from '../features/capture-files.js';
import { openMacrosEditor, openTriggersEditor, openHighlightsEditor, openCustomDecodersEditor } from '../features/editors.js';
import { openStats } from '../features/stats.js';
import { openCompare } from '../features/compare.js';
import { openBridges } from '../features/bridges.js';
import { sendComnexPower } from '../features/comnex.js';
import { uid } from '../core/dom.js';

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 74880, 115200, 128000, 153600, 230400, 250000, 256000, 460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000, 4000000];

const views = new Map();

export function getTabView(sessionId) {
    return views.get(sessionId) || null;
}

function stateLabel(state, info) {
    switch (state) {
        case 'open': return t('Connected');
        case 'opening': return t('Opening...');
        case 'lost': return info && info.autoReconnect === false ? t('Connection lost') : t('Lost - waiting');
        case 'reconnecting': return t('Reconnecting ({n})', { n: info && info.attempts ? info.attempts : 1 });
        case 'given-up': return t('Reconnect abandoned');
        case 'suspended': return t('In use by flash');
        default: return t('Disconnected');
    }
}

export class TabView {
    constructor(session) {
        this.session = session;
        this.subscriptions = [];
        this.fileJob = null;
        this.build();
        views.set(session.id, this);
    }

    build() {
        const s = this.session;
        const virtual = s.isVirtual;
        this.root = el(`
            <div class="tabview ${virtual ? 'virtual' : ''}" data-session="${s.id}">
                <div class="tv-toolbar row1">
                    <div class="grp conn-grp">
                        <select class="input port-select" data-role="port" title="${escapeHtml(t('Serial port'))}"></select>
                        <button class="tb-btn icon-only" data-act="refresh-ports" title="${escapeHtml(t('Refresh ports'))}">${icon('refresh')}</button>
                        <input class="input baud-input" data-role="baud" list="baud-list-${s.id}" value="${s.options.baudRate}" title="${escapeHtml(t('Baud rate'))}">
                        <datalist id="baud-list-${s.id}">${BAUD_RATES.map(b => `<option value="${b}">`).join('')}</datalist>
                        <button class="tb-btn" data-act="serial-options" title="${escapeHtml(t('Serial and framing options'))}">${icon('gear')}<span data-role="format-label"></span></button>
                        <button class="btn btn-primary connect-btn" data-act="connect"></button>
                        <span class="state-chip" data-role="state"></span>
                        <button class="tb-btn icon-only" data-act="auto-reconnect" title="${escapeHtml(t('Automatic reconnection'))}">${icon('replay')}</button>
                    </div>
                    <div class="grp sig-grp">
                        <button class="tb-btn" data-act="reset" title="${escapeHtml(t('Pulse reset (DTR/RTS)'))}">${icon('reset')}<span>${escapeHtml(t('Reset'))}</span></button>
                        <button class="tb-btn sig" data-act="dtr" title="DTR">DTR</button>
                        <button class="tb-btn sig" data-act="rts" title="RTS">RTS</button>
                        <button class="tb-btn sig" data-act="break" title="${escapeHtml(t('Send break'))}">BRK</button>
                        <span class="leds" data-role="leds" title="${escapeHtml(t('Modem input lines'))}">
                            <i data-led="cts">CTS</i><i data-led="dsr">DSR</i><i data-led="dcd">DCD</i><i data-led="ri">RI</i>
                        </span>
                        <select class="input sm comnex-power hidden" data-role="comnex-power" title="${escapeHtml(t('COMNEX level shifter'))}">
                            ${options([['3.3V', '3.3V'], ['5V', '5V']], s.comnex ? s.comnex.power : '3.3V')}
                        </select>
                    </div>
                    <span class="spacer"></span>
                    <div class="grp search-grp">
                        <div class="search-box">
                            ${icon('search', 14)}
                            <input class="input search-input" data-role="search" placeholder="${escapeHtml(t('Search in logs...'))}" spellcheck="false">
                            <span class="search-count" data-role="search-count"></span>
                        </div>
                        <button class="tb-btn toggle" data-act="search-case" title="${escapeHtml(t('Match case'))}">Aa</button>
                        <button class="tb-btn toggle" data-act="search-regex" title="${escapeHtml(t('Regular expression'))}">.*</button>
                        <button class="tb-btn toggle icon-only" data-act="search-filter" title="${escapeHtml(t('Show matching frames only'))}">${icon('filter', 14)}</button>
                        <button class="tb-btn icon-only" data-act="search-prev" title="${escapeHtml(t('Previous match (Shift+Enter)'))}">${icon('up', 14)}</button>
                        <button class="tb-btn icon-only" data-act="search-next" title="${escapeHtml(t('Next match (Enter)'))}">${icon('down', 14)}</button>
                        <div class="seg" data-role="dir-filter">
                            <button data-dir="all">${escapeHtml(t('All'))}</button>
                            <button data-dir="RX">RX</button>
                            <button data-dir="TX">TX</button>
                        </div>
                    </div>
                </div>
                <div class="tv-toolbar row2">
                    <div class="seg" data-role="view-mode">
                        <button data-mode="ascii">ASCII</button>
                        <button data-mode="hex">HEX</button>
                        <button data-mode="mixed">${escapeHtml(t('Dump'))}</button>
                    </div>
                    <button class="tb-btn toggle" data-act="control-chars" title="${escapeHtml(t('Show control characters (CR, LF...)'))}">${icon('cc')}</button>
                    <select class="input sm" data-role="ts-mode" title="${escapeHtml(t('Timestamp mode'))}">
                        ${options([
                            ['none', t('No time')],
                            ['absolute', t('Clock time')],
                            ['relative', t('Since start')],
                            ['delta', t('Delta (prev. frame)')],
                            ['gap', t('Idle gap (prev. end)')],
                            ['chrono', t('Chronometer')]
                        ], s.view.timestampMode)}
                    </select>
                    <button class="tb-btn toggle" data-act="wrap" title="${escapeHtml(t('Wrap long lines'))}">${icon('wrap')}</button>
                    <button class="tb-btn toggle" data-act="follow" title="${escapeHtml(t('Auto-scroll (follow live data)'))}">${icon('follow')}<span>${escapeHtml(t('Follow'))}</span></button>
                    <button class="tb-btn toggle" data-act="pause" title="${escapeHtml(t('Freeze display (capture continues)'))}">${icon('pause')}</button>
                    <button class="tb-btn" data-act="clear" title="${escapeHtml(t('Clear (Ctrl+K)'))}">${icon('trash')}</button>
                    <button class="tb-btn" data-act="marker" title="${escapeHtml(t('Insert marker (Ctrl+M)'))}">${icon('flag')}</button>
                    <span class="tb-sep"></span>
                    <div class="chrono" data-role="chrono" title="${escapeHtml(t('Chronometer: start/stop manually, or from triggers'))}">
                        <button class="tb-btn icon-only" data-act="sw-toggle">${icon('play', 14)}</button>
                        <button class="tb-btn icon-only" data-act="sw-lap" title="${escapeHtml(t('Lap'))}">${icon('lap', 14)}</button>
                        <span class="chrono-display" data-act="sw-laps" title="${escapeHtml(t('Show laps'))}">--:--.---</span>
                        <button class="tb-btn icon-only" data-act="sw-reset" title="${escapeHtml(t('Reset chronometer'))}">${icon('reset', 14)}</button>
                    </div>
                    <span class="tb-sep"></span>
                    <button class="tb-btn toggle" data-act="timeline" title="${escapeHtml(t('RX/TX timeline'))}">${icon('wave')}<span>${escapeHtml(t('Timeline'))}</span></button>
                    <button class="tb-btn toggle" data-act="plotter" title="${escapeHtml(t('Serial plotter'))}">${icon('chart')}<span>${escapeHtml(t('Plot'))}</span></button>
                    <button class="tb-btn toggle" data-act="decoder" title="${escapeHtml(t('Protocol decoder'))}">${icon('decode')}<span>${escapeHtml(t('Decode'))}</span></button>
                    <span class="spacer"></span>
                    <button class="tb-btn toggle" data-act="log-disk" title="${escapeHtml(t('Record to disk'))}">${icon('record')}<span>${escapeHtml(t('Rec'))}</span></button>
                    <button class="tb-btn" data-act="export" title="${escapeHtml(t('Export (Ctrl+E)'))}">${icon('download')}</button>
                    <button class="tb-btn" data-act="save-capture" title="${escapeHtml(t('Save capture (.dtcap)'))}">${icon('save')}</button>
                    <button class="tb-btn" data-act="send-file" title="${escapeHtml(t('Send a file'))}">${icon('fileSend')}<span>${escapeHtml(t('Send file'))}</span></button>
                    <button class="tb-btn icon-only" data-act="more" title="${escapeHtml(t('More'))}">${icon('more')}</button>
                </div>
                <div class="tv-body">
                    <div class="tv-main">
                        <div class="tv-term"></div>
                        <div class="tv-timeline"></div>
                    </div>
                    <div class="tv-splitter hidden"></div>
                    <div class="tv-side hidden"></div>
                </div>
                <div class="tv-filesend hidden"></div>
                <div class="tv-replay hidden"></div>
                <div class="tv-macros"></div>
                <div class="tv-send">
                    <div class="seg" data-role="send-mode">
                        <button data-mode="text">${escapeHtml(t('Text'))}</button>
                        <button data-mode="hex">HEX</button>
                    </div>
                    <input class="input send-input" data-role="send-input" spellcheck="false" autocomplete="off">
                    <select class="input sm" data-role="line-ending" title="${escapeHtml(t('Line ending'))}">
                        ${options([['none', t('None')], ['NL', 'LF \\n'], ['CR', 'CR \\r'], ['CRNL', 'CRLF \\r\\n'], ['NLCR', 'LFCR \\n\\r']], s.send.lineEnding)}
                    </select>
                    <label class="chk" title="${escapeHtml(t('Interpret escapes like \\n, \\r, \\x1B'))}"><input type="checkbox" data-role="escapes"> \\x</label>
                    <label class="chk repeat-chk" title="${escapeHtml(t('Send periodically'))}"><input type="checkbox" data-role="repeat"> ${escapeHtml(t('Every'))}</label>
                    <input class="input xs" type="number" min="10" data-role="repeat-ms" value="${s.send.repeatMs}" title="ms">
                    <span class="unit">ms</span>
                    <button class="btn btn-primary send-btn" data-act="send">${escapeHtml(t('Send'))}</button>
                </div>
            </div>`);
        this.q = (sel) => this.root.querySelector(sel);
        this.termHost = this.q('.tv-term');
        this.timelineHost = this.q('.tv-timeline');
        this.sideHost = this.q('.tv-side');
        this.splitter = this.q('.tv-splitter');
        this.macroBar = this.q('.tv-macros');
        this.sendInput = this.q('[data-role="send-input"]');
        this.historyIndex = -1;

        this.terminal = new TerminalView(s, this.termHost, {
            onSelect: (entry, info) => this.onEntrySelected(entry, info),
            onContextMenu: (entry, e, selected) => this.showEntryMenu(entry, e, selected),
            onFollowChange: () => this.syncToolbar(),
            onSearchUpdate: (info) => this.updateSearchCount(info)
        });
        if (s.timeline.visible) this.showTimeline(true);
        if (s.panels.plotter) this.togglePlotter(true);
        if (s.panels.decoder) this.toggleDecoder(true);

        this.bindEvents();
        this.refreshPortOptions();
        this.renderMacroBar();
        this.syncToolbar();
        this.syncState();
        this.syncSignals();
        this.updateFormatLabel();
        this.chronoTimer = setInterval(() => this.updateChrono(), 47);
        this.updateChrono();
        if (virtual) {
            this.q('.tv-send').classList.add('hidden');
            this.macroBar.classList.add('hidden');
            if (s.kind === 'replay') queueMicrotask(() => this.bindReplay());
        }
    }

    bindReplay() {
        const s = this.session;
        const bar = this.q('.tv-replay');
        if (this.disposed) return;
        if (!s.replay) {
            setTimeout(() => this.bindReplay(), 50);
            return;
        }
        const ctl = s.replay;
        bar.classList.remove('hidden');
        bar.innerHTML = `
            <span class="fs-label">${escapeHtml(t('Replay'))}</span>
            <button class="tb-btn" data-r="play">${icon('play', 14)}<span>${escapeHtml(t('Play'))}</span></button>
            <button class="tb-btn" data-r="stop">${icon('pause', 14)}<span>${escapeHtml(t('Pause'))}</span></button>
            <button class="tb-btn" data-r="all">${escapeHtml(t('Load all'))}</button>
            <select class="input sm" data-r="speed">${options([[0.1, '0.1x'], [0.25, '0.25x'], [0.5, '0.5x'], [1, '1x'], [2, '2x'], [5, '5x'], [10, '10x'], [50, '50x'], [200, '200x']], ctl.speed)}</select>
            <div class="progress"><div class="progress-bar" data-r="bar"></div></div>
            <span class="fs-info" data-r="info"></span>`;
        const update = () => {
            bar.querySelector('[data-r="bar"]').style.width = `${(ctl.progress * 100).toFixed(1)}%`;
            bar.querySelector('[data-r="info"]').textContent = `${ctl.index} / ${ctl.chunks.length} ${t('chunks')}${ctl.playing ? ' - ' + t('playing') : ''}`;
            bar.querySelector('[data-r="play"]').classList.toggle('active', ctl.playing);
        };
        bar.addEventListener('click', (e) => {
            const b = e.target.closest('[data-r]');
            if (!b) return;
            if (b.dataset.r === 'play') ctl.play();
            else if (b.dataset.r === 'stop') ctl.stop();
            else if (b.dataset.r === 'all') ctl.loadAll();
        });
        bar.querySelector('[data-r="speed"]').addEventListener('change', (e) => ctl.setSpeed(parseFloat(e.target.value)));
        this.subscriptions.push(ctl.onChange(update));
        update();
    }

    bindEvents() {
        const s = this.session;
        this.root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn || !this.root.contains(btn)) return;
            if (btn.closest('.side-panel, .tl, .term')) return;
            this.action(btn.dataset.act, btn);
        });
        this.q('[data-role="port"]').addEventListener('change', async (e) => {
            const wasOpen = s.state !== 'closed';
            await s.setPath(e.target.value);
            this.syncComnex();
            if (wasOpen && e.target.value) await this.connect();
        });
        this.q('[data-role="port"]').addEventListener('mousedown', () => refreshPorts());
        const baud = this.q('[data-role="baud"]');
        const applyBaud = () => {
            const value = parseInt(baud.value, 10);
            if (!value || value < 50) {
                baud.value = s.options.baudRate;
                return;
            }
            if (value !== s.options.baudRate) {
                s.updateOptions({ baudRate: value });
                this.updateFormatLabel();
            }
        };
        baud.addEventListener('change', applyBaud);
        baud.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                applyBaud();
                baud.blur();
            }
        });
        this.q('[data-role="dir-filter"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-dir]');
            if (b) s.updateView({ dirFilter: b.dataset.dir });
            this.syncToolbar();
        });
        this.q('[data-role="view-mode"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-mode]');
            if (b) s.updateView({ viewMode: b.dataset.mode });
            this.syncToolbar();
        });
        this.q('[data-role="ts-mode"]').addEventListener('change', (e) => {
            s.updateView({ timestampMode: e.target.value });
        });
        this.q('[data-role="send-mode"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-mode]');
            if (!b) return;
            s.send.mode = b.dataset.mode;
            this.syncToolbar();
            this.sendInput.focus();
        });
        this.q('[data-role="line-ending"]').addEventListener('change', (e) => { s.send.lineEnding = e.target.value; });
        this.q('[data-role="escapes"]').addEventListener('change', (e) => { s.send.escapes = e.target.checked; });
        this.q('[data-role="repeat-ms"]').addEventListener('change', (e) => {
            s.send.repeatMs = Math.max(10, parseInt(e.target.value, 10) || 1000);
            e.target.value = s.send.repeatMs;
            if (isRunning(`${s.id}:__input`)) this.startRepeat();
        });
        this.q('[data-role="repeat"]').addEventListener('change', (e) => {
            if (!e.target.checked) stopPeriodic(`${s.id}:__input`);
            this.syncSendButton();
        });
        this.q('[data-role="comnex-power"]').addEventListener('change', (e) => {
            s.comnex = { ...(s.comnex || {}), power: e.target.value };
            sendComnexPower(s, e.target.value);
        });

        this.sendInput.addEventListener('keydown', (e) => this.onSendKey(e));
        this.sendInput.addEventListener('input', () => this.validateSendInput());

        const search = this.q('[data-role="search"]');
        const applySearch = debounce(() => this.terminal.setSearch({ query: search.value }), 160);
        search.addEventListener('input', applySearch);
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applySearch.cancel();
                if (this.terminal.search.query !== search.value) this.terminal.setSearch({ query: search.value });
                this.terminal.searchStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
                search.value = '';
                this.terminal.setSearch({ query: '' });
                this.terminal.focus();
            }
        });

        this.splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = this.sideHost.offsetWidth;
            const move = (ev) => {
                const w = Math.max(240, Math.min(this.root.clientWidth - 300, startW - (ev.clientX - startX)));
                this.sideHost.style.width = `${w}px`;
                s.panels.sideWidth = w;
            };
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });

        this.root.addEventListener('dragover', (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
                e.preventDefault();
                this.root.classList.add('drop-target');
            }
        });
        this.root.addEventListener('dragleave', (e) => {
            if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('drop-target');
        });
        this.root.addEventListener('drop', (e) => {
            this.root.classList.remove('drop-target');
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file || !file.path) return;
            e.preventDefault();
            e.stopPropagation();
            if (/\.dtcap$/i.test(file.path)) return;
            openSendFileModal(s, file.path);
        });

        this.subscriptions.push(
            s.on('state', () => {
                this.syncState();
                this.syncSendButton();
            }),
            s.on('signals', () => this.syncSignals()),
            s.on('path', () => {
                this.refreshPortOptions();
                this.syncComnex();
            }),
            s.on('view', () => this.syncToolbar()),
            s.on('paused', () => this.syncToolbar()),
            s.on('logging', () => this.syncToolbar()),
            s.on('auto-reconnect', () => this.syncToolbar()),
            s.on('stopwatch', () => this.updateChrono(true)),
            s.on('options', () => {
                this.q('[data-role="baud"]').value = s.options.baudRate;
                this.updateFormatLabel();
            }),
            onEvent('ports:changed', () => this.refreshPortOptions()),
            onEvent('store:macros', () => this.renderMacroBar()),
            onEvent('macros:running', () => {
                this.renderMacroBar();
                this.syncSendButton();
            }),
            onEvent('settings:changed', (key) => {
                if (key === '*' || key.startsWith('logging')) this.syncToolbar();
            }),
            on('filesend:progress', (p) => this.onFileProgress(p)),
            on('logger:state', (p) => {
                if (p.path === s.path) this.syncToolbar();
            })
        );
    }

    action(act, btn) {
        const s = this.session;
        switch (act) {
            case 'refresh-ports': refreshPorts(); break;
            case 'serial-options': this.openSerialOptions(btn); break;
            case 'connect': this.toggleConnection(); break;
            case 'auto-reconnect': s.setAutoReconnect(!s.autoReconnect); break;
            case 'reset': s.reset(); break;
            case 'dtr': s.setSignals({ dtr: !s.signals.dtr }); break;
            case 'rts': s.setSignals({ rts: !s.signals.rts }); break;
            case 'break': s.sendBreak(); break;
            case 'search-case':
                this.terminal.setSearch({ caseSensitive: !this.terminal.search.caseSensitive });
                this.syncToolbar();
                break;
            case 'search-regex':
                this.terminal.setSearch({ regex: !this.terminal.search.regex });
                this.syncToolbar();
                break;
            case 'search-filter':
                this.terminal.setSearch({ filterOnly: !this.terminal.search.filterOnly });
                this.syncToolbar();
                break;
            case 'search-prev': this.terminal.searchStep(-1); break;
            case 'search-next': this.terminal.searchStep(1); break;
            case 'control-chars': s.updateView({ showControl: !s.view.showControl }); break;
            case 'wrap': s.updateView({ wrap: !s.view.wrap }); break;
            case 'follow': this.terminal.setFollow(!s.view.follow); break;
            case 'pause': s.setPaused(!s.paused); break;
            case 'clear': s.clear(); break;
            case 'marker': this.insertMarker(); break;
            case 'sw-toggle': s.swToggle(); break;
            case 'sw-lap': s.swLap(); break;
            case 'sw-reset': s.swReset(); break;
            case 'sw-laps': this.showLaps(btn); break;
            case 'timeline': this.showTimeline(!s.timeline.visible); break;
            case 'plotter': this.togglePlotter(!s.panels.plotter); break;
            case 'decoder': this.toggleDecoder(!s.panels.decoder); break;
            case 'log-disk': s.setLogging(!s.effectiveLogging()); break;
            case 'export': openExportModal(s, this.terminal); break;
            case 'save-capture': saveCapture(s); break;
            case 'send-file': openSendFileModal(s); break;
            case 'more': this.showMoreMenu(btn); break;
            case 'send': this.onSendButton(); break;
            case 'macro': {
                const id = btn.dataset.id;
                if (id) runMacro(id, s);
                break;
            }
            case 'macro-add': this.addMacroFromInput(); break;
            case 'macro-edit': openMacrosEditor(); break;
            case 'fs-pause':
            case 'fs-resume':
            case 'fs-cancel':
                if (this.fileJob) invoke('filesend:control', this.fileJob.jobId, act.slice(3));
                break;
            case 'fs-close':
                this.fileJob = null;
                this.q('.tv-filesend').classList.add('hidden');
                break;
            default: break;
        }
        if (['dtr', 'rts', 'control-chars', 'wrap', 'pause', 'follow'].includes(act)) this.syncToolbar();
    }

    async connect() {
        const result = await this.session.open();
        if (!result.success && result.error) toast(`${this.session.path || t('Port')}: ${result.error}`, { type: 'error', timeout: 5000 });
        if (result.success && this.session.comnex && this.session.comnex.power) {
            setTimeout(() => sendComnexPower(this.session, this.session.comnex.power), 150);
        }
        return result;
    }

    async toggleConnection() {
        const s = this.session;
        if (s.isVirtual) return;
        if (s.state === 'closed' || s.state === 'given-up') {
            if (!s.path) {
                toast(t('Select a port first'), { type: 'warn' });
                this.q('[data-role="port"]').focus();
                return;
            }
            await this.connect();
        } else {
            await s.close();
        }
    }

    refreshPortOptions() {
        const select = this.q('[data-role="port"]');
        const s = this.session;
        if (s.isVirtual) {
            select.innerHTML = `<option>${escapeHtml(s.displayName)}</option>`;
            select.disabled = true;
            return;
        }
        const list = sortPorts(getPorts());
        let html = `<option value="">${escapeHtml(t('Select port...'))}</option>`;
        let found = false;
        for (const p of list) {
            if (p.path === s.path) found = true;
            html += `<option value="${escapeHtml(p.path)}" ${p.path === s.path ? 'selected' : ''}>${escapeHtml(portLabel(p))}</option>`;
        }
        if (s.path && !found) html += `<option value="${escapeHtml(s.path)}" selected>${escapeHtml(s.path)} (${escapeHtml(t('absent'))})</option>`;
        select.innerHTML = html;
        select.title = s.path ? portLabel(list.find(p => p.path === s.path)) || s.path : t('Serial port');
        this.syncComnex();
    }

    syncComnex() {
        const s = this.session;
        const visible = !!s.path && isComnexPort(s.path);
        const sel = this.q('[data-role="comnex-power"]');
        sel.classList.toggle('hidden', !visible);
        if (visible && !s.comnex) s.comnex = { power: '3.3V' };
        if (s.comnex) sel.value = s.comnex.power || '3.3V';
    }

    updateFormatLabel() {
        const o = this.session.options;
        const parity = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[o.parity] || 'N';
        this.q('[data-role="format-label"]').textContent = `${o.dataBits}${parity}${o.stopBits}${o.flowControl !== 'none' ? ' ' + (o.flowControl === 'rtscts' ? 'HW' : 'SW') : ''}`;
    }

    syncState() {
        const s = this.session;
        const chip = this.q('[data-role="state"]');
        chip.className = `state-chip st-${s.state}`;
        chip.textContent = stateLabel(s.state, s.stateInfo);
        chip.title = s.stateInfo && s.stateInfo.reason ? s.stateInfo.reason : (s.stateInfo && s.stateInfo.error ? s.stateInfo.error : '');
        const btn = this.q('[data-act="connect"]');
        if (s.state === 'closed' || s.state === 'given-up') {
            btn.textContent = t('Connect');
            btn.className = 'btn btn-primary connect-btn';
        } else if (s.state === 'open') {
            btn.textContent = t('Disconnect');
            btn.className = 'btn btn-danger connect-btn';
        } else {
            btn.textContent = t('Cancel');
            btn.className = 'btn btn-warn connect-btn';
        }
        btn.disabled = s.state === 'opening' || s.state === 'suspended';
        const open = s.state === 'open';
        for (const act of ['reset', 'dtr', 'rts', 'break']) this.q(`[data-act="${act}"]`).disabled = !open;
        this.q('[data-act="send-file"]').disabled = !open;
        this.root.classList.toggle('is-open', open);
        this.syncSignals();
    }

    syncSignals() {
        const sig = this.session.signals || {};
        const open = this.session.state === 'open';
        this.q('[data-act="dtr"]').classList.toggle('active', open && !!sig.dtr);
        this.q('[data-act="rts"]').classList.toggle('active', open && !!sig.rts);
        this.q('[data-act="break"]').classList.toggle('active', open && !!sig.brk);
        for (const led of this.root.querySelectorAll('[data-led]')) led.classList.toggle('on', open && !!sig[led.dataset.led]);
    }

    syncToolbar() {
        const s = this.session;
        const setActive = (sel, value) => {
            const node = this.q(sel);
            if (node) node.classList.toggle('active', !!value);
        };
        for (const b of this.root.querySelectorAll('[data-role="dir-filter"] [data-dir]')) b.classList.toggle('active', b.dataset.dir === s.view.dirFilter);
        for (const b of this.root.querySelectorAll('[data-role="view-mode"] [data-mode]')) b.classList.toggle('active', b.dataset.mode === s.view.viewMode);
        for (const b of this.root.querySelectorAll('[data-role="send-mode"] [data-mode]')) b.classList.toggle('active', b.dataset.mode === s.send.mode);
        this.q('[data-role="ts-mode"]').value = s.view.timestampMode;
        setActive('[data-act="control-chars"]', s.view.showControl);
        setActive('[data-act="wrap"]', s.view.wrap);
        setActive('[data-act="follow"]', s.view.follow);
        setActive('[data-act="pause"]', s.paused);
        setActive('[data-act="timeline"]', s.timeline.visible);
        setActive('[data-act="plotter"]', s.panels.plotter);
        setActive('[data-act="decoder"]', s.panels.decoder);
        setActive('[data-act="log-disk"]', s.effectiveLogging());
        setActive('[data-act="auto-reconnect"]', s.autoReconnect);
        setActive('[data-act="search-case"]', this.terminal.search.caseSensitive);
        setActive('[data-act="search-regex"]', this.terminal.search.regex);
        setActive('[data-act="search-filter"]', this.terminal.search.filterOnly);
        this.q('[data-role="escapes"]').checked = !!s.send.escapes;
        this.q('[data-role="line-ending"]').value = s.send.lineEnding;
        this.q('[data-role="line-ending"]').disabled = s.send.mode === 'hex';
        this.q('[data-role="escapes"]').disabled = s.send.mode === 'hex';
        this.sendInput.placeholder = s.send.mode === 'hex'
            ? t('Hex bytes, e.g. 01 03 00 00 00 0A {crc16modbus}')
            : t('Type a message... (Enter to send, Up/Down for history)');
        this.root.classList.toggle('paused', s.paused);
        this.validateSendInput();
    }

    updateSearchCount(info) {
        const node = this.q('[data-role="search-count"]');
        const input = this.q('[data-role="search"]');
        input.classList.toggle('invalid', !!info.error);
        if (info.error) node.textContent = t('invalid');
        else if (!info.active) node.textContent = '';
        else node.textContent = info.count ? `${info.index + 1}/${info.count}` : '0';
    }

    updateChrono(force) {
        const s = this.session;
        const sw = s.stopwatch;
        if (!force && !sw.running && this.lastChronoState === `${sw.startT}|${sw.stopT}|${sw.laps.length}`) return;
        this.lastChronoState = `${sw.startT}|${sw.stopT}|${sw.laps.length}`;
        const display = this.q('.chrono-display');
        display.textContent = formatStopwatch(s.swElapsed(mainNow()));
        display.classList.toggle('running', sw.running);
        const toggle = this.q('[data-act="sw-toggle"]');
        toggle.innerHTML = sw.running ? icon('stop', 14) : icon('play', 14);
        toggle.title = sw.running ? t('Stop chronometer') : t('Start chronometer');
    }

    showLaps(anchor) {
        const sw = this.session.stopwatch;
        const rows = sw.laps.map((lap, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(lap.label)}</td><td>${formatDuration(lap.split)}</td><td>${formatDuration(lap.total)}</td></tr>`).join('');
        const html = `
            <div class="laps">
                <div class="laps-head">${escapeHtml(t('Chronometer'))}: <b>${formatStopwatch(this.session.swElapsed(mainNow()))}</b></div>
                ${sw.laps.length ? `<table class="kv laps-table"><tr><th>#</th><th>${escapeHtml(t('Label'))}</th><th>${escapeHtml(t('Split'))}</th><th>${escapeHtml(t('Total'))}</th></tr>${rows}</table>` : `<div class="dim">${escapeHtml(t('No laps. Use the lap button, or triggers with a chronometer action.'))}</div>`}
                <div class="laps-actions"><button class="btn sm" data-copy>${escapeHtml(t('Copy'))}</button></div>
            </div>`;
        const pop = popover(anchor, html);
        const copy = pop.node.querySelector('[data-copy]');
        copy.addEventListener('click', () => {
            const text = sw.laps.map((lap, i) => `${i + 1}\t${lap.label}\t${lap.split.toFixed(3)}\t${lap.total.toFixed(3)}`).join('\n');
            navigator.clipboard.writeText(text);
            closePopover();
        });
    }

    insertMarker() {
        promptDialog({ title: t('Insert marker'), label: t('Marker label'), value: t('Marker {n}', { n: this.session.capture.markers.length + 1 }) }).then((label) => {
            if (label === null) return;
            this.session.addMarker(label || t('Marker'), { color: getSetting('timeline.markerColor', '#ffb300') });
        });
    }

    showTimeline(visible) {
        const s = this.session;
        s.timeline.visible = visible;
        if (visible && !this.timeline) {
            this.timeline = new TimelineView(s, this.timelineHost, {
                onPick: (entry) => {
                    this.terminal.scrollToEntry(entry, { center: true, select: true });
                    if (this.decoderPanel) this.decoderPanel.selectEntry(entry);
                },
                onHeightChange: () => { }
            });
        } else if (!visible && this.timeline) {
            this.timeline.dispose();
            this.timeline = null;
        }
        this.timelineHost.classList.toggle('hidden', !visible);
        this.syncToolbar();
    }

    updateSide() {
        const s = this.session;
        const any = s.panels.plotter || s.panels.decoder;
        this.sideHost.classList.toggle('hidden', !any);
        this.splitter.classList.toggle('hidden', !any);
        this.sideHost.style.width = `${s.panels.sideWidth || 420}px`;
        this.sideHost.classList.toggle('two', s.panels.plotter && s.panels.decoder);
    }

    togglePlotter(visible) {
        const s = this.session;
        s.panels.plotter = visible;
        if (visible && !this.plotter) {
            this.plotter = new PlotterPanel(s, this.sideHost, { onClose: () => this.togglePlotter(false) });
        } else if (!visible && this.plotter) {
            this.plotter.dispose();
            this.plotter = null;
        }
        this.updateSide();
        this.syncToolbar();
    }

    toggleDecoder(visible) {
        const s = this.session;
        s.panels.decoder = visible;
        if (visible && !this.decoderPanel) {
            this.decoderPanel = new DecoderPanel(s, this.sideHost, {
                onPick: (entry) => {
                    this.terminal.scrollToEntry(entry, { center: true, select: true });
                    if (this.timeline) this.timeline.highlight(entry, { center: true });
                },
                onClose: () => this.toggleDecoder(false),
                onEditCustom: () => openCustomDecodersEditor()
            });
        } else if (!visible && this.decoderPanel) {
            this.decoderPanel.dispose();
            this.decoderPanel = null;
        }
        this.updateSide();
        this.syncToolbar();
    }

    onEntrySelected(entry, info) {
        if (this.timeline) this.timeline.highlight(entry, { center: !!info.fromSearch || !this.session.view.follow });
        if (this.decoderPanel && !info.fromDecoder) this.decoderPanel.selectEntry(entry);
        if (info.open && entry.kind === 'data') openAnalysis(this.session, entry);
    }

    showEntryMenu(entry, e, selected) {
        const s = this.session;
        const items = [];
        const isData = entry.kind === 'data';
        items.push({ label: t('Copy text'), shortcut: 'Ctrl+C', action: () => this.terminal.copySelection('text', selected) });
        items.push({ label: t('Copy as hex'), action: () => this.terminal.copySelection('hex', selected) });
        items.push({ label: t('Copy with timestamps'), action: () => this.terminal.copySelection('full', selected) });
        items.push({ separator: true });
        if (isData) {
            items.push({ label: t('Analyze frame...'), action: () => openAnalysis(s, entry) });
            items.push({ label: t('Put in send box'), action: () => this.putInSendBox(entry) });
            items.push({ label: t('Send again'), disabled: !s.canWrite, action: () => s.write(entryBytes(entry).slice()) });
            items.push({ separator: true });
        }
        const at = entry.dir === 'TX' ? entry.t : (entry.tEnd || entry.t);
        items.push({ label: t('Start chronometer here'), action: () => s.swStart(isData ? entry.t : at) });
        items.push({ label: t('Stop chronometer here'), disabled: !s.stopwatch.running, action: () => s.swStop(at) });
        items.push({ label: t('Lap here'), action: () => s.swLap(at) });
        if (selected.length === 2) {
            const [a, b] = selected;
            items.push({ label: t('Measure between selected frames ({d})', { d: formatDuration(Math.abs(b.t - a.t)) }), action: () => this.measureBetween(a, b) });
        }
        items.push({ separator: true });
        items.push({ label: t('Timeline cursor A here'), action: () => this.ensureTimeline().setCursorAt('a', entry.t) });
        items.push({ label: t('Timeline cursor B here'), action: () => this.ensureTimeline().setCursorAt('b', entry.tEnd || entry.t) });
        items.push({ label: t('Show in timeline'), action: () => this.ensureTimeline().highlight(entry, { center: true }) });
        items.push({ label: t('Insert marker before'), action: () => s.addMarker(t('Marker'), { t: entry.t - 0.0001, color: getSetting('timeline.markerColor', '#ffb300') }) });
        if (isData) {
            items.push({ separator: true });
            items.push({ label: t('Create trigger from this frame...'), action: () => this.createTriggerFrom(entry) });
            items.push({ label: t('Highlight similar frames...'), action: () => this.createHighlightFrom(entry) });
            if (entry.dir === 'TX') items.push({ label: t('Save as macro...'), action: () => this.createMacroFrom(entry) });
        }
        contextMenu(e.clientX, e.clientY, items);
    }

    ensureTimeline() {
        if (!this.timeline) this.showTimeline(true);
        return this.timeline;
    }

    measureBetween(a, b) {
        const tl = this.ensureTimeline();
        const first = a.t <= b.t ? a : b;
        const second = a.t <= b.t ? b : a;
        tl.setCursorAt('a', first.t);
        tl.setCursorAt('b', second.t);
        toast(t('Start to start: {a} - End to start: {b}', { a: formatDuration(second.t - first.t), b: formatDuration(second.t - first.tEnd) }), { timeout: 6000 });
    }

    putInSendBox(entry) {
        const bytes = entryBytes(entry);
        const s = this.session;
        const printable = bytes.every(b => (b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D || b === 0x09);
        if (printable && s.send.mode === 'text') {
            this.sendInput.value = entryText(entry).replace(/[\r\n]+$/, '');
        } else {
            s.send.mode = 'hex';
            this.sendInput.value = toHex(bytes);
            this.syncToolbar();
        }
        this.sendInput.focus();
    }

    createTriggerFrom(entry) {
        const text = entryText(entry).replace(/[\r\n]+$/, '');
        const trigger = { ...defaultTrigger(), name: text.slice(0, 24) || t('Trigger'), pattern: text.slice(0, 80), direction: entry.dir };
        saveTriggers([...getTriggers(), trigger]);
        openTriggersEditor(trigger.id);
    }

    createHighlightFrom(entry) {
        const text = entryText(entry).replace(/[\r\n]+$/, '').slice(0, 40);
        const rule = { id: uid(), enabled: true, pattern: text, regex: false, caseSensitive: false, color: '#ffd54f', background: '', bold: true, scope: 'match' };
        saveHighlightRules([...getHighlightRules(), rule]);
        openHighlightsEditor(rule.id);
    }

    createMacroFrom(entry) {
        const bytes = entryBytes(entry);
        const printable = bytes.every(b => (b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D);
        const macro = defaultMacro();
        if (printable) {
            const text = entryText(entry);
            const m = text.match(/(\r\n|\n\r|\r|\n)$/);
            macro.payload = text.replace(/[\r\n]+$/, '');
            macro.lineEnding = m ? ({ '\r\n': 'CRNL', '\n\r': 'NLCR', '\r': 'CR', '\n': 'NL' })[m[1]] : 'none';
        } else {
            macro.mode = 'hex';
            macro.payload = toHex(bytes);
            macro.lineEnding = 'none';
        }
        macro.name = macro.payload.slice(0, 20);
        saveMacros([...getMacros(), macro]);
        openMacrosEditor(macro.id);
    }

    showMoreMenu(anchor) {
        const s = this.session;
        const rect = anchor.getBoundingClientRect();
        contextMenu(rect.left - 180, rect.bottom + 4, [
            { label: t('Macros...'), action: () => openMacrosEditor() },
            { label: t('Triggers and alerts...'), action: () => openTriggersEditor() },
            { label: t('Highlight rules...'), action: () => openHighlightsEditor() },
            { label: t('Custom frame parsers...'), action: () => openCustomDecodersEditor() },
            { separator: true },
            { label: t('Statistics...'), action: () => openStats(s) },
            { label: t('Compare with a file...'), action: () => openCompare(s) },
            { label: t('Bridges (TCP / WebSocket / COM)...'), action: () => openBridges(s) },
            { separator: true },
            { label: t('Snapshot capture to log folder'), action: () => snapshotCapture(s, s.displayName) },
            { label: t('Rename tab...'), action: () => this.renameTab() },
            { label: t('Clear send history'), action: () => { s.sendHistory = []; } }
        ]);
    }

    async renameTab() {
        const name = await promptDialog({ title: t('Rename tab'), label: t('Tab title (empty for port name)'), value: this.session.title });
        if (name === null) return;
        this.session.title = name.trim();
        this.session.emit('path', this.session.path, this.session.path);
    }

    openSerialOptions(anchor) {
        const s = this.session;
        const o = s.options;
        const f = s.framing;
        const node = el(`
            <div class="serial-options">
                <div class="form-grid">
                    <label>${escapeHtml(t('Data bits'))}</label><select class="input sm" data-k="dataBits">${options([5, 6, 7, 8], o.dataBits)}</select>
                    <label>${escapeHtml(t('Parity'))}</label><select class="input sm" data-k="parity">${options([['none', t('None')], ['even', t('Even')], ['odd', t('Odd')], ['mark', t('Mark')], ['space', t('Space')]], o.parity)}</select>
                    <label>${escapeHtml(t('Stop bits'))}</label><select class="input sm" data-k="stopBits">${options([1, 1.5, 2], o.stopBits)}</select>
                    <label>${escapeHtml(t('Flow control'))}</label><select class="input sm" data-k="flowControl">${options([['none', t('None')], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']], o.flowControl)}</select>
                    <label>${escapeHtml(t('DTR on open'))}</label><input type="checkbox" data-k="dtrOnOpen" ${o.dtrOnOpen ? 'checked' : ''}>
                    <label>${escapeHtml(t('RTS on open'))}</label><input type="checkbox" data-k="rtsOnOpen" ${o.rtsOnOpen ? 'checked' : ''}>
                </div>
                <div class="form-sep">${escapeHtml(t('Frame splitting (RX)'))}</div>
                <div class="form-grid">
                    <label>${escapeHtml(t('Mode'))}</label><select class="input sm" data-f="mode">${options([
                        ['delimiter', t('Delimiter')],
                        ['timeout', t('Silence timeout')],
                        ['fixed', t('Fixed length')],
                        ['chunk', t('Raw USB chunks')]
                    ], f.mode)}</select>
                    <label>${escapeHtml(t('Delimiter (hex)'))}</label><input class="input sm" data-f="delimiter" value="${escapeHtml(f.delimiter)}">
                    <label>${escapeHtml(t('Silence (ms)'))}</label><input class="input sm" type="number" min="1" data-f="timeoutMs" value="${f.timeoutMs}">
                    <label>${escapeHtml(t('Length (bytes)'))}</label><input class="input sm" type="number" min="1" data-f="length" value="${f.length}">
                    <label>${escapeHtml(t('Max frame (bytes)'))}</label><input class="input sm" type="number" min="16" data-f="maxLength" value="${f.maxLength}">
                    <label>${escapeHtml(t('Flush idle after (ms)'))}</label><input class="input sm" type="number" min="0" data-f="flushMs" value="${f.flushMs}">
                    <label>${escapeHtml(t('TX frames'))}</label><select class="input sm" data-f="txMode">${options([['write', t('One per send')], ['framed', t('Same rules as RX')]], f.txMode)}</select>
                </div>
            </div>`);
        node.addEventListener('change', (e) => {
            const target = e.target;
            if (target.dataset.k) {
                const key = target.dataset.k;
                let value = target.type === 'checkbox' ? target.checked : target.value;
                if (key === 'dataBits') value = parseInt(value, 10);
                if (key === 'stopBits') value = parseFloat(value);
                s.updateOptions({ [key]: value });
                this.updateFormatLabel();
            } else if (target.dataset.f) {
                const key = target.dataset.f;
                let value = target.value;
                if (['timeoutMs', 'length', 'maxLength', 'flushMs'].includes(key)) value = Math.max(0, parseFloat(value) || 0);
                s.updateFraming({ [key]: value });
            }
        });
        popover(anchor, node);
    }

    renderMacroBar() {
        const s = this.session;
        const macros = getMacros().filter(m => m.showInBar !== false);
        if (!macros.length) {
            this.macroBar.innerHTML = `<span class="dim macro-hint">${escapeHtml(t('Macros: save frequent commands, bind F1-F12, sequences and periodic sends.'))}</span>
                <button class="tb-btn sm" data-act="macro-add" title="${escapeHtml(t('Save the send box as a macro'))}">${icon('plus', 12)}<span>${escapeHtml(t('Add'))}</span></button>
                <button class="tb-btn sm" data-act="macro-edit">${escapeHtml(t('Edit...'))}</button>`;
            return;
        }
        this.macroBar.innerHTML = macros.map(m => {
            const running = isRunning(`${s.id}:${m.id}`);
            return `<button class="macro-btn ${running ? 'running' : ''}" data-act="macro" data-id="${escapeHtml(m.id)}" title="${escapeHtml(m.payload || (m.steps || []).map(st => st.payload).join(' | '))}" ${m.color ? `style="--macro-color:${escapeHtml(m.color)}"` : ''}>
                ${m.key ? `<kbd>${escapeHtml(m.key)}</kbd>` : ''}${escapeHtml(m.name)}${m.repeatMs > 0 ? `<small>${m.repeatMs}ms</small>` : ''}</button>`;
        }).join('') + `<button class="tb-btn sm" data-act="macro-add" title="${escapeHtml(t('Save the send box as a macro'))}">${icon('plus', 12)}</button>
            <button class="tb-btn sm" data-act="macro-edit" title="${escapeHtml(t('Edit macros'))}">${icon('gear', 12)}</button>`;
    }

    addMacroFromInput() {
        const s = this.session;
        const value = this.sendInput.value;
        const macro = { ...defaultMacro(), name: value ? value.slice(0, 20) : t('New macro'), payload: value, mode: s.send.mode, lineEnding: s.send.lineEnding, escapes: s.send.escapes };
        saveMacros([...getMacros(), macro]);
        openMacrosEditor(macro.id);
    }

    validateSendInput() {
        const s = this.session;
        let valid = true;
        if (s.send.mode === 'hex' && this.sendInput.value.trim()) {
            const cleaned = this.sendInput.value.replace(/\{[^}]*\}/g, '');
            valid = /^[\s0-9a-fA-Fx,;:\-]*$/.test(cleaned);
        }
        this.sendInput.classList.toggle('invalid', !valid);
        return valid;
    }

    onSendKey(e) {
        const s = this.session;
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            if (e.repeat) return;
            this.onSendButton();
            return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const hist = s.sendHistory;
            if (!hist.length) return;
            e.preventDefault();
            if (this.historyIndex === -1) this.draft = this.sendInput.value;
            if (e.key === 'ArrowUp') this.historyIndex = this.historyIndex === -1 ? hist.length - 1 : Math.max(0, this.historyIndex - 1);
            else this.historyIndex = this.historyIndex === -1 ? -1 : this.historyIndex + 1;
            if (this.historyIndex >= hist.length) this.historyIndex = -1;
            this.sendInput.value = this.historyIndex === -1 ? (this.draft || '') : hist[this.historyIndex];
            this.sendInput.setSelectionRange(this.sendInput.value.length, this.sendInput.value.length);
            this.validateSendInput();
            return;
        }
        if (e.key === 'Escape') {
            this.sendInput.value = '';
            this.historyIndex = -1;
        }
    }

    syncSendButton() {
        const s = this.session;
        const btn = this.q('[data-act="send"]');
        const repeating = isRunning(`${s.id}:__input`);
        btn.textContent = repeating ? t('Stop') : t('Send');
        btn.classList.toggle('btn-danger', repeating);
        btn.classList.toggle('btn-primary', !repeating);
        btn.disabled = !s.canWrite && !repeating;
    }

    startRepeat() {
        const s = this.session;
        const text = this.sendInput.value;
        if (!text) return;
        startPeriodicSend(s, text, s.send.repeatMs, { mode: s.send.mode, lineEnding: s.send.lineEnding, escapes: s.send.escapes });
        s.rememberSent(text);
    }

    async onSendButton() {
        const s = this.session;
        const key = `${s.id}:__input`;
        if (isRunning(key)) {
            stopPeriodic(key);
            return;
        }
        if (!s.canWrite) {
            toast(t('Port not open'), { type: 'warn' });
            return;
        }
        if (!this.validateSendInput()) {
            toast(t('Invalid hex input'), { type: 'error' });
            return;
        }
        const text = this.sendInput.value;
        if (this.q('[data-role="repeat"]').checked) {
            this.startRepeat();
            return;
        }
        if (this.sending) return;
        this.sending = true;
        try {
            const result = await s.sendText(text);
            if (result.success) {
                this.sendInput.value = '';
                this.historyIndex = -1;
            } else if (result.error) {
                toast(result.error, { type: 'error' });
            }
        } finally {
            this.sending = false;
        }
    }

    onFileProgress(p) {
        if (p.path !== this.session.path) return;
        if (this.fileJob && this.fileJob.jobId !== p.jobId && this.fileJob.state === 'running') return;
        this.fileJob = p;
        const strip = this.q('.tv-filesend');
        strip.classList.remove('hidden');
        const pct = p.totalBytes ? Math.min(100, (p.sentBytes / p.totalBytes) * 100) : 0;
        const done = ['done', 'error', 'cancelled'].includes(p.state);
        strip.innerHTML = `
            <span class="fs-label">${escapeHtml(t('File transfer'))}</span>
            <div class="progress"><div class="progress-bar ${p.state}" style="width:${pct.toFixed(1)}%"></div></div>
            <span class="fs-info">${formatBytes(p.sentBytes)} / ${formatBytes(p.totalBytes)} - ${pct.toFixed(1)}% - ${formatRate(p.rate)}${p.frameCount > 1 ? ` - ${t('frame')} ${Math.min(p.frameIndex + 1, p.frameCount)}/${p.frameCount}` : ''}${p.repeat > 1 ? ` - ${t('pass')} ${p.iteration}/${p.repeat}` : ''}</span>
            <span class="fs-log ${p.error ? 'err' : ''}">${escapeHtml(p.error || p.log || (p.state === 'done' ? t('Completed') : ''))}</span>
            ${done ? `<button class="tb-btn sm" data-act="fs-close">${escapeHtml(t('Close'))}</button>` : `
                ${p.state === 'paused' ? `<button class="tb-btn sm" data-act="fs-resume">${escapeHtml(t('Resume'))}</button>` : `<button class="tb-btn sm" data-act="fs-pause">${escapeHtml(t('Pause'))}</button>`}
                <button class="tb-btn sm" data-act="fs-cancel">${escapeHtml(t('Cancel'))}</button>`}`;
        if (done && p.state === 'done') {
            this.session.addSystem(t('File sent: {size} in {time}', { size: formatBytes(p.totalBytes), time: formatDuration(p.elapsedMs) }), 'success');
        } else if (done && p.state === 'error') {
            this.session.addSystem(t('File transfer failed: {error}', { error: p.error || '' }), 'error');
        }
    }

    focusSearch() {
        const input = this.q('[data-role="search"]');
        input.focus();
        input.select();
    }

    focusSend() {
        this.sendInput.focus();
    }

    dispose() {
        this.disposed = true;
        clearInterval(this.chronoTimer);
        for (const off of this.subscriptions) off();
        this.terminal.dispose();
        if (this.timeline) this.timeline.dispose();
        if (this.plotter) this.plotter.dispose();
        if (this.decoderPanel) this.decoderPanel.dispose();
        views.delete(this.session.id);
        this.root.remove();
    }
}
