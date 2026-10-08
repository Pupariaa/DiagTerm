const fs = require('fs');
const os = require('os');
const path = require('path');
const boardManager = require('./board-manager');
const { run } = require('./process');
const { expand, parseNumber } = require('./properties');
const partitions = require('./partitions');
const uf2 = require('./uf2');
const esptool = require('./drivers/esptool');
const rp2040 = require('./drivers/rp2040');
const { walk } = require('../files');

const EXE = process.platform === 'win32' ? '.exe' : '';

const TOOL_NAMES = {
    littlefs: { exe: 'mklittlefs', names: ['mklittlefs', 'pqt-mklittlefs'] },
    spiffs: { exe: 'mkspiffs', names: ['mkspiffs'] },
    ffat: { exe: 'mkfatfs', names: ['mkfatfs'] }
};

function searchExe(dir, exe, depth = 2) {
    if (!dir || !fs.existsSync(dir)) return null;
    const direct = path.join(dir, exe);
    if (fs.existsSync(direct)) return direct;
    if (depth <= 0) return null;
    for (const name of fs.readdirSync(dir)) {
        const sub = path.join(dir, name);
        try {
            if (fs.statSync(sub).isDirectory()) {
                const found = searchExe(sub, exe, depth - 1);
                if (found) return found;
            }
        } catch (error) {
            continue;
        }
    }
    return null;
}

async function locateFsTool(props, fsType) {
    const spec = TOOL_NAMES[fsType];
    if (!spec) throw new Error(`Unknown filesystem type ${fsType}`);
    const exe = spec.exe + EXE;
    const dirs = [];
    for (const name of spec.names) {
        if (props[`runtime.tools.${name}.path`]) dirs.push(props[`runtime.tools.${name}.path`]);
        if (props[`tools.${name}.path`]) dirs.push(expand(props[`tools.${name}.path`], props));
    }
    for (const dir of dirs) {
        const found = searchExe(dir, exe);
        if (found) return found;
    }
    for (const name of spec.names) {
        const tool = boardManager.findInstalledTool(name);
        const found = tool && searchExe(tool.path, exe);
        if (found) return found;
    }
    const tool = await boardManager.ensureTool(spec.names[0], { packager: 'esp32' });
    const found = tool && searchExe(tool.path, exe);
    if (found) return found;
    throw new Error(`${spec.exe} not available`);
}

function loadPartitionRows(props, build) {
    if (build && build.partitionsCsv) return partitions.parseCsv(fs.readFileSync(build.partitionsCsv, 'utf8'));
    if (build && build.partitions) return partitions.parseBinary(fs.readFileSync(build.partitions));
    const candidates = [];
    if (props['build.variant.path']) candidates.push(path.join(props['build.variant.path'], 'partitions.csv'));
    const platformPath = props['runtime.platform.path'] || '';
    if (props['build.custom_partitions']) candidates.push(path.join(platformPath, 'tools', 'partitions', `${props['build.custom_partitions']}.csv`));
    if (props['build.partitions']) candidates.push(path.join(platformPath, 'tools', 'partitions', `${props['build.partitions']}.csv`));
    for (const file of candidates) {
        if (fs.existsSync(file)) return partitions.parseCsv(fs.readFileSync(file, 'utf8'));
    }
    throw new Error('Partition table not found for the selected scheme');
}

function layoutFor(resolved, fsType, { rows, build } = {}) {
    const props = resolved.props;
    const arch = resolved.platform.arch;
    if (arch === 'esp32') {
        const table = rows || loadPartitionRows(props, build);
        const part = partitions.findFsPartition(table, fsType);
        if (!part) throw new Error(`Selected partition scheme has no ${fsType === 'ffat' ? 'FAT' : 'SPIFFS/LittleFS'} partition`);
        return { family: 'esp', offset: part.offset, size: part.size, block: 4096, page: 256, partition: part.name };
    }
    if (arch === 'esp8266') {
        const start = parseNumber(props['build.spiffs_start']);
        const end = parseNumber(props['build.spiffs_end']);
        if (!(end > start)) throw new Error('Selected flash size has no filesystem area');
        if (fsType === 'ffat') throw new Error('FFat is not supported on ESP8266');
        return {
            family: 'esp',
            offset: start,
            size: end - start,
            block: parseNumber(props['build.spiffs_blocksize']) || 8192,
            page: parseNumber(props['build.spiffs_pagesize']) || 256
        };
    }
    if (arch === 'rp2040') {
        const start = parseNumber(props['build.fs_start']);
        const end = parseNumber(props['build.fs_end']);
        if (!(end > start)) throw new Error('Selected flash size has no filesystem area');
        if (fsType !== 'littlefs') throw new Error('Only LittleFS is supported on RP2040');
        return { family: 'rp2040', offset: start - 0x10000000, absolute: start, size: end - start, block: 4096, page: 256 };
    }
    throw new Error(`Filesystem images are not supported for ${resolved.platform.packager}:${arch}`);
}

