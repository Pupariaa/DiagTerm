const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const semver = require('semver');
const { send, bus } = require('../context');
const settings = require('../settings');
const { fetchJson, download, extract } = require('./archive');

const UPLOAD_TOOL_PATTERN = /^(esptool(_py)?|avrdude|arduinoOTA|bossac|dfu-util|mklittlefs|mkspiffs|mkfatfs|python3|pqt-picotool|pqt-mklittlefs|pqt-python3|picotool|openocd|MCS51Tools|teensy-tools|nrfutil|adafruit-nrfutil|imgtool|wchisp|wlink|beforeinstall)$/i;

let indexes = new Map();
let installedCache = null;
let busy = false;
let updateTimer = null;
const activeTasks = new Map();

function rootDir() {
    const configured = settings.get('flash.toolsFolder');
    const dir = configured || path.join(app.getPath('userData'), 'boards');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function arduino15Dir() {
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Arduino15');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Arduino15');
    return path.join(os.homedir(), '.arduino15');
}

function sources() {
    const list = [{ name: 'managed', dir: rootDir(), writable: true }];
    if (settings.get('flash.reuseArduino15')) {
        const a15 = arduino15Dir();
        if (fs.existsSync(path.join(a15, 'packages'))) list.push({ name: 'arduino15', dir: a15, writable: false });
    }
    return list;
}

function emitProgress(task, data) {
    send('boards:progress', { task, ...data });
}

function indexFileFor(url) {
    const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
    const base = path.basename(url.split('?')[0]).replace(/[^a-zA-Z0-9_.\-]/g, '_');
    return path.join(rootDir(), 'indexes', `${hash}_${base}`);
}

function loadCachedIndexes() {
    indexes = new Map();
    const urls = settings.get('flash.indexUrls') || [];
    for (const url of urls) {
        const file = indexFileFor(url);
        if (fs.existsSync(file)) {
            try {
                indexes.set(url, JSON.parse(fs.readFileSync(file, 'utf8')));
            } catch (error) {
                console.error(`Corrupted index ${url}:`, error.message);
            }
        }
    }
    if (settings.get('flash.reuseArduino15')) {
        const a15 = arduino15Dir();
        if (fs.existsSync(a15)) {
            for (const name of fs.readdirSync(a15)) {
                if (!/^package_.*index\.json$/.test(name)) continue;
                const key = `arduino15:${name}`;
                if (indexes.has(key)) continue;
                try {
                    indexes.set(key, JSON.parse(fs.readFileSync(path.join(a15, name), 'utf8')));
                } catch (error) {
                    console.error(`Unable to read Arduino15 index ${name}:`, error.message);
                }
            }
        }
    }
    return indexes;
}

async function fetchIndexes() {
    const urls = settings.get('flash.indexUrls') || [];
    const results = [];
    emitProgress('indexes', { phase: 'start', message: 'Updating board indexes' });
    for (const url of urls) {
        try {
            const data = await fetchJson(url);
            if (!data || !Array.isArray(data.packages)) throw new Error('Invalid index format');
            const file = indexFileFor(url);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data));
            results.push({ url, success: true });
        } catch (error) {
            console.error(`Failed to fetch index ${url}:`, error.message);
            results.push({ url, success: false, error: error.message });
        }
    }
    loadCachedIndexes();
    settings.storeSet('boards-state', { ...(settings.storeGet('boards-state', {}) || {}), lastIndexFetch: Date.now() });
    emitProgress('indexes', { phase: 'done', results });
    return results;
}

function allPackages() {
    const packages = [];
    for (const [url, data] of indexes.entries()) {
        for (const pkg of data.packages || []) packages.push({ url, pkg });
    }
    return packages;
}

function findPlatformEntry(packager, arch, version) {
    let best = null;
    for (const { pkg } of allPackages()) {
        if (pkg.name !== packager) continue;
        for (const platform of pkg.platforms || []) {
            if (platform.architecture !== arch) continue;
            if (version && platform.version !== version) continue;
            if (!best || compareVersions(platform.version, best.version) > 0) best = platform;
        }
    }
    return best;
}

function findToolEntry(packager, name, version) {
    let best = null;
    for (const { pkg } of allPackages()) {
        if (packager && pkg.name !== packager) continue;
        for (const tool of pkg.tools || []) {
            if (tool.name !== name) continue;
            if (version && tool.version !== version) continue;
            if (!best || compareVersions(tool.version, best.tool.version) > 0) best = { packager: pkg.name, tool };
        }
    }
    return best;
}

