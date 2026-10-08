const listeners = new Map();

export function onEvent(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
}

export function emit(name, ...args) {
    const set = listeners.get(name);
    if (!set) return;
    for (const callback of Array.from(set)) {
        try {
            callback(...args);
        } catch (error) {
            console.error(`Event handler error for ${name}:`, error);
        }
    }
}
