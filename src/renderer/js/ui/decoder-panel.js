import { el, escapeHtml, options } from '../core/dom.js';
import { formatClock } from '../core/format.js';
import { getStore, loadStore } from '../core/store.js';
import { onEvent } from '../core/bus.js';
import { t } from '../core/i18n.js';
import { entryBytes } from '../serial/capture.js';
import { allDecoders, runDecoder } from '../lib/decoders.js';

const MAX_ROWS = 2000;

export class DecoderPanel {
    constructor(session, host, { onPick, onClose, onEditCustom } = {}) {
        this.session = session;
        this.host = host;
        this.onPick = onPick || (() => { });
        this.onClose = onClose || (() => { });
        this.onEditCustom = onEditCustom || (() => { });
        this.rows = [];
        this.onlyErrors = false;
        this.selectedSeq = null;
        this.build();
        this.reprocess();
        this.subscriptions = [
            session.on('frame', (entry) => this.onFrame(entry)),
            session.on('clear', () => this.reprocess()),
            onEvent('store:decoders-custom', () => {
                this.fillDecoders();
                this.reprocess();
            })
        ];
    }

    customDefs() {
        return getStore('decoders-custom', []) || [];
    }

    build() {
        this.root = el(`
            <div class="side-panel decoder-panel">
                <div class="panel-head">
                    <span class="panel-title">${escapeHtml(t('Decoder'))}</span>
                    <select class="input sm" data-role="decoder"></select>
                    <select class="input sm" data-role="dir">
                        ${options([['any', t('All')], ['RX', 'RX'], ['TX', 'TX']], this.session.decoder.dir)}
                    </select>
                    <label class="chk"><input type="checkbox" data-role="errors"> ${escapeHtml(t('Errors only'))}</label>
                    <span class="spacer"></span>
                    <button class="tb-btn" data-act="custom" title="${escapeHtml(t('Edit custom frame parsers'))}">${escapeHtml(t('Parsers'))}</button>
                    <button class="tb-btn" data-act="clear">${escapeHtml(t('Clear'))}</button>
                    <button class="icon-btn" data-act="close" title="${escapeHtml(t('Close'))}">&times;</button>
                </div>
                <div class="panel-stats"></div>
                <div class="decoder-list"></div>
                <div class="decoder-detail"></div>
            </div>`);
        this.list = this.root.querySelector('.decoder-list');
        this.detail = this.root.querySelector('.decoder-detail');
        this.stats = this.root.querySelector('.panel-stats');
        this.host.appendChild(this.root);
        this.fillDecoders();
        this.root.querySelector('[data-role="decoder"]').addEventListener('change', (e) => {
            this.session.decoder.id = e.target.value;
            this.reprocess();
        });
        this.root.querySelector('[data-role="dir"]').addEventListener('change', (e) => {
            this.session.decoder.dir = e.target.value;
            this.reprocess();
        });
        this.root.querySelector('[data-role="errors"]').addEventListener('change', (e) => {
            this.onlyErrors = e.target.checked;
            this.renderList();
        });
        this.root.querySelector('.panel-head').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            if (btn.dataset.act === 'close') this.onClose();
            else if (btn.dataset.act === 'clear') {
                this.rows = [];
                this.renderList();
            } else if (btn.dataset.act === 'custom') this.onEditCustom();
        });
        this.list.addEventListener('click', (e) => {
            const row = e.target.closest('[data-seq]');
            if (!row) return;
            const seq = parseInt(row.dataset.seq, 10);
            this.selectedSeq = seq;
            const item = this.rows.find(r => r.seq === seq);
            this.renderDetail(item);
            this.renderList();
            const idx = this.session.capture.indexOfSeq(seq);
            if (idx >= 0) this.onPick(this.session.capture.entries[idx]);
        });
    }

    fillDecoders() {
        const select = this.root.querySelector('[data-role="decoder"]');
        const decoders = allDecoders(this.customDefs());
        select.innerHTML = options(decoders.map(d => [d.id, d.label]), this.session.decoder.id);
        if (!decoders.some(d => d.id === this.session.decoder.id)) this.session.decoder.id = decoders[0].id;
    }

    decode(entry) {
        const bytes = entryBytes(entry);
        if (!bytes.length) return null;
        let cleaned = bytes;
        if (!['modbus-rtu', 'slip', 'cobs', 'checksum'].includes(this.session.decoder.id) && !this.session.decoder.id.startsWith('custom:')) {
            let end = bytes.length;
            while (end > 0 && (bytes[end - 1] === 0x0A || bytes[end - 1] === 0x0D)) end--;
            cleaned = bytes.subarray(0, end);
        }
        const result = runDecoder(this.session.decoder.id, cleaned, this.customDefs(), { dir: entry.dir });
        return { seq: entry.seq, t: entry.t, dir: entry.dir, len: bytes.length, result };
    }

    accept(entry) {
        if (entry.kind !== 'data' || entry.open) return false;
        const dir = this.session.decoder.dir;
        return dir === 'any' || entry.dir === dir;
    }

    reprocess() {
        this.rows = [];
        const entries = this.session.capture.entries;
        const start = Math.max(0, entries.length - 20000);
        for (let i = start; i < entries.length; i++) {
            const entry = entries[i];
            if (!this.accept(entry)) continue;
            const row = this.decode(entry);
            if (row) this.rows.push(row);
        }
        if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
        this.renderList();
    }

    onFrame(entry) {
        if (!this.accept(entry)) return;
        const row = this.decode(entry);
        if (!row) return;
        this.rows.push(row);
        if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
        if (!this.pending) {
            this.pending = true;
            requestAnimationFrame(() => {
                this.pending = false;
                this.renderList();
            });
        }
    }

    renderList() {
        const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 30;
        const rows = this.onlyErrors ? this.rows.filter(r => !r.result.ok) : this.rows;
        const visible = rows.slice(-500);
        const okCount = this.rows.filter(r => r.result.ok).length;
        this.stats.textContent = t('{n} frames, {ok} valid, {bad} invalid', { n: this.rows.length, ok: okCount, bad: this.rows.length - okCount });
        this.list.innerHTML = visible.map(r => `
            <div class="dec-row ${r.result.ok ? 'ok' : 'bad'} ${r.seq === this.selectedSeq ? 'sel' : ''}" data-seq="${r.seq}">
                <span class="ts">${formatClock(r.t, 'HH:mm:ss.SSS')}</span>
                <span class="dir ${r.dir.toLowerCase()}">${r.dir}</span>
                <span class="sum">${escapeHtml(r.result.summary || r.result.error || '')}</span>
            </div>`).join('');
        if (atBottom) this.list.scrollTop = this.list.scrollHeight;
    }

    renderDetail(row) {
        if (!row) {
            this.detail.innerHTML = '';
            return;
        }
        const r = row.result;
        this.detail.innerHTML = `
            <div class="dec-detail-head">${escapeHtml(r.summary || r.error || '')}</div>
            <table class="kv">${(r.fields || []).map(f => `<tr class="${f.ok === false ? 'bad' : f.ok ? 'ok' : ''}"><th>${escapeHtml(f.name)}</th><td>${escapeHtml(f.value)}</td></tr>`).join('')}
            ${r.error && !(r.fields || []).length ? `<tr class="bad"><th>${escapeHtml(t('Error'))}</th><td>${escapeHtml(r.error)}</td></tr>` : ''}</table>`;
    }

    selectEntry(entry) {
        if (!entry) return;
        const row = this.rows.find(r => r.seq === entry.seq);
        if (!row) return;
        this.selectedSeq = entry.seq;
        this.renderDetail(row);
        this.renderList();
        const node = this.list.querySelector(`[data-seq="${entry.seq}"]`);
        if (node) node.scrollIntoView({ block: 'nearest' });
    }

    dispose() {
        for (const off of this.subscriptions) off();
        this.root.remove();
    }
}

export async function initDecoders() {
    await loadStore('decoders-custom', []);
}
