import { escapeHtml, el } from './dom.js';
import { t } from './i18n.js';

const stack = [];

function overlayRoot() {
    return document.getElementById('overlay-root');
}

export function openModal({ title, body, width = 600, buttons = [], onClose, className = '', dismissable = true } = {}) {
    const root = el(`
        <div class="modal ${className}">
            <div class="modal-content" style="width:${typeof width === 'number' ? width + 'px' : width}">
                <div class="modal-header">
                    <h2>${escapeHtml(title || '')}</h2>
                    <button class="icon-btn modal-close" data-close title="${escapeHtml(t('Close'))}">&times;</button>
                </div>
                <div class="modal-body"></div>
                <div class="modal-footer"></div>
            </div>
        </div>`);
    const bodyEl = root.querySelector('.modal-body');
    const footer = root.querySelector('.modal-footer');
    const modal = {
        root,
        body: bodyEl,
        closed: false,
        close(result) {
            if (modal.closed) return;
            modal.closed = true;
            playExit(root, () => {
                root.remove();
                const idx = stack.indexOf(modal);
                if (idx >= 0) stack.splice(idx, 1);
                if (onClose) onClose(result);
            });
        },
        setBody(content) {
            bodyEl.innerHTML = '';
            if (typeof content === 'string') bodyEl.innerHTML = content;
            else if (content) bodyEl.appendChild(content);
        },
        setButtons(list) {
            footer.innerHTML = '';
            footer.style.display = list.length ? '' : 'none';
            for (const btn of list) {
                const b = document.createElement('button');
                b.className = `btn ${btn.primary ? 'btn-primary' : ''} ${btn.danger ? 'btn-danger' : ''} ${btn.left ? 'left' : ''}`;
                b.textContent = btn.label;
                if (btn.id) b.id = btn.id;
                b.addEventListener('click', async () => {
                    if (btn.action) {
                        const keep = await btn.action(modal);
                        if (keep === false) return;
                    }
                    if (!btn.keepOpen) modal.close(btn.value);
                });
                footer.appendChild(b);
            }
        }
    };
    modal.setBody(body);
    modal.setButtons(buttons);
    root.querySelector('[data-close]').addEventListener('click', () => modal.close());
    if (dismissable) {
        root.addEventListener('mousedown', (e) => {
            if (e.target === root) modal.close();
        });
    }
    overlayRoot().appendChild(root);
    stack.push(modal);
    return modal;
}

export function topModal() {
    return stack[stack.length - 1] || null;
}

export function closeTopModal() {
    const modal = topModal();
    if (modal) {
        modal.close();
        return true;
    }
    return false;
}

export function confirmDialog(message, { title, okLabel, danger = false } = {}) {
    return new Promise((resolve) => {
        openModal({
            title: title || t('Confirm'),
            width: 440,
            body: `<p class="dialog-message">${escapeHtml(message)}</p>`,
            onClose: (value) => resolve(value === true),
            buttons: [
                { label: t('Cancel'), value: false },
                { label: okLabel || t('OK'), primary: !danger, danger, value: true }
            ]
        });
    });
}

export function alertDialog(message, title) {
    return new Promise((resolve) => {
        openModal({
            title: title || t('Information'),
            width: 460,
            body: `<p class="dialog-message">${escapeHtml(message)}</p>`,
            onClose: () => resolve(),
            buttons: [{ label: t('OK'), primary: true }]
        });
    });
}

export function promptDialog({ title, label, value = '', placeholder = '', multiline = false, okLabel } = {}) {
    return new Promise((resolve) => {
        const inputHtml = multiline
            ? `<textarea class="input" rows="6" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
            : `<input class="input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
        let result = null;
        const modal = openModal({
            title: title || t('Input'),
            width: 480,
            body: `<label class="field-label">${escapeHtml(label || '')}</label>${inputHtml}`,
            onClose: () => resolve(result),
            buttons: [
                { label: t('Cancel') },
                {
                    label: okLabel || t('OK'), primary: true, action: () => {
                        result = modal.body.querySelector('.input').value;
                    }
                }
            ]
        });
        const input = modal.body.querySelector('.input');
        input.focus();
        input.select();
        if (!multiline) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    result = input.value;
                    modal.close();
                }
            });
        }
    });
}

export function toast(message, { type = 'info', timeout = 3500 } = {}) {
    const container = document.getElementById('toast-root');
    if (!container) return;
    const node = el(`<div class="toast toast-${type}">${escapeHtml(message)}</div>`);
    container.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    const remove = () => {
        node.classList.remove('show');
        setTimeout(() => node.remove(), 250);
    };
    node.addEventListener('click', remove);
    if (timeout > 0) setTimeout(remove, timeout);
}

let activePopover = null;

export function playExit(node, done) {
    if (!node || node.dataset.leaving) {
        if (done) done();
        return;
    }
    node.dataset.leaving = '1';
    node.classList.add('is-leaving');
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        if (done) done();
    };
    node.addEventListener('animationend', (e) => {
        if (e.target === node) finish();
    });
    setTimeout(finish, 280);
}

export function closePopover() {
    if (activePopover) {
        const p = activePopover;
        activePopover = null;
        document.removeEventListener('mousedown', p.outside, true);
        playExit(p.node, () => {
            p.node.remove();
            if (p.onClose) p.onClose();
        });
    }
}

export function popover(anchor, content, { onClose, align = 'left', className = '' } = {}) {
    closePopover();
    const node = el(`<div class="popover ${className}"></div>`);
    if (typeof content === 'string') node.innerHTML = content;
    else node.appendChild(content);
    overlayRoot().appendChild(node);
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(4, Math.min(window.innerWidth - width - 4, left));
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 4) top = Math.max(4, rect.top - height - 4);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    const outside = (e) => {
        if (!node.contains(e.target) && !anchor.contains(e.target)) closePopover();
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    activePopover = { node, outside, onClose };
    return { node, close: closePopover };
}

export function contextMenu(x, y, items) {
    closePopover();
    const node = el('<div class="popover context-menu"></div>');
    for (const item of items) {
        if (item.separator) {
            node.appendChild(el('<div class="menu-sep"></div>'));
            continue;
        }
        const row = el(`<div class="menu-item ${item.disabled ? 'disabled' : ''}"><span>${escapeHtml(item.label)}</span>${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ''}</div>`);
        if (!item.disabled) {
            row.addEventListener('click', () => {
                closePopover();
                item.action();
            });
        }
        node.appendChild(row);
    }
    overlayRoot().appendChild(node);
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    node.style.left = `${Math.min(x, window.innerWidth - w - 4)}px`;
    node.style.top = `${Math.min(y, window.innerHeight - h - 4)}px`;
    const outside = (e) => {
        if (!node.contains(e.target)) closePopover();
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    activePopover = { node, outside };
}
