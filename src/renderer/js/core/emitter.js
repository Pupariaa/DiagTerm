export class Emitter {
    constructor() {
        this._listeners = new Map();
    }

    on(name, callback) {
        if (!this._listeners.has(name)) this._listeners.set(name, new Set());
        this._listeners.get(name).add(callback);
        return () => this.off(name, callback);
    }

    off(name, callback) {
        const set = this._listeners.get(name);
        if (set) set.delete(callback);
    }

    emit(name, ...args) {
        const set = this._listeners.get(name);
        if (!set) return;
        for (const callback of Array.from(set)) {
            try {
                callback(...args);
            } catch (error) {
                console.error(`Listener error for ${name}:`, error);
            }
        }
    }

    removeAllListeners() {
        this._listeners.clear();
    }
}
