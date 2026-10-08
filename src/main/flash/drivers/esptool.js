const fs = require('fs');
const os = require('os');
const path = require('path');
const boardManager = require('../board-manager');
const settings = require('../../settings');
const { run } = require('../process');
const { parseFlashArgs } = require('../inputs');
const { parseNumber } = require('../properties');
const partitions = require('../partitions');
const { prepareUploadPort, settlePort } = require('./common');

const versionCache = new Map();

function candidateBinaries(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    const names = process.platform === 'win32' ? ['esptool.exe'] : ['esptool', 'esptool.py'];
    const out = [];
    for (const name of names) {
        const direct = path.join(dir, name);
        if (fs.existsSync(direct)) out.push(direct);
    }
    if (out.length === 0) {
        for (const sub of fs.readdirSync(dir)) {
            const subDir = path.join(dir, sub);
            try {
                if (!fs.statSync(subDir).isDirectory()) continue;
            } catch (error) {
                continue;
            }
            for (const name of names) {
                const nested = path.join(subDir, name);
                if (fs.existsSync(nested)) out.push(nested);
            }
        }
    }
    return out;
}

async function locate(props) {
    const fromBoard = props && (props['runtime.tools.esptool_py.path'] || props['runtime.tools.esptool.path']);
    let bins = candidateBinaries(fromBoard);
    if (bins.length) return bins[0];
    const installed = boardManager.findInstalledTool('esptool_py') || boardManager.findInstalledTool('esptool');
    if (installed) {
        bins = candidateBinaries(installed.path);
        if (bins.length) return bins[0];
    }
    const tool = await boardManager.ensureTool('esptool_py', { packager: 'esp32' });
    bins = candidateBinaries(tool && tool.path);
    if (bins.length) return bins[0];
    throw new Error('esptool not available. Install the esp32 platform from the Board Manager.');
}

function commandFor(bin) {
    if (bin.endsWith('.py')) return { cmd: process.platform === 'win32' ? 'python' : 'python3', prefix: [bin] };
    return { cmd: bin, prefix: [] };
}

async function getVersion(bin) {
    if (versionCache.has(bin)) return versionCache.get(bin);
    const { cmd, prefix } = commandFor(bin);
    const res = await run(cmd, [...prefix, 'version']);
    const m = res.output.match(/v?(\d+)\.(\d+)(?:\.(\d+))?/);
    const version = m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), text: m[0] } : { major: 4, minor: 0, text: 'unknown' };
    versionCache.set(bin, version);
    return version;
}

function style(version) {
    const modern = version.major >= 5;
    const c = (name) => modern ? name.replace(/_/g, '-') : name.replace(/-/g, '_');
    return { modern, c };
}

function chipOf(props, override) {
    if (override && override !== 'board') return override;
    const mcu = (props['build.mcu'] || '').toLowerCase();
    if (mcu.startsWith('esp')) return mcu;
    if ((props['build.arch'] || '').toLowerCase() === 'esp8266' || props['runtime.platform.path'] && /esp8266/i.test(props['runtime.platform.path'])) return 'esp8266';
    return 'auto';
}

function baudOf(props, options) {
    const override = options.uploadSpeed || settings.get('flash.uploadSpeedOverride');
    return String(override || props['upload.speed'] || 921600);
}

function resetArgs(props, s) {
    const method = props['upload.resetmethod'] || '';
    const before = (method.match(/--before[ =]([\w-]+)/) || [])[1] || 'default_reset';
    const after = (method.match(/--after[ =]([\w-]+)/) || [])[1] || 'hard_reset';
    return ['--before', s.c(before), '--after', s.c(after)];
}

function progressParser(ctx, totalImages = 1) {
    let index = 0;
    let lastPct = -1;
    return (text) => {
        ctx.log(text);
        if (/Wrote \d+ bytes|Hash of data verified/.test(text)) {
            const count = (text.match(/Wrote \d+ bytes/g) || []).length;
            index = Math.min(totalImages, index + Math.max(1, count));
        }
        const matches = text.match(/(\d{1,3}(?:\.\d+)?)\s?%/g);
        if (matches) {
            const pct = parseFloat(matches[matches.length - 1]);
            if (!Number.isNaN(pct)) {
                const overall = Math.min(100, ((Math.min(index, totalImages - 1) + pct / 100) / totalImages) * 100);
                if (Math.round(overall) !== lastPct) {
                    lastPct = Math.round(overall);
                    ctx.progress(overall);
                }
            }
        }
    };
}

async function exec(ctx, args, { totalImages = 1, timeoutMs } = {}) {
    const bin = await locate(ctx.resolved && ctx.resolved.props);
    const { cmd, prefix } = commandFor(bin);
    const res = await run(cmd, [...prefix, ...args], { onOutput: progressParser(ctx, totalImages), job: ctx.job, timeoutMs });
    if (ctx.job.cancelled) throw new Error('Cancelled');
    if (res.code !== 0) {
        const hint = diagnose(res.output || res.error || '');
        throw new Error(`esptool failed (code ${res.code})${hint ? ': ' + hint : ''}${res.error ? ' - ' + res.error : ''}`);
    }
    return res.output;
}

