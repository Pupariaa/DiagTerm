const fs = require('fs');

const OS_SUFFIX = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macosx' : 'linux');
const OS_SUFFIXES = ['windows', 'linux', 'macosx', 'freebsd'];

function parseProperties(text) {
    const props = {};
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        props[key] = value;
    }
    return props;
}

function loadProperties(file) {
    if (!fs.existsSync(file)) return {};
    return parseProperties(fs.readFileSync(file, 'utf8'));
}

function applyOsOverrides(props) {
    const out = {};
    const overrides = {};
    for (const [key, value] of Object.entries(props)) {
        const lastDot = key.lastIndexOf('.');
        const suffix = lastDot >= 0 ? key.slice(lastDot + 1) : '';
        if (OS_SUFFIXES.includes(suffix)) {
            if (suffix === OS_SUFFIX) overrides[key.slice(0, lastDot)] = value;
            continue;
        }
        out[key] = value;
    }
    return Object.assign(out, overrides);
}

function subTree(props, prefix) {
    const out = {};
    const p = prefix.endsWith('.') ? prefix : prefix + '.';
    for (const [key, value] of Object.entries(props)) {
        if (key.startsWith(p)) out[key.slice(p.length)] = value;
    }
    return out;
}

function expand(value, props, maxDepth = 12) {
    if (value === undefined || value === null) return '';
    let current = String(value);
    for (let i = 0; i < maxDepth; i++) {
        let changed = false;
        current = current.replace(/\{([^{}\s]+)\}/g, (match, key) => {
            if (Object.prototype.hasOwnProperty.call(props, key)) {
                changed = true;
                return props[key];
            }
            return match;
        });
        if (!changed) break;
    }
    return current;
}

function unresolved(value) {
    const out = [];
    String(value).replace(/\{([^{}\s]+)\}/g, (m, key) => {
        out.push(key);
        return m;
    });
    return out;
}

function stripUnresolved(value) {
    return String(value).replace(/\{[^{}\s]+\}/g, '');
}

function splitArgs(commandLine) {
    const args = [];
    let current = '';
    let quote = null;
    let hasToken = false;
    for (let i = 0; i < commandLine.length; i++) {
        const ch = commandLine[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasToken || current.length > 0) {
                args.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }
    if (hasToken || current.length > 0) args.push(current);
    return args;
}

function parseNumber(value) {
    if (value === undefined || value === null || value === '') return NaN;
    const str = String(value).trim();
    if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16);
    const m = str.match(/^(\d+(?:\.\d+)?)\s*([KkMm])?$/);
    if (m) {
        const base = parseFloat(m[1]);
        if (!m[2]) return Math.round(base);
        return Math.round(base * (m[2].toUpperCase() === 'K' ? 1024 : 1024 * 1024));
    }
    return parseInt(str, 10);
}

module.exports = { OS_SUFFIX, parseProperties, loadProperties, applyOsOverrides, subTree, expand, unresolved, stripUnresolved, splitArgs, parseNumber };
