(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PromptCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_HISTORY_CAP = 50;
    const SOURCE_KEYS = ['acoustic', 'electric', 'drums'];
    const CHARACTER_KEYS = ['mood', 'negativePrompt', 'modifiers'];
    const MIDDLE_KEYS = ['genre', 'harmony', 'style'];
    const LEGACY_POSITIVE_KEYS = ['instrument'];
    const CHORD_PROGRESSOR_VALUE = 'Use Chord Progressor';
    const DEFAULT_SELECTION_KEYS = [
        'freePrompt',
        ...SOURCE_KEYS,
        ...MIDDLE_KEYS,
        ...CHARACTER_KEYS,
        'sourceChoice',
        'characterChoice',
        'progressionKey',
        'progressionId',
        'progression',
        'chordTrack',
        // Accepted so old saved histories still compose instead of vanishing.
        ...LEGACY_POSITIVE_KEYS,
        'production'
    ];
    const HISTORY_STATUSES = new Set(['draft', 'pending', 'complete', 'failed']);

    function clean(value) {
        return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    }

    function normalizeSelections(selections, sectionKeys) {
        const source = selections && typeof selections === 'object' ? selections : {};
        const keys = Array.isArray(sectionKeys) && sectionKeys.length
            ? sectionKeys
            : DEFAULT_SELECTION_KEYS;
        return Object.fromEntries(keys.map(key => [key, clean(source[key])]));
    }

    function normalizeMutedOptions(mutedOptions, sections) {
        const source = mutedOptions && typeof mutedOptions === 'object' ? mutedOptions : {};
        const safeSections = Array.isArray(sections) ? sections : [];
        return Object.fromEntries(safeSections.map(section => {
            const options = sectionOptions(section);
            const requested = new Set(Array.isArray(source[section && section.key])
                ? source[section.key]
                : []);
            return [section.key, options.filter(option => requested.has(option))];
        }));
    }

    function sectionOptionGroups(section) {
        if (Array.isArray(section && section.optionGroups)) {
            return section.optionGroups
                .filter(group => group && Array.isArray(group.options))
                .map(group => ({
                    label: clean(group.label) || 'Options',
                    randomize: group.randomize !== false,
                    options: group.options.filter(value => typeof value === 'string')
                }))
                .filter(group => group.options.length);
        }
        const options = Array.isArray(section && section.options)
            ? section.options.filter(value => typeof value === 'string')
            : [];
        return options.length ? [{ label: clean(section.label) || 'Options', options }] : [];
    }

    function sectionOptions(section) {
        return sectionOptionGroups(section).flatMap(group => group.options);
    }

    function chooseRandomOption(section, mutedValues, random = Math.random) {
        const muted = new Set(Array.isArray(mutedValues) ? mutedValues : []);
        const groups = sectionOptionGroups(section)
            .filter(group => group.randomize !== false)
            .map(group => ({
                ...group,
                options: group.options.filter(option => !muted.has(option))
            }))
            .filter(group => group.options.length);
        if (!groups.length) return '';
        const sample = Number(random());
        const boundedSample = Number.isFinite(sample)
            ? Math.max(0, Math.min(sample, 0.9999999999999999))
            : 0;
        const group = groups[Math.floor(boundedSample * groups.length)];
        const optionSample = Number(random());
        const boundedOptionSample = Number.isFinite(optionSample)
            ? Math.max(0, Math.min(optionSample, 0.9999999999999999))
            : boundedSample;
        return group.options[Math.floor(boundedOptionSample * group.options.length)];
    }

    function randomIndex(length, random = Math.random) {
        if (!Number.isInteger(length) || length < 1) return -1;
        const sample = Number(random());
        const bounded = Number.isFinite(sample)
            ? Math.max(0, Math.min(sample, 0.9999999999999999))
            : 0;
        return Math.floor(bounded * length);
    }

    /**
     * Pure Randomize All policy shared by the UI and its tests.
     *
     * Columns marked `one` select exactly one eligible row. Other columns roll
     * every eligible row. A muted row is left completely untouched, including
     * its active-choice state; muting is therefore a lock, never a mutation.
     */
    function randomizeGroupedSelections(config, selections, mutedSections, random = Math.random) {
        const next = { ...(selections && typeof selections === 'object' ? selections : {}) };
        const sections = Array.isArray(config && config.sections) ? config.sections : [];
        const columns = Array.isArray(config && config.columns) ? config.columns : [];
        const byKey = new Map(sections.map(section => [section.key, section]));
        const muted = new Set(Array.isArray(mutedSections) ? mutedSections : []);

        columns.forEach(column => {
            const eligible = (Array.isArray(column.sections) ? column.sections : [])
                .map(key => byKey.get(key))
                .filter(section => section && section.randomizeAll !== false && !muted.has(section.key));
            if (!eligible.length) return;
            if (column.randomize === 'one') {
                const selected = eligible[randomIndex(eligible.length, random)];
                if (!selected) return;
                if (typeof column.choiceKey === 'string' && column.choiceKey) {
                    next[column.choiceKey] = selected.key;
                }
                next[selected.key] = chooseRandomOption(selected, [], random);
                return;
            }
            eligible.forEach(section => {
                next[section.key] = chooseRandomOption(section, [], random);
            });
        });
        return next;
    }

    function selectedGroupValue(values, choiceKey, keys) {
        const selectedKey = values[choiceKey];
        if (keys.includes(selectedKey)) return values[selectedKey] || '';
        // A compatibility fallback for histories written before grouped rows.
        const populated = keys.filter(key => values[key]);
        return populated.length === 1 ? values[populated[0]] : '';
    }

    function progressionPhrase(value) {
        const cleaned = clean(value);
        if (!cleaned) return '';
        const separator = cleaned.lastIndexOf(':');
        if (separator < 0) return `four-chord ${cleaned} progression`;
        const formula = clean(cleaned.slice(0, separator));
        const mood = clean(cleaned.slice(separator + 1));
        return [mood ? mood.toLowerCase() : '', 'four-chord', formula, 'progression']
            .filter(Boolean)
            .join(' ');
    }

    function usesChordProgressor(value) {
        return clean(value).toLowerCase() === CHORD_PROGRESSOR_VALUE.toLowerCase();
    }

    function composePrompt(selections) {
        const values = normalizeSelections(selections);
        const source = selectedGroupValue(values, 'sourceChoice', SOURCE_KEYS) ||
            LEGACY_POSITIVE_KEYS.map(key => values[key]).find(Boolean) || '';
        const characterChoice = values.characterChoice;
        const mood = characterChoice === 'mood' ? values.mood :
            (!characterChoice && values.mood ? values.mood : '');
        const modifiers = characterChoice === 'modifiers' ? values.modifiers :
            (!characterChoice && values.modifiers ? values.modifiers : '');
        const head = [mood, values.genre, source, values.style].filter(Boolean).join(' ');
        const progressorActive = usesChordProgressor(values.harmony);
        const key = progressorActive ? values.progressionKey : values.harmony;
        const harmony = key ? `in ${key}` : '';
        const progression = progressorActive ? progressionPhrase(values.progression) : '';
        const lead = [head, harmony].filter(Boolean).join(' ');
        return [
            values.freePrompt,
            lead,
            progression,
            values.production,
            modifiers
        ].filter(Boolean).join(', ');
    }

    function effectiveNegativePrompt(selections) {
        const values = normalizeSelections(selections);
        return values.characterChoice === 'negativePrompt' || !values.characterChoice
            ? values.negativePrompt
            : '';
    }

    function historyType(status) {
        return status === 'draft' ? 'draft' : 'sent';
    }

    function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeHistoryEntry(entry) {
        if (!isRecord(entry)) return null;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const hasTimestamp = typeof entry.timestamp === 'number' ||
            (typeof entry.timestamp === 'string' && entry.timestamp.trim() !== '');
        const timestamp = hasTimestamp ? Number(entry.timestamp) : Number.NaN;
        const status = typeof entry.status === 'string' ? entry.status : '';
        if (!id || !Number.isFinite(timestamp) || timestamp < 0 || !HISTORY_STATUSES.has(status)) {
            return null;
        }

        const sourceSelections = isRecord(entry.selections) ? entry.selections : {};
        const selections = Object.fromEntries(Object.entries(sourceSelections)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, clean(value)]));
        const prompt = typeof entry.prompt === 'string'
            ? clean(entry.prompt)
            : composePrompt(selections);
        const resultReference = isRecord(entry.resultReference)
            ? { ...entry.resultReference }
            : null;

        return {
            ...entry,
            id,
            timestamp,
            selections,
            prompt,
            status,
            resultReference
        };
    }

    function enforceHistoryCap(entries, cap = DEFAULT_HISTORY_CAP) {
        const safeCap = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_HISTORY_CAP;
        const counts = { draft: 0, sent: 0 };
        const source = Array.isArray(entries) ? entries : [];
        return source
            .map(normalizeHistoryEntry)
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp)
            .filter(entry => {
                const type = historyType(entry.status);
                counts[type] += 1;
                return counts[type] <= safeCap;
            });
    }

    function appendHistory(entries, entry, cap = DEFAULT_HISTORY_CAP) {
        if (!entry || typeof entry !== 'object') return enforceHistoryCap(entries || [], cap);
        const source = Array.isArray(entries) ? entries : [];
        const withoutSameId = source.filter(item => item && item.id !== entry.id);
        return enforceHistoryCap([entry, ...withoutSameId], cap);
    }

    function updateHistoryEntry(entries, id, changes, cap = DEFAULT_HISTORY_CAP) {
        const source = Array.isArray(entries) ? entries : [];
        return enforceHistoryCap(source.map(entry => (
            isRecord(entry) && entry.id === id ? { ...entry, ...changes } : entry
        )), cap);
    }

    function selectionFingerprint(selections, sectionKeys) {
        return JSON.stringify(normalizeSelections(selections, sectionKeys));
    }

    function isSubmittedSnapshot(entries, selections, sectionKeys) {
        const target = selectionFingerprint(selections, sectionKeys);
        const source = Array.isArray(entries) ? entries : [];
        return source.some(rawEntry => {
            const entry = normalizeHistoryEntry(rawEntry);
            return entry && entry.status !== 'draft' &&
                selectionFingerprint(entry.selections, sectionKeys) === target;
        });
    }

    return Object.freeze({
        DEFAULT_HISTORY_CAP,
        CHARACTER_KEYS,
        CHORD_PROGRESSOR_VALUE,
        MIDDLE_KEYS,
        SOURCE_KEYS,
        appendHistory,
        chooseRandomOption,
        composePrompt,
        effectiveNegativePrompt,
        enforceHistoryCap,
        historyType,
        isSubmittedSnapshot,
        normalizeHistoryEntry,
        normalizeMutedOptions,
        normalizeSelections,
        progressionPhrase,
        randomizeGroupedSelections,
        selectedGroupValue,
        sectionOptionGroups,
        sectionOptions,
        selectionFingerprint,
        usesChordProgressor,
        updateHistoryEntry
    });
});
