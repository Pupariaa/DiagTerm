import { getSetting } from '../core/settings.js';
import { toast } from '../core/dialogs.js';

let audioCtx = null;

export function beep({ frequency = 880, duration = 120, type = 'sine' } = {}) {
    if (!getSetting('notifications.sound', true)) return;
    try {
        if (!audioCtx) audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const volume = Math.max(0, Math.min(1, Number(getSetting('notifications.soundVolume', 0.4))));
        osc.type = type;
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(volume * 0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration / 1000);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration / 1000 + 0.02);
    } catch (error) {
        console.warn('Beep failed:', error.message);
    }
}

export function notify(title, body, { type = 'info', system = true } = {}) {
    toast(body ? `${title}: ${body}` : title, { type });
    if (!system || !getSetting('notifications.enabled', true)) return;
    if (document.hasFocus()) return;
    try {
        if (window.Notification && Notification.permission === 'granted') {
            new Notification(title, { body: body || '' });
        } else if (window.Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    } catch (error) {
        console.warn('Notification failed:', error.message);
    }
}
