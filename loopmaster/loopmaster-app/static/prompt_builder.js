(function (root) {
    'use strict';

    const STORAGE_SELECTIONS = 'loopmaster_prompt_builder_v1';
    const STORAGE_HISTORY = 'loopmaster_generation_history_v1';
    const LEGACY_HISTORY = 'loopmaster_prompt_history';
    const RANDOM_VALUE = '__random__';
    const NONE_VALUE = '__none__';
    const CUSTOM_VALUE = '__custom__';
    const FREEFORM_KEY = '__free_prompt__';
    const CUSTOM_DEBOUNCE_MS = 250;
    const INITIAL_HISTORY_WINDOW = 30;
    const EXTRA_SELECTION_KEYS = [
        'sourceChoice', 'characterChoice', 'progressionKey', 'progressionId',
        'progression', 'chordTrack',
        // Kept for restoring histories written before the grouped builder.
        'instrument', 'production'
    ];
    const PROGRESSION_SECTION_KEY = 'chordProgression';

    function readJson(storage, key, fallback) {
        try {
            const raw = storage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            console.warn(`Unable to read ${key}`, error);
            return fallback;
        }
    }

    function writeJson(storage, key, value) {
        try {
            storage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`Unable to persist ${key}`, error);
        }
    }

    function makeId(prefix) {
        if (root.crypto && typeof root.crypto.randomUUID === 'function') {
            return `${prefix}-${root.crypto.randomUUID()}`;
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function createPromptBuilder(options) {
        const core = root.PromptCore;
        if (!core) throw new Error('PromptCore must load before PromptBuilder');

        const storage = options.storage || root.localStorage;
        const sectionsRoot = document.getElementById('prompt-builder-sections');
        const freeform = document.getElementById('prompt-freeform');
        const preview = document.getElementById('prompt-preview');
        const errorBox = document.getElementById('prompt-builder-error');
        const randomizeAllButton = document.getElementById('btn-randomize-all');
        const historyButton = document.getElementById('btn-generation-history');
        const historyCount = document.getElementById('history-count');
        const historyPanel = document.getElementById('generation-history-panel');
        const historyViewport = document.getElementById('generation-history-viewport');
        const historyItems = document.getElementById('generation-history-items');
        const clearHistoryButton = document.getElementById('btn-clear-generation-history');
        const progressionKeySelect = document.getElementById('progression-key-select');
        const progressionPresetSelect = document.getElementById('progression-preset-select');
        const progressionCards = document.getElementById('progression-chord-cards');
        const progressionStatus = document.getElementById('progression-status');
        const progressionRandomButton = document.getElementById('btn-progression-random');
        const progressionMuteButton = document.getElementById('btn-progression-mute');

        let config = null;
        let progressionCatalog = null;
        let selections = {};
        let mutedSections = new Set();
        let controls = new Map();
        let optionTemplates = new Map();
        let customTimers = new Map();
        let historyWindow = INITIAL_HISTORY_WINDOW;
        let onResend = options.onResend || (() => {});
        let onEnter = options.onEnter || (() => {});
        let history = core.enforceHistoryCap(readJson(storage, STORAGE_HISTORY, []));
        let currentSnapshotSubmitted = false;

        function persistHistory() {
            history = core.enforceHistoryCap(history);
            writeJson(storage, STORAGE_HISTORY, history);
            renderHistory();
        }

        function migrateLegacyHistory() {
            if (history.length) return;
            const legacy = readJson(storage, LEGACY_HISTORY, []);
            if (!Array.isArray(legacy) || !legacy.length) return;
            legacy.slice(0, 10).forEach((prompt, index) => {
                if (typeof prompt !== 'string' || !prompt.trim()) return;
                history = core.appendHistory(history, {
                    id: makeId('legacy'),
                    timestamp: Date.now() - index,
                    selections: { modifiers: prompt.trim() },
                    prompt: prompt.trim(),
                    status: 'draft',
                    resultReference: null
                });
            });
            persistHistory();
        }

        function persistSelections() {
            writeJson(storage, STORAGE_SELECTIONS, {
                configVersion: config && config.version,
                selections,
                mutedSections: [...mutedSections]
            });
        }

        function scheduleSelectionPersistence(key) {
            const timer = customTimers.get(key);
            if (timer) clearTimeout(timer);
            customTimers.set(key, setTimeout(() => {
                customTimers.delete(key);
                persistSelections();
            }, CUSTOM_DEBOUNCE_MS));
        }

        function flushPendingUpdate(key) {
            const timer = customTimers.get(key);
            if (!timer) return false;
            clearTimeout(timer);
            customTimers.delete(key);
            persistSelections();
            return true;
        }

        function flushAllPendingUpdates() {
            if (!customTimers.size) return;
            customTimers.forEach(timer => clearTimeout(timer));
            customTimers.clear();
            persistSelections();
        }

        function sectionKeys() {
            return ['freePrompt', ...config.sections.map(section => section.key), ...EXTRA_SELECTION_KEYS];
        }

        function snapshot() {
            return core.normalizeSelections(selections, sectionKeys());
        }

        function currentPrompt() {
            return core.composePrompt(selections);
        }

        function captureDraft(previous) {
            if (currentSnapshotSubmitted) return;
            const prompt = core.composePrompt(previous);
            if (!prompt) return;
            const negativePrompt = core.effectiveNegativePrompt(previous);
            const newest = history[0];
            if (newest && newest.status === 'draft' && newest.prompt === prompt &&
                    core.effectiveNegativePrompt(newest.selections || {}) === negativePrompt) return;
            history = core.appendHistory(history, {
                id: makeId('draft'),
                timestamp: Date.now(),
                selections: core.normalizeSelections(previous, sectionKeys()),
                prompt,
                status: 'draft',
                resultReference: null
            });
            persistHistory();
        }

        function updatePreview() {
            const prompt = currentPrompt();
            const negativePrompt = core.effectiveNegativePrompt(selections);
            preview.textContent = [
                prompt || 'Choose options or randomize all.',
                negativePrompt ? `Avoid: ${negativePrompt}` : ''
            ].filter(Boolean).join('\n');
        }

        function queueFreeformUpdate() {
            const hasPendingUpdate = customTimers.has(FREEFORM_KEY);
            const changed = commit({
                ...selections,
                freePrompt: freeform.value
            }, { capture: !hasPendingUpdate, persist: false });
            if (changed || hasPendingUpdate) scheduleSelectionPersistence(FREEFORM_KEY);
        }

        function flushFreeformUpdate() {
            flushPendingUpdate(FREEFORM_KEY);
        }

        function commit(nextSelections, options = {}) {
            const { capture = true, persist = true, submitted } = options;
            const previous = snapshot();
            const grouped = prepareGroupedSelections(nextSelections);
            const prepared = progressionCatalog
                ? prepareProgressionSelections(grouped)
                : grouped;
            const normalized = core.normalizeSelections(prepared, sectionKeys());
            const changed = sectionKeys().some(key => previous[key] !== normalized[key]);
            if (!changed) {
                if (typeof submitted === 'boolean') currentSnapshotSubmitted = submitted;
                return false;
            }
            if (capture) captureDraft(previous);
            selections = normalized;
            currentSnapshotSubmitted = typeof submitted === 'boolean'
                ? submitted
                : false;
            if (persist) persistSelections();
            updatePreview();
            refreshGroupedSectionState();
            refreshProgressionUi();
            return true;
        }

        function randomOption(section) {
            return core.chooseRandomOption(section, []);
        }

        function columnForSection(sectionKey) {
            const columns = Array.isArray(config && config.columns) ? config.columns : [];
            return columns.find(column => Array.isArray(column.sections) && column.sections.includes(sectionKey)) || null;
        }

        function prepareGroupedSelections(source) {
            const next = { ...(source && typeof source === 'object' ? source : {}) };
            if (!config || !Array.isArray(config.columns)) return next;
            config.columns
                .filter(column => column.randomize === 'one' && column.choiceKey)
                .forEach(column => {
                    if (column.sections.includes(next[column.choiceKey])) return;
                    if (column.key === 'sources' && typeof next.instrument === 'string' && next.instrument.trim()) {
                        const legacyInstrument = next.instrument.trim();
                        const acoustic = config.sections.find(section => section.key === 'acoustic');
                        const target = core.sectionOptions(acoustic).includes(legacyInstrument)
                            ? 'acoustic'
                            : 'electric';
                        if (!next[target]) next[target] = legacyInstrument;
                        next[column.choiceKey] = target;
                        return;
                    }
                    const populated = column.sections.filter(key => (
                        typeof next[key] === 'string' && next[key].trim()
                    ));
                    if (populated.length === 1) next[column.choiceKey] = populated[0];
                });
            return next;
        }

        function isSectionMuted(sectionKey) {
            return mutedSections.has(sectionKey);
        }

        function refreshMuteControl(section) {
            const control = controls.get(section.key);
            if (!control) return;
            const muted = isSectionMuted(section.key);
            control.mute.classList.toggle('is-muted', muted);
            control.mute.textContent = muted ? '🔒' : '🔓';
            control.mute.title = muted
                ? `Unmute ${section.label} for Randomize All`
                : `Mute ${section.label} from Randomize All`;
            control.mute.setAttribute('aria-label', control.mute.title);
            control.mute.setAttribute('aria-pressed', String(muted));
            control.dice.disabled = muted;
            control.wrapper.classList.toggle('is-random-muted', muted);
        }

        function toggleMutedSection(section) {
            if (mutedSections.has(section.key)) mutedSections.delete(section.key);
            else mutedSections.add(section.key);
            persistSelections();
            // Muting changes only Randomize All eligibility. It never rolls a
            // replacement or mutates the current prompt value.
            refreshMuteControl(section);
        }

        function applyControlValue(section, value) {
            const control = controls.get(section.key);
            if (!control) return;
            const isCurated = core.sectionOptions(section).includes(value);
            control.select.value = value === '' ? NONE_VALUE : (isCurated ? value : CUSTOM_VALUE);
            control.custom.hidden = isCurated || value === '';
            control.custom.value = isCurated ? '' : value;
            refreshMuteControl(section);
        }

        function refreshGroupedSectionState() {
            if (!config) return;
            config.sections.forEach(section => {
                const control = controls.get(section.key);
                if (!control) return;
                const column = columnForSection(section.key);
                const active = !column || column.randomize !== 'one' ||
                    selections[column.choiceKey] === section.key;
                control.wrapper.classList.toggle('is-group-active', active);
                control.wrapper.classList.toggle('is-group-dormant', !active);
                control.wrapper.setAttribute('data-group-active', String(active));
                refreshMuteControl(section);
            });
        }

        function setSectionValue(section, value, capture = true) {
            const next = { ...selections, [section.key]: value };
            const column = columnForSection(section.key);
            if (column && column.randomize === 'one' && column.choiceKey) {
                // Selecting None still makes this the active row. That prevents
                // a preserved value in a dormant sibling from resurfacing.
                next[column.choiceKey] = section.key;
            }
            commit(next, { capture });
            applyControlValue(section, value);
            refreshGroupedSectionState();
        }

        function queueSectionCustomUpdate(section, select, custom) {
            const hasPendingUpdate = customTimers.has(section.key);
            const next = {
                ...selections,
                [section.key]: custom.value
            };
            const column = columnForSection(section.key);
            if (column && column.randomize === 'one' && column.choiceKey && custom.value) {
                next[column.choiceKey] = section.key;
            }
            const changed = commit(next, { capture: !hasPendingUpdate, persist: false });
            custom.hidden = false;
            select.value = CUSTOM_VALUE;
            refreshGroupedSectionState();
            if (changed || hasPendingUpdate) scheduleSelectionPersistence(section.key);
        }

        function optionSpecs(section) {
            if (!optionTemplates.has(section.key)) {
                optionTemplates.set(section.key, [
                    { value: NONE_VALUE, text: 'None / skip' },
                    { value: RANDOM_VALUE, text: 'Random' },
                    ...core.sectionOptionGroups(section).map(group => ({
                        label: group.label,
                        options: group.options.map(value => ({ value, text: value }))
                    })),
                    { value: CUSTOM_VALUE, text: 'Free-text override…' }
                ]);
            }
            return optionTemplates.get(section.key);
        }

        function renderSection(section) {
            const wrapper = el('div', 'prompt-builder-section');
            const label = el('label', 'chip-label', section.label);
            label.htmlFor = `prompt-select-${section.key}`;
            if (section.randomizeAll === false) {
                wrapper.dataset.randomizeAll = 'preserve';
                const pin = el('span', 'prompt-section-pin', 'Pinned');
                pin.title = `${section.label} stays unchanged when using Randomize All`;
                label.append(' ', pin);
            }
            const row = el('div', 'prompt-builder-control-row');
            const select = el('select', 'prompt-section-select');
            select.id = `prompt-select-${section.key}`;
            select.setAttribute('aria-label', `${section.label} curated options`);
            optionSpecs(section).forEach(spec => {
                if (Array.isArray(spec.options)) {
                    const group = document.createElement('optgroup');
                    group.label = spec.label;
                    spec.options.forEach(({ value, text }) => {
                        const option = el('option', '', text);
                        option.value = value;
                        group.appendChild(option);
                    });
                    select.appendChild(group);
                    return;
                }
                const option = el('option', '', spec.text);
                option.value = spec.value;
                select.appendChild(option);
            });
            const dice = el('button', 'chip-dice', '⚄');
            dice.type = 'button';
            dice.title = `Randomize ${section.label}`;
            dice.setAttribute('aria-label', `Randomize ${section.label}`);
            const mute = el('button', 'chip-mute', '🔇');
            mute.type = 'button';
            const custom = el('input', 'prompt-custom-input');
            custom.type = 'text';
            custom.placeholder = section.placeholder || `Custom ${section.label.toLowerCase()}`;
            custom.autocomplete = 'off';
            custom.spellcheck = false;
            custom.hidden = true;

            select.addEventListener('change', () => {
                if (select.value === RANDOM_VALUE) {
                    setSectionValue(section, randomOption(section));
                    return;
                }
                if (select.value === NONE_VALUE) {
                    setSectionValue(section, '');
                    return;
                }
                if (select.value === CUSTOM_VALUE) {
                    setSectionValue(section, custom.value || '');
                    select.value = CUSTOM_VALUE;
                    custom.hidden = false;
                    custom.focus();
                    return;
                }
                setSectionValue(section, select.value);
            });
            mute.addEventListener('click', () => toggleMutedSection(section));
            dice.addEventListener('click', () => {
                if (!isSectionMuted(section.key)) setSectionValue(section, randomOption(section));
            });
            custom.addEventListener('input', () => queueSectionCustomUpdate(section, select, custom));
            custom.addEventListener('blur', () => flushPendingUpdate(section.key));
            custom.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    flushPendingUpdate(section.key);
                    custom.blur();
                    onEnter();
                }
            });

            row.append(select, mute, dice);
            wrapper.append(label, row, custom);
            controls.set(section.key, { select, custom, mute, dice, wrapper });
            refreshMuteControl(section);
            return wrapper;
        }

        function progressionEntry(id) {
            return root.ChordProgressionCore.findProgression(progressionCatalog, id);
        }

        function keyWithMode(keyValue, mode) {
            const normalized = root.ChordProgressionCore.normalizeKey(keyValue);
            if (!normalized) return mode === 'minor' ? 'C minor' : 'C major';
            const displayRoot = normalized.root.charAt(0).toUpperCase() + normalized.root.slice(1);
            return `${displayRoot} ${mode}`;
        }

        function prepareProgressionSelections(source) {
            const next = { ...source };
            if (!progressionCatalog) return next;
            const active = core.usesChordProgressor(next.harmony);
            let entry = progressionEntry(next.progressionId);
            let normalizedKey = root.ChordProgressionCore.normalizeKey(next.progressionKey);
            if (active && !normalizedKey) {
                const previousKey = root.ChordProgressionCore.normalizeKey(selections.harmony);
                const mode = entry?.mode || previousKey?.mode || 'major';
                next.progressionKey = previousKey && previousKey.mode === mode
                    ? previousKey.display
                    : keyWithMode('C major', mode);
                normalizedKey = root.ChordProgressionCore.normalizeKey(next.progressionKey);
            }
            if (normalizedKey) next.progressionKey = normalizedKey.display;
            if (active && (!entry || !normalizedKey || entry.mode !== normalizedKey.mode)) {
                const mode = normalizedKey?.mode || 'major';
                entry = progressionCatalog.progressions.find(item => item.mode === mode) || null;
                next.progressionId = entry?.id || '';
            }
            if (!entry || !next.progressionKey) {
                next.progression = '';
                next.chordTrack = '';
                return next;
            }
            try {
                const resolution = root.ChordProgressionCore.resolveProgression(
                    progressionCatalog,
                    entry.id,
                    next.progressionKey,
                    4
                );
                next.progression = resolution.selection;
                next.chordTrack = resolution.chordTrack;
            } catch (_error) {
                next.progression = '';
                next.chordTrack = '';
            }
            return next;
        }

        function setProgressionEntry(entry, capture = true) {
            if (!entry) {
                commit({ ...selections, progressionId: '', progression: '', chordTrack: '' }, { capture });
                refreshProgressionUi();
                return;
            }
            const key = keyWithMode(selections.progressionKey, entry.mode);
            commit(prepareProgressionSelections({
                ...selections,
                progressionKey: key,
                progressionId: entry.id
            }), { capture });
            refreshProgressionUi();
        }

        function randomProgressionEntry(baseSelections = selections) {
            const key = root.ChordProgressionCore.normalizeKey(baseSelections.progressionKey);
            const mode = key?.mode || null;
            return root.ChordProgressionCore.chooseRandomProgression(
                progressionCatalog,
                mode,
                []
            );
        }

        function randomizeProgression() {
            if (isSectionMuted(PROGRESSION_SECTION_KEY)) return;
            const entry = randomProgressionEntry();
            if (entry) setProgressionEntry(entry);
        }

        function refreshProgressionUi() {
            if (!progressionCatalog) return;
            const active = core.usesChordProgressor(selections.harmony);
            const entry = progressionEntry(selections.progressionId);
            if (progressionKeySelect) progressionKeySelect.value = selections.progressionKey || '';
            if (progressionPresetSelect) progressionPresetSelect.value = entry?.id || NONE_VALUE;
            const muted = isSectionMuted(PROGRESSION_SECTION_KEY);
            progressionMuteButton?.classList.toggle('is-muted', muted);
            if (progressionMuteButton) {
                progressionMuteButton.textContent = muted ? '🔒' : '🔓';
                progressionMuteButton.setAttribute('aria-pressed', String(muted));
                progressionMuteButton.title = muted
                    ? 'Unmute the chord progressor for Randomize All'
                    : 'Mute the chord progressor from Randomize All';
            }
            if (progressionRandomButton) progressionRandomButton.disabled = muted;
            document.getElementById('chord-progressor')?.classList.toggle('is-active', active);
            progressionCards?.replaceChildren();
            if (!entry || !selections.progressionKey) {
                if (progressionStatus) progressionStatus.textContent = 'Choose a key and progression.';
                return;
            }
            try {
                const resolution = root.ChordProgressionCore.resolveProgression(
                    progressionCatalog,
                    entry.id,
                    selections.progressionKey,
                    4
                );
                resolution.events.slice(0, 4).forEach((event, index) => {
                    const card = el('article', 'chord-progressor-card');
                    const bar = el('span', 'chord-card-bar', `Bar ${index + 1}`);
                    const symbol = el('strong', 'chord-card-symbol', event.symbol);
                    const roman = el('span', 'chord-card-roman', event.roman);
                    card.append(bar, symbol, roman);
                    progressionCards.appendChild(card);
                });
                if (progressionStatus) {
                    progressionStatus.textContent = active
                        ? `${entry.mood} · ${entry.formula} · applied to every generation`
                        : `${entry.mood} · ${entry.formula} · choose “Use Chord Progressor” above to apply`;
                }
            } catch (error) {
                if (progressionStatus) progressionStatus.textContent = error.message;
            }
        }

        function renderProgressionControls() {
            if (!progressionKeySelect || !progressionPresetSelect) return;
            progressionKeySelect.replaceChildren();
            const keyOptions = config.sections
                .find(section => section.key === 'harmony')?.options
                .map(value => root.ChordProgressionCore.normalizeKey(value)?.display || '')
                .filter(Boolean) || [];
            keyOptions.forEach(value => {
                const option = el('option', '', value);
                option.value = value;
                progressionKeySelect.appendChild(option);
            });
            progressionPresetSelect.replaceChildren();
            const none = el('option', '', 'None / choose a preset');
            none.value = NONE_VALUE;
            progressionPresetSelect.appendChild(none);
            for (const mode of ['major', 'minor']) {
                const group = document.createElement('optgroup');
                group.label = mode === 'major' ? 'Major progressions' : 'Minor progressions';
                progressionCatalog.progressions
                    .filter(entry => entry.mode === mode)
                    .forEach(entry => {
                        const option = el('option', '', `${entry.formula}: ${entry.mood}`);
                        option.value = entry.id;
                        group.appendChild(option);
                    });
                progressionPresetSelect.appendChild(group);
            }
            progressionKeySelect.addEventListener('change', () => {
                const key = progressionKeySelect.value;
                const normalized = root.ChordProgressionCore.normalizeKey(key);
                let entry = progressionEntry(selections.progressionId);
                if (!entry || entry.mode !== normalized?.mode) {
                    entry = progressionCatalog.progressions.find(item => item.mode === normalized?.mode) || null;
                }
                commit(prepareProgressionSelections({
                    ...selections,
                    progressionKey: key,
                    progressionId: entry?.id || ''
                }));
                refreshProgressionUi();
            });
            progressionPresetSelect.addEventListener('change', () => {
                if (progressionPresetSelect.value === NONE_VALUE) setProgressionEntry(null);
                else setProgressionEntry(progressionEntry(progressionPresetSelect.value));
            });
            progressionRandomButton?.addEventListener('click', randomizeProgression);
            progressionMuteButton?.addEventListener('click', () => {
                if (mutedSections.has(PROGRESSION_SECTION_KEY)) mutedSections.delete(PROGRESSION_SECTION_KEY);
                else mutedSections.add(PROGRESSION_SECTION_KEY);
                persistSelections();
                refreshProgressionUi();
            });
            refreshProgressionUi();
        }

        function renderBuilderColumns() {
            const sectionByKey = new Map(config.sections.map(section => [section.key, section]));
            const columns = Array.isArray(config.columns) && config.columns.length
                ? config.columns
                : [{ key: 'all', label: 'Prompt choices', sections: config.sections.map(section => section.key) }];
            return columns.map((column, columnIndex) => {
                const wrapper = el('section', 'prompt-builder-column');
                wrapper.dataset.column = column.key;
                const heading = el('div', 'prompt-column-heading');
                heading.append(
                    el('span', 'prompt-column-number', String(columnIndex + 1).padStart(2, '0')),
                    el('span', 'prompt-column-title', column.label || column.key),
                    el('span', 'prompt-column-hint', column.hint || '')
                );
                wrapper.appendChild(heading);
                column.sections.forEach(sectionKey => {
                    const section = sectionByKey.get(sectionKey);
                    if (section) wrapper.appendChild(renderSection(section));
                });
                return wrapper;
            });
        }

        function randomizeAll() {
            if (!config) return;
            const next = core.randomizeGroupedSelections(
                config,
                selections,
                [...mutedSections],
                Math.random
            );
            if (core.usesChordProgressor(next.harmony) &&
                    !isSectionMuted(PROGRESSION_SECTION_KEY)) {
                if (!next.progressionKey) {
                    const previousKey = root.ChordProgressionCore.normalizeKey(selections.harmony);
                    next.progressionKey = previousKey?.display || 'C major';
                }
                const entry = randomProgressionEntry(next);
                if (entry) {
                    next.progressionKey = keyWithMode(next.progressionKey, entry.mode);
                    next.progressionId = entry.id;
                }
            }
            commit(prepareProgressionSelections(next));
            config.sections.forEach(section => applyControlValue(section, selections[section.key]));
            refreshGroupedSectionState();
            refreshProgressionUi();
        }

        function restore(entryOrSelections, capture = true) {
            const isHistoryEntry = entryOrSelections && typeof entryOrSelections === 'object' &&
                !Array.isArray(entryOrSelections) &&
                entryOrSelections.selections && typeof entryOrSelections.selections === 'object' &&
                typeof entryOrSelections.status === 'string';
            const source = isHistoryEntry
                ? entryOrSelections.selections
                : entryOrSelections;
            commit(source || {}, {
                capture,
                submitted: isHistoryEntry ? entryOrSelections.status !== 'draft' : false
            });
            config.sections.forEach(section => applyControlValue(section, selections[section.key]));
            freeform.value = selections.freePrompt || '';
        }

        function restoreLegacyPrompt(prompt, capture = true) {
            const next = Object.fromEntries(sectionKeys().map(key => [key, '']));
            next.freePrompt = typeof prompt === 'string' ? prompt.trim() : '';
            restore(next, capture);
        }

        function createHistoryEntry(status, resultReference) {
            const prompt = currentPrompt();
            const entry = {
                id: makeId(status === 'draft' ? 'draft' : 'generation'),
                timestamp: Date.now(),
                selections: snapshot(),
                prompt,
                status,
                resultReference: resultReference || null
            };
            history = core.appendHistory(history, entry);
            if (status !== 'draft' && history.some(item => item.id === entry.id)) {
                currentSnapshotSubmitted = true;
            }
            persistHistory();
            return entry;
        }

        function updateGeneration(id, status, resultReference) {
            history = core.updateHistoryEntry(history, id, {
                status,
                resultReference: resultReference || null
            });
            persistHistory();
        }

        function formatTimestamp(timestamp) {
            try {
                return new Date(timestamp).toLocaleString([], {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                });
            } catch (_error) {
                return '';
            }
        }

        function renderHistoryEntry(entry) {
            const row = el('article', 'generation-history-entry');
            row.dataset.entryId = entry.id;
            row.tabIndex = 0;
            const meta = el('div', 'generation-history-meta');
            const status = el('span', `history-status history-status-${entry.status}`, entry.status);
            const time = el('time', 'history-time', formatTimestamp(entry.timestamp));
            meta.append(status, time);
            const prompt = el('p', 'generation-history-prompt', entry.prompt || '(negative prompt only)');
            const actions = el('div', 'generation-history-actions');
            const restoreButton = el('button', 'history-action', 'Restore');
            restoreButton.type = 'button';
            restoreButton.dataset.historyAction = 'restore';
            const resendButton = el('button', 'history-action history-action-primary', 'Send');
            resendButton.type = 'button';
            resendButton.dataset.historyAction = 'resend';
            const deleteButton = el('button', 'history-action history-action-danger', 'Delete');
            deleteButton.type = 'button';
            deleteButton.dataset.historyAction = 'delete';
            actions.append(restoreButton, resendButton, deleteButton);
            row.append(meta, prompt, actions);
            return row;
        }

        function renderHistory() {
            if (!historyItems) return;
            history.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
            historyItems.replaceChildren();
            const visible = history.slice(0, historyWindow);
            visible.forEach(entry => historyItems.appendChild(renderHistoryEntry(entry)));
            if (history.length > visible.length) {
                const more = el('button', 'history-load-more', `Show ${Math.min(30, history.length - visible.length)} older`);
                more.type = 'button';
                more.addEventListener('click', () => {
                    historyWindow += 30;
                    renderHistory();
                });
                historyItems.appendChild(more);
            }
            if (!history.length) historyItems.appendChild(el('p', 'history-empty', 'No drafts or generations yet.'));
            if (historyCount) historyCount.textContent = String(history.length);
        }

        async function reconcilePendingHistory() {
            const pending = history.filter(entry => entry.status === 'pending');
            if (!pending.length) return;
            let changed = false;
            await Promise.allSettled(pending.map(async entry => {
                const jobId = entry.resultReference && entry.resultReference.jobId;
                if (!jobId) {
                    history = core.updateHistoryEntry(history, entry.id, {
                        status: 'failed',
                        resultReference: { error: 'Submission was interrupted before a job was created.' }
                    });
                    changed = true;
                    return;
                }
                const response = await fetch(`/api/status/${encodeURIComponent(jobId)}`);
                if (response.status === 404) {
                    history = core.updateHistoryEntry(history, entry.id, {
                        status: 'failed',
                        resultReference: { ...entry.resultReference, error: 'Generation is no longer available.' }
                    });
                    changed = true;
                    return;
                }
                if (!response.ok) return;
                const result = await response.json();
                if (result.status === 'done') {
                    history = core.updateHistoryEntry(history, entry.id, {
                        status: 'complete',
                        resultReference: {
                            jobId,
                            files: result.files || [],
                            trackNum: result.track_num,
                            partialErrors: result.partial_errors || []
                        }
                    });
                    changed = true;
                } else if (result.status === 'error' || result.status === 'cancelled') {
                    history = core.updateHistoryEntry(history, entry.id, {
                        status: 'failed',
                        resultReference: {
                            ...entry.resultReference,
                            error: result.error || `Generation ${result.status}.`
                        }
                    });
                    changed = true;
                }
            }));
            if (changed) persistHistory();
        }

        function handleHistoryClick(event) {
            const row = event.target.closest('[data-entry-id]');
            if (!row) return;
            const entry = history.find(item => item.id === row.dataset.entryId);
            if (!entry) return;
            const action = event.target.closest('[data-history-action]')?.dataset.historyAction || 'restore';
            if (action === 'delete') {
                history = history.filter(item => item.id !== entry.id);
                persistHistory();
                return;
            }
            restore(entry);
            if (action === 'resend') onResend(entry);
        }

        async function initialize() {
            try {
                const [optionsResponse, progressionResponse] = await Promise.all([
                    fetch('/static/prompt_options.json', { cache: 'no-cache' }),
                    fetch('/static/chord_progressions.json', { cache: 'no-cache' })
                ]);
                if (!optionsResponse.ok) {
                    throw new Error(`Prompt options returned HTTP ${optionsResponse.status}`);
                }
                if (!progressionResponse.ok) {
                    throw new Error(`Chord progressions returned HTTP ${progressionResponse.status}`);
                }
                config = await optionsResponse.json();
                progressionCatalog = root.ChordProgressionCore.validateCatalog(
                    await progressionResponse.json()
                );
                if (!config || !Array.isArray(config.sections) || !config.sections.length) {
                    throw new Error('Prompt option config is invalid');
                }
                await Promise.all(config.sections.map(async section => {
                    if (!section.optionsFile) return;
                    const sectionResponse = await fetch(section.optionsFile, { cache: 'no-cache' });
                    if (!sectionResponse.ok) {
                        throw new Error(`${section.label} options returned HTTP ${sectionResponse.status}`);
                    }
                    const sectionConfig = await sectionResponse.json();
                    if (!sectionConfig || !Array.isArray(sectionConfig.optionGroups)) {
                        throw new Error(`${section.label} option config is invalid`);
                    }
                    section.optionGroups = sectionConfig.optionGroups;
                    section.optionsVersion = sectionConfig.version;
                }));
                if (!Array.isArray(config.columns) || config.columns.length !== 3) {
                    throw new Error('Prompt option columns are invalid');
                }
                const saved = readJson(storage, STORAGE_SELECTIONS, {});
                selections = core.normalizeSelections(
                    prepareProgressionSelections(prepareGroupedSelections(saved.selections || {})),
                    sectionKeys()
                );
                const validSectionKeys = new Set([
                    ...config.sections.map(section => section.key),
                    PROGRESSION_SECTION_KEY
                ]);
                mutedSections = new Set(
                    (Array.isArray(saved.mutedSections) ? saved.mutedSections : [])
                        .filter(key => validSectionKeys.has(key))
                );
                freeform.value = selections.freePrompt || '';
                sectionsRoot.replaceChildren(...renderBuilderColumns());
                config.sections.forEach(section => applyControlValue(section, selections[section.key]));
                renderProgressionControls();
                refreshGroupedSectionState();
                updatePreview();
                persistSelections();
                migrateLegacyHistory();
                currentSnapshotSubmitted = core.isSubmittedSnapshot(
                    history,
                    selections,
                    sectionKeys()
                );
                renderHistory();
                void reconcilePendingHistory();
                randomizeAllButton.disabled = false;
            } catch (error) {
                console.error('Unable to initialize prompt builder:', error);
                errorBox.textContent = `Prompt builder unavailable: ${error.message}`;
                errorBox.hidden = false;
                randomizeAllButton.disabled = true;
                throw error;
            }
        }

        randomizeAllButton.addEventListener('click', randomizeAll);
        freeform.addEventListener('input', queueFreeformUpdate);
        freeform.addEventListener('blur', flushFreeformUpdate);
        freeform.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                flushFreeformUpdate();
                onEnter();
            }
        });
        if (typeof root.addEventListener === 'function') {
            root.addEventListener('pagehide', flushAllPendingUpdates);
        }
        historyButton.addEventListener('click', () => {
            const opening = historyPanel.hidden;
            historyPanel.hidden = !opening;
            historyButton.setAttribute('aria-expanded', String(opening));
            if (opening) renderHistory();
        });
        clearHistoryButton.addEventListener('click', () => {
            history = [];
            historyWindow = INITIAL_HISTORY_WINDOW;
            persistHistory();
        });
        historyViewport.addEventListener('click', handleHistoryClick);
        historyViewport.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') handleHistoryClick(event);
        });

        renderHistory();
        const ready = initialize();
        return Object.freeze({
            ready,
            createHistoryEntry,
            currentChordTrack() {
                return core.usesChordProgressor(selections.harmony)
                    ? selections.chordTrack || ''
                    : '';
            },
            currentNegativePrompt() {
                return core.effectiveNegativePrompt(selections);
            },
            currentPrompt,
            getSelections: snapshot,
            randomizeAll,
            restore,
            restoreLegacyPrompt,
            setOnEnter(callback) { onEnter = callback; },
            setOnResend(callback) { onResend = callback; },
            updateGeneration
        });
    }

    root.PromptBuilder = Object.freeze({ createPromptBuilder });
})(typeof globalThis !== 'undefined' ? globalThis : this);
