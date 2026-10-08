import { openModal, toast } from '../core/dialogs.js';
import { escapeHtml, options } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { formatClock, toHex, concatBytes } from '../core/format.js';
import { t } from '../core/i18n.js';
import { entryBytes } from '../serial/capture.js';
import { entryText } from '../serial/entry-text.js';

function rowsFor(session, terminal, opts) {
    let entries;
    if (opts.scope === 'selected') entries = terminal.getSelectedEntries();
    else if (opts.scope === 'visible') entries = terminal.list;
    else entries = session.capture.entries;
    const first = session.capture.entries[0];
    const origin = first ? first.t : 0;
    const rows = [];
    for (const entry of entries) {
        if (entry.kind !== 'data') {
            if (!opts.includeSystem) continue;
        } else if (entry.dir === 'TX' && !opts.includeTx) continue;
        else if (entry.dir === 'RX' && !opts.includeRx) continue;
        const bytes = entry.kind === 'data' ? entryBytes(entry) : new Uint8Array(0);
        rows.push({
            t: entry.t,
            iso: new Date(entry.t).toISOString(),
            clock: formatClock(entry.t, 'HH:mm:ss.SSS'),
            rel: ((entry.t - origin) / 1000).toFixed(6),
            dir: entry.kind === 'data' ? entry.dir : (entry.kind === 'marker' ? 'MARK' : 'SYS'),
            text: entry.kind === 'data' ? entryText(entry).replace(/[\r\n]+$/, '') : (entry.label || ''),
            hex: toHex(bytes),
            len: bytes.length,
            bytes
        });
    }
    return rows;
}

function timeOf(row, mode) {
    if (mode === 'iso') return row.iso;
    if (mode === 'relative') return row.rel;
    if (mode === 'epoch') return String(Math.round(row.t * 1000) / 1000);
    return row.clock;
}

