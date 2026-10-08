import { openModal, toast } from '../core/dialogs.js';
import { escapeHtml, options } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { entryText } from '../serial/entry-text.js';

function lcsDiff(a, b, maxCells = 4000000) {
    const n = a.length;
    const m = b.length;
    if (n * m > maxCells) return null;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: 'same', a: i, b: j });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', a: i });
            i++;
        } else {
            out.push({ type: 'add', b: j });
            j++;
        }
    }
    while (i < n) out.push({ type: 'del', a: i++ });
    while (j < m) out.push({ type: 'add', b: j++ });
    return out;
}

function parseFileLines(content, path) {
    if (/\.json$/i.test(path)) {
        const data = JSON.parse(content);
        if (!Array.isArray(data.entries)) throw new Error(t('Invalid JSON export'));
        return data.entries.map(e => ({ dir: e.type === 'TX' ? 'TX' : 'RX', text: String(e.content || e.text || '').replace(/[\r\n]+$/, '') }));
    }
    if (/\.dtcap$/i.test(path)) throw new Error(t('Open .dtcap files with File > Open capture, then compare the two tabs'));
    return content.split(/\r?\n/).filter(Boolean).map(line => {
        const m = line.match(/^\[[^\]]*\]\s*(RX|TX):\s?(.*)$/);
        if (m) return { dir: m[1], text: m[2] };
        return { dir: 'RX', text: line };
    });
}

export function openCompare(session) {
    let fileLines = null;
    const modal = openModal({
        title: t('Compare logs'),
        width: 1000,
        className: 'compare-modal',
        body: `
            <div class="inline compare-head">
                <button class="btn" data-act="file">${escapeHtml(t('Choose reference file (.txt, .log, .json)...'))}</button>
                <span class="dim file-label"></span>
                <span class="spacer"></span>
                <label>${escapeHtml(t('Direction'))}</label>
                <select class="input sm" data-o="dir">${options([['all', t('All')], ['RX', 'RX'], ['TX', 'TX']], 'all')}</select>
                <label class="chk"><input type="checkbox" data-o="trim" checked> ${escapeHtml(t('Ignore surrounding spaces'))}</label>
                <label class="chk"><input type="checkbox" data-o="nocase"> ${escapeHtml(t('Ignore case'))}</label>
                <label class="chk"><input type="checkbox" data-o="numbers"> ${escapeHtml(t('Ignore numbers'))}</label>
            </div>
            <div class="compare-summary"></div>
            <div class="compare-result"></div>`,
        buttons: [{ label: t('Close'), primary: true }]
    });
    const result = modal.body.querySelector('.compare-result');
    const summary = modal.body.querySelector('.compare-summary');

    const normalize = (text, o) => {
        let s = text;
        if (o.trim) s = s.trim();
        if (o.nocase) s = s.toLowerCase();
        if (o.numbers) s = s.replace(/[-+]?\d+(\.\d+)?/g, '#');
        return s;
    };

    const run = () => {
        if (!fileLines) return;
        const o = {};
        for (const input of modal.body.querySelectorAll('[data-o]')) o[input.dataset.o] = input.type === 'checkbox' ? input.checked : input.value;
        const current = session.capture.entries.filter(e => e.kind === 'data' && (o.dir === 'all' || e.dir === o.dir)).map(e => ({ dir: e.dir, text: entryText(e).replace(/[\r\n]+$/, '') }));
        const ref = fileLines.filter(l => o.dir === 'all' || l.dir === o.dir);
        const a = ref.map(l => `${l.dir}|${normalize(l.text, o)}`);
        const b = current.map(l => `${l.dir}|${normalize(l.text, o)}`);
        const diff = lcsDiff(a, b);
        if (!diff) {
            summary.innerHTML = `<span class="err">${escapeHtml(t('Logs too large for a full diff; comparing line by line.'))}</span>`;
            const rows = [];
            const max = Math.max(a.length, b.length);
            let diffs = 0;
            for (let i = 0; i < max && rows.length < 2000; i++) {
                if (a[i] === b[i]) continue;
                diffs++;
                rows.push(`<div class="cmp-row del"><span>${i + 1}</span>${escapeHtml(ref[i] ? `${ref[i].dir}: ${ref[i].text}` : '')}</div><div class="cmp-row add"><span>${i + 1}</span>${escapeHtml(current[i] ? `${current[i].dir}: ${current[i].text}` : '')}</div>`);
            }
            result.innerHTML = rows.join('') || `<div class="ok pad">${escapeHtml(t('Identical'))}</div>`;
            summary.innerHTML += ` ${diffs} ${escapeHtml(t('differences'))}`;
            return;
        }
        const added = diff.filter(d => d.type === 'add').length;
        const removed = diff.filter(d => d.type === 'del').length;
        const same = diff.length - added - removed;
        summary.innerHTML = `<b>${same}</b> ${escapeHtml(t('identical'))}, <span class="del-c">${removed} ${escapeHtml(t('missing from capture'))}</span>, <span class="add-c">${added} ${escapeHtml(t('extra in capture'))}</span>`;
        if (!added && !removed) {
            result.innerHTML = `<div class="ok pad">${escapeHtml(t('Logs are identical'))}</div>`;
            return;
        }
        const rows = [];
        let context = 0;
        for (let k = 0; k < diff.length && rows.length < 3000; k++) {
            const d = diff[k];
            if (d.type === 'same') {
                const near = (diff[k - 1] && diff[k - 1].type !== 'same') || (diff[k + 1] && diff[k + 1].type !== 'same');
                if (near) {
                    rows.push(`<div class="cmp-row same"><span>${d.a + 1}</span><span>${d.b + 1}</span>${escapeHtml(`${current[d.b].dir}: ${current[d.b].text}`)}</div>`);
                    context = 0;
                } else if (context++ === 0) rows.push('<div class="cmp-gap">...</div>');
            } else if (d.type === 'del') {
                rows.push(`<div class="cmp-row del"><span>${d.a + 1}</span><span></span>- ${escapeHtml(`${ref[d.a].dir}: ${ref[d.a].text}`)}</div>`);
            } else {
                rows.push(`<div class="cmp-row add"><span></span><span>${d.b + 1}</span>+ ${escapeHtml(`${current[d.b].dir}: ${current[d.b].text}`)}</div>`);
            }
        }
        result.innerHTML = rows.join('');
    };

    modal.body.querySelector('[data-act="file"]').addEventListener('click', async () => {
        const file = await invoke('files:select-file', [{ name: t('Logs'), extensions: ['txt', 'log', 'json', 'csv'] }, { name: t('All files'), extensions: ['*'] }]);
        if (!file) return;
        const res = await invoke('files:read-text', file);
        if (!res.success) {
            toast(res.error, { type: 'error' });
            return;
        }
        try {
            fileLines = parseFileLines(res.content, file);
            modal.body.querySelector('.file-label').textContent = `${file} (${fileLines.length})`;
            run();
        } catch (error) {
            toast(error.message, { type: 'error' });
        }
    });
    modal.body.addEventListener('change', run);
}
