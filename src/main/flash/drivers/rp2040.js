const fs = require('fs');
const os = require('os');
const path = require('path');
const boardManager = require('../board-manager');
const { run } = require('../process');
const uf2 = require('../uf2');
const { touch1200, findUf2Drives, waitForUf2Drive, waitForDriveGone, waitForPortReturn, sleep } = require('../serial-utils');

let deployLock = Promise.resolve();

function withLock(fn) {
    const next = deployLock.then(fn, fn);
    deployLock = next.catch(() => { });
    return next;
}

function familyOf(props) {
    const chip = (props['build.chip'] || props['build.mcu'] || 'rp2040').toLowerCase();
    if (chip.includes('rp2350')) return /riscv/.test(props['build.mcu'] || '') ? uf2.FAMILIES['rp2350-riscv'] : uf2.FAMILIES.rp2350;
    return uf2.FAMILIES.rp2040;
}

function loadImage(desc, props) {
    let file = desc.file;
    if (!file && desc.build) file = desc.build.uf2 || desc.build.app;
    if (!file) throw new Error('No .uf2 or .bin file found');
    const data = fs.readFileSync(file);
    if (uf2.isUf2(data)) return { buffer: data, file };
    if (file.toLowerCase().endsWith('.bin')) return { buffer: uf2.encode(data, 0x10000000, familyOf(props)), file };
    throw new Error('RP2040 upload requires a .uf2 or .bin file');
}

async function locatePicotool(props) {
    const dirs = [props['runtime.tools.pqt-picotool.path'], props['runtime.tools.picotool.path']].filter(Boolean);
    const installed = boardManager.findInstalledTool('pqt-picotool') || boardManager.findInstalledTool('picotool');
    if (installed) dirs.push(installed.path);
    for (const dir of dirs) {
        const exe = path.join(dir, process.platform === 'win32' ? 'picotool.exe' : 'picotool');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

async function copyWithProgress(ctx, buffer, target) {
    const fd = fs.openSync(target, 'w');
    try {
        const chunk = 64 * 1024;
        for (let offset = 0; offset < buffer.length; offset += chunk) {
            if (ctx.job.cancelled) throw new Error('Cancelled');
            fs.writeSync(fd, buffer, offset, Math.min(chunk, buffer.length - offset));
            ctx.progress(20 + ((offset + chunk) / buffer.length) * 70);
            await sleep(0);
        }
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

async function deploy(ctx, buffer, options = {}) {
    return withLock(async () => {
        const before = findUf2Drives().map(d => d.root);
        const originalPort = ctx.port;
        if (ctx.port && options.method !== 'bootsel') {
            ctx.log(`Rebooting ${ctx.port} into BOOTSEL (1200-bps touch)\n`);
            const res = await touch1200(ctx.port);
            if (!res.success) ctx.log(`1200-bps touch failed: ${res.error}\n`);
        }
        ctx.progress(5);
        ctx.log('Waiting for RP2 mass storage drive...\n');
        const drive = await waitForUf2Drive(before, 15000, options.method === 'bootsel' || before.length > 0);
        if (!drive) {
            const picotool = await locatePicotool(ctx.resolved.props);
            if (picotool) {
                ctx.log('No drive detected, trying picotool\n');
                const tmp = path.join(os.tmpdir(), `diagterm_${Date.now()}.uf2`);
                fs.writeFileSync(tmp, buffer);
                const res = await run(picotool, ['load', tmp, '-f', '-x'], { onOutput: (t) => ctx.log(t), job: ctx.job });
                fs.rmSync(tmp, { force: true });
                if (res.code !== 0) throw new Error(`picotool failed (code ${res.code})`);
            } else {
                throw new Error('No RP2 drive appeared. Hold BOOTSEL while plugging the board, then retry.');
            }
        } else {
            ctx.log(`Copying ${buffer.length} bytes to ${drive.root}${drive.boardId ? ' (' + drive.boardId + ')' : ''}\n`);
            await copyWithProgress(ctx, buffer, path.join(drive.root, 'NEW.UF2'));
            ctx.log('Waiting for the board to reboot...\n');
            await waitForDriveGone(drive.root, 15000);
        }
        ctx.progress(95);
        if (originalPort) {
            const back = await waitForPortReturn(originalPort, ctx.identity, 12000);
            if (back) {
                if (back !== ctx.port) ctx.log(`Device back on ${back}\n`);
                ctx.port = back;
            } else {
                ctx.log('Serial port did not come back (sketch may not use USB serial)\n');
            }
        }
        ctx.progress(100);
    });
}

async function upload(ctx, desc, options = {}) {
    const { buffer, file } = loadImage(desc, ctx.resolved.props);
    ctx.log(`Image ${file}\n`);
    await deploy(ctx, buffer, options);
}

async function info(ctx) {
    const drives = findUf2Drives();
    ctx.progress(100);
    return {
        chip: ctx.resolved.props['build.chip'] || 'rp2040',
        bootselDrives: drives.map(d => `${d.root} ${d.boardId}`).join(', ') || 'none'
    };
}

module.exports = { upload, deploy, info, familyOf };