function compareVersions(a, b) {
    const ca = semver.coerce(a, { loose: true });
    const cb = semver.coerce(b, { loose: true });
    if (ca && cb) {
        const cmp = semver.compare(ca, cb);
        if (cmp !== 0) return cmp;
        const pa = semver.valid(a, { loose: true });
        const pb = semver.valid(b, { loose: true });
        if (pa && pb) return semver.compare(pa, pb, { loose: true });
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function hostCandidates() {
    const arch = process.arch;
    if (process.platform === 'win32') {
        return arch === 'arm64'
            ? ['arm64-mingw32', 'x86_64-mingw32', 'x86_64-w64-mingw32', 'i686-mingw32', 'i686-w64-mingw32', 'i686-pc-mingw32']
            : ['x86_64-mingw32', 'x86_64-w64-mingw32', 'i686-mingw32', 'i686-w64-mingw32', 'i686-pc-mingw32', 'i386-mingw32'];
    }
    if (process.platform === 'darwin') {
        return arch === 'arm64'
            ? ['arm64-apple-darwin', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'i386-apple-darwin11', 'x86_64-apple-darwin12']
            : ['x86_64-apple-darwin', 'x86_64-apple-darwin12', 'i386-apple-darwin11', 'i686-apple-darwin'];
    }
    if (arch === 'arm64') return ['aarch64-linux-gnu', 'aarch64-unknown-linux-gnu', 'arm64-linux-gnu'];
    if (arch === 'arm') return ['arm-linux-gnueabihf', 'armhf-pc-linux-gnu'];
    return ['x86_64-linux-gnu', 'x86_64-pc-linux-gnu', 'x86_64-unknown-linux-gnu', 'i686-linux-gnu', 'i686-pc-linux-gnu'];
}

function pickSystem(tool) {
    const systems = tool.systems || [];
    for (const host of hostCandidates()) {
        const exact = systems.find(s => s.host === host);
        if (exact) return exact;
    }
    if (process.platform === 'win32') return systems.find(s => /mingw|windows|win32/i.test(s.host)) || null;
    if (process.platform === 'darwin') return systems.find(s => /darwin|apple/i.test(s.host)) || null;
    return systems.find(s => /linux/i.test(s.host) && !/arm|aarch/i.test(s.host)) || null;
}

function scanInstalled(force = false) {
    if (installedCache && !force) return installedCache;
    const platforms = [];
    const tools = [];
    for (const source of sources()) {
        const pkgRoot = path.join(source.dir, 'packages');
        if (!fs.existsSync(pkgRoot)) continue;
        for (const packager of safeReaddir(pkgRoot)) {
            const hwRoot = path.join(pkgRoot, packager, 'hardware');
            for (const arch of safeReaddir(hwRoot)) {
                for (const version of safeReaddir(path.join(hwRoot, arch))) {
                    const dir = path.join(hwRoot, arch, version);
                    if (fs.existsSync(path.join(dir, 'boards.txt'))) {
                        platforms.push({ packager, arch, version, path: dir, source: source.name, writable: source.writable });
                    }
                }
            }
            const toolRoot = path.join(pkgRoot, packager, 'tools');
            for (const name of safeReaddir(toolRoot)) {
                for (const version of safeReaddir(path.join(toolRoot, name))) {
                    const dir = path.join(toolRoot, name, version);
                    if (!fs.statSync(dir).isDirectory()) continue;
                    if (safeReaddir(dir).length === 0) continue;
                    tools.push({ packager, name, version, path: dir, source: source.name, writable: source.writable });
                }
            }
        }
    }
    installedCache = { platforms, tools };
    return installedCache;
}

function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir).filter(n => !n.startsWith('.') && !n.includes('.extract-'));
    } catch (error) {
        return [];
    }
}

function activePlatforms() {
    const { platforms } = scanInstalled();
    const byKey = new Map();
    for (const p of platforms) {
        const key = `${p.packager}:${p.arch}`;
        const current = byKey.get(key);
        if (!current) {
            byKey.set(key, p);
            continue;
        }
        const cmp = compareVersions(p.version, current.version);
        if (cmp > 0 || (cmp === 0 && p.source === 'managed' && current.source !== 'managed')) byKey.set(key, p);
    }
    return Array.from(byKey.values());
}

