const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAcidMetadata } = require('../static/wav_metadata_core.js');


test('browser ACID writer uses the classic layout and valid beat cues', () => {
    const bytes = buildAcidMetadata(120, 8, 44100, true);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(view.getUint32(0, true), 0x64696361); // acid
    assert.equal(view.getUint32(4, true), 24);
    assert.equal(view.getUint32(8, true), 1);
    assert.equal(view.getUint16(12, true), 0xFFFF);
    assert.equal(view.getFloat32(16, true), 0);
    assert.equal(view.getUint32(20, true), 16);
    assert.equal(view.getUint16(24, true), 4);
    assert.equal(view.getUint16(26, true), 4);
    assert.equal(view.getFloat32(28, true), 120);

    assert.equal(view.getUint32(32, true), 0x20657563); // cue chunk
    assert.equal(view.getUint32(40, true), 16);
    const finalCueSampleOffset = 32 + 12 + (15 * 24) + 20;
    assert.equal(view.getUint32(finalCueSampleOffset, true), 330750);
});


test('browser one-shot metadata clears loop timing', () => {
    const bytes = buildAcidMetadata(140, 1.5, 44100, false);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(bytes.byteLength, 32);
    assert.equal(view.getUint32(8, true), 0);
    assert.equal(view.getUint32(20, true), 0);
    assert.equal(view.getFloat32(28, true), 0);
});
