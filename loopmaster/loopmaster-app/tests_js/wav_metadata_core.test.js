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


// Golden bytes mirroring wav_metadata.py's writers, so the two ACID
// implementations cannot drift apart on the SHARED fields without a test
// failing. Python packs the acid payload as
//   struct.pack("<IHHfIHHf", flags, root, 0, 0.0, beats, 4, 4, tempo)
// and each cue point as
//   struct.pack("<II4sIII", id, position, b"data", 0, 0, sample)
// inside a header of struct.pack("<4sII", b"cue ", 4 + 24 * n, n).
// Key/root fields are deliberately EXCLUDED from the parity assertions: the
// browser writer intentionally never emits a key (flags bit 2 clear, root
// 0xFFFF) — see the comment in static/wav_metadata_core.js.
function goldenAcidPayload(flags, beats, tempo) {
    const payload = new ArrayBuffer(24);
    const view = new DataView(payload);
    view.setUint32(0, flags, true);      // I flags
    view.setUint16(4, 0, true);          // H root — placeholder, excluded from parity
    view.setUint16(6, 0, true);          // H reserved
    view.setFloat32(8, 0, true);         // f reserved
    view.setUint32(12, beats, true);     // I beat count
    view.setUint16(16, 4, true);         // H meter denominator
    view.setUint16(18, 4, true);         // H meter numerator
    view.setFloat32(20, tempo, true);    // f tempo
    return new DataView(payload);
}

function goldenCueChunk(bpm, sampleRate, beatCount) {
    const samplesPerBeat = (60 / bpm) * sampleRate;
    const cue = new ArrayBuffer(12 + 24 * beatCount);
    const view = new DataView(cue);
    view.setUint32(0, 0x20657563, true);           // 4s "cue "
    view.setUint32(4, 4 + 24 * beatCount, true);   // I chunk size
    view.setUint32(8, beatCount, true);            // I point count
    for (let index = 0; index < beatCount; index++) {
        const sample = Math.round(index * samplesPerBeat);
        const base = 12 + index * 24;
        view.setUint32(base, index + 1, true);         // I id
        view.setUint32(base + 4, sample, true);        // I position
        view.setUint32(base + 8, 0x61746164, true);    // 4s "data"
        view.setUint32(base + 12, 0, true);            // I chunk start
        view.setUint32(base + 16, 0, true);            // I block start
        view.setUint32(base + 20, sample, true);       // I sample offset
    }
    return new Uint8Array(cue);
}

test('browser ACID writer matches the Python writer on shared fields', () => {
    const bpm = 120;
    const durationSec = 8;
    const sampleRate = 44100;
    const beatCount = 16; // Python: int(round(actual_duration * bpm / 60.0))
    const bytes = buildAcidMetadata(bpm, durationSec, sampleRate, true);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const golden = goldenAcidPayload(1, beatCount, bpm);

    // acid payload starts after the 8-byte chunk header.
    assert.equal(view.getUint32(8, true) & 1, golden.getUint32(0, true) & 1, 'flags bit 0 (loop)');
    assert.equal(view.getUint32(20, true), golden.getUint32(12, true), 'beat count');
    assert.equal(view.getUint16(24, true), golden.getUint16(16, true), 'meter denominator');
    assert.equal(view.getUint16(26, true), golden.getUint16(18, true), 'meter numerator');
    assert.equal(view.getFloat32(28, true), golden.getFloat32(20, true), 'tempo');

    // Cue grid: byte-for-byte against the Python cue chunk layout.
    const goldenCue = goldenCueChunk(bpm, sampleRate, beatCount);
    const actualCue = bytes.subarray(32, 32 + goldenCue.length);
    assert.deepEqual(actualCue, goldenCue);
});


test('browser one-shot metadata clears loop timing', () => {
    const bytes = buildAcidMetadata(140, 1.5, 44100, false);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    assert.equal(bytes.byteLength, 32);
    assert.equal(view.getUint32(8, true), 0);
    assert.equal(view.getUint32(20, true), 0);
    assert.equal(view.getFloat32(28, true), 0);
});
