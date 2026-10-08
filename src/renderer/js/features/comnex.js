import { openModal, toast } from '../core/dialogs.js';
import { escapeHtml } from '../core/dom.js';
import { invoke } from '../core/api.js';
import { t } from '../core/i18n.js';
import { createSession, allSessions, setActive } from '../serial/sessions.js';

export async function sendComnexPower(session, level) {
    if (!session.canWrite) return;
    const voltage = level === '5V' ? '5V' : '3V';
    const result = await invoke('comnex:command', session.path, `@c%|levelshifter|${voltage}%`).catch(error => ({ success: false, error: error.message }));
    if (!result.success) toast(t('COMNEX command failed: {error}', { error: result.error || '' }), { type: 'error' });
    else session.addSystem(t('COMNEX level shifter set to {v}', { v: level }), 'info');
}

function hubSerial(hub) {
    const is4 = hub.model.includes('4-Port');
    return `COMNEX-${is4 ? '4' : '8'}-${hub.hubKey.replace('0x', '').toUpperCase()}`;
}

export async function openHub(hub, { connect = true, baudRate = 115200 } = {}) {
    const channels = Object.entries(hub.channels).sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
    const created = [];
    for (const [channel, path] of channels) {
        let session = allSessions().find(s => s.path === path);
        if (!session) {
            session = createSession({
                path,
                title: `CNX${hub.model.includes('4-Port') ? '4' : '8'}-CH${parseInt(channel, 10) + 1}`,
                options: { baudRate },
                comnex: { power: '3.3V', channel: parseInt(channel, 10), hub: hub.hubKey }
            }, { activate: false });
        }
        created.push(session);
    }
    if (created[0]) setActive(created[0].id);
    if (connect) {
        for (const s of created) {
            if (s.state === 'closed') {
                const res = await s.open();
                if (!res.success) toast(`${s.path}: ${res.error}`, { type: 'error' });
            }
        }
    }
    return created;
}

export function openComnex() {
    const modal = openModal({
        title: t('COMNEX hubs'),
        width: 720,
        body: `<div class="comnex-list"><div class="dim pad">${escapeHtml(t('Searching for COMNEX devices...'))}</div></div>`,
        buttons: [
            { label: t('Refresh'), keepOpen: true, left: true, action: () => load() },
            { label: t('Close'), primary: true }
        ]
    });
    const list = modal.body.querySelector('.comnex-list');
    let hubs = [];
    async function load() {
        list.innerHTML = `<div class="dim pad">${escapeHtml(t('Searching for COMNEX devices...'))}</div>`;
        hubs = await invoke('comnex:list').catch(() => []) || [];
        if (!hubs.length) {
            list.innerHTML = `<div class="dim pad">${escapeHtml(t('No COMNEX device found (USB VID 0x1209).'))}</div>`;
            return;
        }
        list.innerHTML = hubs.map((hub, i) => {
            const channels = Object.entries(hub.channels).sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
            return `
                <div class="comnex-hub">
                    <div class="comnex-head">
                        <b>${escapeHtml(hubSerial(hub))}</b><span class="dim">${escapeHtml(hub.model)}</span>
                        <span class="spacer"></span>
                        <button class="btn sm" data-open="${i}" data-connect="0">${escapeHtml(t('Open tabs'))}</button>
                        <button class="btn btn-primary sm" data-open="${i}" data-connect="1">${escapeHtml(t('Open and connect'))}</button>
                    </div>
                    <div class="comnex-channels">${channels.map(([ch, path]) => `<div class="comnex-ch"><span class="dim">${escapeHtml(t('Channel {n}', { n: parseInt(ch, 10) + 1 }))}</span><b class="mono">${escapeHtml(path)}</b></div>`).join('')}</div>
                </div>`;
        }).join('');
    }
    list.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-open]');
        if (!btn) return;
        const hub = hubs[parseInt(btn.dataset.open, 10)];
        modal.close();
        await openHub(hub, { connect: btn.dataset.connect === '1' });
    });
    load();
}
