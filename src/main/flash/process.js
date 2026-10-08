const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => { });
    } else {
        try {
            child.kill('SIGTERM');
        } catch (error) {
            console.error('Unable to kill process:', error.message);
        }
    }
}

function resolveExecutable(cmd) {
    if (process.platform !== 'win32') return cmd;
    if (path.extname(cmd)) return cmd;
    for (const ext of ['.exe', '.cmd', '.bat']) {
        if (fs.existsSync(cmd + ext)) return cmd + ext;
    }
    return cmd;
}

function run(cmd, args, { cwd, env, onOutput, job, timeoutMs } = {}) {
    return new Promise((resolve) => {
        const exe = resolveExecutable(cmd);
        if (onOutput) onOutput(`> ${quote(exe)} ${args.map(quote).join(' ')}\n`);
        let child;
        try {
            child = spawn(exe, args, {
                cwd: cwd || (path.isAbsolute(exe) ? path.dirname(exe) : undefined),
                env: { ...process.env, PYTHONUNBUFFERED: '1', ...(env || {}) },
                windowsHide: true,
                shell: false
            });
        } catch (error) {
            resolve({ code: -1, output: '', error: error.message });
            return;
        }
        let output = '';
        let timer = null;
        const onData = (data) => {
            const text = data.toString();
            output += text;
            if (output.length > 2000000) output = output.slice(-1000000);
            if (onOutput) onOutput(text);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        if (job) job.kill = () => killTree(child);
        if (timeoutMs) {
            timer = setTimeout(() => {
                if (onOutput) onOutput(`\nProcess timeout after ${timeoutMs} ms\n`);
                killTree(child);
            }, timeoutMs);
        }
        child.on('error', (error) => {
            if (timer) clearTimeout(timer);
            if (job) job.kill = null;
            const message = error.code === 'ENOENT' ? `Executable not found: ${exe}` : error.message;
            resolve({ code: -1, output, error: message });
        });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (job) job.kill = null;
            resolve({ code: code === null ? -1 : code, output });
        });
    });
}

function quote(arg) {
    const str = String(arg);
    return /[\s"]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

module.exports = { run, killTree, resolveExecutable };
