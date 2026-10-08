const fs = require('fs');
const path = require('path');
const boardManager = require('./board-manager');
const { loadProperties, applyOsOverrides, subTree, OS_SUFFIX } = require('./properties');

const cache = new Map();

function platformKey(platform) {
    return `${platform.packager}:${platform.arch}`;
}

function mtime(file) {
    try {
        return fs.statSync(file).mtimeMs;
    } catch (error) {
        return 0;
    }
}

function loadPlatform(platform) {
    const boardsFile = path.join(platform.path, 'boards.txt');
    const stamp = `${platform.path}:${mtime(boardsFile)}:${mtime(path.join(platform.path, 'platform.txt'))}`;
    const cached = cache.get(platform.path);
    if (cached && cached.stamp === stamp) return cached;
    const boardsProps = loadProperties(boardsFile);
    const localBoards = loadProperties(path.join(platform.path, 'boards.local.txt'));
    Object.assign(boardsProps, localBoards);
    const platformProps = loadProperties(path.join(platform.path, 'platform.txt'));
    Object.assign(platformProps, loadProperties(path.join(platform.path, 'platform.local.txt')));
    const programmersProps = loadProperties(path.join(platform.path, 'programmers.txt'));
    const menuLabels = subTree(boardsProps, 'menu');
    const boardIds = [];
    for (const key of Object.keys(boardsProps)) {
        const m = key.match(/^([^.]+)\.name$/);
        if (m && m[1] !== 'menu') boardIds.push(m[1]);
    }
    const boards = [];
    for (const id of boardIds) {
        const hidden = boardsProps[`${id}.hide`] !== undefined;
        const menus = [];
        const menuOrder = [];
        const prefix = `${id}.menu.`;
        for (const key of Object.keys(boardsProps)) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length).split('.');
            if (rest.length !== 2) continue;
            const [menuId, optionId] = rest;
            let menu = menus.find(m => m.id === menuId);
            if (!menu) {
                menu = { id: menuId, label: menuLabels[menuId] || menuId, options: [] };
                menus.push(menu);
                menuOrder.push(menuId);
            }
            menu.options.push({ id: optionId, label: boardsProps[key] });
        }
        const declared = Object.keys(menuLabels);
        menus.sort((a, b) => declared.indexOf(a.id) - declared.indexOf(b.id));
        const ids = [];
        for (let i = 0; i < 16; i++) {
            const vid = boardsProps[`${id}.vid.${i}`] || boardsProps[`${id}.upload_port.${i}.vid`];
            const pid = boardsProps[`${id}.pid.${i}`] || boardsProps[`${id}.upload_port.${i}.pid`];
            if (vid && pid) ids.push({ vid: vid.toLowerCase().replace(/^0x/, '').padStart(4, '0'), pid: pid.toLowerCase().replace(/^0x/, '').padStart(4, '0') });
        }
        boards.push({
            id,
            fqbn: `${platform.packager}:${platform.arch}:${id}`,
            name: boardsProps[`${id}.name`],
            hidden,
            menus,
            ids,
            uploadTool: boardsProps[`${id}.upload.tool.serial`] || boardsProps[`${id}.upload.tool.default`] || boardsProps[`${id}.upload.tool`] || '',
            mcu: boardsProps[`${id}.build.mcu`] || ''
        });
    }
    const programmers = [];
    for (const key of Object.keys(programmersProps)) {
        const m = key.match(/^([^.]+)\.name$/);
        if (m) programmers.push({ id: m[1], name: programmersProps[key] });
    }
    const data = { stamp, platform, boardsProps, platformProps, programmersProps, programmers, boards };
    cache.set(platform.path, data);
    return data;
}

function platformLabel(platform, data) {
    return `${data.platformProps.name || platformKey(platform)} ${data.platformProps.version || platform.version}`;
}

function listBoards({ includeHidden = false } = {}) {
    const out = [];
    for (const platform of boardManager.activePlatforms()) {
        let data;
        try {
            data = loadPlatform(platform);
        } catch (error) {
            console.error(`Failed to parse platform ${platformKey(platform)}:`, error.message);
            continue;
        }
        const label = platformLabel(platform, data);
        for (const board of data.boards) {
            if (board.hidden && !includeHidden) continue;
            out.push({
                fqbn: board.fqbn,
                name: board.name,
                platform: label,
                packager: platform.packager,
                arch: platform.arch,
                version: platform.version,
                source: platform.source,
                menus: board.menus,
                ids: board.ids,
                uploadTool: board.uploadTool,
                mcu: board.mcu
            });
        }
    }
    return out;
}

function listProgrammers(fqbn) {
    const [packager, arch] = fqbn.split(':');
    const platform = boardManager.findInstalledPlatform(packager, arch);
    if (!platform) return [];
    const own = loadPlatform(platform).programmers;
    if (own.length) return own.map(p => ({ ...p, ref: p.id }));
    const core = boardManager.findInstalledPlatform('arduino', arch);
    if (core && core.path !== platform.path) return loadPlatform(core).programmers.map(p => ({ ...p, ref: `arduino:${p.id}` }));
    return [];
}