function diagnose(output) {
    if (/Failed to connect|No serial data received|Wrong boot mode/i.test(output)) return 'unable to enter bootloader. Hold BOOT while resetting, or lower the upload speed';
    if (/could not open port|PermissionError|Access is denied|being used by another/i.test(output)) return 'port busy or access denied';
    if (/does not match|This chip is/i.test(output)) return 'chip mismatch with selected board';
    if (/File .* is too big|exceeds/i.test(output)) return 'image larger than flash/partition';
    if (/MD5 of file does not match|verify failed/i.test(output)) return 'verification failed';
    return '';
}

async function baseArgs(ctx, options = {}) {
    const props = ctx.resolved ? ctx.resolved.props : {};
    const bin = await locate(props);
    const version = await getVersion(bin);
    const s = style(version);
    const chip = chipOf(props, options.chip);
    return {
        s,
        chip,
        args: ['--chip', chip, '--port', ctx.port, '--baud', baudOf(props, options), ...resetArgs(props, s)]
    };
}

function flashParams(props, s, options) {
    const out = [];
    const mode = options.flashMode || 'keep';
    const freq = options.flashFreq || 'keep';
    const size = options.flashSize || 'keep';
    out.push(s.modern ? '--flash-mode' : '--flash_mode', mode);
    out.push(s.modern ? '--flash-freq' : '--flash_freq', freq);
    out.push(s.modern ? '--flash-size' : '--flash_size', size);
    return out;
}

function bootApp0Path(props, build) {
    if (build && build.bootApp0) return build.bootApp0;
    const candidate = path.join(props['runtime.platform.path'] || '', 'tools', 'partitions', 'boot_app0.bin');
    return fs.existsSync(candidate) ? candidate : null;
}

function imagesFromInput(desc, props) {
    const isEsp8266 = /esp8266/i.test(props['runtime.platform.path'] || '') || (props['build.mcu'] || '') === 'esp8266';
    if (desc.mode === 'images') {
        return desc.images.filter(i => i.file).map(i => ({ offset: i.offset, file: i.file }));
    }
    if (desc.mode === 'merged') {
        const file = desc.file || desc.build.merged;
        if (!file) throw new Error('No merged image found');
        return [{ offset: '0x0', file }];
    }
    if (desc.mode === 'file') {
        const offset = desc.offset || (isEsp8266 ? '0x0' : '0x10000');
        return [{ offset, file: desc.file }];
    }
    const build = desc.build;
    if (isEsp8266) {
        if (!build.app) throw new Error('No application binary found');
        return [{ offset: '0x0', file: build.app }];
    }
    if (build.flashArgs) {
        const parsed = parseFlashArgs(build.flashArgs);
        const images = parsed.images.map(img => {
            let file = path.isAbsolute(img.file) ? img.file : path.join(build.folder, img.file);
            if (!fs.existsSync(file) && path.basename(file) === 'boot_app0.bin') file = bootApp0Path(props, build);
            return { offset: img.offset, file };
        }).filter(i => i.file && fs.existsSync(i.file));
        if (images.length) return images;
    }
    const images = [];
    if (build.bootloader) images.push({ offset: props['build.bootloader_addr'] || '0x1000', file: build.bootloader });
    if (build.partitions) images.push({ offset: '0x8000', file: build.partitions });
    const bootApp0 = bootApp0Path(props, build);
    if (build.partitions && bootApp0) images.push({ offset: '0xe000', file: bootApp0 });
    if (build.app) images.push({ offset: '0x10000', file: build.app });
    if (images.length === 0 && build.merged) images.push({ offset: '0x0', file: build.merged });
    if (images.length === 0) throw new Error('No ESP binaries found in build folder');
    return images;
}

