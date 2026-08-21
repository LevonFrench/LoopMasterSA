'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '..', 'static');
const core = require(path.join(staticRoot, 'skins', 'skin_core.js'));

function loadCatalog() {
    const source = fs.readFileSync(path.join(staticRoot, 'skins', 'skin_catalog.js'), 'utf8');
    const context = { window: {} };
    vm.runInNewContext(source, context, { filename: 'skin_catalog.js' });
    return Array.from(context.window.LoopMasterSkinCatalog, entry => ({ ...entry }));
}

test('skin catalog validates as a same-origin CSS-only contract', () => {
    const catalog = core.validateCatalog(loadCatalog(), {
        baseHref: 'http://127.0.0.1:7861/',
        contractVersion: 1
    });
    assert.equal(catalog.length, 4);
    assert.equal(catalog[0].id, 'original');
    assert.ok(Object.isFrozen(catalog));
    assert.ok(catalog.every(Object.isFrozen));
});

test('catalog validation rejects duplicate, malformed, remote, and incompatible skins', () => {
    const original = loadCatalog()[0];
    const validate = entries => core.validateCatalog(entries, {
        baseHref: 'http://127.0.0.1:7861/',
        contractVersion: 1
    });
    assert.throws(() => validate([original, { ...original }]), /Duplicate/);
    assert.throws(() => validate([{ ...original, id: '../escape' }]), /Invalid skin id/);
    assert.throws(() => validate([{ ...original, cssHref: 'https://example.com/skin.css' }]), /Unsafe/);
    assert.throws(() => validate([{ ...original, contractVersion: 2 }]), /Unsupported/);
    assert.throws(() => validate([{ ...original, id: 'not-original' }]), /Original fallback/);
});

test('initial selection prefers a registered query, then storage, then Original', () => {
    const catalog = core.validateCatalog(loadCatalog(), {
        baseHref: 'http://127.0.0.1:7861/'
    });
    assert.deepEqual(core.chooseInitialSkin(catalog, 'cutline', 'original'), {
        id: 'cutline', source: 'query'
    });
    assert.deepEqual(core.chooseInitialSkin(catalog, 'missing', 'cutline'), {
        id: 'cutline', source: 'storage'
    });
    assert.deepEqual(core.chooseInitialSkin(catalog, 'missing', 'tampered'), {
        id: 'original', source: 'fallback'
    });
});

test('every catalog stylesheet exists and declares its root skin scope', () => {
    for (const entry of loadCatalog()) {
        const filePath = path.join(staticRoot, entry.cssHref.replace(/^\/static\//, ''));
        assert.ok(fs.existsSync(filePath), `${entry.id} stylesheet is missing`);
        const css = fs.readFileSync(filePath, 'utf8');
        assert.match(css, new RegExp(`data-lm-skin=["']${entry.id}["']`));
        assert.doesNotMatch(css, /(^|\})\s*body\s*\{/m, `${entry.id} contains an unscoped body rule`);
        assert.doesNotMatch(css, /@import|expression\s*\(|javascript\s*:|url\s*\(/i,
            `${entry.id} contains an external or executable CSS dependency`);
        assert.doesNotMatch(css, /\.arranger-cell\.is-active\b/,
            `${entry.id} targets a state class the arranger never emits`);
    }
});
