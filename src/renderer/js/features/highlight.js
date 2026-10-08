import { loadStore, getStore, saveStore } from '../core/store.js';
import { onEvent, emit } from '../core/bus.js';

let compiled = [];

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRule(rule) {
    if (!rule || !rule.pattern) return null;
    try {
        const source = rule.regex ? rule.pattern : escapeRegex(rule.pattern);
        return new RegExp(source, rule.caseSensitive ? 'g' : 'gi');
    } catch (error) {
        return null;
    }
}

function recompile() {
    const rules = getStore('highlights', []) || [];
    compiled = rules.filter(r => r.enabled !== false).map(rule => ({ rule, re: compileRule(rule) })).filter(c => c.re);
    emit('highlights:changed');
}

export async function initHighlights() {
    await loadStore('highlights', []);
    recompile();
    onEvent('store:highlights', recompile);
}

export function getHighlightRules() {
    return getStore('highlights', []) || [];
}

export function saveHighlightRules(rules) {
    saveStore('highlights', rules);
}

export function hasHighlights() {
    return compiled.length > 0;
}

export function highlightRanges(text) {
    if (compiled.length === 0 || !text) return { ranges: [], line: null };
    const ranges = [];
    let line = null;
    for (const { rule, re } of compiled) {
        re.lastIndex = 0;
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 200) {
            if (m[0].length === 0) {
                re.lastIndex++;
                continue;
            }
            if (rule.scope === 'line') {
                if (!line) line = rule;
                break;
            }
            ranges.push({ start: m.index, end: m.index + m[0].length, rule });
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    let lastEnd = -1;
    for (const r of ranges) {
        if (r.start < lastEnd) continue;
        merged.push(r);
        lastEnd = r.end;
    }
    return { ranges: merged, line };
}