async function writeImages(ctx, images, options = {}) {
    const props = ctx.resolved ? ctx.resolved.props : {};
    await prepareUploadPort(ctx);
    const { s, args } = await baseArgs(ctx, options);
    const writeArgs = [...args, s.c('write_flash')];
    if (options.eraseAll || /(^|\s)(-e|--erase-all)(\s|$)/.test(props['upload.erase_cmd'] || '')) writeArgs.push('-e');
    if (options.compress !== false) writeArgs.push('-z');
    writeArgs.push(...flashParams(props, s, options));
    if (options.verify || settings.get('flash.verify')) writeArgs.push('--verify');
    const extra = (props['upload.extra_flags'] || '').trim();
    for (const img of images) {
        if (!fs.existsSync(img.file)) throw new Error(`File not found: ${img.file}`);
        ctx.log(`Image ${img.offset} <- ${img.file} (${fs.statSync(img.file).size} bytes)\n`);
        writeArgs.push(String(img.offset), img.file);
    }
    if (extra && !/\{/.test(extra)) writeArgs.push(...extra.split(/\s+/).filter(Boolean));
    await exec(ctx, writeArgs, { totalImages: images.length });
    await settlePort(ctx);
}

async function upload(ctx, desc, options = {}) {
    const images = imagesFromInput(desc, ctx.resolved.props);
    await writeImages(ctx, images, options);
}

async function verify(ctx, desc, options = {}) {
    const images = imagesFromInput(desc, ctx.resolved.props);
    const { s, args } = await baseArgs(ctx, options);
    const verifyArgs = [...args, s.c('verify_flash')];
    for (const img of images) verifyArgs.push(String(img.offset), img.file);
    await exec(ctx, verifyArgs, { totalImages: images.length });
}

async function erase(ctx, options = {}) {
    await prepareUploadPort(ctx);
    const { s, args } = await baseArgs(ctx, options);
    ctx.progress(10);
    await exec(ctx, [...args, s.c('erase_flash')], { timeoutMs: 180000 });
    ctx.progress(100);
    await settlePort(ctx);
}

async function eraseRegion(ctx, offset, size, options = {}) {
    const { s, args } = await baseArgs(ctx, options);
    await exec(ctx, [...args, s.c('erase_region'), String(offset), String(size)]);
}

function parseInfo(output) {
    const info = {};
    const chip = output.match(/Chip (?:is|type:)\s*([^\r\n]+)/i);
    if (chip) info.chip = chip[1].trim();
    const features = output.match(/Features:\s*([^\r\n]+)/i);
    if (features) info.features = features[1].trim();
    const crystal = output.match(/Crystal (?:is|frequency:)\s*([^\r\n]+)/i);
    if (crystal) info.crystal = crystal[1].trim();
    const mac = output.match(/MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5,7})/i);
    if (mac) info.mac = mac[1].toLowerCase();
    const flash = output.match(/Detected flash size:\s*(\S+)/i);
    if (flash) info.flashSize = flash[1];
    const manufacturer = output.match(/Manufacturer:\s*(\S+)/i);
    if (manufacturer) info.flashManufacturer = manufacturer[1];
    const device = output.match(/Device:\s*(\S+)/i);
    if (device) info.flashDevice = device[1];
    const psram = output.match(/(?:Embedded PSRAM|PSRAM)[^\r\n]*?(\d+\s?MB)/i);
    if (psram) info.psram = psram[1];
    return info;
}

async function info(ctx, options = {}) {
    const { s, args } = await baseArgs(ctx, { ...options, chip: options.chip || 'auto' });
    const out = await exec(ctx, [...args, s.c('flash_id')]);
    ctx.progress(100);
    return parseInfo(out);
}

function flashSizeBytes(value) {
    if (!value) return 0;
    const m = String(value).match(/(\d+)\s*(MB|KB|M|K)/i);
    if (!m) return 0;
    return parseInt(m[1], 10) * (/^M/i.test(m[2]) ? 1024 * 1024 : 1024);
}

async function readFlash(ctx, offset, size, outFile, options = {}) {
    let length = size;
    if (!length || String(length).toUpperCase() === 'ALL') {
        const details = await info(ctx, options);
        length = flashSizeBytes(details.flashSize);
        if (!length) throw new Error('Unable to detect flash size');
        ctx.log(`Detected flash size ${details.flashSize}\n`);
    }
    const { s, args } = await baseArgs(ctx, options);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await exec(ctx, [...args, s.c('read_flash'), String(offset), String(length), outFile], { timeoutMs: 1800000 });
    return { file: outFile, size: parseNumber(String(length)) };
}

async function readPartitionTable(ctx, options = {}) {
    const tmp = path.join(os.tmpdir(), `diagterm_pt_${Date.now()}.bin`);
    await readFlash(ctx, `0x${partitions.TABLE_OFFSET.toString(16)}`, `0x${partitions.TABLE_SIZE.toString(16)}`, tmp, options);
    const buffer = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    const rows = partitions.parseBinary(buffer);
    if (rows.length === 0) throw new Error('No valid partition table found on device');
    return rows;
}

async function writePartitionTable(ctx, rows, options = {}) {
    const errors = partitions.validate(rows);
    if (errors.length) throw new Error(errors.join('; '));
    const tmp = path.join(os.tmpdir(), `diagterm_pt_${Date.now()}.bin`);
    fs.writeFileSync(tmp, partitions.toBinary(rows));
    try {
        await writeImages(ctx, [{ offset: `0x${partitions.TABLE_OFFSET.toString(16)}`, file: tmp }], options);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

module.exports = { upload, verify, erase, eraseRegion, info, readFlash, writeImages, readPartitionTable, writePartitionTable, locate, imagesFromInput, flashSizeBytes };
