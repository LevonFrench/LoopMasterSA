'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '..', 'static');
const builderSource = fs.readFileSync(path.join(staticRoot, 'prompt_builder.js'), 'utf8');
const promptCore = require(path.join(staticRoot, 'prompt_core.js'));
const chordProgressionCore = require(path.join(staticRoot, 'chord_progression_core.js'));

const STORAGE_HISTORY = 'loopmaster_generation_history_v1';

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.listeners = new Map();
        this.classList = { add() {}, remove() {}, toggle() {} };
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.textContent = '';
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    dispatch(type, event) {
        (this.listeners.get(type) || []).forEach(handler => handler(event));
    }

    appendChild(node) {
        node.parentNode = this;
        this.children.push(node);
        return node;
    }

    append(...nodes) {
        nodes.forEach(node => {
            if (node instanceof FakeElement) this.appendChild(node);
        });
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    setAttribute() {}
    getAttribute() { return null; }
    focus() {}
    blur() {}

    matches(selector) {
        if (selector === 'button') return this.tagName === 'BUTTON';
        if (selector === '[data-entry-id]') return typeof this.dataset.entryId === 'string';
        if (selector === '[data-history-action]') return typeof this.dataset.historyAction === 'string';
        return false;
    }

    closest(selector) {
        let node = this;
        while (node) {
            if (node.matches(selector)) return node;
            node = node.parentNode;
        }
        return null;
    }
}

function findAll(node, predicate, found = []) {
    if (predicate(node)) found.push(node);
    node.children.forEach(child => findAll(child, predicate, found));
    return found;
}

function makeStorage(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
        getItem(key) { return store.has(key) ? store.get(key) : null; },
        setItem(key, value) { store.set(key, String(value)); },
        removeItem(key) { store.delete(key); }
    };
}

function makeKeyEvent(key, target) {
    return {
        key,
        target,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
    };
}

function createHarness({ storageSeed = {}, onResend } = {}) {
    const elements = new Map();
    const ids = [
        'prompt-builder-sections', 'prompt-freeform', 'prompt-builder-error',
        'btn-randomize-all', 'btn-generation-history', 'history-count',
        'generation-history-panel', 'generation-history-viewport',
        'generation-history-items', 'btn-clear-generation-history'
    ];
    ids.forEach(id => {
        const tag = id.startsWith('btn-') ? 'button' : (id === 'prompt-freeform' ? 'textarea' : 'div');
        elements.set(id, new FakeElement(tag));
    });
    const documentStub = {
        createElement: tag => new FakeElement(tag),
        getElementById: id => elements.get(id) || null
    };

    let releaseFetch;
    const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
    const fetchStub = async url => {
        await fetchGate;
        const relative = String(url).replace(/^\/static\//, '');
        const body = fs.readFileSync(path.join(staticRoot, relative), 'utf8');
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
    };

    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        document: documentStub,
        fetch: fetchStub,
        PromptCore: promptCore,
        ChordProgressionCore: chordProgressionCore
    });
    vm.runInContext(builderSource, context, { filename: 'prompt_builder.js' });

    const resendCalls = [];
    const builder = context.PromptBuilder.createPromptBuilder({
        storage: makeStorage(storageSeed),
        onResend: onResend || (entry => resendCalls.push(entry))
    });
    return {
        builder,
        resendCalls,
        releaseFetch,
        freeform: elements.get('prompt-freeform'),
        viewport: elements.get('generation-history-viewport'),
        items: elements.get('generation-history-items')
    };
}

function seedHistory(entries) {
    return { [STORAGE_HISTORY]: JSON.stringify(entries) };
}

const storedEntry = {
    id: 'gen-stored',
    timestamp: Date.now(),
    selections: { promptMode: 'manual', freePrompt: 'stored prompt' },
    prompt: 'stored prompt',
    status: 'draft',
    resultReference: null
};

test('history keydown ignores focused buttons and activates rows once', async () => {
    const harness = createHarness({ storageSeed: seedHistory([storedEntry]) });
    harness.releaseFetch();
    await harness.builder.ready;

    const row = findAll(harness.items, node => node.dataset.entryId === 'gen-stored')[0];
    assert.ok(row, 'history row is rendered');
    const resendButton = findAll(row, node => node.dataset.historyAction === 'resend')[0];
    assert.ok(resendButton, 'resend button is rendered');

    // Enter with focus on a button: native click activation owns it, so the
    // keydown handler must neither act nor preventDefault.
    const buttonEvent = makeKeyEvent('Enter', resendButton);
    harness.viewport.dispatch('keydown', buttonEvent);
    assert.equal(harness.resendCalls.length, 0);
    assert.equal(buttonEvent.defaultPrevented, false);

    // Enter on the row itself restores the entry exactly once and prevents
    // the default action (Space would otherwise scroll the viewport).
    const rowEvent = makeKeyEvent('Enter', row);
    harness.viewport.dispatch('keydown', rowEvent);
    assert.equal(rowEvent.defaultPrevented, true);
    assert.equal(harness.freeform.value, 'stored prompt');
    assert.equal(harness.resendCalls.length, 0);

    const spaceEvent = makeKeyEvent(' ', row);
    harness.viewport.dispatch('keydown', spaceEvent);
    assert.equal(spaceEvent.defaultPrevented, true);
});

test('typing before config loads never throws and is replayed after init', async () => {
    const harness = createHarness();

    harness.freeform.value = 'hello';
    harness.freeform.dispatch('input', {});
    harness.freeform.value = 'hello world';
    harness.freeform.dispatch('input', {});
    harness.freeform.dispatch('blur', {});
    assert.equal(harness.freeform.value, 'hello world', 'text stays in the textarea pre-init');

    harness.releaseFetch();
    await harness.builder.ready;

    assert.equal(harness.freeform.value, 'hello world');
    const selections = harness.builder.getSelections();
    assert.equal(selections.promptMode, 'manual');
    assert.equal(selections.freePrompt, 'hello world');
    assert.equal(harness.builder.currentPrompt(), 'hello world');
});

test('history clicks before config loads are queued and replayed after init', async () => {
    const harness = createHarness({ storageSeed: seedHistory([storedEntry]) });

    const row = findAll(harness.items, node => node.dataset.entryId === 'gen-stored')[0];
    assert.ok(row, 'history row is rendered before init');
    const resendButton = findAll(row, node => node.dataset.historyAction === 'resend')[0];

    harness.viewport.dispatch('click', makeKeyEvent('', resendButton));
    assert.equal(harness.resendCalls.length, 0, 'resend deferred until config loads');

    harness.releaseFetch();
    await harness.builder.ready;

    assert.equal(harness.resendCalls.length, 1);
    assert.equal(harness.resendCalls[0].id, 'gen-stored');
    assert.equal(harness.freeform.value, 'stored prompt');
});
