const path = require('path');

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQ = 0x43;
const PAD = 0x1A;

function crc16xmodem(buffer) {
    let crc = 0;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i] << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

function checksum8(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum = (sum + buffer[i]) & 0xFF;
    return sum;
}

class ByteQueue {
    constructor() {
        this.bytes = [];
        this.waiters = [];
    }

    push(buffer) {
        for (const b of buffer) this.bytes.push(b);
        this.flush();
    }

    flush() {
        while (this.waiters.length > 0 && this.bytes.length > 0) {
            const waiter = this.waiters.shift();
            clearTimeout(waiter.timer);
            waiter.resolve(this.bytes.shift());
        }
    }

    clear() {
        this.bytes = [];
    }

    read(timeoutMs) {
        if (this.bytes.length > 0) return Promise.resolve(this.bytes.shift());
        return new Promise((resolve) => {
            const waiter = { resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const idx = this.waiters.indexOf(waiter);
                if (idx >= 0) this.waiters.splice(idx, 1);
                resolve(null);
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
}

function buildBlock(blockNumber, data, size, useCrc, padByte = PAD) {
    const payload = Buffer.alloc(size, padByte);
    data.copy(payload, 0, 0, Math.min(size, data.length));
    const header = Buffer.from([size === 1024 ? STX : SOH, blockNumber & 0xFF, 0xFF - (blockNumber & 0xFF)]);
    let trailer;
    if (useCrc) {
        const crc = crc16xmodem(payload);
        trailer = Buffer.from([(crc >> 8) & 0xFF, crc & 0xFF]);
    } else {
        trailer = Buffer.from([checksum8(payload)]);
    }
    return Buffer.concat([header, payload, trailer]);
}

async function waitStart(queue, ctx, wantCrc) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (ctx.cancelled()) throw new Error('Cancelled');
        const byte = await queue.read(1000);
        if (byte === null) continue;
        if (byte === CRC_REQ) return true;
        if (byte === NAK) {
            if (wantCrc) ctx.log('Receiver requested checksum mode');
            return false;
        }
        if (byte === CAN) throw new Error('Transfer cancelled by receiver');
    }
    throw new Error('Timeout waiting for receiver');
}

async function sendBlockWithRetry(queue, ctx, block) {
    for (let attempt = 0; attempt < 10; attempt++) {
        if (ctx.cancelled()) throw new Error('Cancelled');
        await ctx.waitIfPaused();
        queue.clear();
        const res = await ctx.write(block);
        if (!res.success) throw new Error(res.error || 'Write failed');
        const reply = await queue.read(10000);
        if (reply === ACK) return;
        if (reply === CAN) {
            const second = await queue.read(1000);
            if (second === CAN) throw new Error('Transfer cancelled by receiver');
        }
        ctx.log(`Block retry ${attempt + 1}`);
    }
    throw new Error('Too many retries');
}

async function sendEot(queue, ctx) {
    for (let attempt = 0; attempt < 10; attempt++) {
        queue.clear();
        await ctx.write(Buffer.from([EOT]));
        const reply = await queue.read(5000);
        if (reply === ACK) return;
    }
    throw new Error('EOT not acknowledged');
}

async function sendXmodem(data, ctx, variant) {
    const queue = ctx.queue;
    const wantCrc = variant !== 'xmodem';
    const useCrc = await waitStart(queue, ctx, wantCrc);
    if (variant === 'xmodem-1k' && !useCrc) ctx.log('Receiver does not support CRC, falling back to 128-byte blocks');
    const blockSize = variant === 'xmodem-1k' && useCrc ? 1024 : 128;
    let offset = 0;
    let blockNumber = 1;
    while (offset < data.length) {
        const slice = data.subarray(offset, offset + blockSize);
        const size = slice.length <= 128 ? 128 : blockSize;
        await sendBlockWithRetry(queue, ctx, buildBlock(blockNumber, slice, size, useCrc));
        offset += slice.length;
        blockNumber++;
        ctx.progress(offset, data.length);
    }
    await sendEot(queue, ctx);
}

async function sendYmodem(data, filePath, ctx) {
    const queue = ctx.queue;
    const useCrc = await waitStart(queue, ctx, true);
    if (!useCrc) throw new Error('YMODEM requires CRC mode');
    const name = path.basename(filePath);
    const header = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0]), Buffer.from(String(data.length), 'latin1'), Buffer.from([0])]);
    await sendBlockWithRetry(queue, ctx, buildBlock(0, header, header.length > 128 ? 1024 : 128, true, 0x00));
    const startAgain = await queue.read(10000);
    if (startAgain !== CRC_REQ) ctx.log('Receiver did not request data with C, continuing');
    let offset = 0;
    let blockNumber = 1;
    while (offset < data.length) {
        const slice = data.subarray(offset, offset + 1024);
        const size = slice.length <= 128 ? 128 : 1024;
        await sendBlockWithRetry(queue, ctx, buildBlock(blockNumber, slice, size, true));
        offset += slice.length;
        blockNumber++;
        ctx.progress(offset, data.length);
    }
    queue.clear();
    await ctx.write(Buffer.from([EOT]));
    let reply = await queue.read(5000);
    if (reply === NAK) {
        await ctx.write(Buffer.from([EOT]));
        reply = await queue.read(5000);
    }
    if (reply !== ACK) throw new Error('EOT not acknowledged');
    await queue.read(5000);
    await sendBlockWithRetry(queue, ctx, buildBlock(0, Buffer.alloc(0), 128, true, 0x00));
}

module.exports = { ByteQueue, sendXmodem, sendYmodem, crc16xmodem };
