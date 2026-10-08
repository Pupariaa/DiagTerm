const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');

const FORMAT_FILTERS = {
    csv: { name: 'CSV Files', extensions: ['csv'] },
    txt: { name: 'Text Files', extensions: ['txt', 'log'] },
    html: { name: 'HTML Files', extensions: ['html'] },
    xml: { name: 'XML Files', extensions: ['xml'] },
    json: { name: 'JSON Files', extensions: ['json'] },
    md: { name: 'Markdown Files', extensions: ['md'] },
    tex: { name: 'LaTeX Files', extensions: ['tex'] },
    png: { name: 'PNG Images', extensions: ['png'] },
    bin: { name: 'Binary Files', extensions: ['bin'] },
    dtcap: { name: 'DiagTerm Capture', extensions: ['dtcap'] }
};

function filtersFor(format) {
    const filters = [];
    if (FORMAT_FILTERS[format]) filters.push(FORMAT_FILTERS[format]);
    filters.push({ name: 'All Files', extensions: ['*'] });
    return filters;
}

function walk(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push({ path: path.relative(base, full).replace(/\\/g, '/'), dir: true, size: 0 });
            walk(full, base, out);
        } else {
            out.push({ path: path.relative(base, full).replace(/\\/g, '/'), dir: false, size: fs.statSync(full).size });
        }
    }
    return out;
}

function register() {
    ipcMain.handle('files:save-text', async (event, content, format, defaultFileName) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultFileName, filters: filtersFor(format) });
        if (result.canceled || !result.filePath) return { success: false };
        try {
            fs.writeFileSync(result.filePath, content, 'utf8');
            return { success: true, filePath: result.filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:save-binary', async (event, data, format, defaultFileName) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultFileName, filters: filtersFor(format) });
        if (result.canceled || !result.filePath) return { success: false };
        try {
            fs.writeFileSync(result.filePath, Buffer.from(data));
            return { success: true, filePath: result.filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:select-file', async (event, filters, options = {}) => {
        const result = await dialog.showOpenDialog({
            properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
            filters: filters && filters.length ? filters : [{ name: 'All Files', extensions: ['*'] }]
        });
        if (result.canceled || !result.filePaths.length) return null;
        return options.multiple ? result.filePaths : result.filePaths[0];
    });

    ipcMain.handle('files:select-folder', async (event, defaultPath) => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: defaultPath || undefined });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('files:read-text', async (event, filePath) => {
        try {
            return { success: true, content: fs.readFileSync(filePath, 'utf8') };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:stat', async (event, filePath) => {
        try {
            const st = fs.statSync(filePath);
            return { exists: true, size: st.size, isDirectory: st.isDirectory(), mtime: st.mtimeMs };
        } catch (error) {
            return { exists: false };
        }
    });

    ipcMain.handle('files:list-dir', async (event, dirPath) => {
        try {
            return { success: true, entries: walk(dirPath) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:read-dir', async (event, dirPath) => {
        try {
            return {
                success: true,
                entries: fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() }))
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:open-path', async (event, target) => {
        const err = await shell.openPath(target);
        return { success: !err, error: err || null };
    });

    ipcMain.handle('files:show-item', async (event, target) => {
        shell.showItemInFolder(target);
        return { success: true };
    });

    ipcMain.handle('files:copy-folder', async (event, source, defaultName) => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || !result.filePaths.length) return { success: false };
        const target = path.join(result.filePaths[0], defaultName || path.basename(source));
        try {
            fs.cpSync(source, target, { recursive: true });
            return { success: true, path: target };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('files:open-external', async (event, url) => {
        if (!/^https?:\/\//i.test(url)) return { success: false };
        await shell.openExternal(url);
        return { success: true };
    });

    ipcMain.handle('get-app-version', () => ({ version: app.getVersion() }));
}

module.exports = { register, walk };
