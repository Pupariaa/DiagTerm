import { getSetting } from './settings.js';

const commands = new Map();
const keyHandlers = [];

export function registerCommand(command) {
    commands.set(command.id, command);
}

export function listCommands() {
    return Array.from(commands.values());
}

export function getCommand(id) {
    return commands.get(id);
}

export function runCommand(id, ...args) {
    const command = commands.get(id);
    if (!command) return false;
    if (command.enabled && !command.enabled()) return false;
    command.run(...args);
    return true;
}

export function bindingFor(id) {
    const overrides = getSetting('shortcuts', {}) || {};
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] || '';
    const command = commands.get(id);
    return command ? command.key || '' : '';
}

export function keyFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    if (key === ' ') key = 'Space';
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return parts.join('+');
    if (key.length === 1) key = key.toUpperCase();
    if (key === 'Esc') key = 'Escape';
    parts.push(key);
    return parts.join('+');
}

export function addKeyHandler(handler) {
    keyHandlers.push(handler);
}

export function handleGlobalKey(e) {
    const combo = keyFromEvent(e);
    if (!combo) return false;
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    if (e.target && e.target.dataset && e.target.dataset.keycapture !== undefined) return false;
    if (/^(Ctrl\+|Alt\+|Shift\+)*F\d+$/.test(combo)) {
        for (const handler of keyHandlers) {
            if (handler(e, combo, typing)) {
                e.preventDefault();
                return true;
            }
        }
    }
    for (const command of commands.values()) {
        const binding = bindingFor(command.id);
        if (!binding || binding !== combo) continue;
        if (typing && !combo.includes('Ctrl') && !combo.includes('Alt') && !/^F\d+$/.test(combo)) continue;
        if (command.enabled && !command.enabled()) continue;
        e.preventDefault();
        command.run();
        return true;
    }
    for (const handler of keyHandlers) {
        if (handler(e, combo, typing)) {
            e.preventDefault();
            return true;
        }
    }
    return false;
}
