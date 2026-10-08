import { el, escapeHtml } from '../core/dom.js';
import { playExit } from '../core/dialogs.js';
import { t } from '../core/i18n.js';
import { listCommands, bindingFor } from '../core/commands.js';
import { allSessions, setActive } from '../serial/sessions.js';
import { getMacros, runMacro } from '../features/macros.js';
import { getPorts, sortPorts, portLabel } from '../serial/ports.js';

let current = null;
const recent = [];

function fuzzyScore(query, text) {
    if (!query) return 1;
    const q = query.toLowerCase();
    const s = text.toLowerCase();
    const direct = s.indexOf(q);
    if (direct >= 0) return 1000 - direct * 2 - (s.length - q.length) * 0.1 + (direct === 0 || s[direct - 1] === ' ' ? 200 : 0);
    let score = 0;
    let si = 0;
    let streak = 0;
    for (let qi = 0; qi < q.length; qi++) {
        const ch = q[qi];
        if (ch === ' ') continue;
        let found = -1;
        while (si < s.length) {
            if (s[si] === ch) {
                found = si;
                break;
            }
            si++;
        }
        if (found < 0) return -1;
        streak = found > 0 && s[found - 1] === q[qi - 1] ? streak + 1 : 0;
        score += 10 + streak * 5 + (found === 0 || s[found - 1] === ' ' || s[found - 1] === ':' ? 15 : 0);
        si = found + 1;
    }
    return score - s.length * 0.2;
}

function highlightMatch(query, text) {
    if (!query) return escapeHtml(text);
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    const direct = lower.indexOf(q);
    if (direct >= 0) {
        return `${escapeHtml(text.slice(0, direct))}<mark>${escapeHtml(text.slice(direct, direct + q.length))}</mark>${escapeHtml(text.slice(direct + q.length))}`;
    }
    let out = '';
    let qi = 0;
    for (let i = 0; i < text.length; i++) {
        if (qi < q.length && lower[i] === q[qi]) {
            out += `<mark>${escapeHtml(text[i])}</mark>`;
            qi++;
            while (q[qi] === ' ') qi++;
        } else {
            out += escapeHtml(text[i]);
        }
    }
    return out;
}

function collectItems() {
    const items = [];
    for (const c of listCommands()) {
        if (c.hidden) continue;
        if (c.enabled && !c.enabled()) continue;
        const title = typeof c.title === 'function' ? c.title() : c.title;
        items.push({ id: `cmd:${c.id}`, label: `${c.category ? t(c.category) + ': ' : ''}${t(title)}`, key: bindingFor(c.id), run: () => c.run() });
    }
    for (const s of allSessions()) {
        items.push({ id: `tab:${s.id}`, label: `${t('Go to tab')}: ${s.displayName}${s.path && s.path !== s.displayName ? ` (${s.path})` : ''}`, run: () => setActive(s.id) });
    }
    for (const m of getMacros()) {
        items.push({ id: `macro:${m.id}`, label: `${t('Run macro')}: ${m.name || t('Untitled')}`, key: m.key || '', run: () => runMacro(m.id) });
    }
    for (const p of sortPorts(getPorts())) {
        items.push({
            id: `port:${p.path}`, label: `${t('Open port in new tab')}: ${portLabel(p)}`, run: async () => {
                const { newTab } = await import('./workspace.js');
                const { getTabView } = await import('./tab-view.js');
                const s = newTab({ path: p.path });
                const v = getTabView(s.id);
                if (v) v.connect();
            }
        });
    }
    return items;
}

export function closePalette() {
    if (!current) return false;
    const node = current.node;
    current = null;
    playExit(node, () => node.remove());
    return true;
}

export function isPaletteOpen() {
    return !!current;
}

export function openPalette(initial = '') {
    if (current) {
        current.input.focus();
        return;
    }
    const node = el(`
        <div class="palette-overlay">
            <div class="palette">
                <input class="palette-input" type="text" spellcheck="false" placeholder="${escapeHtml(t('Type a command, a tab, a macro or a port...'))}">
                <div class="palette-list"></div>
            </div>
        </div>`);
    document.getElementById('overlay-root').appendChild(node);
    const input = node.querySelector('.palette-input');
    const list = node.querySelector('.palette-list');
    const all = collectItems();
    let shown = [];
    let index = 0;

    const render = () => {
        const q = input.value.trim();
        const scored = [];
        for (const item of all) {
            const score = fuzzyScore(q, item.label);
            if (score < 0) continue;
            const r = recent.indexOf(item.id);
            scored.push({ item, score: score + (r >= 0 ? (q ? 50 : 2000) - r * 10 : 0) });
        }
        scored.sort((a, b) => b.score - a.score);
        shown = scored.slice(0, 80).map(s => s.item);
        index = Math.min(index, Math.max(0, shown.length - 1));
        list.innerHTML = shown.length ? shown.map((item, i) => `
            <div class="palette-item ${i === index ? 'active' : ''}" data-i="${i}">
                <span class="palette-label">${highlightMatch(q, item.label)}</span>
                ${recent.includes(item.id) && !q ? `<span class="palette-recent">${escapeHtml(t('recent'))}</span>` : ''}
                ${item.key ? `<kbd>${escapeHtml(item.key)}</kbd>` : ''}
            </div>`).join('') : `<div class="palette-empty">${escapeHtml(t('No matching command'))}</div>`;
        const active = list.querySelector('.palette-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    };

    const execute = (i) => {
        const item = shown[i];
        if (!item) return;
        const r = recent.indexOf(item.id);
        if (r >= 0) recent.splice(r, 1);
        recent.unshift(item.id);
        if (recent.length > 12) recent.pop();
        closePalette();
        setTimeout(() => item.run(), 0);
    };

    input.addEventListener('input', () => {
        index = 0;
        render();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            index = Math.min(shown.length - 1, index + 1);
            render();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            index = Math.max(0, index - 1);
            render();
        } else if (e.key === 'PageDown') {
            e.preventDefault();
            index = Math.min(shown.length - 1, index + 10);
            render();
        } else if (e.key === 'PageUp') {
            e.preventDefault();
            index = Math.max(0, index - 10);
            render();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            execute(index);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePalette();
        }
    });
    list.addEventListener('mousemove', (e) => {
        const row = e.target.closest('.palette-item');
        if (!row) return;
        const i = parseInt(row.dataset.i, 10);
        if (i !== index) {
            index = i;
            list.querySelectorAll('.palette-item').forEach((r, k) => r.classList.toggle('active', k === i));
        }
    });
    list.addEventListener('click', (e) => {
        const row = e.target.closest('.palette-item');
        if (row) execute(parseInt(row.dataset.i, 10));
    });
    node.addEventListener('mousedown', (e) => {
        if (e.target === node) closePalette();
    });
    current = { node, input };
    input.value = initial;
    render();
    input.focus();
}
