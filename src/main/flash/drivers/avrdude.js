const fs = require('fs');
const path = require('path');
const boardManager = require('../board-manager');
const settings = require('../../settings');
const { run } = require('../process');
const { expand } = require('../properties');
const { prepareUploadPort, settlePort } = require('./common');

async function locate(props) {
    let cmd = expand(props['cmd.path'] || '', props);
    let conf = expand(props['config.path'] || '', props);
    if (!cmd || /\{/.test(cmd)) {
        const tool = boardManager.findInstalledTool('avrdude') || await boardManager.ensureTool('avrdude', { packager: 'arduino' });
        if (!tool) throw new Error('avrdude not available. Install the Arduino AVR platform.');
        cmd = path.join(tool.path, 'bin', 'avrdude');
        conf = path.join(tool.path, 'etc', 'avrdude.conf');
    }
    const exe = process.platform === 'win32' && !cmd.toLowerCase().endsWith('.exe') ? cmd + '.exe' : cmd;
    if (!fs.existsSync(exe)) throw new Error(`avrdude not found at ${exe}`);
    if (!conf || !fs.existsSync(conf)) {
        const alt = path.join(path.dirname(path.dirname(exe)), 'etc', 'avrdude.conf');
        conf = fs.existsSync(alt) ? alt : '';
    }
    return { exe, conf };
}

function formatFor(file) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.hex') || lower.endsWith('.eep')) return 'i';
    if (lower.endsWith('.elf')) return 'e';
    if (lower.endsWith('.bin')) return 'r';
    return 'a';
}

function pickFile(desc) {
    if (desc.file) return desc.file;
    const build = desc.build;
    if (build.hex) return build.hex;
    if (build.withBootloaderHex) return build.withBootloaderHex;
    if (build.elf) return build.elf;
    if (build.app) return build.app;
    throw new Error('No .hex file found');
}

function baseArgs(ctx, props, conf) {
    const protocol = props['upload.protocol'];
    const mcu = props['build.mcu'];
    if (!protocol || !mcu) throw new Error('Board has no serial upload protocol (programmer required)');
    const speed = settings.get('flash.uploadSpeedOverride') || props['upload.speed'] || '115200';
    const args = [];
    if (conf) args.push(`-C${conf}`);
    args.push(`-p${mcu}`, `-c${protocol}`, `-P${ctx.port}`, `-b${speed}`);
    return args;
}

function parser(ctx) {
    let phase = 0;
    return (text) => {
        ctx.log(text);
        if (/Writing/.test(text)) phase = 1;
        if (/Reading/.test(text) && phase >= 1) phase = 2;
        const m = text.match(/(\d{1,3})%/g);
        if (m) {
            const pct = parseInt(m[m.length - 1], 10);
            ctx.progress(phase === 2 ? 50 + pct / 2 : pct / (settings.get('flash.verify') ? 2 : 1));
        }
    };
}

async function upload(ctx, desc) {
    const props = ctx.resolved.props;
    const { exe, conf } = await locate(props);
    await prepareUploadPort(ctx);
    const file = pickFile(desc);
    const args = baseArgs(ctx, props, conf);
    if (!settings.get('flash.verify')) args.push('-V');
    args.push('-D', `-Uflash:w:${file}:${formatFor(file)}`);
    const res = await run(exe, args, { onOutput: parser(ctx), job: ctx.job });
    if (ctx.job.cancelled) throw new Error('Cancelled');
    if (res.code !== 0) throw new Error(`avrdude failed (code ${res.code})${/not in sync|stk500_recv/.test(res.output) ? ': bootloader not responding, check board selection and port' : ''}${res.error ? ' - ' + res.error : ''}`);
    ctx.progress(100);
    await settlePort(ctx);
}

async function info(ctx) {
    const props = ctx.resolved.props;
    const { exe, conf } = await locate(props);
    await prepareUploadPort(ctx);
    const res = await run(exe, [...baseArgs(ctx, props, conf), '-v'], { onOutput: (t) => ctx.log(t), job: ctx.job });
    const signature = (res.output.match(/Device signature = (0x[0-9a-f]+)/i) || [])[1];
    if (res.code !== 0 && !signature) throw new Error(`avrdude failed (code ${res.code})`);
    ctx.progress(100);
    return { chip: props['build.mcu'], signature: signature || null };
}

module.exports = { upload, info };
