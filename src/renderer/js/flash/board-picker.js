import { escapeHtml } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { openModal } from '../core/dialogs.js';
import { getPorts, sortPorts } from '../serial/ports.js';
import { loadBoards, recentBoards, findBoard } from './flash-state.js';
import { runCommand } from '../core/commands.js';

function score(board, words) {
    const hay = `${board.name} ${board.fqbn} ${board.platform} ${board.mcu || ''}`.toLowerCase();
    let s = 0;
    for (const w of words) {
        const idx = hay.indexOf(w);
        if (idx < 0) return -1;
        s += idx === 0 ? 30 : board.name.toLowerCase().includes(w) ? 20 : 5;
    }
    return s;
}

export function pickBoard({ current, portHint } = {}) {
    return new Promise(async (resolve) => {
        let result = null;
        let boards = await loadBoards();
        let query = '';
        let platformFilter = '';
        let index = 0;
        let flat = [];
        const detected = new Map();
        const modal = openModal({
            title: t('Select a board'),
            width: 860,
            className: 'board-picker-modal',
            body: `
                <div class="bp">
                    <div class="bp-top">
                        <input class="input bp-search" type="text" placeholder="${escapeHtml(t('Search by name, FQBN, MCU or platform'))}" spellcheck="false">
                        <select class="input bp-platform"></select>
                    </div>
                    <div class="bp-detect"></div>
                    <div class="bp-list"></div>
                </div>`,
            onClose: () => resolve(result),
            buttons: [
                { label: t('Board manager...'), left: true, action: () => { runCommand('flash.board-manager'); } },
                { label: t('Cancel') }
            ]
        });
        const search = modal.body.querySelector('.bp-search');
        const platformSel = modal.body.querySelector('.bp-platform');
        const list = modal.body.querySelector('.bp-list');
        const detectEl = modal.body.querySelector('.bp-detect');

        const platforms = () => Array.from(new Set(boards.map(b => b.platform))).sort();
        const renderPlatforms = () => {
            platformSel.innerHTML = `<option value="">${escapeHtml(t('All platforms'))} (${boards.length})</option>${platforms().map(p => `<option value="${escapeHtml(p)}" ${p === platformFilter ? 'selected' : ''}>${escapeHtml(p)} (${boards.filter(b => b.platform === p).length})</option>`).join('')}`;
        };

        const render = () => {
            if (!boards.length) {
                list.innerHTML = `
                    <div class="bp-empty">
                        <p>${escapeHtml(t('No board package installed yet.'))}</p>
                        <p class="dim">${escapeHtml(t('Install the packages you need (ESP32, ESP8266, AVR, RP2040, CH55x...) from the board manager. They are downloaded once and kept up to date automatically.'))}</p>
                        <button class="btn btn-primary" data-bp="manager">${escapeHtml(t('Open board manager'))}</button>
                    </div>`;
                return;
            }
            const words = query.toLowerCase().split(/\s+/).filter(Boolean);
            let pool = boards.filter(b => !platformFilter || b.platform === platformFilter);
            const sections = [];
            if (!words.length) {
                const recent = recentBoards().map(f => pool.find(b => b.fqbn === f)).filter(Boolean);
                if (recent.length) sections.push({ title: t('Recent'), items: recent });
                const groups = new Map();
                for (const b of pool) {
                    if (!groups.has(b.platform)) groups.set(b.platform, []);
                    groups.get(b.platform).push(b);
                }
                for (const [title, items] of groups) sections.push({ title, items: items.slice().sort((a, b) => a.name.localeCompare(b.name)) });
            } else {
                const scored = pool.map(b => ({ b, s: score(b, words) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s || a.b.name.localeCompare(b.b.name));
                sections.push({ title: t('{n} results', { n: scored.length }), items: scored.slice(0, 300).map(x => x.b) });
            }
            flat = [];
            const html = sections.map(sec => `
                <div class="bp-section">
                    <div class="bp-section-title">${escapeHtml(sec.title)}</div>
                    ${sec.items.map(b => {
                        const i = flat.length;
                        flat.push(b);
                        return `
                            <div class="bp-item ${b.fqbn === current ? 'current' : ''} ${i === index ? 'active' : ''}" data-i="${i}">
                                <div class="bp-name">${escapeHtml(b.name)}${detected.has(b.fqbn) ? ` <span class="badge ok">${escapeHtml(t('detected on {port}', { port: detected.get(b.fqbn) }))}</span>` : ''}</div>
                                <div class="bp-meta dim">${escapeHtml(b.fqbn)}${b.mcu ? ` - ${escapeHtml(b.mcu)}` : ''}${b.source === 'arduino15' ? ` - <span class="badge">Arduino15</span>` : ''}</div>
                            </div>`;
                    }).join('')}
                </div>`).join('');
            list.innerHTML = html || `<div class="dim bp-empty">${escapeHtml(t('No board matches your search'))}</div>`;
            const active = list.querySelector('.bp-item.active');
            if (active) active.scrollIntoView({ block: 'nearest' });
        };

        const choose = (board) => {
            if (!board) return;
            result = board.fqbn;
            modal.close();
        };

        const detect = async () => {
            const ports = sortPorts(getPorts()).filter(p => p.vendorId);
            if (!ports.length) {
                detectEl.innerHTML = '';
                return;
            }
            const results = [];
            for (const p of ports) {
                const found = await invoke('flash:detect-board', p.path);
                for (const f of found || []) {
                    if (!detected.has(f.fqbn)) detected.set(f.fqbn, p.path);
                    results.push({ port: p.path, ...f });
                }
            }
            const preferred = portHint ? results.filter(r => r.port === portHint) : results;
            const shown = (preferred.length ? preferred : results).slice(0, 8);
            detectEl.innerHTML = shown.length ? `
                <span class="dim">${escapeHtml(t('Identified from USB IDs:'))}</span>
                ${shown.map(r => `<button class="chip-btn" data-fqbn="${escapeHtml(r.fqbn)}">${escapeHtml(r.name)} <span class="dim">${escapeHtml(r.port)}</span></button>`).join('')}` : '';
            render();
        };

        search.addEventListener('input', () => {
            query = search.value;
            index = 0;
            render();
        });
        platformSel.addEventListener('change', () => {
            platformFilter = platformSel.value;
            index = 0;
            render();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                index = Math.min(flat.length - 1, index + 1);
                render();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                index = Math.max(0, index - 1);
                render();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(flat[index]);
            }
        });
        modal.body.addEventListener('click', (e) => {
            const item = e.target.closest('.bp-item');
            if (item) {
                choose(flat[parseInt(item.dataset.i, 10)]);
                return;
            }
            const chip = e.target.closest('[data-fqbn]');
            if (chip) {
                choose(findBoard(chip.dataset.fqbn) || { fqbn: chip.dataset.fqbn });
                return;
            }
            if (e.target.closest('[data-bp="manager"]')) {
                modal.close();
                runCommand('flash.board-manager');
            }
        });
        renderPlatforms();
        render();
        search.focus();
        detect().catch(error => console.error('Board detection failed:', error.message));
        if (!boards.length) {
            boards = await loadBoards(true);
            renderPlatforms();
            render();
        }
    });
}