async function buildImage(ctx, fsType, sourceDir, layout, outFile) {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) throw new Error(`Folder not found: ${sourceDir}`);
    const tool = await locateFsTool(ctx.resolved.props, fsType);
    const args = fsType === 'ffat'
        ? ['-c', sourceDir, '-s', String(layout.size), outFile]
        : ['-c', sourceDir, '-p', String(layout.page), '-b', String(layout.block), '-s', String(layout.size), outFile];
    const res = await run(tool, args, { onOutput: (t) => ctx.log(t), job: ctx.job });
    if (res.code !== 0 || !fs.existsSync(outFile)) throw new Error(`${path.basename(tool)} failed (code ${res.code})`);
    ctx.log(`Image built: ${fs.statSync(outFile).size} bytes\n`);
    return outFile;
}

async function resolveLayout(ctx, fsType, options) {
    if (options.layoutSource === 'device' && ctx.resolved.platform.arch === 'esp32') {
        ctx.log('Reading partition table from device\n');
        const rows = await esptool.readPartitionTable(ctx, options);
        return layoutFor(ctx.resolved, fsType, { rows });
    }
    if (options.offset && options.size) {
        const offset = parseNumber(options.offset);
        const size = parseNumber(options.size);
        const family = ctx.resolved.platform.arch === 'rp2040' ? 'rp2040' : 'esp';
        return { family, offset, size, absolute: family === 'rp2040' ? 0x10000000 + offset : undefined, block: parseNumber(options.block) || 4096, page: parseNumber(options.page) || 256 };
    }
    return layoutFor(ctx.resolved, fsType, { build: options.build });
}

async function upload(ctx, options) {
    const fsType = options.fsType || 'littlefs';
    const layout = await resolveLayout(ctx, fsType, options);
    ctx.log(`Filesystem ${fsType} at 0x${layout.offset.toString(16)} size ${layout.size} bytes${layout.partition ? ' (' + layout.partition + ')' : ''}\n`);
    let image = options.imageFile;
    let tmp = null;
    if (!image) {
        tmp = path.join(os.tmpdir(), `diagterm_fs_${Date.now()}.bin`);
        image = await buildImage(ctx, fsType, options.sourceDir, layout, tmp);
    }
    try {
        if (fs.statSync(image).size > layout.size) throw new Error('Filesystem image is larger than the partition');
        if (layout.family === 'esp') {
            await esptool.writeImages(ctx, [{ offset: `0x${layout.offset.toString(16)}`, file: image }], options);
        } else {
            const data = fs.readFileSync(image);
            await rp2040.deploy(ctx, uf2.encode(data, layout.absolute, rp2040.familyOf(ctx.resolved.props)), options);
        }
    } finally {
        if (tmp) fs.rmSync(tmp, { force: true });
    }
    return { layout };
}

async function build(ctx, options) {
    const fsType = options.fsType || 'littlefs';
    if (!options.outFile) throw new Error('No output file selected');
    const layout = await resolveLayout(ctx, fsType, options);
    ctx.log(`Building ${fsType} image for 0x${layout.offset.toString(16)} size ${layout.size} bytes\n`);
    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    await buildImage(ctx, fsType, options.sourceDir, layout, options.outFile);
    ctx.progress(100);
    return { layout, file: options.outFile };
}

async function download(ctx, options) {
    const fsType = options.fsType || 'littlefs';
    const layout = await resolveLayout(ctx, fsType, options);
    if (layout.family !== 'esp') throw new Error('Filesystem download is only supported on ESP chips');
    const outDir = options.outDir || path.join(os.tmpdir(), `diagterm_fs_${Date.now()}`);
    const image = options.keepImage || path.join(os.tmpdir(), `diagterm_fsread_${Date.now()}.bin`);
    ctx.log(`Reading ${fsType} partition at 0x${layout.offset.toString(16)} (${layout.size} bytes)\n`);
    await esptool.readFlash(ctx, `0x${layout.offset.toString(16)}`, `0x${layout.size.toString(16)}`, image, options);
    const tool = await locateFsTool(ctx.resolved.props, fsType);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const args = fsType === 'ffat'
        ? ['-u', outDir, '-s', String(layout.size), image]
        : ['-u', outDir, '-p', String(layout.page), '-b', String(layout.block), '-s', String(layout.size), image];
    const res = await run(tool, args, { onOutput: (t) => ctx.log(t), job: ctx.job });
    if (!options.keepImage) fs.rmSync(image, { force: true });
    if (res.code !== 0) throw new Error(`Unable to unpack filesystem (code ${res.code}). Check the filesystem type.`);
    ctx.progress(100);
    return { outDir, files: walk(outDir), layout };
}

module.exports = { upload, download, build, layoutFor, loadPartitionRows, buildImage };
