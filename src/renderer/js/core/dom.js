export function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

export function qs(root, selector) {
    return root.querySelector(selector);
}

export function qsa(root, selector) {
    return Array.from(root.querySelectorAll(selector));
}

export function delegate(root, eventName, selector, handler) {
    const listener = (event) => {
        const target = event.target.closest(selector);
        if (target && root.contains(target)) handler(event, target);
    };
    root.addEventListener(eventName, listener);
    return () => root.removeEventListener(eventName, listener);
}

export function option(value, label, selected) {
    return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export function options(list, selectedValue) {
    return list.map(item => {
        const value = Array.isArray(item) ? item[0] : (typeof item === 'object' ? item.value : item);
        const label = Array.isArray(item) ? item[1] : (typeof item === 'object' ? item.label : item);
        return option(value, label, String(value) === String(selectedValue));
    }).join('');
}

export function rafThrottle(fn) {
    let scheduled = false;
    let lastArgs = null;
    return (...args) => {
        lastArgs = args;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            fn(...lastArgs);
        });
    };
}

export function debounce(fn, ms) {
    let timer = null;
    const wrapped = (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, ms);
    };
    wrapped.cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    return wrapped;
}

export function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
