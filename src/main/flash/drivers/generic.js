const path = require('path');
const fs = require('fs');
const boardManager = require('../board-manager');
const { run } = require('../process');
const { expand, unresolved, stripUnresolved, splitArgs } = require('../properties');
const { prepareUploadPort, settlePort } = require('./common');

function percentParser(ctx) {
    let last = -1;
    return (text) => {
        ctx.log(text);
        const matches = text.match(/(\d{1,3})(?:\.\d+)?\s?%/g);
        if (matches) {
            const pct = parseInt(matches[matches.length - 1], 10);
            if (!Number.isNaN(pct) && pct !== last && pct <= 100) {
                last = pct;
                ctx.progress(pct);
            }
        }
    };
}

async function ensureMissingTools(ctx, props, text) {
    const missing = unresolved(text).filter(k => /^runtime\.tools\..+\.path$/.test(k));
    for (const key of missing) {
        const m = key.match(/^runtime\.tools\.(.+?)\.path$/);
        if (!m) continue;
        let name = m[1];
        let version;
        const versioned = name.match(/^(.+?)-(\d[\w.\-+]*)$/);
        if (versioned) {
            name = versioned[1];
            version = versioned[2];
        }
        ctx.log(`Installing missing tool ${name}${version ? ' ' + version : ''}\n`);
        try {
            const tool = await boardManager.ensureTool(name, { packager: ctx.resolved.platform.packager, version });
            if (tool) props[key] = tool.path;
        } catch (error) {
            ctx.log(`Unable to install ${name}: ${error.message}\n`);
        }
    }
}

function applyBuild(props, desc) {
    if (!desc) return;
    const build = desc.build;
    if (build) {
        props['build.path'] = build.folder;
        props['build.project_name'] = build.projectName;
    }
    if (desc.file) {
        props['build.path'] = path.dirname(desc.file);
        props['build.project_name'] = build ? build.projectName : path.basename(desc.file).replace(/\.[^.]+$/, '');
    }
}

async function runPattern(ctx, action, desc) {
    const props = { ...ctx.resolved.props };
    applyBuild(props, desc);
    props['serial.port'] = ctx.port || '';
    props['serial.port.file'] = ctx.port ? path.basename(ctx.port) : '';
    props['upload.port.address'] = ctx.port || '';
    props['upload.port.protocol'] = 'serial';
    props['upload.port.label'] = ctx.port || '';
    const key = `${action}.pattern`;
    const pattern = props[key];
    if (!pattern) throw new Error(`No ${action} recipe defined for tool ${ctx.resolved.tool || '(none)'}`);
    let expanded = expand(pattern, props);
    if (unresolved(expanded).some(k => k.startsWith('runtime.tools.'))) {
        await ensureMissingTools(ctx, props, expanded);
        expanded = expand(pattern, props);
    }
    const leftovers = unresolved(expanded);
    if (leftovers.length) ctx.log(`Warning: unresolved properties ${leftovers.join(', ')}\n`);
    const args = splitArgs(stripUnresolved(expanded));
    if (args.length === 0) throw new Error(`Empty ${action} command`);
    const cmd = args.shift();
    if (desc && desc.build && props['build.project_name']) {
        const referenced = args.filter(a => a.includes(props['build.path']) && /\.(bin|hex|uf2|elf)$/i.test(a));
        for (const file of referenced) {
            if (!fs.existsSync(file)) ctx.log(`Warning: referenced file not found ${file}\n`);
        }
    }
    const res = await run(cmd, args, { onOutput: percentParser(ctx), job: ctx.job, cwd: props['build.path'] && fs.existsSync(props['build.path']) ? props['build.path'] : undefined });
    if (ctx.job.cancelled) throw new Error('Cancelled');
    if (res.code !== 0) throw new Error(`${path.basename(cmd)} failed (code ${res.code})${res.error ? ': ' + res.error : ''}`);
    ctx.progress(100);
}

async function upload(ctx, desc) {
    await prepareUploadPort(ctx);
    await runPattern(ctx, 'upload', desc);
    await settlePort(ctx);
}

async function program(ctx, desc) {
    await runPattern(ctx, 'program', desc);
}

async function erase(ctx) {
    await runPattern(ctx, 'erase', null);
}

async function burnBootloader(ctx) {
    if (ctx.resolved.props['erase.pattern']) await runPattern(ctx, 'erase', null);
    await runPattern(ctx, 'bootloader', null);
}

module.exports = { upload, program, erase, burnBootloader, runPattern };
