const manager = require('../../serial/manager');
const { touch1200, waitForUploadPort, waitForPortReturn, sleep } = require('../serial-utils');

async function prepareUploadPort(ctx) {
    if (ctx.portPrepared) return;
    ctx.portPrepared = true;
    const props = ctx.resolved ? ctx.resolved.props : {};
    const useTouch = String(props['upload.use_1200bps_touch'] || '').trim() === 'true';
    const waitPort = String(props['upload.wait_for_upload_port'] || '').trim() === 'true';
    if (!useTouch || !ctx.port) return;
    const before = (await manager.listPorts()).map(p => p.path);
    ctx.log(`Performing 1200-bps touch reset on ${ctx.port}\n`);
    const res = await touch1200(ctx.port);
    if (!res.success) ctx.log(`1200-bps touch failed: ${res.error}\n`);
    await sleep(400);
    if (waitPort) {
        ctx.log('Waiting for upload port...\n');
        const next = await waitForUploadPort(ctx.port, before.filter(p => p !== ctx.port), 10000, ctx.log);
        if (next) {
            if (next !== ctx.port) ctx.log(`Using upload port ${next}\n`);
            ctx.port = next;
        } else {
            ctx.log('Upload port not detected, using original port\n');
        }
    }
}

async function settlePort(ctx) {
    const props = ctx.resolved ? ctx.resolved.props : {};
    const waitPort = String(props['upload.wait_for_upload_port'] || '').trim() === 'true';
    if (!waitPort && !ctx.expectReenumeration) return;
    const back = await waitForPortReturn(ctx.originalPort || ctx.port, ctx.identity, 10000);
    if (back && back !== ctx.port) {
        ctx.log(`Device re-enumerated as ${back}\n`);
        ctx.port = back;
    }
}

module.exports = { prepareUploadPort, settlePort };
