const UF2_MAGIC_START0 = 0x0A324655;
const UF2_MAGIC_START1 = 0x9E5D5157;
const UF2_MAGIC_END = 0x0AB16F30;
const FLAG_FAMILY_ID = 0x00002000;

const FAMILIES = {
    rp2040: 0xe48bff56,
    rp2350: 0xe48bff59,
    'rp2350-arm-s': 0xe48bff59,
    'rp2350-riscv': 0xe48bff5a,
    data: 0xe48bff58,
    absolute: 0xe48bff57
};

function familyFor(chip) {
    const key = String(chip || 'rp2040').toLowerCase();
    return FAMILIES[key] || FAMILIES.rp2040;
}

function encode(data, baseAddress, familyId) {
    const payloadSize = 256;
    const numBlocks = Math.ceil(data.length / payloadSize);
    const out = Buffer.alloc(numBlocks * 512);
    for (let i = 0; i < numBlocks; i++) {
        const block = out.subarray(i * 512, (i + 1) * 512);
        block.writeUInt32LE(UF2_MAGIC_START0, 0);
        block.writeUInt32LE(UF2_MAGIC_START1, 4);
        block.writeUInt32LE(FLAG_FAMILY_ID, 8);
        block.writeUInt32LE((baseAddress + i * payloadSize) >>> 0, 12);
        block.writeUInt32LE(payloadSize, 16);
        block.writeUInt32LE(i, 20);
        block.writeUInt32LE(numBlocks, 24);
        block.writeUInt32LE(familyId >>> 0, 28);
        data.copy(block, 32, i * payloadSize, Math.min(data.length, (i + 1) * payloadSize));
        block.writeUInt32LE(UF2_MAGIC_END, 508);
    }
    return out;
}

function isUf2(buffer) {
    return buffer.length >= 512 && buffer.readUInt32LE(0) === UF2_MAGIC_START0 && buffer.readUInt32LE(4) === UF2_MAGIC_START1;
}

module.exports = { encode, familyFor, isUf2, FAMILIES };
