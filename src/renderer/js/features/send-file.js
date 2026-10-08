import { openModal, toast } from '../core/dialogs.js';
import { escapeHtml, options } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { formatBytes, toHex } from '../core/format.js';
import { loadStore, saveStore } from '../core/store.js';
import { t } from '../core/i18n.js';

const DEFAULTS = {
    mode: 'lines',
    chunkSize: 64,
    lineEnding: 'keep',
    encoding: 'utf8',
    skipEmptyLines: false,
    delimiterHex: '0A',
    includeDelimiter: true,
    frameLength: 0,
    delayMs: 0,
    repeat: 1,
    repeatDelayMs: 0,
    protocol: 'none',
    ack: { enabled: false, pattern: 'OK', nakPattern: '', timeoutMs: 1000, retries: 0, caseSensitive: false, onTimeout: 'abort' }
};

export async function openSendFileModal(session, presetPath) {
    if (!session.canWrite) {
        toast(t('Open the port before sending a file'), { type: 'warn' });
        return;
    }
    const saved = await loadStore('filesend-options', DEFAULTS);
    const opts = { ...DEFAULTS, ...saved, ack: { ...DEFAULTS.ack, ...(saved.ack || {}) } };
    let file = null;

    const modal = openModal({
        title: t('Send file to {port}', { port: session.path }),
        width: 760,
        body: `
            <div class="sendfile">
                <div class="file-pick">
                    <button class="btn" data-act="pick">${escapeHtml(t('Choose file...'))}</button>
                    <span class="file-name dim">${escapeHtml(t('No file selected'))}</span>
                </div>
                <div class="cols-2">
                    <div>
                        <div class="form-sep">${escapeHtml(t('How to split the file'))}</div>
                        <div class="form-grid">
                            <label>${escapeHtml(t('Protocol'))}</label>
                            <select class="input" data-k="protocol">${options([
                                ['none', t('None (stream)')],
                                ['xmodem', 'XMODEM (checksum)'],
                                ['xmodem-crc', 'XMODEM-CRC'],
                                ['xmodem-1k', 'XMODEM-1K'],
                                ['ymodem', 'YMODEM']
                            ], opts.protocol)}</select>
                            <label class="stream-only">${escapeHtml(t('Mode'))}</label>
                            <select class="input stream-only" data-k="mode">${options([
                                ['raw', t('Raw (whole file, as fast as possible)')],
                                ['chunks', t('Fixed-size chunks')],
                                ['lines', t('Line by line (text)')],
                                ['frames', t('Frames split on a delimiter')]
                            ], opts.mode)}</select>
                            <label class="m-chunks">${escapeHtml(t('Chunk size (bytes)'))}</label>
                            <input class="input m-chunks" type="number" min="1" data-k="chunkSize" value="${opts.chunkSize}">
                            <label class="m-lines">${escapeHtml(t('Line ending'))}</label>
                            <select class="input m-lines" data-k="lineEnding">${options([['keep', t('Keep original')], ['NL', 'LF'], ['CR', 'CR'], ['CRLF', 'CRLF'], ['LFCR', 'LFCR'], ['none', t('None')]], opts.lineEnding)}</select>
                            <label class="m-lines">${escapeHtml(t('Encoding'))}</label>
                            <select class="input m-lines" data-k="encoding">${options([['utf8', 'UTF-8'], ['latin1', 'Latin-1']], opts.encoding)}</select>
                            <label class="m-lines">${escapeHtml(t('Skip empty lines'))}</label>
                            <input type="checkbox" class="m-lines" data-k="skipEmptyLines" ${opts.skipEmptyLines ? 'checked' : ''}>
                            <label class="m-frames">${escapeHtml(t('Delimiter (hex)'))}</label>
                            <input class="input m-frames" data-k="delimiterHex" value="${escapeHtml(opts.delimiterHex)}">
                            <label class="m-frames">${escapeHtml(t('Keep delimiter'))}</label>
                            <input type="checkbox" class="m-frames" data-k="includeDelimiter" ${opts.includeDelimiter ? 'checked' : ''}>
                            <label class="stream-only">${escapeHtml(t('Delay between frames (ms)'))}</label>
                            <input class="input stream-only" type="number" min="0" data-k="delayMs" value="${opts.delayMs}">
                            <label>${escapeHtml(t('Repeat'))}</label>
                            <input class="input" type="number" min="1" data-k="repeat" value="${opts.repeat}">
                            <label>${escapeHtml(t('Delay between passes (ms)'))}</label>
                            <input class="input" type="number" min="0" data-k="repeatDelayMs" value="${opts.repeatDelayMs}">
                        </div>
                    </div>
                    <div class="stream-only">
                        <div class="form-sep">${escapeHtml(t('Wait for acknowledge after each frame'))}</div>
                        <div class="form-grid">
                            <label>${escapeHtml(t('Enabled'))}</label>
                            <input type="checkbox" data-a="enabled" ${opts.ack.enabled ? 'checked' : ''}>
                            <label>${escapeHtml(t('ACK regex'))}</label>
                            <input class="input" data-a="pattern" value="${escapeHtml(opts.ack.pattern)}">
                            <label>${escapeHtml(t('NAK regex'))}</label>
                            <input class="input" data-a="nakPattern" value="${escapeHtml(opts.ack.nakPattern)}" placeholder="${escapeHtml(t('optional'))}">
                            <label>${escapeHtml(t('Timeout (ms)'))}</label>
                            <input class="input" type="number" min="10" data-a="timeoutMs" value="${opts.ack.timeoutMs}">
                            <label>${escapeHtml(t('Retries'))}</label>
                            <input class="input" type="number" min="0" data-a="retries" value="${opts.ack.retries}">
                            <label>${escapeHtml(t('Case sensitive'))}</label>
                            <input type="checkbox" data-a="caseSensitive" ${opts.ack.caseSensitive ? 'checked' : ''}>
                            <label>${escapeHtml(t('On timeout'))}</label>
                            <select class="input" data-a="onTimeout">${options([['abort', t('Abort transfer')], ['continue', t('Continue with next frame')]], opts.ack.onTimeout)}</select>
                        </div>
                    </div>
                </div>
                <div class="form-sep">${escapeHtml(t('Preview'))}</div>
                <div class="preview dim">${escapeHtml(t('Select a file to see how it will be split.'))}</div>
            </div>`,
        buttons: [
            { label: t('Cancel') },
            { label: t('Send'), primary: true, id: 'filesend-go', action: () => start() }
        ]
    });

    const body = modal.body;
    const preview = body.querySelector('.preview');

    function readOptions() {
        for (const input of body.querySelectorAll('[data-k]')) {
            const key = input.dataset.k;
            if (input.type === 'checkbox') opts[key] = input.checked;
            else if (input.type === 'number') opts[key] = parseFloat(input.value) || 0;
            else opts[key] = input.value;
        }
        for (const input of body.querySelectorAll('[data-a]')) {
            const key = input.dataset.a;
            if (input.type === 'checkbox') opts.ack[key] = input.checked;
            else if (input.type === 'number') opts.ack[key] = parseFloat(input.value) || 0;
            else opts.ack[key] = input.value;
        }
        return opts;
    }

    function syncVisibility() {
        const protocol = body.querySelector('[data-k="protocol"]').value;
        const mode = body.querySelector('[data-k="mode"]').value;
        const stream = protocol === 'none';
        for (const node of body.querySelectorAll('.stream-only')) node.style.display = stream ? '' : 'none';
        for (const [cls, m] of [['m-chunks', 'chunks'], ['m-lines', 'lines'], ['m-frames', 'frames']]) {
            for (const node of body.querySelectorAll(`.${cls}`)) node.style.display = stream && mode === m ? '' : 'none';
        }
    }

    async function updatePreview() {
        syncVisibility();
        if (!file) return;
        readOptions();
        if (opts.protocol !== 'none') {
            const block = opts.protocol === 'xmodem-1k' || opts.protocol === 'ymodem' ? 1024 : 128;
            preview.innerHTML = escapeHtml(t('{proto}: {n} blocks of {b} bytes. Start the receiver first; the transfer begins when it requests data.', { proto: opts.protocol.toUpperCase(), n: Math.ceil(file.size / block), b: block }));
            return;
        }
        const res = await invoke('filesend:preview', file.filePath, opts);
        if (!res.success) {
            preview.textContent = res.error;
            return;
        }
        const lines = res.sample.map((bytes, i) => {
            const arr = new Uint8Array(bytes);
            const printable = arr.every(b => (b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D || b === 0x09);
            const text = printable ? new TextDecoder().decode(arr).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') : toHex(arr);
            return `<div class="pv-row"><span class="pv-idx">#${i + 1}</span><span class="pv-len">${bytes.length >= 64 ? '64+' : bytes.length} B</span><span class="pv-data">${escapeHtml(text)}</span></div>`;
        }).join('');
        const eta = opts.delayMs > 0 ? t(' - at least {s}s with the configured delay', { s: ((res.frameCount * opts.delayMs * Math.max(1, opts.repeat)) / 1000).toFixed(1) }) : '';
        preview.innerHTML = `<div class="pv-summary">${escapeHtml(t('{size} in {n} frame(s)', { size: formatBytes(res.size), n: res.frameCount }))}${escapeHtml(eta)}</div>${lines}${res.frameCount > 20 ? `<div class="dim">... ${res.frameCount - 20} ${escapeHtml(t('more'))}</div>` : ''}`;
    }

    async function setFile(path) {
        const st = await invoke('files:stat', path);
        if (!st.exists || st.isDirectory) {
            toast(t('File not found'), { type: 'error' });
            return;
        }
        file = { filePath: path, size: st.size };
        body.querySelector('.file-name').textContent = `${path} (${formatBytes(st.size)})`;
        body.querySelector('.file-name').classList.remove('dim');
        updatePreview();
    }

    async function start() {
        if (!file) {
            toast(t('Select a file first'), { type: 'warn' });
            return false;
        }
        readOptions();
        saveStore('filesend-options', opts);
        const res = await invoke('filesend:start', session.path, file.filePath, opts);
        if (!res.success) {
            toast(res.error || t('Failed to start transfer'), { type: 'error' });
            return false;
        }
        session.addSystem(t('Sending {file} ({size})', { file: file.filePath.split(/[\\/]/).pop(), size: formatBytes(res.size) }), 'info');
        return undefined;
    }

    body.querySelector('[data-act="pick"]').addEventListener('click', async () => {
        const picked = await invoke('filesend:select');
        if (picked) setFile(picked.filePath);
    });
    body.addEventListener('change', () => updatePreview());
    syncVisibility();
    if (presetPath) setFile(presetPath);
}