function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`);
}

function texEscape(value) {
    return String(value).replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

function convert(rows, opts, session) {
    const cols = [];
    cols.push({ h: 'Time', v: r => timeOf(r, opts.time) });
    cols.push({ h: 'Dir', v: r => r.dir });
    if (opts.content !== 'hex') cols.push({ h: 'Text', v: r => r.text });
    if (opts.content !== 'text') cols.push({ h: 'Hex', v: r => r.hex });
    cols.push({ h: 'Length', v: r => r.len });
    switch (opts.format) {
        case 'csv':
            return [cols.map(c => csvCell(c.h)).join(','), ...rows.map(r => cols.map(c => csvCell(c.v(r))).join(','))].join('\r\n');
        case 'txt':
            return rows.map(r => `[${timeOf(r, opts.time)}] ${r.dir}: ${opts.content === 'hex' ? r.hex : opts.content === 'both' ? `${r.text}  |  ${r.hex}` : r.text}`).join('\n');
        case 'tsv':
            return [cols.map(c => c.h).join('\t'), ...rows.map(r => cols.map(c => String(c.v(r)).replace(/\t/g, ' ')).join('\t'))].join('\n');
        case 'html':
            return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DiagTerm - ${escapeHtml(session.displayName)}</title>
<style>body{font-family:Segoe UI,sans-serif;background:#1e1e1e;color:#ddd}table{border-collapse:collapse;font-family:Consolas,monospace;font-size:12px}td,th{border:1px solid #333;padding:3px 6px;text-align:left;vertical-align:top}th{background:#2a2a2a}tr.RX td:nth-child(2){color:#4caf50}tr.TX td:nth-child(2){color:#f44336}tr.SYS,tr.MARK{color:#ffb300}</style></head><body>
<h2>DiagTerm - ${escapeHtml(session.displayName)}</h2><p>${escapeHtml(new Date().toLocaleString())} - ${rows.length} rows</p>
<table><tr>${cols.map(c => `<th>${c.h}</th>`).join('')}</tr>
${rows.map(r => `<tr class="${r.dir}">${cols.map(c => `<td>${escapeHtml(c.v(r))}</td>`).join('')}</tr>`).join('\n')}
</table></body></html>`;
        case 'xml':
            return `<?xml version="1.0" encoding="UTF-8"?>\n<capture port="${xmlEscape(session.path)}" baud="${session.options.baudRate}" exported="${new Date().toISOString()}">\n${rows.map(r => `  <frame time="${xmlEscape(timeOf(r, opts.time))}" dir="${r.dir}" length="${r.len}">${opts.content !== 'hex' ? `<text>${xmlEscape(r.text)}</text>` : ''}${opts.content !== 'text' ? `<hex>${r.hex}</hex>` : ''}</frame>`).join('\n')}\n</capture>\n`;
        case 'json':
            return JSON.stringify({
                port: session.path,
                baudRate: session.options.baudRate,
                exportDate: new Date().toISOString(),
                entries: rows.map(r => ({
                    timestamp: r.t,
                    timestampStr: r.iso,
                    type: r.dir,
                    content: r.text,
                    hex: opts.content !== 'text' ? r.hex : undefined,
                    length: r.len
                }))
            }, null, 2);
        case 'md':
            return [`# DiagTerm - ${session.displayName}`, '', `| ${cols.map(c => c.h).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`,
                ...rows.map(r => `| ${cols.map(c => String(c.v(r)).replace(/\|/g, '\\|').replace(/`/g, '\\`')).join(' | ')} |`)].join('\n');
        case 'tex':
            return `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{longtable}\n\\begin{document}\n\\section*{DiagTerm - ${texEscape(session.displayName)}}\n\\begin{longtable}{${cols.map(() => 'l').join('|')}}\n\\hline\n${cols.map(c => `\\textbf{${c.h}}`).join(' & ')} \\\\\n\\hline\n${rows.map(r => cols.map(c => texEscape(c.v(r))).join(' & ') + ' \\\\').join('\n')}\n\\hline\n\\end{longtable}\n\\end{document}\n`;
        default:
            return '';
    }
}

const FORMATS = [
    ['txt', 'Text log (.txt)'],
    ['csv', 'Excel CSV (.csv)'],
    ['tsv', 'Tab delimited (.txt)'],
    ['html', 'HTML table (.html)'],
    ['xml', 'XML (.xml)'],
    ['json', 'JSON (.json)'],
    ['md', 'Markdown (.md)'],
    ['tex', 'LaTeX (.tex)'],
    ['bin', 'Raw binary (.bin)']
];

export function openExportModal(session, terminal) {
    const selectedCount = terminal ? terminal.getSelectedEntries().length : 0;
    const modal = openModal({
        title: t('Export'),
        width: 520,
        body: `
            <div class="form-grid wide">
                <label>${escapeHtml(t('Format'))}</label>
                <select class="input" data-o="format">${options(FORMATS.map(([v, l]) => [v, t(l)]), 'txt')}</select>
                <label>${escapeHtml(t('Scope'))}</label>
                <select class="input" data-o="scope">${options([
                    ['all', t('Whole capture')],
                    ['visible', t('Current view (filters and search)')],
                    ['selected', t('Selected frames ({n})', { n: selectedCount })]
                ], selectedCount > 1 ? 'selected' : 'all')}</select>
                <label>${escapeHtml(t('Content'))}</label>
                <select class="input" data-o="content">${options([['text', t('Text')], ['hex', 'Hex'], ['both', t('Text and hex')]], 'text')}</select>
                <label>${escapeHtml(t('Time'))}</label>
                <select class="input" data-o="time">${options([['clock', 'HH:mm:ss.SSS'], ['iso', 'ISO 8601'], ['relative', t('Seconds since start')], ['epoch', t('Epoch (ms)')]], 'clock')}</select>
                <label>${escapeHtml(t('Directions'))}</label>
                <div class="inline">
                    <label class="chk"><input type="checkbox" data-o="includeRx" checked> RX</label>
                    <label class="chk"><input type="checkbox" data-o="includeTx" checked> TX</label>
                    <label class="chk"><input type="checkbox" data-o="includeSystem"> ${escapeHtml(t('System and markers'))}</label>
                </div>
            </div>
            <p class="dim export-hint"></p>`,
        buttons: [
            { label: t('Copy to clipboard'), left: true, keepOpen: true, action: (m) => run(m, true) },
            { label: t('Cancel') },
            { label: t('Export'), primary: true, action: (m) => run(m, false) }
        ]
    });
    const hint = modal.body.querySelector('.export-hint');
    const updateHint = () => {
        const fmt = modal.body.querySelector('[data-o="format"]').value;
        hint.textContent = fmt === 'bin' ? t('Raw bytes of the selected directions are concatenated in time order.') : '';
    };
    modal.body.querySelector('[data-o="format"]').addEventListener('change', updateHint);

    async function run(m, clipboard) {
        const opts = {};
        for (const input of m.body.querySelectorAll('[data-o]')) opts[input.dataset.o] = input.type === 'checkbox' ? input.checked : input.value;
        const rows = rowsFor(session, terminal, opts).filter(r => opts.format !== 'bin' || r.dir === 'RX' || r.dir === 'TX');
        if (!rows.length) {
            toast(t('Nothing to export'), { type: 'warn' });
            return false;
        }
        const base = `${(session.path || session.displayName).replace(/[^a-zA-Z0-9]/g, '_')}_${formatClock(Date.now(), 'YYYY-MM-DD_HH-mm-ss')}`;
        if (opts.format === 'bin') {
            const data = concatBytes(rows.map(r => r.bytes));
            if (clipboard) {
                await navigator.clipboard.writeText(toHex(data));
                toast(t('Copied {n} bytes as hex', { n: data.length }), { type: 'success' });
                return false;
            }
            const res = await invoke('files:save-binary', data, 'bin', `${base}.bin`);
            if (res.success) toast(t('Exported to {file}', { file: res.filePath }), { type: 'success' });
            return res.success ? undefined : false;
        }
        const content = convert(rows, opts, session);
        if (clipboard) {
            await navigator.clipboard.writeText(content);
            toast(t('Copied {n} rows', { n: rows.length }), { type: 'success' });
            return false;
        }
        const ext = opts.format === 'tsv' ? 'txt' : opts.format;
        const res = await invoke('files:save-text', content, ext, `${base}.${ext}`);
        if (res.success) toast(t('Exported to {file}', { file: res.filePath }), { type: 'success' });
        else if (res.error) toast(res.error, { type: 'error' });
        return res.success ? undefined : false;
    }
}
