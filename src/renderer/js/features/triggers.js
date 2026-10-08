import { loadStore, getStore, saveStore } from '../core/store.js';
import { onEvent, emit } from '../core/bus.js';
import { uid } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { entryText, entryHex } from '../serial/entry-text.js';
import { notify, beep } from './notify.js';

let compiled = [];
const lastFired = new Map();
const hits = new Map();
let macroRunner = null;
let snapshotRunner = null;

export function setTriggerRunners({ runMacro, snapshot }) {
    macroRunner = runMacro;
    snapshotRunner = snapshot;
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultTrigger() {
    return {
        id: uid(),
        name: t('New trigger'),
        enabled: true,
        pattern: '',
        matchType: 'contains',
        caseSensitive: false,
        direction: 'RX',
        portFilter: '',
        cooldownMs: 0,
        actions: {
            notify: true,
            sound: false,
            marker: false,
            highlight: '',
            reply: { enabled: false, payload: '', mode: 'text', lineEnding: 'NL', delayMs: 0 },
            stopwatch: 'none',
            pause: false,
            macroId: '',
            snapshot: false,
            disconnect: false
        }
    };
}

function compileTrigger(trigger) {
    if (!trigger.pattern) return null;
    try {
        let source;
        const flags = trigger.caseSensitive ? '' : 'i';
        switch (trigger.matchType) {
            case 'regex': source = trigger.pattern; break;
            case 'exact': source = `^${escapeRegex(trigger.pattern)}$`; break;
            case 'starts': source = `^${escapeRegex(trigger.pattern)}`; break;
            case 'hex': source = escapeRegex(trigger.pattern.replace(/\s+/g, ' ').trim().toUpperCase()); break;
            default: source = escapeRegex(trigger.pattern);
        }
        let portRe = null;
        if (trigger.portFilter) {
            try {
                portRe = new RegExp(trigger.portFilter, 'i');
            } catch (error) {
                portRe = new RegExp(escapeRegex(trigger.portFilter), 'i');
            }
        }
        return { trigger, re: new RegExp(source, flags), portRe };
    } catch (error) {
        console.warn(`Invalid trigger pattern for ${trigger.name}:`, error.message);
        return null;
    }
}

function recompile() {
    const list = getStore('triggers', []) || [];
    compiled = list.filter(tr => tr.enabled !== false).map(compileTrigger).filter(Boolean);
}

export function getTriggers() {
    return getStore('triggers', []) || [];
}

export function saveTriggers(list) {
    saveStore('triggers', list);
}

export function triggerHits(id) {
    return hits.get(id) || 0;
}

export function testTrigger(trigger, sample) {
    const c = compileTrigger(trigger);
    if (!c) return { ok: false, error: t('Invalid pattern') };
    const text = trigger.matchType === 'hex' ? sample.toUpperCase() : sample;
    const m = c.re.exec(text);
    return { ok: true, match: !!m, groups: m ? Array.from(m) : [] };
}

function substituteGroups(text, match) {
    return text.replace(/\$(\d)/g, (m, n) => (match[parseInt(n, 10)] !== undefined ? match[parseInt(n, 10)] : ''));
}

async function fire(session, entry, c, match) {
    const tr = c.trigger;
    const a = tr.actions || {};
    hits.set(tr.id, (hits.get(tr.id) || 0) + 1);
    emit('triggers:hit', tr, session, entry);
    const snippet = entryText(entry).replace(/[\r\n]+$/, '').slice(0, 160);
    if (a.highlight) entry.color = a.highlight;
    if (a.marker) session.addMarker(`${tr.name}`, { t: entry.tEnd, kind: 'marker', color: a.highlight || null });
    if (a.notify) notify(`${t('Trigger')}: ${tr.name}`, `${session.displayName} - ${snippet}`, { type: 'warn' });
    if (a.sound) beep({ frequency: 1046 });
    if (a.stopwatch && a.stopwatch !== 'none') {
        const at = entry.dir === 'TX' ? entry.t : entry.tEnd;
        if (a.stopwatch === 'start') session.swStart(at, tr.name);
        else if (a.stopwatch === 'stop') session.swStop(at, tr.name);
        else if (a.stopwatch === 'lap') session.swLap(at, tr.name);
        else if (a.stopwatch === 'toggle') session.swToggle(at);
    }
    if (a.pause) session.setPaused(true);
    if (a.snapshot && snapshotRunner) snapshotRunner(session, tr.name);
    if (a.reply && a.reply.enabled && a.reply.payload) {
        const send = () => session.sendText(substituteGroups(a.reply.payload, match), {
            mode: a.reply.mode || 'text',
            lineEnding: a.reply.mode === 'hex' ? 'none' : (a.reply.lineEnding || 'NL'),
            remember: false
        });
        if (a.reply.delayMs > 0) setTimeout(send, a.reply.delayMs);
        else send();
    }
    if (a.macroId && macroRunner) macroRunner(a.macroId, session);
    if (a.disconnect) session.close();
}

function evaluate(session, entry) {
    if (compiled.length === 0 || entry.kind !== 'data') return;
    let text = null;
    let hex = null;
    const now = Date.now();
    for (const c of compiled) {
        const tr = c.trigger;
        if (tr.direction !== 'any' && tr.direction !== entry.dir) continue;
        if (c.portRe && !c.portRe.test(session.path || '') && !c.portRe.test(session.displayName)) continue;
        let subject;
        if (tr.matchType === 'hex') {
            if (hex === null) hex = entryHex(entry);
            subject = hex;
        } else {
            if (text === null) text = entryText(entry).replace(/[\r\n]+$/, '');
            subject = text;
        }
        c.re.lastIndex = 0;
        const match = c.re.exec(subject);
        if (!match) continue;
        const key = `${tr.id}:${session.id}`;
        if (tr.cooldownMs > 0 && now - (lastFired.get(key) || 0) < tr.cooldownMs) continue;
        lastFired.set(key, now);
        fire(session, entry, c, match).catch(error => console.error('Trigger action failed:', error));
    }
}

export async function initTriggers() {
    await loadStore('triggers', []);
    recompile();
    onEvent('store:triggers', recompile);
    onEvent('session:frame', evaluate);
}