function findInstalledPlatform(packager, arch) {
    return activePlatforms().find(p => p.packager === packager && p.arch === arch) || null;
}

function findInstalledTool(name, { packager, version } = {}) {
    const { tools } = scanInstalled();
    let candidates = tools.filter(t => t.name === name);
    if (version) {
        const exact = candidates.filter(t => t.version === version);
        if (exact.length) candidates = exact;
    }
    if (packager) {
        const sameVendor = candidates.filter(t => t.packager === packager);
        if (sameVendor.length) candidates = sameVendor;
    }
    candidates.sort((a, b) => compareVersions(b.version, a.version) || (a.source === 'managed' ? -1 : 1));
    return candidates[0] || null;
}

function toolsForPlatform(platform) {
    const { tools } = scanInstalled();
    const resolved = new Map();
    const sorted = [...tools].sort((a, b) => compareVersions(a.version, b.version));
    for (const tool of sorted) {
        const existing = resolved.get(tool.name);
        if (!existing || tool.packager === platform.packager || existing.packager !== platform.packager) resolved.set(tool.name, tool);
    }
    const entry = findPlatformEntry(platform.packager, platform.arch, platform.version);
    const versioned = [];
    if (entry && entry.toolsDependencies) {
        for (const dep of entry.toolsDependencies) {
            const tool = tools.find(t => t.name === dep.name && t.version === dep.version && t.packager === dep.packager) ||
                tools.find(t => t.name === dep.name && t.version === dep.version);
            if (tool) {
                resolved.set(dep.name, tool);
                versioned.push({ name: `${dep.name}-${dep.version}`, tool });
            }
        }
    }
    for (const tool of tools) versioned.push({ name: `${tool.name}-${tool.version}`, tool });
    return { byName: resolved, versioned, dependencies: entry ? entry.toolsDependencies || [] : [] };
}

