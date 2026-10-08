import { invoke, on } from '../core/api.js';
import { loadStore, getStore, saveStore } from '../core/store.js';
import { Emitter } from '../core/emitter.js';
import { uid } from '../core/dom.js';

export const flashEvents = new Emitter();

const jobs = new Map();
const logs = new Map();
let boards = [];
let boardsLoaded = false;
let catalog = [];
let production = { active: false, stats: { queued: 0, done: 0, failed: 0 } };
const boardProgress = new Map();

export function defaultProfile() {
    return {
        id: uid(),
        name: '',
        fqbn: '',
        menus: {},
        input: { mode: 'folder', path: '', offset: '', images: [] },
        fs: { enabled: false, fsType: 'littlefs', source: 'folder', sourceDir: '', imageFile: '', layoutSource: 'board', offset: '', size: '' },
        eraseFirst: false,
        verify: false,
        options: { uploadSpeed: '', chip: 'board', flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', method: 'touch' },
        programmer: '',
        forceGeneric: false,
        verbose: false
    };
}

export function normalizeProfile(p) {
    const d = defaultProfile();
    return {
        ...d,
        ...p,
        menus: { ...(p && p.menus) },
        input: { ...d.input, ...(p && p.input) },
        fs: { ...d.fs, ...(p && p.fs) },
        options: { ...d.options, ...(p && p.options) }
    };
}

export function getDraft() {
    const state = getStore('flash-state', null);
    return normalizeProfile(state && state.draft ? state.draft : {});
}

export function saveDraft(draft) {
    const state = getStore('flash-state', {}) || {};
    saveStore('flash-state', { ...state, draft }, { debounce: 400 });
    flashEvents.emit('draft', draft);
}

export function getFlashUiState() {
    return getStore('flash-state', {}) || {};
}

export function setFlashUiState(partial) {
    const state = getStore('flash-state', {}) || {};
    saveStore('flash-state', { ...state, ...partial }, { debounce: 400 });
}

export function getProfiles() {
    return getStore('flash-profiles', []) || [];
}

export function saveProfiles(list) {
    saveStore('flash-profiles', list);
    flashEvents.emit('profiles', list);
}

export function recentBoards() {
    return getFlashUiState().recentBoards || [];
}

export function pushRecentBoard(fqbn) {
    if (!fqbn) return;
    const list = recentBoards().filter(f => f !== fqbn);
    list.unshift(fqbn);
    setFlashUiState({ recentBoards: list.slice(0, 8) });
}

export function profileForJob(profile) {
    const p = normalizeProfile(profile);
    const input = { ...p.input };
    if (input.mode === 'images') {
        input.images = (input.images || []).filter(i => i.file && i.offset);
    } else if (!input.path) {
        input.images = [];
    }
    const fs = { ...p.fs };
    if (fs.source === 'folder') fs.imageFile = '';
    else fs.sourceDir = '';
    if (fs.layoutSource !== 'custom') {
        fs.offset = '';
        fs.size = '';
    }
    const options = {};
    for (const [k, v] of Object.entries(p.options)) {
        if (v === '' || v === 'keep' || v === 'board') continue;
        options[k] = v;
    }
    return { ...p, input, fs, options };
}

export async function loadBoards(force = false) {
    if (boardsLoaded && !force) return boards;
    boards = await invoke('flash:boards');
    boardsLoaded = true;
    flashEvents.emit('boards', boards);
    return boards;
}

export function getBoards() {
    return boards;
}

export function findBoard(fqbn) {
    return boards.find(b => b.fqbn === fqbn) || null;
}

export async function loadCatalog() {
    catalog = await invoke('boards:catalog');
    flashEvents.emit('catalog', catalog);
    return catalog;
}

export function getCatalog() {
    return catalog;
}

export function getBoardProgress() {
    return boardProgress;
}

export function allJobs() {
    return Array.from(jobs.values()).sort((a, b) => a.id - b.id);
}

export function getJob(id) {
    return jobs.get(id) || null;
}

export function jobLog(id) {
    return logs.get(id) || '';
}

export async function fetchJobLog(id) {
    const text = await invoke('flash:job-log', id);
    logs.set(id, text || '');
    return logs.get(id);
}

export function activeJobCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') n++;
    return n;
}

export function getProduction() {
    return production;
}

export async function enqueueJobs(specs) {
    const ids = await invoke('flash:enqueue', specs);
    flashEvents.emit('enqueued', ids);
    return ids;
}

export async function clearFinishedJobs() {
    await invoke('flash:clear');
    for (const [id, job] of jobs) {
        if (job.status !== 'running' && job.status !== 'queued') {
            jobs.delete(id);
            logs.delete(id);
        }
    }
    flashEvents.emit('jobs');
}

export async function initFlashState() {
    await Promise.all([loadStore('flash-profiles', []), loadStore('flash-state', {})]);
    on('flash:job', (job) => {
        jobs.set(job.id, job);
        flashEvents.emit('job', job);
        flashEvents.emit('jobs');
    });
    on('flash:log', ({ jobId, text }) => {
        logs.set(jobId, (logs.get(jobId) || '') + text);
        flashEvents.emit('log', jobId, text);
    });
    on('flash:production', (state) => {
        production = state;
        flashEvents.emit('production', state);
    });
    on('boards:progress', (p) => {
        boardProgress.set(p.task, p);
        if (p.phase === 'done' || p.phase === 'error') setTimeout(() => {
            boardProgress.delete(p.task);
            flashEvents.emit('board-progress', p);
        }, 4000);
        flashEvents.emit('board-progress', p);
    });
    on('boards:changed', async () => {
        await loadBoards(true);
        await loadCatalog();
    });
    on('boards:auto-updated', (info) => flashEvents.emit('auto-updated', info));
    const list = await invoke('flash:jobs');
    for (const j of list || []) jobs.set(j.id, j);
    production = await invoke('flash:production-state');
    loadBoards().catch(error => console.error('Failed to load boards:', error.message));
    loadCatalog().catch(error => console.error('Failed to load board catalog:', error.message));
}