function detectBoardsForPort(portInfo) {
    if (!portInfo || !portInfo.vendorId || !portInfo.productId) return [];
    const vid = portInfo.vendorId.toLowerCase();
    const pid = portInfo.productId.toLowerCase();
    return listBoards({ includeHidden: true }).filter(b => b.ids.some(i => i.vid === vid && i.pid === pid)).map(b => ({ fqbn: b.fqbn, name: b.name }));
}

function setRuntimeTools(props, platform) {
    const tools = boardManager.toolsForPlatform(platform);
    for (const [name, tool] of tools.byName.entries()) {
        props[`runtime.tools.${name}.path`] = tool.path;
    }
    for (const { name, tool } of tools.versioned) {
        if (!props[`runtime.tools.${name}.path`]) props[`runtime.tools.${name}.path`] = tool.path;
    }
    return tools;
}

function resolveToolProps(toolRef, platform, data) {
    let toolName = toolRef;
    let source = data;
    if (toolRef.includes(':')) {
        const [vendor, name] = toolRef.split(':');
        toolName = name;
        const ref = boardManager.findInstalledPlatform(vendor, platform.arch);
        if (ref) source = loadPlatform(ref);
    }
    return { toolName, toolProps: subTree(source.platformProps, `tools.${toolName}`), refPlatform: source.platform };
}

function resolve(fqbn, menuSelections = {}, options = {}) {
    const parts = fqbn.split(':');
    if (parts.length < 3) throw new Error(`Invalid FQBN: ${fqbn}`);
    const [packager, arch, boardId] = parts;
    const platform = boardManager.findInstalledPlatform(packager, arch);
    if (!platform) throw new Error(`Platform ${packager}:${arch} is not installed`);
    const data = loadPlatform(platform);
    const board = data.boards.find(b => b.id === boardId);
    if (!board) throw new Error(`Board ${boardId} not found in ${packager}:${arch}`);

    let props = { ...data.platformProps };
    props['runtime.platform.path'] = platform.path;
    props['runtime.hardware.path'] = path.dirname(platform.path);
    props['runtime.os'] = OS_SUFFIX;
    props['runtime.ide.version'] = '10819';
    props['ide_version'] = '10819';
    props['software'] = 'ARDUINO';
    props['build.arch'] = arch.toUpperCase();
    props['build.fqbn'] = fqbn;
    setRuntimeTools(props, platform);

    const boardProps = subTree(data.boardsProps, boardId);
    const selected = {};
    for (const [key, value] of Object.entries(boardProps)) {
        if (!key.startsWith('menu.')) props[key] = value;
    }
    for (const menu of board.menus) {
        const optionId = menuSelections[menu.id] && menu.options.some(o => o.id === menuSelections[menu.id]) ? menuSelections[menu.id] : menu.options[0] && menu.options[0].id;
        if (!optionId) continue;
        selected[menu.id] = optionId;
        const optionProps = subTree(boardProps, `menu.${menu.id}.${optionId}`);
        Object.assign(props, optionProps);
    }
    props = applyOsOverrides(props);

    if (props['build.variant']) {
        const variantPath = path.join(platform.path, 'variants', props['build.variant']);
        props['build.variant.path'] = variantPath;
    }

    const toolRef = options.tool || props['upload.tool.serial'] || props['upload.tool.default'] || props['upload.tool'] || '';
    let toolName = toolRef;
    if (toolRef) {
        const resolved = resolveToolProps(toolRef, platform, data);
        toolName = resolved.toolName;
        const toolProps = applyOsOverrides(resolved.toolProps);
        Object.assign(props, toolProps);
    }

    if (options.programmer) {
        const [progVendor, progId] = options.programmer.includes(':') ? options.programmer.split(':') : [null, options.programmer];
        let progSource = data;
        if (progVendor) {
            const ref = boardManager.findInstalledPlatform(progVendor, arch);
            if (ref) progSource = loadPlatform(ref);
        }
        const progProps = applyOsOverrides(subTree(progSource.programmersProps, progId));
        Object.assign(props, progProps);
        const progTool = progProps['program.tool'] || progProps['program.tool.default'];
        if (progTool) {
            const resolved = resolveToolProps(progTool, platform, data);
            Object.assign(props, applyOsOverrides(resolved.toolProps));
            toolName = resolved.toolName;
        }
    }

    const verbose = !!options.verbose;
    props['upload.verbose'] = verbose ? (props['upload.params.verbose'] || '') : (props['upload.params.quiet'] || '');
    props['upload.verify'] = options.verify === false ? (props['upload.params.noverify'] || '') : (props['upload.params.verify'] || '');
    props['program.verbose'] = verbose ? (props['program.params.verbose'] || '') : (props['program.params.quiet'] || '');
    props['program.verify'] = props['program.params.verify'] || '';
    props['erase.verbose'] = verbose ? (props['erase.params.verbose'] || '') : (props['erase.params.quiet'] || '');
    props['bootloader.verbose'] = verbose ? (props['bootloader.params.verbose'] || '') : (props['bootloader.params.quiet'] || '');

    return {
        fqbn,
        board: { id: board.id, name: board.name, menus: board.menus },
        platform,
        selected,
        tool: toolName,
        props
    };
}

module.exports = { listBoards, listProgrammers, resolve, detectBoardsForPort, loadPlatform };
