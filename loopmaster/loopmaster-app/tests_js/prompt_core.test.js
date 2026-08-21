'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    appendHistory,
    chooseRandomOption,
    composePrompt,
    effectiveNegativePrompt,
    enforceHistoryCap,
    isSubmittedSnapshot,
    normalizeMutedOptions,
    progressionPhrase,
    randomizeGroupedSelections,
    sectionOptions
} = require('../static/prompt_core.js');

function loadSectionConfig(section) {
    if (!section.optionsFile) return section;
    const relativePath = section.optionsFile.replace(/^\/static\//, '');
    const fragmentPath = path.join(__dirname, '..', 'static', relativePath);
    const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8'));
    return { ...section, optionGroups: fragment.optionGroups };
}

test('composePrompt includes only the active source and character rows', () => {
    const selections = {
        freePrompt: 'a hand-written melodic idea',
        genre: 'techno',
        acoustic: 'grand piano',
        electric: 'analog synthesizer',
        drums: '909 drum machine',
        sourceChoice: 'drums',
        style: 'arpeggiated',
        mood: 'hypnotic',
        characterChoice: 'mood',
        harmony: 'A minor',
        production: 'tape saturated',
        modifiers: 'four bar seamless loop',
        negativePrompt: 'unwanted vocals'
    };
    assert.equal(
        composePrompt(selections),
        'a hand-written melodic idea, hypnotic techno 909 drum machine arpeggiated in A minor, tape saturated'
    );
    assert.equal(effectiveNegativePrompt(selections), '');
});

test('composePrompt switches the active source and character deterministically', () => {
    const selections = {
        genre: 'house',
        acoustic: 'upright piano',
        electric: 'wavetable synthesizer',
        drums: '909 drum machine',
        sourceChoice: 'electric',
        style: 'syncopated',
        harmony: 'C minor',
        mood: 'euphoric',
        negativePrompt: 'unwanted vocals',
        modifiers: 'tight low end',
        characterChoice: 'modifiers'
    };

    assert.equal(
        composePrompt(selections),
        'house wavetable synthesizer syncopated in C minor, tight low end'
    );
    assert.equal(effectiveNegativePrompt(selections), '');

    const avoidActive = { ...selections, characterChoice: 'negativePrompt' };
    assert.equal(composePrompt(avoidActive), 'house wavetable synthesizer syncopated in C minor');
    assert.equal(effectiveNegativePrompt(avoidActive), 'unwanted vocals');
});

test('composePrompt skips empty sections and normalizes whitespace', () => {
    assert.equal(
        composePrompt({ instrument: '  synth   bass ', modifiers: ' punchy ' }),
        'synth bass, punchy'
    );
    assert.equal(composePrompt({ harmony: 'C minor' }), 'in C minor');
    assert.equal(composePrompt({ freePrompt: '  type   absolutely anything  ' }), 'type absolutely anything');
});

test('composePrompt describes an active four-chord progressor selection', () => {
    assert.equal(
        progressionPhrase('I-V-vi-IV: Hopeful'),
        'hopeful four-chord I-V-vi-IV progression'
    );
    assert.equal(progressionPhrase('i-bVII-bVI-V'), 'four-chord i-bVII-bVI-V progression');

    const selections = {
        harmony: 'Use Chord Progressor',
        progressionKey: 'Db major',
        progression: 'I-V-vi-IV: Hopeful',
        electric: 'analog synthesizer',
        sourceChoice: 'electric',
        mood: 'uplifting',
        characterChoice: 'mood'
    };
    assert.equal(
        composePrompt(selections),
        'uplifting analog synthesizer in Db major, hopeful four-chord I-V-vi-IV progression'
    );
    assert.equal(
        composePrompt({ ...selections, harmony: 'Db major' }),
        'uplifting analog synthesizer in Db major'
    );
});

test('history eviction keeps the newest 50 entries per type', () => {
    let history = [];
    for (let index = 0; index < 55; index += 1) {
        history = appendHistory(history, {
            id: `draft-${index}`,
            timestamp: index,
            status: 'draft'
        });
        history = appendHistory(history, {
            id: `sent-${index}`,
            timestamp: index + 0.5,
            status: index % 2 ? 'complete' : 'failed'
        });
    }
    assert.equal(history.filter(item => item.status === 'draft').length, 50);
    assert.equal(history.filter(item => item.status !== 'draft').length, 50);
    assert.equal(history.some(item => item.id === 'draft-0'), false);
    assert.equal(history.some(item => item.id === 'sent-0'), false);
    assert.deepEqual(history, enforceHistoryCap(history));
});

test('history eviction recovers from corrupt persisted data', () => {
    assert.deepEqual(enforceHistoryCap({ unexpected: true }), []);
});

test('history normalization drops invalid entries and repairs malformed nested fields', () => {
    const history = enforceHistoryCap([
        null,
        { id: '', timestamp: 1, status: 'draft' },
        { id: 'missing-time', timestamp: null, status: 'pending' },
        { id: 'bad-time', timestamp: 'not-a-time', status: 'pending' },
        { id: 'bad-status', timestamp: 2, status: 'queued' },
        {
            id: 'safe-sent',
            timestamp: '7',
            status: 'complete',
            selections: ['not', 'an', 'object'],
            prompt: 42,
            resultReference: 'not an object'
        },
        {
            id: 'cleaned-draft',
            timestamp: 8,
            status: 'draft',
            selections: { instrument: '  synth   bass ', ignored: 123 },
            prompt: '  spaced   prompt ',
            resultReference: ['not', 'an', 'object']
        }
    ]);

    assert.deepEqual(history.map(entry => entry.id), ['cleaned-draft', 'safe-sent']);
    assert.deepEqual(history[0].selections, { instrument: 'synth bass' });
    assert.equal(history[0].prompt, 'spaced prompt');
    assert.equal(history[0].resultReference, null);
    assert.equal(history[1].timestamp, 7);
    assert.deepEqual(history[1].selections, {});
    assert.equal(history[1].prompt, '');
    assert.equal(history[1].resultReference, null);
});

test('submitted snapshot detection distinguishes sent entries from real drafts', () => {
    const sectionKeys = ['freePrompt', 'instrument', 'drums', 'harmony', 'negativePrompt'];
    const selections = {
        freePrompt: '  custom   idea ',
        instrument: 'synth bass',
        drums: '909 drum machine',
        harmony: 'A minor',
        negativePrompt: 'vocals'
    };

    for (const status of ['pending', 'complete', 'failed']) {
        assert.equal(isSubmittedSnapshot([{
            id: `sent-${status}`,
            timestamp: 1,
            status,
            selections: { ...selections, freePrompt: 'custom idea' }
        }], selections, sectionKeys), true, `${status} is a submitted state`);
    }

    assert.equal(isSubmittedSnapshot([{
        id: 'draft-only',
        timestamp: 1,
        status: 'draft',
        selections
    }], selections, sectionKeys), false);
    assert.equal(isSubmittedSnapshot([{
        id: 'different-sent-state',
        timestamp: 1,
        status: 'complete',
        selections: { ...selections, drums: 'acoustic drums' }
    }], selections, sectionKeys), false);
});

test('generation payload preserves free prompt and drums in prompt_sections', () => {
    const appPath = path.join(__dirname, '..', 'static', 'app.js');
    const appSource = fs.readFileSync(appPath, 'utf8');
    assert.match(appSource, /prompt_sections:\s*serverPromptSections/);
    assert.doesNotMatch(appSource, /delete serverPromptSections\.(?:freePrompt|drums)/);
});

test('muted prompt options are normalized against the current config', () => {
    const sections = [
        { key: 'genre', options: ['techno', 'house', 'ambient'] },
        { key: 'mood', options: ['dark', 'bright'] }
    ];
    assert.deepEqual(normalizeMutedOptions({
        genre: ['ambient', 'removed option', 'ambient'],
        removedSection: ['anything'],
        mood: 'corrupt value'
    }, sections), {
        genre: ['ambient'],
        mood: []
    });
});

test('random prompt choices never select muted options', () => {
    const section = { key: 'genre', options: ['techno', 'house', 'ambient'] };
    assert.equal(chooseRandomOption(section, ['techno'], () => 0), 'house');
    assert.equal(chooseRandomOption(section, ['techno'], () => 0.999), 'ambient');
    assert.equal(chooseRandomOption(section, ['techno', 'house', 'ambient'], () => 0.5), '');
});

test('grouped random choices exclude option groups marked randomize false', () => {
    const section = {
        key: 'modifiers',
        optionGroups: [
            { label: 'Format', randomize: false, options: ['one shot', 'full arrangement'] },
            { label: 'Texture', options: ['analog warmth', 'pristine digital'] }
        ]
    };

    assert.equal(chooseRandomOption(section, [], () => 0), 'analog warmth');
    assert.equal(chooseRandomOption(section, [], () => 0.999), 'pristine digital');
    assert.equal(
        chooseRandomOption({
            key: 'format-only',
            optionGroups: [{ label: 'Format', randomize: false, options: ['one shot'] }]
        }, [], () => 0),
        ''
    );
});

test('Randomize All rolls one row per grouped column and preserves muted rows', () => {
    const config = {
        columns: [
            { key: 'sources', randomize: 'one', choiceKey: 'sourceChoice', sections: ['acoustic', 'electric'] },
            { key: 'music', randomize: 'all', sections: ['genre', 'harmony'] },
            { key: 'character', randomize: 'one', choiceKey: 'characterChoice', sections: ['mood', 'modifiers'] }
        ],
        sections: [
            { key: 'acoustic', options: ['grand piano'] },
            { key: 'electric', options: ['analog synthesizer'] },
            { key: 'genre', options: ['house'] },
            { key: 'harmony', options: ['C major', 'D minor'] },
            { key: 'mood', options: ['euphoric'] },
            { key: 'modifiers', options: ['tight low end'] }
        ]
    };
    const previous = {
        acoustic: 'upright piano',
        electric: 'wavetable synthesizer',
        sourceChoice: 'electric',
        genre: 'techno',
        harmony: 'C major',
        mood: 'dark',
        modifiers: 'wide stereo image',
        characterChoice: 'modifiers'
    };

    const randomized = randomizeGroupedSelections(config, previous, ['harmony'], () => 0);
    assert.deepEqual(randomized, {
        ...previous,
        acoustic: 'grand piano',
        sourceChoice: 'acoustic',
        genre: 'house',
        mood: 'euphoric',
        characterChoice: 'mood'
    });
    assert.equal(randomized.harmony, 'C major');
    assert.equal(randomized.electric, 'wavetable synthesizer');
    assert.equal(randomized.modifiers, 'wide stereo image');
});

test('prompt config separates drums, expands every pool, and groups the middle column', () => {
    const configPath = path.join(__dirname, '..', 'static', 'prompt_options.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const hydratedSections = config.sections.map(loadSectionConfig);
    const byKey = Object.fromEntries(hydratedSections.map(section => [section.key, section]));
    const drumTerms = /\b(?:drums?|drum machine|percussion|808|909|drum kit)\b/i;

    const minimums = {
        acoustic: 150,
        electric: 140,
        drums: 180,
        genre: 250,
        harmony: 25,
        style: 190,
        mood: 140,
        negativePrompt: 120,
        modifiers: 180
    };
    Object.entries(minimums).forEach(([key, minimum]) => {
        const values = sectionOptions(byKey[key]);
        assert.ok(values.length >= minimum, `${key} should contain at least ${minimum} options`);
        assert.equal(new Set(values).size, values.length, `${key} should not contain duplicate options`);
        const normalizedValues = values.filter(value => value !== 'Use Chord Progressor');
        assert.equal(normalizedValues.every(value => value === value.trim() && !/[A-Z]/.test(value)), true,
            `${key} options should be normalized lowercase strings`);
    });
    assert.equal(sectionOptions(byKey.acoustic).some(option => drumTerms.test(option)), false);
    assert.equal(sectionOptions(byKey.electric).some(option => drumTerms.test(option)), false);
    const musicColumn = config.columns.find(column => column.key === 'music');
    assert.equal(musicColumn.randomize, 'all');
    assert.deepEqual(musicColumn.sections, ['genre', 'harmony', 'style']);
});
