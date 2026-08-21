'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '..', 'static');
const core = require(path.join(staticRoot, 'skins', 'skin_core.js'));
const runtimeSource = fs.readFileSync(
    path.join(staticRoot, 'skins', 'skin_system.js'),
    'utf8'
);

const catalog = Object.freeze([
    Object.freeze({
        id: 'original',
        label: 'Original',
        shortLabel: 'Midnight Grid',
        description: 'The fallback skin.',
        version: '1.0.0',
        contractVersion: 1,
        cssHref: '/static/skins/original.v1.css',
        colorScheme: 'dark',
        preview: 'original'
    }),
    Object.freeze({
        id: 'cutline',
        label: 'CUTLINE',
        shortLabel: 'Sampler Bench',
        description: 'The alternate skin.',
        version: '1.0.0',
        contractVersion: 1,
        cssHref: '/static/skins/cutline.v1.css',
        colorScheme: 'light',
        preview: 'cutline'
    })
]);

function createRuntimeHarness() {
    const pendingLinks = [];
    const stored = new Map();
    const events = [];

    class FakeHTMLElement {
        constructor(tagName = 'div') {
            this.tagName = tagName.toUpperCase();
            this.dataset = {};
            this.isConnected = false;
            this.hidden = false;
            this.classList = { add() {}, remove() {}, toggle() {} };
        }

        addEventListener() {}
        append() {}
        remove() { this.isConnected = false; }
        setAttribute() {}
    }

    class FakeCustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
        }
    }

    const documentElement = {
        dataset: { lmSkin: 'original' },
        loading: true,
        removeAttribute(name) {
            if (name === 'data-lm-skin-loading') this.loading = false;
        }
    };
    const document = {
        documentElement,
        readyState: 'complete',
        head: {
            appendChild(link) {
                link.isConnected = true;
                pendingLinks.push(link);
            }
        },
        createElement(tagName) { return new FakeHTMLElement(tagName); },
        getElementById() { return null; },
        dispatchEvent(event) { events.push(event); },
        addEventListener() {}
    };
    const window = {
        LoopMasterSkinCore: core,
        LoopMasterSkinCatalog: catalog,
        location: { href: 'http://127.0.0.1:7861/' },
        localStorage: {
            getItem(key) { return stored.get(key) ?? null; },
            setItem(key, value) { stored.set(key, value); },
            removeItem(key) { stored.delete(key); }
        },
        setTimeout,
        clearTimeout,
        addEventListener() {}
    };

    vm.runInNewContext(runtimeSource, {
        window,
        document,
        CustomEvent: FakeCustomEvent,
        HTMLElement: FakeHTMLElement,
        URL,
        console,
        setTimeout,
        clearTimeout
    }, { filename: 'skin_system.js' });

    return { documentElement, events, pendingLinks, stored, skins: window.LoopMasterSkins };
}

async function finishInitialLoad(harness) {
    const initialLink = harness.pendingLinks.shift();
    assert.equal(initialLink.dataset.lmSkinSheet, 'original');
    initialLink.onload();
    await harness.skins.ready;
    return initialLink;
}

test('re-applying the active skin invalidates an older pending load', async () => {
    const harness = createRuntimeHarness();
    const originalLink = await finishInitialLoad(harness);

    const pendingCutline = harness.skins.apply('cutline');
    const cutlineLink = harness.pendingLinks.shift();
    assert.equal(cutlineLink.dataset.lmSkinSheet, 'cutline');

    const latest = await harness.skins.apply('original');
    assert.equal(latest.id, 'original');
    cutlineLink.onload();
    const staleResult = await pendingCutline;

    assert.equal(staleResult.id, 'original');
    assert.equal(harness.skins.current().id, 'original');
    assert.equal(harness.stored.get('loopmaster.ui.skin.v1'), 'original');
    assert.equal(originalLink.isConnected, true);
    assert.equal(cutlineLink.isConnected, false);

    const lateFailure = harness.skins.apply('cutline');
    const failedLink = harness.pendingLinks.shift();
    await harness.skins.apply('original');
    failedLink.onerror();

    assert.equal((await lateFailure).id, 'original');
    assert.equal(
        harness.events.filter(event => event.type === 'loopmaster:skinerror').length,
        0
    );
});

test('a stylesheet load failure preserves the active and persisted skin', async () => {
    const harness = createRuntimeHarness();
    await finishInitialLoad(harness);
    await harness.skins.apply('original');

    const failedSwitch = harness.skins.apply('cutline');
    const cutlineLink = harness.pendingLinks.shift();
    cutlineLink.onerror();
    await assert.rejects(failedSwitch, /could not be loaded/);

    assert.equal(harness.skins.current().id, 'original');
    assert.equal(harness.stored.get('loopmaster.ui.skin.v1'), 'original');
    assert.equal(cutlineLink.isConnected, false);
});

test('the bootstrap loading veil has a CSS-only fail-open', () => {
    const html = fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(staticRoot, 'skin-core.css'), 'utf8');

    assert.match(html, /<html[^>]+data-lm-skin-loading/);
    assert.match(css, /animation:\s*lm-skin-bootstrap-fail-open\s+0s\s+3s\s+forwards/);
    assert.match(css, /@keyframes\s+lm-skin-bootstrap-fail-open[\s\S]*visibility:\s*visible/);
});

test('CUTLINE styles the arranger state class emitted by the application', () => {
    const css = fs.readFileSync(path.join(staticRoot, 'skins', 'cutline.v1.css'), 'utf8');

    assert.match(css, /\.arranger-cell\.active\s*\{/);
    assert.doesNotMatch(css, /\.arranger-cell\.is-active\s*\{/);
});
