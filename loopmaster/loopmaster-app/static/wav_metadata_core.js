(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WavMetadataCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function buildAcidMetadata(bpm, durationSec, sampleRate, loop) {
        const beatCount = (bpm > 0 && durationSec > 0)
            ? Math.round(durationSec * bpm / 60)
            : 0;
        const acid = new ArrayBuffer(32);
        const av = new DataView(acid);
        av.setUint32(0, 0x64696361, true);             // acid
        av.setUint32(4, 24, true);
        // INTENTIONAL divergence from wav_metadata.py: the browser writer's
        // only call site exports a one-shot composite mix with no key context,
        // so flags bit 2 (key valid) is never set and root stays 0xFFFF
        // ("don't transpose"). Do not "fix" this to match the Python writer;
        // the parity test in tests_js covers the shared ACID fields only.
        av.setUint32(8, loop ? 1 : 0, true);
        av.setUint16(12, 0xFFFF, true);
        av.setUint16(14, 0, true);
        av.setFloat32(16, 0, true);
        av.setUint32(20, loop ? beatCount : 0, true);
        av.setUint16(24, 4, true);                     // denominator
        av.setUint16(26, 4, true);                     // numerator
        av.setFloat32(28, loop ? bpm : 0, true);
        const parts = [new Uint8Array(acid)];

        if (loop && beatCount > 0) {
            const samplesPerBeat = (60 / bpm) * sampleRate;
            const cue = new ArrayBuffer(12 + 24 * beatCount);
            const cv = new DataView(cue);
            cv.setUint32(0, 0x20657563, true);         // cue chunk
            cv.setUint32(4, 4 + 24 * beatCount, true);
            cv.setUint32(8, beatCount, true);
            const encoder = new TextEncoder();
            const labels = [];
            for (let index = 0; index < beatCount; index++) {
                const sample = Math.round(index * samplesPerBeat);
                const base = 12 + index * 24;
                cv.setUint32(base, index + 1, true);
                cv.setUint32(base + 4, sample, true);
                cv.setUint32(base + 8, 0x61746164, true); // data
                cv.setUint32(base + 12, 0, true);
                cv.setUint32(base + 16, 0, true);
                cv.setUint32(base + 20, sample, true);
                let name = encoder.encode(`beat_${index + 1}\0`);
                if (name.length % 2) {
                    const padded = new Uint8Array(name.length + 1);
                    padded.set(name);
                    name = padded;
                }
                const label = new Uint8Array(12 + name.length);
                const lv = new DataView(label.buffer);
                lv.setUint32(0, 0x6c62616c, true);     // labl
                lv.setUint32(4, 4 + name.length, true);
                lv.setUint32(8, index + 1, true);
                label.set(name, 12);
                labels.push(label);
            }
            parts.push(new Uint8Array(cue));
            const labelsLength = labels.reduce((total, label) => total + label.length, 0);
            const list = new Uint8Array(12 + labelsLength);
            const listView = new DataView(list.buffer);
            listView.setUint32(0, 0x5453494c, true);  // LIST
            listView.setUint32(4, 4 + labelsLength, true);
            listView.setUint32(8, 0x6c746461, true);  // adtl
            let offset = 12;
            labels.forEach(label => {
                list.set(label, offset);
                offset += label.length;
            });
            parts.push(list);
        }

        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const output = new Uint8Array(total + (total % 2));
        let offset = 0;
        parts.forEach(part => {
            output.set(part, offset);
            offset += part.length;
        });
        return output;
    }

    return { buildAcidMetadata };
}));
