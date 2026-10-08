const fs = require('fs');
const path = require('path');

const SUFFIXES = ['.with_bootloader.hex', '.with_bootloader.bin', '.merged.bin', '.bootloader.bin', '.partitions.bin', '.bin', '.hex', '.uf2', '.elf', '.eep', '.zip', '.dfu'];

function projectNameOf(file) {
    const base = path.basename(file);
    const lower = base.toLowerCase();
    for (const suffix of SUFFIXES) {
        if (lower.endsWith(suffix)) return base.slice(0, base.length - suffix.length);
    }
    return base.replace(/\.[^.]+$/, '');
}

function scanFolder(folder) {
    const names = fs.readdirSync(folder);
    const lower = names.map(n => n.toLowerCase());
    const pick = (predicate) => {
        const idx = lower.findIndex(predicate);
        return idx >= 0 ? path.join(folder, names[idx]) : null;
    };
    const app = pick(n => n.endsWith('.bin') && !/\.(merged|bootloader|partitions|with_bootloader)\.bin$/.test(n) && n !== 'boot_app0.bin');
    const anchor = app || pick(n => n.endsWith('.hex') && !n.endsWith('.with_bootloader.hex')) || pick(n => n.endsWith('.uf2')) || pick(n => n.endsWith('.elf'));
    const projectName = anchor ? projectNameOf(anchor) : null;
    const byName = (suffix) => {
        if (!projectName) return null;
        const target = path.join(folder, projectName + suffix);
        return fs.existsSync(target) ? target : null;
    };
    return {
        folder,
        projectName,
        app: byName('.bin'),
        bootloader: byName('.bootloader.bin'),
        partitions: byName('.partitions.bin'),
        merged: byName('.merged.bin'),
        hex: byName('.hex'),
        withBootloaderHex: byName('.with_bootloader.hex'),
        uf2: byName('.uf2'),
        elf: byName('.elf'),
        eep: byName('.eep'),
        bootApp0: fs.existsSync(path.join(folder, 'boot_app0.bin')) ? path.join(folder, 'boot_app0.bin') : null,
        partitionsCsv: fs.existsSync(path.join(folder, 'partitions.csv')) ? path.join(folder, 'partitions.csv') : null,
        flashArgs: fs.existsSync(path.join(folder, 'flash_args')) ? path.join(folder, 'flash_args') : null
    };
}

function findBuildFolder(start) {
    if (!fs.existsSync(start)) return null;
    const stat = fs.statSync(start);
    if (!stat.isDirectory()) return null;
    const direct = scanFolder(start);
    if (direct.projectName) return direct;
    const queue = [start];
    let depth = 0;
    while (queue.length && depth < 4) {
        const level = queue.splice(0);
        for (const dir of level) {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                try {
                    if (!fs.statSync(full).isDirectory()) continue;
                } catch (error) {
                    continue;
                }
                const scanned = scanFolder(full);
                if (scanned.projectName) return scanned;
                queue.push(full);
            }
        }
        depth++;
    }
    return null;
}

function parseFlashArgs(file) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const flags = [];
    const images = [];
    for (const line of lines) {
        if (line.startsWith('--')) {
            flags.push(...line.split(/\s+/));
            continue;
        }
        const m = line.match(/^(0x[0-9a-fA-F]+)\s+(.+)$/);
        if (m) images.push({ offset: m[1], file: m[2].trim() });
    }
    return { flags, images };
}

function describe(input) {
    if (!input) return null;
    if (input.mode === 'images') return { mode: 'images', images: input.images || [] };
    const target = input.path;
    if (!target || !fs.existsSync(target)) throw new Error(`Input not found: ${target || '(none)'}`);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        const build = findBuildFolder(target);
        if (!build) throw new Error(`No compiled sketch found in ${target}`);
        return { mode: input.mode === 'merged' ? 'merged' : 'folder', build };
    }
    const folderScan = scanFolder(path.dirname(target));
    const lower = target.toLowerCase();
    const build = { ...folderScan, projectName: projectNameOf(target) };
    const fileKind = lower.endsWith('.merged.bin') ? 'merged' : lower.endsWith('.uf2') ? 'uf2' : lower.endsWith('.hex') ? 'hex' : lower.endsWith('.elf') ? 'elf' : 'bin';
    return { mode: input.mode === 'folder' ? 'folder' : (fileKind === 'merged' ? 'merged' : 'file'), file: target, fileKind, build, offset: input.offset };
}

module.exports = { describe, scanFolder, findBuildFolder, parseFlashArgs, projectNameOf };
