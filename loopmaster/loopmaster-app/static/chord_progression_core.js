(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ChordProgressionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FLAT_ROOTS = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
    const ROOT_TO_PC = Object.fromEntries(FLAT_ROOTS.map((root, index) => [root, index]));
    const DEGREE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
    const ROMAN_DEGREES = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };
    const QUALITY_INTERVALS = Object.freeze({
        maj: [0, 4, 7],
        min: [0, 3, 7],
        dim: [0, 3, 6],
        aug: [0, 4, 8],
        sus2: [0, 2, 7],
        sus4: [0, 5, 7],
        maj6: [0, 4, 7, 9],
        min6: [0, 3, 7, 9],
        maj7: [0, 4, 7, 11],
        min7: [0, 3, 7, 10],
        dom7: [0, 4, 7, 10],
        dim7: [0, 3, 6, 9],
        aug7: [0, 4, 8, 10],
        maj9: [0, 4, 7, 11, 14],
        min9: [0, 3, 7, 10, 14],
        dom9: [0, 4, 7, 10, 14],
        min11: [0, 3, 7, 10, 14, 17],
        dom11: [0, 4, 7, 10, 14, 17],
        min13: [0, 3, 7, 10, 14, 17, 21],
        dom13: [0, 4, 7, 10, 14, 17, 21],
        majadd9: [0, 4, 7, 14],
        minadd9: [0, 3, 7, 14],
        majadd11: [0, 4, 7, 17],
        minadd11: [0, 3, 7, 17],
        dimaddaug5: [0, 3, 6, 8],
        min7aug5: [0, 3, 8, 10]
    });
    const QUALITY_DISPLAY = Object.freeze({
        maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
        maj6: '6', min6: 'm6', maj7: 'M7', min7: 'm7', dom7: '7', dim7: 'dim7',
        aug7: 'aug7', maj9: 'M9', min9: 'm9', dom9: '9', min11: 'm11',
        dom11: '11', min13: 'm13', dom13: '13', majadd9: 'add9', minadd9: 'madd9',
        majadd11: 'add11', minadd11: 'madd11', dimaddaug5: 'dim(add#5)',
        min7aug5: 'm7#5'
    });

    function clean(value) {
        return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    }

    function modulo(value, divisor) {
        return ((value % divisor) + divisor) % divisor;
    }

    function rootDisplay(root) {
        return root.charAt(0).toUpperCase() + root.slice(1);
    }

    function normalizeKey(value) {
        const text = clean(value).replace(/♭/g, 'b').replace(/♯/g, '#');
        const match = text.match(/^([a-gA-G])\s*(#|b|sharp|flat)?\s*(major|minor|maj|min)$/i);
        if (!match) return null;
        const natural = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1].toLowerCase()];
        const accidental = (match[2] || '').toLowerCase();
        const delta = accidental === '#' || accidental === 'sharp'
            ? 1
            : (accidental === 'b' || accidental === 'flat' ? -1 : 0);
        const root = FLAT_ROOTS[modulo(natural + delta, 12)];
        const mode = /^(major|maj)$/i.test(match[3]) ? 'major' : 'minor';
        return {
            root,
            pitchClass: ROOT_TO_PC[root],
            mode,
            display: `${rootDisplay(root)} ${mode}`
        };
    }

    function normalizeRomanText(value) {
        return clean(value)
            .replace(/[♭]/g, 'b')
            .replace(/[♯]/g, '#')
            .replace(/[△]/g, 'Δ')
            .replace(/[º]/g, '°')
            .replace(/\s+/g, '');
    }

    function parseDegreeRoot(value) {
        const match = value.match(/^([b#]*)([ivIV]+)(.*)$/);
        if (!match) throw new Error(`Invalid Roman chord “${value}”`);
        const degree = ROMAN_DEGREES[match[2].toUpperCase()];
        if (!degree) throw new Error(`Unsupported Roman degree in “${value}”`);
        const alter = [...match[1]].reduce((sum, accidental) => sum + (accidental === '#' ? 1 : -1), 0);
        return {
            degree,
            alter,
            uppercase: match[2] === match[2].toUpperCase(),
            suffix: match[3]
        };
    }

    function qualityForSuffix(suffix, uppercase) {
        if (!suffix) return uppercase ? 'maj' : 'min';
        if (suffix === '°') return 'dim';
        if (suffix === '°add#5') return 'dimaddaug5';
        if (suffix === 'aug') return 'aug';
        if (suffix === 'aug7') return 'aug7';
        if (suffix === 'sus2' || suffix === 'sus4') return suffix;
        if (suffix === 'Δ' || suffix === 'M7') return 'maj7';
        if (suffix === 'Δ9' || suffix === 'M9') return 'maj9';
        if (suffix === 'add6') return uppercase ? 'maj6' : 'min6';
        if (suffix === 'add9') return uppercase ? 'majadd9' : 'minadd9';
        if (suffix === 'add11') return uppercase ? 'majadd11' : 'minadd11';
        if (suffix === '7#5') return uppercase ? 'aug7' : 'min7aug5';
        if (suffix === '7') return uppercase ? 'dom7' : 'min7';
        if (suffix === '9') return uppercase ? 'dom9' : 'min9';
        if (suffix === '11') return uppercase ? 'dom11' : 'min11';
        if (suffix === '13') return uppercase ? 'dom13' : 'min13';
        throw new Error(`Unsupported chord extension “${suffix}”`);
    }

    function parseRomanStep(value) {
        const roman = clean(value);
        const normalized = normalizeRomanText(roman);
        const slashParts = normalized.split('/');
        if (slashParts.length > 2 || !slashParts[0]) {
            throw new Error(`Invalid slash-bass chord “${roman}”`);
        }
        const root = parseDegreeRoot(slashParts[0]);
        const quality = qualityForSuffix(root.suffix, root.uppercase);
        if (!QUALITY_INTERVALS[quality]) throw new Error(`Unsupported chord quality “${quality}”`);
        let bass = null;
        if (slashParts[1]) {
            bass = parseDegreeRoot(slashParts[1]);
            if (bass.suffix) throw new Error(`Slash bass must be a scale degree in “${roman}”`);
        }
        return { roman, degree: root.degree, alter: root.alter, quality, bass };
    }

    function resolveStep(step, tonicPitchClass) {
        const parsed = typeof step === 'string' ? parseRomanStep(step) : step;
        const rootPc = modulo(tonicPitchClass + DEGREE_OFFSETS[parsed.degree - 1] + parsed.alter, 12);
        const root = FLAT_ROOTS[rootPc];
        const intervals = QUALITY_INTERVALS[parsed.quality];
        if (!intervals) throw new Error(`Unknown chord quality “${parsed.quality}”`);
        let bass = null;
        let bassOffset = null;
        if (parsed.bass) {
            const bassPc = modulo(
                tonicPitchClass + DEGREE_OFFSETS[parsed.bass.degree - 1] + parsed.bass.alter,
                12
            );
            bass = FLAT_ROOTS[bassPc];
            bassOffset = modulo(bassPc - rootPc, 12);
        }
        const suffix = QUALITY_DISPLAY[parsed.quality];
        return {
            roman: parsed.roman,
            chord: `${root}_${parsed.quality}`,
            symbol: `${rootDisplay(root)}${suffix}${bass ? `/${rootDisplay(bass)}` : ''}`,
            formulaOffsets: [...intervals],
            bass,
            bassOffset
        };
    }

    function validateCatalog(catalog) {
        if (!catalog || !Array.isArray(catalog.progressions)) {
            throw new Error('Chord progression catalog is invalid');
        }
        const ids = new Set();
        catalog.progressions.forEach(entry => {
            if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) {
                throw new Error('Chord progression IDs must be unique');
            }
            ids.add(entry.id);
            if (!['major', 'minor'].includes(entry.mode)) {
                throw new Error(`Progression ${entry.id} has an invalid mode`);
            }
            if (!Array.isArray(entry.steps) || entry.steps.length !== 4) {
                throw new Error(`Progression ${entry.id} must contain exactly four chord slots`);
            }
            entry.steps.forEach(parseRomanStep);
        });
        return catalog;
    }

    function selectionText(entry) {
        return entry ? `${entry.formula}: ${entry.mood}` : '';
    }

    function findProgression(catalog, id) {
        return catalog && Array.isArray(catalog.progressions)
            ? catalog.progressions.find(entry => entry.id === id) || null
            : null;
    }

    function resolveProgression(catalog, id, keyValue, bars = 4) {
        const entry = findProgression(catalog, id);
        if (!entry) throw new Error('Choose a chord progression preset');
        const key = normalizeKey(keyValue);
        if (!key) throw new Error('Choose a major or minor key for the chord progressor');
        if (key.mode !== entry.mode) {
            throw new Error(`${entry.mood} is a ${entry.mode} progression; choose a ${entry.mode} key`);
        }
        const barCount = Number(bars);
        if (!Number.isInteger(barCount) || barCount < 1) throw new Error('bars must be a positive integer');
        const parsedSteps = entry.steps.map(parseRomanStep);
        const events = Array.from({ length: barCount }, (_, index) => ({
            bar: index + 1,
            beat: 1,
            ...resolveStep(parsedSteps[index % parsedSteps.length], key.pitchClass)
        }));
        return {
            catalogId: entry.id,
            catalogVersion: Number(catalog.catalogVersion) || 1,
            mode: entry.mode,
            mood: entry.mood,
            formula: entry.formula,
            selection: selectionText(entry),
            key: key.display,
            cycleBars: 4,
            events,
            chordTrack: events.map(event => `${event.chord}@${event.bar}:1`).join(', ')
        };
    }

    function chooseRandomProgression(catalog, mode, mutedIds, random = Math.random) {
        const muted = new Set(Array.isArray(mutedIds) ? mutedIds : []);
        const choices = (catalog && Array.isArray(catalog.progressions) ? catalog.progressions : [])
            .filter(entry => (!mode || entry.mode === mode) && !muted.has(entry.id));
        if (!choices.length) return null;
        const sampled = Number(random());
        const bounded = Number.isFinite(sampled) ? Math.max(0, Math.min(sampled, 0.9999999999999999)) : 0;
        return choices[Math.floor(bounded * choices.length)];
    }

    return Object.freeze({
        DEGREE_OFFSETS,
        FLAT_ROOTS,
        QUALITY_INTERVALS,
        chooseRandomProgression,
        findProgression,
        normalizeKey,
        parseRomanStep,
        resolveProgression,
        resolveStep,
        selectionText,
        validateCatalog
    });
});