function platformFilter(rel) {
    if (rel === '') return true;
    const normalized = rel.replace(/\\/g, '/');
    if (!normalized.includes('/')) return true;
    const top = normalized.split('/')[0];
    if (!['tools', 'bootloaders', 'firmwares', 'variants'].includes(top)) return false;
    if (/^tools\/(sdk|ide-debug)\//.test(normalized)) return false;
    return true;
}

async function installTool(packager, name, version, task = `tool:${name}`) {
    const existing = findInstalledTool(name, { packager, version });
    if (existing && (!version || existing.version === version)) return existing;
    const found = findToolEntry(packager, name, version) || findToolEntry(null, name, version);
    if (!found) throw new Error(`Tool ${name}${version ? '@' + version : ''} not found in indexes`);
    const system = pickSystem(found.tool);
    if (!system) throw new Error(`Tool ${name}@${found.tool.version} has no build for this system`);
    const staging = path.join(rootDir(), 'staging', system.archiveFileName || path.basename(system.url));
    emitProgress(task, { phase: 'download', message: `Downloading ${name} ${found.tool.version}`, percent: 0 });
    await download(system.url, staging, {
        checksum: system.checksum,
        size: system.size,
        onProgress: (rec, total) => emitProgress(task, { phase: 'download', message: `Downloading ${name} ${found.tool.version}`, percent: total ? Math.round(rec * 100 / total) : null, received: rec, total })
    });
    emitProgress(task, { phase: 'extract', message: `Extracting ${name}` });
    const dest = path.join(rootDir(), 'packages', found.packager, 'tools', name, found.tool.version);
    await extract(staging, dest, { archiveName: system.archiveFileName || system.url });
    fs.rmSync(staging, { force: true });
    installedCache = null;
    console.log(`Installed tool ${found.packager}:${name}@${found.tool.version}`);
    return findInstalledTool(name, { packager: found.packager, version: found.tool.version });
}

async function ensureTool(name, { packager, version } = {}) {
    const existing = findInstalledTool(name, { packager, version });
    if (existing) return existing;
    if (indexes.size === 0) loadCachedIndexes();
    if (indexes.size === 0) await fetchIndexes();
    return installTool(packager, name, version);
}

async function installPlatform(packager, arch, version) {
    if (indexes.size === 0) loadCachedIndexes();
    const entry = findPlatformEntry(packager, arch, version);
    if (!entry) throw new Error(`Platform ${packager}:${arch}${version ? '@' + version : ''} not found`);
    const task = `platform:${packager}:${arch}`;
    activeTasks.set(task, true);
    try {
        const staging = path.join(rootDir(), 'staging', entry.archiveFileName || path.basename(entry.url));
        emitProgress(task, { phase: 'download', message: `Downloading ${entry.name} ${entry.version}`, percent: 0 });
        await download(entry.url, staging, {
            checksum: entry.checksum,
            size: entry.size,
            onProgress: (rec, total) => emitProgress(task, { phase: 'download', message: `Downloading ${entry.name} ${entry.version}`, percent: total ? Math.round(rec * 100 / total) : null, received: rec, total })
        });
        emitProgress(task, { phase: 'extract', message: `Extracting ${entry.name}` });
        const dest = path.join(rootDir(), 'packages', packager, 'hardware', arch, entry.version);
        await extract(staging, dest, { filter: platformFilter, archiveName: entry.archiveFileName || entry.url });
        fs.rmSync(staging, { force: true });
        installedCache = null;
        const deps = (entry.toolsDependencies || []).filter(d => UPLOAD_TOOL_PATTERN.test(d.name));
        for (let i = 0; i < deps.length; i++) {
            const dep = deps[i];
            emitProgress(task, { phase: 'tools', message: `Installing ${dep.name} ${dep.version} (${i + 1}/${deps.length})` });
            try {
                await installTool(dep.packager, dep.name, dep.version, task);
            } catch (error) {
                console.error(`Failed to install tool ${dep.name}:`, error.message);
                emitProgress(task, { phase: 'warning', message: `Tool ${dep.name}: ${error.message}` });
            }
        }
        if (!settings.get('flash.keepOldVersions')) removeOtherVersions(packager, arch, entry.version);
        installedCache = null;
        emitProgress(task, { phase: 'done', message: `${entry.name} ${entry.version} installed` });
        bus.emit('boards-changed');
        send('boards:changed');
        return { success: true, version: entry.version };
    } catch (error) {
        emitProgress(task, { phase: 'error', message: error.message });
        throw error;
    } finally {
        activeTasks.delete(task);
    }
}

function removeOtherVersions(packager, arch, keepVersion) {
    const dir = path.join(rootDir(), 'packages', packager, 'hardware', arch);
    for (const version of safeReaddir(dir)) {
        if (version === keepVersion) continue;
        fs.rmSync(path.join(dir, version), { recursive: true, force: true });
        console.log(`Removed old platform ${packager}:${arch}@${version}`);
    }
    cleanupTools();
}

function cleanupTools() {
    installedCache = null;
    const { platforms, tools } = scanInstalled(true);
    const needed = new Set();
    for (const p of platforms) {
        const entry = findPlatformEntry(p.packager, p.arch, p.version);
        for (const dep of (entry && entry.toolsDependencies) || []) needed.add(`${dep.packager}:${dep.name}:${dep.version}`);
    }
    for (const tool of tools) {
        if (tool.source !== 'managed') continue;
        const key = `${tool.packager}:${tool.name}:${tool.version}`;
        if (needed.has(key)) continue;
        const newer = tools.some(t => t.name === tool.name && t.source === 'managed' && compareVersions(t.version, tool.version) > 0);
        if (newer && platforms.length > 0) {
            fs.rmSync(tool.path, { recursive: true, force: true });
            console.log(`Removed unused tool ${key}`);
        }
    }
    installedCache = null;
}

function uninstallPlatform(packager, arch, version) {
    const dir = path.join(rootDir(), 'packages', packager, 'hardware', arch, version);
    if (!fs.existsSync(dir)) return { success: false, error: 'Not installed in DiagTerm storage' };
    fs.rmSync(dir, { recursive: true, force: true });
    installedCache = null;
    cleanupTools();
    bus.emit('boards-changed');
    send('boards:changed');
    return { success: true };
}

function getCatalog() {
    if (indexes.size === 0) loadCachedIndexes();
    const installed = scanInstalled().platforms;
    const map = new Map();
    for (const { url, pkg } of allPackages()) {
        for (const platform of pkg.platforms || []) {
            const key = `${pkg.name}:${platform.architecture}`;
            let item = map.get(key);
            if (!item) {
                item = {
                    key,
                    packager: pkg.name,
                    arch: platform.architecture,
                    name: platform.name,
                    maintainer: pkg.maintainer || '',
                    website: pkg.websiteURL || '',
                    indexUrl: url,
                    versions: new Set(),
                    boards: []
                };
                map.set(key, item);
            }
            item.versions.add(platform.version);
            if (!item.latest || compareVersions(platform.version, item.latest) > 0) {
                item.latest = platform.version;
                item.name = platform.name;
                item.boards = (platform.boards || []).map(b => b.name);
                item.deprecated = !!platform.deprecated;
            }
        }
    }
    for (const p of installed) {
        const key = `${p.packager}:${p.arch}`;
        if (!map.has(key)) {
            map.set(key, { key, packager: p.packager, arch: p.arch, name: `${p.packager} ${p.arch}`, maintainer: '', website: '', versions: new Set([p.version]), latest: p.version, boards: [] });
        }
    }
    const out = [];
    for (const item of map.values()) {
        const versions = Array.from(item.versions).sort((a, b) => compareVersions(b, a));
        const inst = installed.filter(p => p.packager === item.packager && p.arch === item.arch);
        const active = activePlatforms().find(p => p.packager === item.packager && p.arch === item.arch) || null;
        out.push({
            ...item,
            versions,
            installed: inst.map(p => ({ version: p.version, source: p.source, path: p.path })),
            activeVersion: active ? active.version : null,
            activeSource: active ? active.source : null,
            updateAvailable: !!(active && item.latest && compareVersions(item.latest, active.version) > 0)
        });
    }
    out.sort((a, b) => (b.installed.length - a.installed.length) || a.name.localeCompare(b.name));
    return out;
}

async function autoUpdate() {
    if (busy) return;
    if (!settings.get('flash.autoUpdate')) return;
    busy = true;
    try {
        const state = settings.storeGet('boards-state', {}) || {};
        const intervalMs = Math.max(1, Number(settings.get('flash.updateIntervalHours')) || 12) * 3600000;
        if (!state.lastIndexFetch || Date.now() - state.lastIndexFetch >= intervalMs || indexes.size === 0) {
            await fetchIndexes();
        }
        const managed = scanInstalled(true).platforms.filter(p => p.source === 'managed');
        const keys = new Set(managed.map(p => `${p.packager}:${p.arch}`));
        for (const key of keys) {
            const [packager, arch] = key.split(':');
            const entry = findPlatformEntry(packager, arch);
            const current = managed.filter(p => p.packager === packager && p.arch === arch).sort((a, b) => compareVersions(b.version, a.version))[0];
            if (entry && current && compareVersions(entry.version, current.version) > 0) {
                console.log(`Auto-updating ${key} from ${current.version} to ${entry.version}`);
                try {
                    await installPlatform(packager, arch, entry.version);
                    send('boards:auto-updated', { key, from: current.version, to: entry.version });
                } catch (error) {
                    console.error(`Auto-update of ${key} failed:`, error.message);
                }
            }
        }
    } catch (error) {
        console.error('Board auto-update error:', error.message);
    } finally {
        busy = false;
    }
}

function scheduleAutoUpdate() {
    if (updateTimer) clearInterval(updateTimer);
    setTimeout(autoUpdate, 15000);
    updateTimer = setInterval(autoUpdate, 30 * 60000);
}

function init() {
    loadCachedIndexes();
    scheduleAutoUpdate();
    bus.on('settings-changed', (keyPath) => {
        if (keyPath === '*' || keyPath.startsWith('flash.indexUrls') || keyPath.startsWith('flash.reuseArduino15') || keyPath.startsWith('flash.toolsFolder') || keyPath === 'flash') {
            installedCache = null;
            loadCachedIndexes();
            send('boards:changed');
        }
    });
}

module.exports = {
    init,
    rootDir,
    fetchIndexes,
    getCatalog,
    installPlatform,
    uninstallPlatform,
    installTool,
    ensureTool,
    activePlatforms,
    findInstalledPlatform,
    findInstalledTool,
    toolsForPlatform,
    scanInstalled,
    compareVersions,
    autoUpdate,
    isBusy: () => busy || activeTasks.size > 0,
    invalidate: () => { installedCache = null; }
};
