import { loadStore, getStore, saveStore } from '../core/store.js';
import { onEvent, emit } from '../core/bus.js';
import { addKeyHandler } from '../core/commands.js';
import { uid } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { toast } from '../core/dialogs.js';
import { entryText } from '../serial/entry-text.js';

const periodic = new Map();
const running = new Map();
let activeSessionGetter = () => null;

export function setMacroContext({ getActiveSession }) {
    activeSessionGetter = getActiveSession;
}

export function defaultMacro() {
    return {
        id: uid(),
        name: t('New macro'),
        key: '',
        payload: '',
        mode: 'text',
        escapes: true,
        lineEnding: 'NL',
        steps: [],
        repeatMs: 0,
        color: '',
        showInBar: true,
        group: ''
    };
}

export function getMacros() {
    return getStore('macros', []) || [];
}

export function saveMacros(list) {
    saveStore('macros', list);
}

export function findMacro(id) {
    return getMacros().find(m => m.id === id) || null;
}

function waitForMatch(session, pattern, timeoutMs) {
    return new Promise((resolve) => {
        let re;
        try {
            re = new RegExp(pattern, 'i');
        } catch (error) {
            resolve(false);
            return;
        }
        const off = session.on('frame', (entry) => {
            if (entry.dir !== 'RX') return;
            if (re.test(entryText(entry))) {
                cleanup();
                resolve(true);
            }
        });
        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, Math.max(10, timeoutMs || 2000));
        const cleanup = () => {
            clearTimeout(timer);
            off();
        };
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runSteps(macro, session, token) {
    const steps = macro.steps && macro.steps.length ? macro.steps : [{
        payload: macro.payload,
        mode: macro.mode,
        escapes: macro.escapes,
        lineEnding: macro.lineEnding,
        delayMs: 0
    }];
    for (let i = 0; i < steps.length; i++) {
        if (token.cancelled) return false;
        const step = steps[i];
        if (step.delayMs > 0) await sleep(step.delayMs);
        if (token.cancelled) return false;
        if (step.payload) {
            const waitPromise = step.waitFor ? waitForMatch(session, step.waitFor, step.waitTimeoutMs) : null;
            const result = await session.sendText(step.payload, {
                mode: step.mode || macro.mode,
                escapes: step.escapes !== undefined ? step.escapes : macro.escapes,
                lineEnding: (step.mode || macro.mode) === 'hex' ? 'none' : (step.lineEnding !== undefined ? step.lineEnding : macro.lineEnding),
                counterKey: `${session.id}:${macro.id}`,
                remember: false
            });
            if (!result.success) return false;
            if (waitPromise) {
                const ok = await waitPromise;
                if (!ok) {
                    session.addSystem(t('Macro "{name}": expected response not received at step {n}', { name: macro.name, n: i + 1 }), 'warn');
                    if (step.onTimeout !== 'continue') return false;
                }
            }
        } else if (step.waitFor) {
            const ok = await waitForMatch(session, step.waitFor, step.waitTimeoutMs);
            if (!ok && step.onTimeout !== 'continue') return false;
        }
    }
    return true;
}

export async function runMacro(macroOrId, sessionArg) {
    const macro = typeof macroOrId === 'string' ? findMacro(macroOrId) : macroOrId;
    const session = sessionArg || activeSessionGetter();
    if (!macro || !session) return;
    if (!session.canWrite) {
        toast(t('Port not open'), { type: 'warn' });
        return;
    }
    if (macro.repeatMs > 0) {
        togglePeriodic(macro, session);
        return;
    }
    const key = `${session.id}:${macro.id}`;
    if (running.has(key)) {
        running.get(key).cancelled = true;
        running.delete(key);
        emit('macros:running', key, false);
        return;
    }
    const token = { cancelled: false };
    running.set(key, token);
    emit('macros:running', key, true);
    try {
        await runSteps(macro, session, token);
    } finally {
        running.delete(key);
        emit('macros:running', key, false);
    }
}

export function togglePeriodic(macro, session) {
    const key = `${session.id}:${macro.id}`;
    if (periodic.has(key)) {
        stopPeriodic(key);
        return false;
    }
    const token = { cancelled: false, busy: false };
    const tick = async () => {
        if (token.busy || token.cancelled) return;
        if (!session.canWrite || session.disposed) {
            stopPeriodic(key);
            return;
        }
        token.busy = true;
        try {
            await runSteps(macro, session, token);
        } finally {
            token.busy = false;
        }
    };
    token.timer = setInterval(tick, Math.max(10, macro.repeatMs));
    periodic.set(key, token);
    tick();
    emit('macros:running', key, true);
    return true;
}

export function startPeriodicSend(session, text, intervalMs, overrides = {}) {
    const key = `${session.id}:__input`;
    if (periodic.has(key)) stopPeriodic(key);
    const token = { cancelled: false };
    const tick = () => {
        if (!session.canWrite || session.disposed) {
            stopPeriodic(key);
            return;
        }
        session.sendText(text, { ...overrides, remember: false });
    };
    token.timer = setInterval(tick, Math.max(10, intervalMs));
    periodic.set(key, token);
    tick();
    emit('macros:running', key, true);
}

export function stopPeriodic(key) {
    const token = periodic.get(key);
    if (!token) return;
    token.cancelled = true;
    clearInterval(token.timer);
    periodic.delete(key);
    emit('macros:running', key, false);
}

export function isRunning(key) {
    return periodic.has(key) || running.has(key);
}

export function stopAllForSession(sessionId) {
    for (const key of Array.from(periodic.keys())) {
        if (key.startsWith(`${sessionId}:`)) stopPeriodic(key);
    }
    for (const [key, token] of Array.from(running.entries())) {
        if (key.startsWith(`${sessionId}:`)) {
            token.cancelled = true;
            running.delete(key);
        }
    }
}

function migrateLegacy() {
    try {
        if (localStorage.getItem('diagterm_migrated_v2')) return;
        const templates = JSON.parse(localStorage.getItem('diagterm_templates') || '[]');
        const alerts = JSON.parse(localStorage.getItem('diagterm_alert_patterns') || '[]');
        if (templates.length) {
            const macros = getMacros().slice();
            for (const tpl of templates) {
                macros.push({ ...defaultMacro(), name: tpl.name || 'Template', payload: tpl.content || '', lineEnding: 'none' });
            }
            saveMacros(macros);
            console.log(`Migrated ${templates.length} legacy templates to macros`);
        }
        if (alerts.length) {
            const triggers = (getStore('triggers', []) || []).slice();
            for (const al of alerts) {
                const type = String(al.matchType || 'Contains').toLowerCase();
                triggers.push({
                    id: uid(),
                    name: al.name || 'Alert',
                    enabled: al.enabled !== false,
                    pattern: al.pattern || '',
                    matchType: type === 'regex' ? 'regex' : (type === 'exact' ? 'exact' : 'contains'),
                    caseSensitive: false,
                    direction: 'any',
                    portFilter: '',
                    cooldownMs: 0,
                    actions: { notify: true, sound: true, marker: true, highlight: '#f44336', reply: { enabled: false, payload: '', mode: 'text', lineEnding: 'NL', delayMs: 0 }, stopwatch: 'none', pause: false, macroId: '', snapshot: false, disconnect: false }
                });
            }
            saveStore('triggers', triggers);
            console.log(`Migrated ${alerts.length} legacy alert patterns to triggers`);
        }
        localStorage.setItem('diagterm_migrated_v2', '1');
    } catch (error) {
        console.error('Legacy migration failed:', error);
    }
}

export async function initMacros() {
    await loadStore('macros', []);
    await loadStore('triggers', []);
    migrateLegacy();
    addKeyHandler((e, combo, typing) => {
        if (!combo) return false;
        const macro = getMacros().find(m => m.key && m.key === combo);
        if (!macro) return false;
        if (typing && !/^F\d+$/.test(combo) && !combo.includes('Ctrl') && !combo.includes('Alt')) return false;
        runMacro(macro);
        return true;
    });
    onEvent('session:removed', (session) => stopAllForSession(session.id));
}
