import { on } from '../core/api.js';
import { emit } from '../core/bus.js';
import { onEvent } from '../core/bus.js';
import { getSetting } from '../core/settings.js';
import { Session } from './session.js';
import { mainNow } from './clock.js';

const sessions = [];
let activeId = null;

export function allSessions() {
    return sessions;
}

export function getSession(id) {
    return sessions.find(s => s.id === id) || null;
}

export function activeSession() {
    return getSession(activeId);
}

export function sessionsForPath(path) {
    return sessions.filter(s => s.path === path);
}

export function setActive(id) {
    if (activeId === id) return;
    activeId = id;
    emit('session:active', getSession(id));
}

export function createSession(config = {}, { activate = true, index } = {}) {
    const session = new Session(config);
    if (index !== undefined && index >= 0 && index <= sessions.length) sessions.splice(index, 0, session);
    else sessions.push(session);
    session.on('frame', (entry) => emit('session:frame', session, entry));
    session.on('marker', (entry) => emit('session:marker', session, entry));
    session.on('state', (state, info) => emit('session:state', session, state, info));
    session.on('path', () => emit('sessions:changed', sessions));
    emit('session:created', session);
    emit('sessions:changed', sessions);
    if (activate) setActive(session.id);
    return session;
}

export async function removeSession(id) {
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return;
    const session = sessions[idx];
    if (session.kind === 'serial' && session.state !== 'closed') await session.close();
    sessions.splice(idx, 1);
    emit('session:removed', session);
    session.dispose();
    if (activeId === id) {
        const next = sessions[Math.min(idx, sessions.length - 1)];
        activeId = null;
        setActive(next ? next.id : null);
    }
    emit('sessions:changed', sessions);
}

export function moveSession(id, toIndex) {
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return;
    const [session] = sessions.splice(idx, 1);
    sessions.splice(Math.max(0, Math.min(sessions.length, toIndex)), 0, session);
    emit('sessions:changed', sessions);
}

export function findFreeSessionForPath(path) {
    return sessions.find(s => s.kind === 'serial' && s.path === path) || null;
}

function updateRates() {
    for (const session of sessions) {
        const st = session.stats;
        st.rxRate = st.rxBytes - st.lastRxBytes;
        st.txRate = st.txBytes - st.lastTxBytes;
        if (st.rxRate < 0) st.rxRate = 0;
        if (st.txRate < 0) st.txRate = 0;
        st.lastRxBytes = st.rxBytes;
        st.lastTxBytes = st.txBytes;
        st.peakRx = Math.max(st.peakRx, st.rxRate);
        st.peakTx = Math.max(st.peakTx, st.txRate);
        st.history.push({ rx: st.rxRate, tx: st.txRate });
        if (st.history.length > 60) st.history.shift();
    }
    emit('stats:tick', sessions);
}

export function initSessions() {
    on('serial:data', (batch) => {
        const touched = new Set();
        for (const item of batch) {
            const bytes = item.b instanceof Uint8Array ? item.b : new Uint8Array(item.b);
            for (const session of sessions) {
                if (session.path !== item.p) continue;
                session.ingest(item.d, item.t, bytes);
                touched.add(session);
            }
        }
        for (const session of touched) session.emit('batch');
    });
    on('serial:state', (payload) => {
        for (const session of sessions) {
            if (session.path === payload.path || (payload.previousPath && session.path === payload.previousPath)) {
                if (session.isVirtual) continue;
                session.handleState(payload);
            }
        }
        emit('serial:state', payload);
    });
    on('serial:signals', ({ path, signals }) => {
        for (const session of sessions) {
            if (session.path === path) session.handleSignals(signals);
        }
    });
    on('serial:error', ({ path, error }) => {
        for (const session of sessions) {
            if (session.path === path) {
                session.stats.errors++;
                session.addSystem(error, 'error');
            }
        }
    });
    setInterval(() => {
        const now = mainNow();
        for (const session of sessions) session.flushIdle(now);
    }, 25);
    setInterval(updateRates, 1000);
    onEvent('settings:changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('terminal.max')) {
            for (const session of sessions) {
                session.capture.maxEntries = getSetting('terminal.maxEntries', 200000);
                session.capture.maxBytes = getSetting('terminal.maxCaptureMB', 128) * 1024 * 1024;
            }
        }
    });
}
