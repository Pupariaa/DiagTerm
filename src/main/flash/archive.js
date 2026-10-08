const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const yauzl = require('yauzl');
const unbzip2 = require('unbzip2-stream');

async function fetchJson(url) {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'DiagTerm' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return JSON.parse(text);
}

function parseChecksum(checksum) {
    if (!checksum) return null;
    const idx = checksum.indexOf(':');
    if (idx < 0) return null;
    const algo = checksum.slice(0, idx).toLowerCase().replace('-', '');
    const value = checksum.slice(idx + 1).toLowerCase();
    if (!['sha256', 'sha1', 'md5'].includes(algo)) return null;
    return { algo, value };
}

async function hashFile(file, algo) {
    const hash = crypto.createHash(algo);
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
}

async function download(url, dest, { checksum, size, onProgress, signal } = {}) {
    const expected = parseChecksum(checksum);
    if (fs.existsSync(dest) && expected) {
        const existing = await hashFile(dest, expected.algo);
        if (existing === expected.value) return dest;
        fs.rmSync(dest, { force: true });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await net.fetch(url, { headers: { 'User-Agent': 'DiagTerm' }, signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} while downloading ${url}`);
    const total = parseInt(res.headers.get('content-length'), 10) || parseInt(size, 10) || 0;
    const hash = expected ? crypto.createHash(expected.algo) : null;
    let received = 0;
    let lastEmit = 0;
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length;
            if (hash) hash.update(chunk);
            const now = Date.now();
            if (onProgress && now - lastEmit > 150) {
                lastEmit = now;
                onProgress(received, total);
            }
            callback(null, chunk);
        }
    });
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
    if (onProgress) onProgress(received, total);
    if (hash) {
        const digest = hash.digest('hex');
        if (digest !== expected.value) {
            fs.rmSync(tmp, { force: true });
            throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
        }
    }
    fs.renameSync(tmp, dest);
    return dest;
}

function stripFirst(entryPath) {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
    const idx = normalized.indexOf('/');
    if (idx < 0) return '';
    return normalized.slice(idx + 1);
}

function extractZip(file, dest, filter) {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
            if (err) {
                reject(err);
                return;
            }
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.readEntry();
            zip.on('entry', (entry) => {
                const name = entry.fileName.replace(/\\/g, '/');
                if (name.includes('..')) {
                    zip.readEntry();
                    return;
                }
                if (filter && !filter(stripFirst(name), name)) {
                    zip.readEntry();
                    return;
                }
                const target = path.join(dest, name);
                if (name.endsWith('/')) {
                    fs.mkdirSync(target, { recursive: true });
                    zip.readEntry();
                    return;
                }
                fs.mkdirSync(path.dirname(target), { recursive: true });
                zip.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) {
                        reject(streamErr);
                        return;
                    }
                    const mode = (entry.externalFileAttributes >>> 16) & 0o777;
                    const out = fs.createWriteStream(target, mode ? { mode } : undefined);
                    stream.pipe(out);
                    out.on('finish', () => zip.readEntry());
                    out.on('error', reject);
                });
            });
        });
    });
}

async function extractTar(file, dest, filter, compression) {
    fs.mkdirSync(dest, { recursive: true });
    const options = {
        cwd: dest,
        filter: filter ? (p) => filter(stripFirst(p), p) : undefined,
        preservePaths: false
    };
    if (compression === 'bz2') {
        await pipeline(fs.createReadStream(file), unbzip2(), tar.x(options));
    } else {
        await tar.x({ ...options, file });
    }
}

function detectFormat(file) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'gz';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'bz2';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'xz';
    return null;
}

async function extract(file, dest, { filter, archiveName } = {}) {
    const format = detectFormat(archiveName || file);
    if (!format) throw new Error(`Unsupported archive format: ${path.basename(archiveName || file)}`);
    if (format === 'xz') throw new Error('XZ archives are not supported');
    const tmp = `${dest}.extract-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
        if (format === 'zip') await extractZip(file, tmp, filter);
        else await extractTar(file, tmp, filter, format === 'bz2' ? 'bz2' : null);
        const entries = fs.readdirSync(tmp);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory()) {
            fs.renameSync(path.join(tmp, entries[0]), dest);
            fs.rmSync(tmp, { recursive: true, force: true });
        } else {
            fs.renameSync(tmp, dest);
        }
    } catch (error) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw error;
    }
    return dest;
}

module.exports = { fetchJson, download, extract, hashFile };
