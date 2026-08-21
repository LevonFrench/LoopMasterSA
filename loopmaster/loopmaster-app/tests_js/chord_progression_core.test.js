'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    chooseRandomProgression,
    normalizeKey,
    resolveProgression,
    resolveStep,
    selectionText,
    validateCatalog
} = require('../static/chord_progression_core.js');

const catalogPath = path.join(__dirname, '..', 'static', 'chord_progressions.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function musicalEvent(event) {
    return {
        roman: event.roman,
        chord: event.chord,
        symbol: event.symbol,
        formulaOffsets: event.formulaOffsets,
        bass: event.bass,
        bassOffset: event.bassOffset
    };
}

test('catalog contains exactly 62 unique progressions split 31 major and 31 minor', () => {
    assert.equal(validateCatalog(catalog), catalog);
    assert.equal(catalog.chordCount, 4);
    assert.equal(catalog.progressions.length, 62);
    assert.equal(new Set(catalog.progressions.map(entry => entry.id)).size, 62);
    assert.equal(catalog.progressions.filter(entry => entry.mode === 'major').length, 31);
    assert.equal(catalog.progressions.filter(entry => entry.mode === 'minor').length, 31);
});

test('every catalog entry resolves in a matching key', () => {
    for (const entry of catalog.progressions) {
        const key = entry.mode === 'major' ? 'C major' : 'C minor';
        const resolution = resolveProgression(catalog, entry.id, key, 4);
        assert.equal(resolution.catalogId, entry.id, entry.id);
        assert.equal(resolution.mode, entry.mode, entry.id);
        assert.equal(resolution.events.length, 4, entry.id);
        assert.equal(resolution.chordTrack.split(', ').length, 4, entry.id);
        resolution.events.forEach(event => {
            assert.ok(event.chord, `${entry.id} should resolve ${event.roman}`);
            assert.ok(event.symbol, `${entry.id} should display ${event.roman}`);
            assert.ok(event.formulaOffsets.length >= 3, `${entry.id} should emit chord tones`);
        });
    }
});

test('four-chord progressions repeat every four bars and expose stable selection text', () => {
    const entry = catalog.progressions.find(item => item.id === 'major_hopeful_01');
    const resolution = resolveProgression(catalog, entry.id, 'C major', 10);

    assert.equal(selectionText(entry), 'I-V-vi-IV: Hopeful');
    assert.equal(resolution.selection, 'I-V-vi-IV: Hopeful');
    assert.equal(resolution.cycleBars, 4);
    assert.equal(resolution.events.length, 10);
    assert.deepEqual(
        resolution.events.slice(4, 8).map(musicalEvent),
        resolution.events.slice(0, 4).map(musicalEvent)
    );
    assert.deepEqual(
        resolution.events.slice(8, 10).map(musicalEvent),
        resolution.events.slice(0, 2).map(musicalEvent)
    );
});

test('slash bass is a scale degree: V/vi in C resolves to G over A, never G over E', () => {
    const key = normalizeKey('C major');
    const event = resolveStep('V/vi', key.pitchClass);

    assert.equal(event.chord, 'g_maj');
    assert.equal(event.symbol, 'G/A');
    assert.equal(event.bass, 'a');
    assert.equal(event.bassOffset, 2);
    assert.notEqual(event.symbol, 'G/E');
});

test('key normalization converts sharp and word accidentals to canonical flat roots', () => {
    assert.deepEqual(normalizeKey('C# major'), {
        root: 'db',
        pitchClass: 1,
        mode: 'major',
        display: 'Db major'
    });
    assert.equal(normalizeKey('A sharp minor').display, 'Bb minor');
    assert.equal(normalizeKey('G flat major').display, 'Gb major');
    assert.equal(normalizeKey('eb min').display, 'Eb minor');
    assert.equal(normalizeKey('D♭ major').display, 'Db major');
    assert.equal(normalizeKey('F♯ minor').display, 'Gb minor');
});

test('extended minor-thirteen formulas resolve without a partial-registry failure', () => {
    const event = resolveStep('i13', normalizeKey('C minor').pitchClass);
    assert.equal(event.chord, 'c_min13');
    assert.equal(event.symbol, 'Cm13');
    assert.deepEqual(event.formulaOffsets, [0, 3, 7, 10, 14, 17, 21]);
});

test('seeded random progression selection is deterministic and honors mode and mutes', () => {
    const mutedId = catalog.progressions.find(entry => entry.mode === 'major').id;
    const pickIds = random => Array.from({ length: 12 }, () => (
        chooseRandomProgression(catalog, 'major', [mutedId], random).id
    ));

    const first = pickIds(seededRandom(0xC0FFEE));
    const second = pickIds(seededRandom(0xC0FFEE));
    assert.deepEqual(first, second);
    assert.ok(first.every(id => id.startsWith('major_')));
    assert.equal(first.includes(mutedId), false);
    assert.equal(new Set(first).size > 1, true);
});
