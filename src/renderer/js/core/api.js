const bridge = window.electronAPI;

export function invoke(channel, ...args) {
    if (!bridge) return Promise.reject(new Error('electronAPI not available'));
    return bridge.invoke(channel, ...args);
}

export function on(channel, callback) {
    if (!bridge) return () => { };
    return bridge.on(channel, callback);
}

export const platform = bridge ? bridge.platform : 'unknown';

export function setZoomFactor(factor) {
    if (bridge && bridge.setZoomFactor) bridge.setZoomFactor(factor);
}
