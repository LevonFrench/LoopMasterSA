'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..', '..', 'loopmaster', 'loopmaster-app');
const HOST = '127.0.0.1';
const VIEWPORTS = [375, 768, 1280];
const TIMEOUT_MS = 45_000;
const CAPTURE_SKINS = process.argv.includes('--capture-skins');
const SKIN_PREVIEW_DIR = path.resolve(__dirname, '..', '..', 'output', 'skin-previews');

app.commandLine.appendSwitch('disable-gpu');

const MIME_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.woff2': 'font/woff2',
});

const evidence = {
    command: 'npm run qa:frontend',
    platform: `${process.platform}/${process.arch}`,
    appRoot: APP_ROOT,
    startedAt: new Date().toISOString(),
    tests: [],
    console: [],
    resourceFailures: [],
    requests: [],
    fatal: null,
    skinPreviews: [],
};

let server;
let windowUnderTest;
let qaSession;
let finishing = false;
let collectNetwork = true;
let watchdog;

function summarizeError(error) {
    return {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stack: error?.stack || null,
        details: error?.details,
    };
}

async function check(name, fn, options = {}) {
    const started = Date.now();
    try {
        const details = await fn();
        const status = options.skipWhen?.(details) ? 'skip' : 'pass';
        evidence.tests.push({ name, status, durationMs: Date.now() - started, details });
        process.stdout.write(`${status.toUpperCase()} ${name}\n`);
        return details;
    } catch (error) {
        const details = summarizeError(error);
        evidence.tests.push({ name, status: 'fail', durationMs: Date.now() - started, details });
        process.stderr.write(`FAIL ${name}: ${details.message}\n`);
        return null;
    }
}

function assert(condition, message, details) {
    if (!condition) {
        const error = new Error(message);
        if (details !== undefined) error.details = details;
        throw error;
    }
}

function contentType(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticServer() {
    server = http.createServer((request, response) => {
        let status = 200;
        try {
            const requestUrl = new URL(request.url, `http://${HOST}`);
            const pathname = decodeURIComponent(requestUrl.pathname);
            const relativePath = pathname === '/' ? 'static/index.html' : pathname.replace(/^\/+/, '');
            const filePath = path.resolve(APP_ROOT, relativePath);
            const contained = filePath === APP_ROOT || filePath.startsWith(`${APP_ROOT}${path.sep}`);

            if (!contained || !['GET', 'HEAD'].includes(request.method)) {
                status = contained ? 405 : 403;
                response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end(status === 405 ? 'Method not allowed' : 'Forbidden');
                return;
            }

            const stats = fs.statSync(filePath);
            if (!stats.isFile()) throw new Error('Not a file');
            response.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Length': stats.size,
                'Content-Type': contentType(filePath),
                'X-Content-Type-Options': 'nosniff',
            });
            if (request.method === 'HEAD') response.end();
            else fs.createReadStream(filePath).pipe(response);
        } catch (error) {
            status = 404;
            if (!response.headersSent) {
                response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            response.end('Not found');
        } finally {
            evidence.requests.push({ method: request.method, url: request.url, status });
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, () => resolve(server.address().port));
    });
}

function normalizeConsoleMessage(args) {
    const details = args[0] && typeof args[0] === 'object'
        ? args[0]
        : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] };
    const numericLevels = ['info', 'warning', 'error', 'debug'];
    return {
        level: typeof details.level === 'number' ? numericLevels[details.level] || String(details.level) : details.level,
        message: String(details.message || ''),
        lineNumber: details.lineNumber ?? null,
        sourceId: details.sourceId || null,
    };
}

async function waitForRendererReady() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await windowUnderTest.webContents.executeJavaScript(
            "Boolean(document.readyState === 'complete' && window._dev)",
            true,
        );
        if (ready) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Renderer did not expose window._dev within five seconds');
}

async function testSkinRuntime() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(async () => {
        const api = window.LoopMasterSkins;
        if (!api) return { exercised: false, reason: 'Skin API is missing' };
        await api.ready;
        const skins = api.list();
        const prompt = document.getElementById('prompt-freeform');
        if (!prompt) return { exercised: false, reason: 'Prompt input is missing' };
        const originalNode = prompt;
        const originalValue = prompt.value;
        const checks = [];
        for (const skin of skins) {
            prompt.focus();
            const selected = await api.apply(skin.id, { persist: true });
            const sheet = document.querySelector('link[data-lm-skin-sheet="' + skin.id + '"]');
            checks.push({
                id: skin.id,
                selected: selected.id === skin.id,
                root: document.documentElement.dataset.lmSkin === skin.id,
                sheet: Boolean(sheet && sheet.href.endsWith(skin.cssHref)),
                preservedNode: document.getElementById('prompt-freeform') === originalNode,
                preservedValue: prompt.value === originalValue,
                preservedFocus: document.activeElement === prompt,
                persisted: localStorage.getItem('loopmaster.ui.skin.v1') === skin.id,
            });
        }
        let invalidRejected = false;
        try {
            await api.apply('https://example.com/evil.css');
        } catch (_error) {
            invalidRejected = true;
        }
        const firstAlternate = skins.find(skin => skin.id !== 'original');
        if (firstAlternate) {
            await Promise.allSettled([
                api.apply(firstAlternate.id, { persist: false }),
                api.apply('original', { persist: false })
            ]);
        }
        const latestWins = api.current()?.id === 'original';
        await api.apply('original', { persist: true });
        return {
            exercised: true,
            skinCount: skins.length,
            checks,
            invalidRejected,
            latestWins,
            noInlineStyles: document.querySelectorAll('[style]').length === 0
        };
    })()`);
    assert(result.exercised, result.reason || 'Skin runtime test was not exercised');
    assert(result.skinCount >= 2, 'Expected at least Original and one alternate skin');
    for (const checkResult of result.checks) {
        for (const key of ['selected', 'root', 'sheet', 'preservedNode', 'preservedValue', 'preservedFocus', 'persisted']) {
            assert(checkResult[key], `Skin ${checkResult.id} failed ${key}`);
        }
    }
    assert(result.invalidRejected, 'Skin runtime accepted an unregistered external URL');
    assert(result.latestWins, 'Concurrent skin changes did not preserve the latest request');
    assert(result.noInlineStyles, 'Skin runtime created inline style attributes');
    return result;
}

async function captureSkinPreviews() {
    if (!CAPTURE_SKINS) return [];
    fs.mkdirSync(SKIN_PREVIEW_DIR, { recursive: true });
    const skins = await windowUnderTest.webContents.executeJavaScript(
        'window.LoopMasterSkins.list().map(skin => skin.id)'
    );
    const viewports = [
        { width: 1440, height: 900 },
        { width: 900, height: 900 },
        { width: 375, height: 812 },
    ];
    const captures = [];
    for (const skin of skins) {
        await windowUnderTest.webContents.executeJavaScript(
            `window.LoopMasterSkins.apply(${JSON.stringify(skin)}, { persist: false })`
        );
        for (const viewport of viewports) {
            windowUnderTest.setContentSize(viewport.width, viewport.height, false);
            await new Promise(resolve => setTimeout(resolve, 100));
            await windowUnderTest.webContents.executeJavaScript('window.scrollTo(0, 0)');
            const image = await windowUnderTest.webContents.capturePage();
            const filePath = path.join(SKIN_PREVIEW_DIR, `${skin}-${viewport.width}x${viewport.height}.png`);
            fs.writeFileSync(filePath, image.toPNG());
            captures.push(filePath);
        }
    }
    await windowUnderTest.webContents.executeJavaScript(
        "window.LoopMasterSkins.apply('original', { persist: false })"
    );
    evidence.skinPreviews = captures;
    return captures;
}

async function testResponsiveOverflow() {
    const layouts = [];
    const skinIds = await windowUnderTest.webContents.executeJavaScript(
        'window.LoopMasterSkins.list().map(skin => skin.id)'
    );
    const chromeDebugger = windowUnderTest.webContents.debugger;
    const attachedHere = !chromeDebugger.isAttached();
    if (attachedHere) chromeDebugger.attach('1.3');

    try {
    for (const skinId of skinIds) {
        await windowUnderTest.webContents.executeJavaScript(
            `window.LoopMasterSkins.apply(${JSON.stringify(skinId)}, { persist: false })`
        );
        for (const width of VIEWPORTS) {
        // DevTools viewport emulation is deterministic for hidden Windows.
        // Native BrowserWindow resize requests can be coalesced while hidden,
        // leaving media queries at a stale width and producing false results.
        await chromeDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
            screenWidth: width,
            screenHeight: 900,
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        const observedWidth = await windowUnderTest.webContents.executeJavaScript('window.innerWidth');
        assert(Math.abs(observedWidth - width) <= 1,
            `Expected approximately ${width}px viewport, got ${observedWidth}px`);
        const layout = await windowUnderTest.webContents.executeJavaScript(`(() => {
            const root = document.documentElement;
            const body = document.body;
            const viewportWidth = window.innerWidth;
            const tracks = document.querySelector('[data-lm-region="tracks"]');
            const tracksRect = tracks?.getBoundingClientRect();
            const maxScrollY = Math.max(0, root.scrollHeight - window.innerHeight);
            const visiblePromptSelects = Array.from(document.querySelectorAll('.prompt-section-select'))
                .filter(el => {
                    const style = getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
                })
                .map(el => ({
                    width: el.getBoundingClientRect().width,
                    id: el.id || null,
                    section: el.closest('[data-lm-section]')?.dataset.lmSection || null,
                    part: el.closest('[data-lm-part]')?.dataset.lmPart || null,
                    sectionWidth: el.closest('.prompt-builder-section')?.getBoundingClientRect().width || null,
                    gridWidth: el.closest('.prompt-builder-grid')?.getBoundingClientRect().width || null,
                    gridColumns: el.closest('.prompt-builder-grid')
                        ? getComputedStyle(el.closest('.prompt-builder-grid')).gridTemplateColumns
                        : null,
                }));
            const visiblePromptWidths = visiblePromptSelects.map(item => item.width);
            const offenders = Array.from(document.querySelectorAll('body *'))
                .filter(el => {
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
                })
                .slice(0, 20)
                .map(el => {
                    const rect = el.getBoundingClientRect();
                    return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || null,
                        classes: Array.from(el.classList).slice(0, 4),
                        left: Math.round(rect.left * 10) / 10,
                        right: Math.round(rect.right * 10) / 10,
                    };
                });
            return {
                skinId: ${JSON.stringify(skinId)},
                requestedWidth: ${width},
                viewportWidth,
                documentScrollWidth: root.scrollWidth,
                bodyScrollWidth: body.scrollWidth,
                horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) - viewportWidth,
                tracksReachable: !tracksRect || tracksRect.top <= window.innerHeight + maxScrollY + 1,
                minimumPromptSelectWidth: visiblePromptWidths.length ? Math.min(...visiblePromptWidths) : null,
                minimumPromptSelect: visiblePromptSelects.length
                    ? visiblePromptSelects.reduce((smallest, item) => item.width < smallest.width ? item : smallest)
                    : null,
                offenders,
            };
        })()`);
        layouts.push(layout);
        assert(layout.horizontalOverflow <= 1,
            `${skinId} at ${width}px has ${layout.horizontalOverflow}px global horizontal overflow; `
            + `offenders=${JSON.stringify(layout.offenders)}`);
        assert(layout.tracksReachable, `${skinId} at ${width}px makes generated tracks unreachable`);
        const selectFloor = width <= 375 ? 160 : 110;
        if (layout.minimumPromptSelectWidth !== null) {
            assert(layout.minimumPromptSelectWidth >= selectFloor,
                `${skinId} at ${width}px collapses a prompt select to ${layout.minimumPromptSelectWidth}px; `
                + `select=${JSON.stringify(layout.minimumPromptSelect)}`);
        }
        }
    }
    } finally {
        await chromeDebugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
        if (attachedHere && chromeDebugger.isAttached()) chromeDebugger.detach();
        await windowUnderTest.webContents.executeJavaScript(
            "window.LoopMasterSkins.apply('original', { persist: false })"
        );
    }
    return layouts;
}

async function testAccessibleNames() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const visible = el => {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
        };
        const textForIds = value => (value || '').split(/\\s+/)
            .map(id => document.getElementById(id)?.textContent?.trim() || '')
            .filter(Boolean).join(' ');
        const accessibleName = el => {
            const labelledBy = textForIds(el.getAttribute('aria-labelledby'));
            const explicitLabel = el.id
                ? Array.from(document.querySelectorAll('label[for]')).find(label => label.htmlFor === el.id)?.textContent?.trim()
                : '';
            return labelledBy
                || el.getAttribute('aria-label')?.trim()
                || explicitLabel
                || el.closest('label')?.textContent?.trim()
                || el.getAttribute('alt')?.trim()
                || el.getAttribute('title')?.trim()
                || el.getAttribute('placeholder')?.trim()
                || el.textContent?.trim()
                || '';
        };
        const controls = Array.from(document.querySelectorAll(
            'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="slider"]'
        )).filter(visible);
        const unnamed = controls.filter(el => !accessibleName(el)).map(el => ({
            tag: el.tagName.toLowerCase(), id: el.id || null, classes: Array.from(el.classList)
        }));
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map(el => ({
            id: el.id || null, name: accessibleName(el), modal: el.getAttribute('aria-modal')
        }));
        return { checkedControls: controls.length, unnamed, dialogs };
    })()`);
    assert(result.checkedControls > 0, 'No visible controls were available for the accessible-name audit');
    assert(result.unnamed.length === 0, `${result.unnamed.length} visible controls have no accessible name`);
    assert(result.dialogs.length > 0, 'Expected at least one ARIA dialog');
    assert(result.dialogs.every(dialog => dialog.name && dialog.modal === 'true'), 'Dialog name or aria-modal contract is incomplete');
    return result;
}

async function testAriaPressed() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const toggles = Array.from(document.querySelectorAll('[aria-pressed]'));
        const invalid = toggles.filter(el => !['true', 'false'].includes(el.getAttribute('aria-pressed')))
            .map(el => el.id || el.className || el.tagName);
        const target = document.querySelector('.lfo1-toggle');
        if (!target) return { count: toggles.length, invalid, exercised: false, reason: 'Missing .lfo1-toggle' };
        const before = target.getAttribute('aria-pressed');
        target.click();
        const after = target.getAttribute('aria-pressed');
        target.click();
        const restored = target.getAttribute('aria-pressed');
        return { count: toggles.length, invalid, exercised: true, before, after, restored };
    })()`);
    assert(result.count > 0, 'No aria-pressed controls were initialized');
    assert(result.invalid.length === 0, 'Some aria-pressed values are not boolean strings');
    assert(result.exercised, result.reason || 'No toggle could be exercised');
    assert(result.before !== result.after, 'aria-pressed did not change after activating an LFO toggle');
    assert(result.restored === result.before, 'aria-pressed did not restore after the second activation');
    return result;
}

async function testModalFocus() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const trigger = document.getElementById('btn-render-mix');
        const modal = document.getElementById('export-modal');
        const first = document.getElementById('export-filename-input');
        const last = document.getElementById('btn-export-cancel');
        if (!trigger || !modal || !first || !last || !window._dev?.openExportModalForQa) {
            return { exercised: false, reason: 'Export modal controls or QA seam are missing' };
        }
        const wasDisabled = trigger.disabled;
        trigger.disabled = false;
        trigger.focus();
        window._dev.openExportModalForQa();
        const opened = modal.classList.contains('is-visible');
        const initialFocus = document.activeElement === first;

        last.focus();
        last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        const forwardWrapped = document.activeElement === first;
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        const backwardWrapped = document.activeElement === last;

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const closed = !modal.classList.contains('is-visible');
        const focusReturned = document.activeElement === trigger;
        trigger.disabled = wasDisabled;
        return { exercised: true, opened, initialFocus, forwardWrapped, backwardWrapped, closed, focusReturned };
    })()`);
    assert(result.exercised, result.reason || 'Modal test was not exercised');
    for (const key of ['opened', 'initialFocus', 'forwardWrapped', 'backwardWrapped', 'closed', 'focusReturned']) {
        assert(result[key], `Modal contract failed: ${key}`);
    }
    return result;
}

async function testSkinPickerFocus() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const trigger = document.getElementById('btn-skins');
        const modal = document.getElementById('skin-picker-modal');
        const done = document.getElementById('btn-skin-picker-done');
        if (!trigger || !modal || !done) {
            return { exercised: false, reason: 'Skin picker controls are missing' };
        }
        trigger.focus();
        trigger.click();
        const first = modal.querySelector('.skin-option');
        if (!first) return { exercised: false, reason: 'Skin catalog did not render' };
        const opened = !modal.hidden && modal.classList.contains('is-visible');
        const initialFocus = document.activeElement === first;

        done.focus();
        done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        const forwardWrapped = document.activeElement === first;
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        const backwardWrapped = document.activeElement === done;

        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const closed = modal.hidden && !modal.classList.contains('is-visible');
        const focusReturned = document.activeElement === trigger;
        return { exercised: true, opened, initialFocus, forwardWrapped, backwardWrapped, closed, focusReturned };
    })()`);
    assert(result.exercised, result.reason || 'Skin picker focus test was not exercised');
    for (const key of ['opened', 'initialFocus', 'forwardWrapped', 'backwardWrapped', 'closed', 'focusReturned']) {
        assert(result[key], `Skin picker contract failed: ${key}`);
    }
    return result;
}

async function testFileNamingModalFocus() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(async () => {
        const trigger = document.getElementById('btn-file-naming');
        const modal = document.getElementById('file-naming-modal');
        const first = document.getElementById('pack-name-input');
        const last = document.getElementById('btn-file-naming-cancel');
        if (!trigger || !modal || !first || !last) {
            return { exercised: false, reason: 'File Naming modal controls are missing' };
        }
        trigger.focus();
        trigger.click();
        const opened = modal.classList.contains('is-visible') && modal.getAttribute('aria-hidden') === 'false';
        const initialFocus = document.activeElement === first;
        last.focus();
        last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        const forwardWrapped = document.activeElement === first;
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        const backwardWrapped = document.activeElement === last;
        const originalValue = first.value;
        first.value = 'cancelled-popup-edit';
        first.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 300));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const closed = !modal.classList.contains('is-visible') && modal.getAttribute('aria-hidden') === 'true';
        const focusReturned = document.activeElement === trigger;
        const stored = JSON.parse(localStorage.getItem('loopmaster_asset_metadata_v1') || '{}');
        const cancelRestored = first.value === originalValue && stored.pack_name === originalValue;
        return { exercised: true, opened, initialFocus, forwardWrapped, backwardWrapped, closed, focusReturned, cancelRestored };
    })()`);
    assert(result.exercised, result.reason || 'File Naming modal test was not exercised');
    for (const key of ['opened', 'initialFocus', 'forwardWrapped', 'backwardWrapped', 'closed', 'focusReturned', 'cancelRestored']) {
        assert(result[key], `File Naming modal contract failed: ${key}`);
    }
    return result;
}

async function testTypedAttributesAndInlineStyles() {
    const result = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const fixture = document.createElement('div');
        fixture.dataset.position = 'absolute';
        fixture.dataset.left = '37px';
        fixture.dataset.top = '19px';
        fixture.dataset.width = '123px';
        fixture.dataset.rotation = '33deg';
        fixture.setAttribute('aria-hidden', 'true');
        const progress = document.createElement('div');
        progress.className = 'card-progress-fill';
        progress.dataset.progress = '0.41';
        fixture.appendChild(progress);
        document.body.appendChild(fixture);
        const computed = getComputedStyle(fixture);
        const progressComputed = getComputedStyle(progress);
        const result = {
            left: computed.left,
            top: computed.top,
            width: computed.width,
            transform: computed.transform,
            progressWidth: progressComputed.width,
            inlineStyleCount: document.querySelectorAll('[style]').length,
            supportsTypedAttr: CSS.supports('width', 'attr(data-width type(<length-percentage>), auto)'),
        };
        fixture.remove();
        return result;
    })()`);
    assert(result.supportsTypedAttr, 'Bundled Chromium does not report support for typed attr()');
    assert(result.left === '37px' && result.top === '19px', `Typed position attrs did not compute: ${result.left}/${result.top}`);
    assert(result.width === '123px', `Typed width attr did not compute: ${result.width}`);
    assert(result.transform && result.transform !== 'none', 'Typed rotation/transform attr did not compute');
    const progressPixels = Number.parseFloat(result.progressWidth);
    assert(Number.isFinite(progressPixels) && Math.abs(progressPixels - 50.43) < 1,
        `Typed progress attr did not compute to 41% of 123px: ${result.progressWidth}`);
    assert(result.inlineStyleCount === 0, `Page contains ${result.inlineStyleCount} inline style attributes`);
    return result;
}

async function testPromptOptionMuting() {
    const details = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const storageKey = 'loopmaster_prompt_builder_v1';
        const select = document.getElementById('prompt-select-genre');
        const section = select?.closest('.prompt-builder-section');
        const mute = section?.querySelector('.chip-mute');
        const curated = Array.from(select?.options || []).filter(option => !option.value.startsWith('__'));
        if (!select || !mute || curated.length < 2) {
            throw new Error('Prompt mute controls or curated options are unavailable');
        }

        const originalSelection = select.value;
        const lockedValue = curated[0].value;
        try {
            select.value = lockedValue;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            const valueBeforeMute = select.value;
            mute.click();

            const afterMute = JSON.parse(localStorage.getItem(storageKey));
            const muteState = {
                persisted: afterMute.mutedSections.includes('genre'),
                valueUnchanged: select.value === valueBeforeMute,
                diceDisabled: section.querySelector('.chip-dice')?.disabled === true,
            };

            const pressedBeforeUnmute = mute.getAttribute('aria-pressed');
            mute.click();
            const afterUnmute = JSON.parse(localStorage.getItem(storageKey));

            return {
                lockedValue,
                muteState,
                pressedBeforeUnmute,
                unmuted: !afterUnmute.mutedSections.includes('genre'),
                pressedAfterUnmute: mute.getAttribute('aria-pressed'),
            };
        } finally {
            select.value = originalSelection;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    })()`);

    assert(details.muteState.persisted, 'Muted prompt section was not persisted', details);
    assert(details.muteState.valueUnchanged, 'Muting changed the current prompt value', details);
    assert(details.muteState.diceDisabled, 'Muted section dice stayed enabled', details);
    assert(details.pressedBeforeUnmute === 'true', 'Mute button did not expose its pressed state', details);
    assert(details.unmuted, 'Prompt choice could not be unmuted', details);
    assert(details.pressedAfterUnmute === 'false', 'Mute button stayed pressed after unmuting', details);
    return details;
}

async function testPromptRandomizerSeparationAndFreeform() {
    const details = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const freeform = document.getElementById('prompt-freeform');
        const preview = document.getElementById('prompt-preview');
        const acoustic = document.getElementById('prompt-select-acoustic');
        const electric = document.getElementById('prompt-select-electric');
        const drums = document.getElementById('prompt-select-drums');
        const harmony = document.getElementById('prompt-select-harmony');
        const randomizeAll = document.getElementById('btn-randomize-all');
        const acousticSection = acoustic?.closest('.prompt-builder-section');
        const acousticDice = acousticSection?.querySelector('.chip-dice');
        const acousticMute = acousticSection?.querySelector('.chip-mute');
        const harmonyMute = harmony?.closest('.prompt-builder-section')?.querySelector('.chip-mute');
        if (!freeform || !preview || !acoustic || !electric || !drums || !harmony ||
                !randomizeAll || !acousticDice || !acousticMute || !harmonyMute) {
            throw new Error('Expanded prompt controls did not initialize');
        }

        const curatedAcoustic = Array.from(acoustic.options)
            .map(option => option.value)
            .filter(value => value && !value.startsWith('__'));
        const curatedElectric = Array.from(electric.options)
            .map(option => option.value)
            .filter(value => value && !value.startsWith('__'));
        const curatedDrums = Array.from(drums.options)
            .map(option => option.value)
            .filter(value => value && !value.startsWith('__'));
        const drumTerms = /(drum|percussion|808|909)/i;
        const typedPrompt = 'my freely typed glassy midnight melody';

        harmony.value = 'a minor';
        harmony.dispatchEvent(new Event('change', { bubbles: true }));
        harmonyMute.click();
        freeform.value = typedPrompt;
        freeform.dispatchEvent(new Event('input', { bubbles: true }));

        const forbiddenRolls = [];
        for (let index = 0; index < 30; index += 1) {
            acousticDice.click();
            if (drumTerms.test(acoustic.value)) forbiddenRolls.push(acoustic.value);
        }
        const harmonyAfterInstrumentRolls = harmony.value;
        acousticMute.click();
        randomizeAll.click();
        const stored = JSON.parse(localStorage.getItem('loopmaster_prompt_builder_v1'));
        const activeSources = document.querySelectorAll('[data-column="sources"] .is-group-active').length;
        const activeCharacters = document.querySelectorAll('[data-column="character"] .is-group-active').length;
        acousticMute.click();
        harmonyMute.click();

        return {
            curatedAcousticCount: curatedAcoustic.length,
            curatedElectricCount: curatedElectric.length,
            curatedDrumCount: curatedDrums.length,
            acousticPoolHasDrums: curatedAcoustic.some(value => drumTerms.test(value)),
            electricPoolHasDrums: curatedElectric.some(value => drumTerms.test(value)),
            forbiddenRolls,
            harmonyAfterInstrumentRolls,
            harmonyAfterRandomizeAll: harmony.value,
            selectedSourceAfterRandomizeAll: stored.selections.sourceChoice,
            activeSources,
            activeCharacters,
            freeformAfterRandomizeAll: freeform.value,
            previewAfterRandomizeAll: preview.textContent,
            typedPrompt,
        };
    })()`);

    assert(details.curatedAcousticCount >= 150, 'Acoustic pool was not expanded', details);
    assert(details.curatedElectricCount >= 140, 'Electric pool was not expanded', details);
    assert(details.curatedDrumCount >= 180, 'Dedicated drums pool was not expanded', details);
    assert(!details.acousticPoolHasDrums, 'Acoustic pool still contains drums', details);
    assert(!details.electricPoolHasDrums, 'Electric pool still contains drums', details);
    assert(details.forbiddenRolls.length === 0, 'Acoustic dice selected drums', details);
    assert(details.harmonyAfterInstrumentRolls === 'a minor', 'Instrument dice changed the chord', details);
    assert(details.harmonyAfterRandomizeAll === 'a minor', 'Randomize All changed the muted chord', details);
    assert(['electric', 'drums'].includes(details.selectedSourceAfterRandomizeAll),
        'Randomize All selected the muted acoustic row', details);
    assert(details.activeSources === 1, 'Randomize All did not activate exactly one instrument row', details);
    assert(details.activeCharacters === 1, 'Randomize All did not activate exactly one character row', details);
    assert(details.freeformAfterRandomizeAll === details.typedPrompt, 'Randomization erased free text', details);
    assert(details.previewAfterRandomizeAll.includes(details.typedPrompt), 'Final prompt omitted free text', details);
    return details;
}

async function testChordProgressor() {
    const details = await windowUnderTest.webContents.executeJavaScript(`(() => {
        const harmony = document.getElementById('prompt-select-harmony');
        const harmonyMute = harmony?.closest('.prompt-builder-section')?.querySelector('.chip-mute');
        const key = document.getElementById('progression-key-select');
        const preset = document.getElementById('progression-preset-select');
        const cards = document.getElementById('progression-chord-cards');
        const progressorMute = document.getElementById('btn-progression-mute');
        const randomizeAll = document.getElementById('btn-randomize-all');
        const preview = document.getElementById('prompt-preview');
        if (!harmony || !harmonyMute || !key || !preset || !cards ||
                !progressorMute || !randomizeAll || !preview) {
            throw new Error('Chord progressor controls did not initialize');
        }
        const sentinel = Array.from(harmony.options).find(option => option.value === 'Use Chord Progressor');
        if (!sentinel) throw new Error('Key / Chord is missing Use Chord Progressor');

        harmony.value = sentinel.value;
        harmony.dispatchEvent(new Event('change', { bubbles: true }));
        key.value = 'C major';
        key.dispatchEvent(new Event('change', { bubbles: true }));
        preset.value = 'major_hopeful_01';
        preset.dispatchEvent(new Event('change', { bubbles: true }));
        const before = JSON.parse(localStorage.getItem('loopmaster_prompt_builder_v1'));
        const symbols = Array.from(cards.querySelectorAll('.chord-card-symbol')).map(node => node.textContent);

        harmonyMute.click();
        progressorMute.click();
        randomizeAll.click();
        const after = JSON.parse(localStorage.getItem('loopmaster_prompt_builder_v1'));
        progressorMute.click();
        harmonyMute.click();

        return {
            symbols,
            preview: preview.textContent,
            progressionBefore: before.selections.progressionId,
            progressionAfter: after.selections.progressionId,
            harmonyAfter: after.selections.harmony,
            keyAfter: after.selections.progressionKey,
            chordTrackCount: (after.selections.chordTrack || '').split(', ').filter(Boolean).length,
        };
    })()`);

    assert(JSON.stringify(details.symbols) === JSON.stringify(['C', 'G', 'Am', 'F']),
        'Hopeful C-major cards are incorrect', details);
    assert(details.preview.includes('I-V-vi-IV'), 'Assembled prompt omitted the progression formula', details);
    assert(details.progressionBefore === 'major_hopeful_01', 'Progression selection did not persist', details);
    assert(details.progressionAfter === details.progressionBefore, 'Locked progression changed during Randomize All', details);
    assert(details.harmonyAfter === 'Use Chord Progressor', 'Locked harmony changed during Randomize All', details);
    assert(details.keyAfter === 'C major', 'Progression key changed unexpectedly', details);
    assert(details.chordTrackCount === 4, 'Progressor did not materialize four chord events', details);
    return details;
}

async function testQueuedCancellation() {
    return windowUnderTest.webContents.executeJavaScript(`(async () => {
        const dev = window._dev;
        if (!dev?.pollGenerationJob || !dev?.requestGenerationCancellation || !dev?.getGenerationCancellationState) {
            return { skipped: true, reason: 'Queued-cancellation dev seams are not exposed' };
        }
        const originalFetch = window.fetch;
        const originalSetTimeout = window.setTimeout;
        const calls = [];
        try {
            window.fetch = async (url, options = {}) => {
                const target = typeof url === 'string' ? url : url.url;
                calls.push({ url: target, method: options.method || 'GET' });
                if (target.endsWith('/api/generate')) {
                    return new Response(JSON.stringify({ job_id: 'qa-queued-job' }), {
                        status: 200, headers: { 'Content-Type': 'application/json' }
                    });
                }
                if (target.endsWith('/api/cancel/qa-queued-job')) {
                    return new Response(JSON.stringify({ status: 'cancelled' }), {
                        status: 200, headers: { 'Content-Type': 'application/json' }
                    });
                }
                if (target.endsWith('/api/status/qa-queued-job')) {
                    return new Response(JSON.stringify({ status: 'queued', queue_position: 1 }), {
                        status: 200, headers: { 'Content-Type': 'application/json' }
                    });
                }
                throw new Error('Unexpected QA fetch: ' + target);
            };

            const modifiers = document.getElementById('prompt-select-modifiers');
            const generate = document.getElementById('btn-generate');
            // Keep runGeneration's polling promise parked. The harness exercises
            // the queued -> cancelled UI state without letting a later status
            // request escape after the fetch stub is restored.
            window.setTimeout = () => 0;
            if (!modifiers) throw new Error('Structured prompt builder did not initialize');
            modifiers.value = 'punchy transients';
            modifiers.dispatchEvent(new Event('change', { bubbles: true }));
            generate.click();
            for (let i = 0; i < 50 && dev.getGenerationCancellationState()?.id !== 'qa-queued-job'; i += 1) {
                await new Promise(resolve => originalSetTimeout(resolve, 10));
            }
            const queued = dev.getGenerationCancellationState();
            await dev.requestGenerationCancellation();
            const cancelled = dev.getGenerationCancellationState();
            window.setTimeout = originalSetTimeout;
            return { skipped: false, queued, cancelled, calls };
        } finally {
            window.fetch = originalFetch;
            window.setTimeout = originalSetTimeout;
        }
    })()`);
}

async function testWebAudioContract() {
    return windowUnderTest.webContents.executeJavaScript(`(async () => {
        const graph = window._dev?.trackEffectGraph;
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!graph) return { skipped: true, reason: 'window._dev.trackEffectGraph is not exposed' };
        if (!Offline) return { skipped: true, reason: 'OfflineAudioContext is unavailable in bundled Chromium' };
        // Match the production context's 48 kHz rate so the app's 20 kHz
        // low-pass defaults remain below Nyquist and do not create false
        // console errors in the contract test.
        const sampleRate = 48000;
        const frameCount = sampleRate / 2;
        const ctx = new Offline(2, frameCount, sampleRate);
        const buffer = ctx.createBuffer(2, sampleRate / 4, sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += 1) data[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const settings = {
            tunaChorusEnabled: true, tunaChorusMix: 0.25,
            tunaPhaserEnabled: true, tunaPhaserMix: 0.25,
            tunaBitcrusherEnabled: true, tunaBitcrusherMix: 0.2,
            aelapseDelayEnabled: true, aelapseDelayTime: 0.05, aelapseFeedback: 0.1, aelapseDelayMix: 0.1,
            aelapseReverbEnabled: true, aelapseReverbMix: 0.05, aelapseReverbSize: 0.1,
            tremoloEnabled: true, tremoloRate: 4, tremoloDepth: 0.2,
            gateEnabled: true, gateSyncIndex: 2, gateWidth: 0.5, gateMix: 0.2,
        };
        const insert = graph.buildInsertChain(ctx, source, settings);
        const modulation = graph.buildModulationChain(ctx, insert.output, settings, 120);
        const send = graph.buildSendChain(ctx, modulation.output, settings);
        send.output.connect(ctx.destination);
        source.start(0);
        const rendered = await ctx.startRendering();
        let peak = 0;
        let finite = true;
        let nonSilentFrames = 0;
        for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
            for (const sample of rendered.getChannelData(channel)) {
                if (!Number.isFinite(sample)) finite = false;
                const magnitude = Math.abs(sample);
                if (magnitude > peak) peak = magnitude;
                if (magnitude > 1e-6) nonSilentFrames += 1;
            }
        }
        if (!finite) throw new Error('Shared effect graph produced non-finite samples');
        if (nonSilentFrames < 100 || peak <= 1e-6) throw new Error('Shared effect graph produced a silent buffer');
        return {
            skipped: false,
            sampleRate: rendered.sampleRate,
            frames: rendered.length,
            channels: rendered.numberOfChannels,
            peak,
            nonSilentFrames,
            stages: ['insert', 'modulation', 'send'],
        };
    })()`);
}

async function run() {
    assert(fs.existsSync(path.join(APP_ROOT, 'static', 'index.html')), `Frontend root not found: ${APP_ROOT}`);
    const port = await createStaticServer();
    await app.whenReady();

    qaSession = session.fromPartition(`qa-frontend-${Date.now()}`, { cache: false });
    qaSession.webRequest.onErrorOccurred(details => {
        if (!collectNetwork || details.error === 'net::ERR_ABORTED') return;
        evidence.resourceFailures.push({ url: details.url, error: details.error, resourceType: details.resourceType });
    });

    windowUnderTest = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        useContentSize: true,
        webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            session: qaSession,
        },
    });

    windowUnderTest.webContents.on('console-message', (_event, ...args) => {
        evidence.console.push(normalizeConsoleMessage(args));
    });
    windowUnderTest.webContents.on('render-process-gone', (_event, details) => {
        evidence.resourceFailures.push({ url: null, error: `Renderer exited: ${details.reason}`, resourceType: 'renderer' });
    });

    const target = `http://${HOST}:${port}/static/index.html`;
    await windowUnderTest.loadURL(target);
    await waitForRendererReady();

    await check('skin runtime switches atomically and preserves UI state', testSkinRuntime);
    await check('responsive overflow at 375/768/1280', testResponsiveOverflow);
    windowUnderTest.setContentSize(1280, 900, false);
    await check('visible controls have accessible names', testAccessibleNames);
    await check('aria-pressed toggle state changes and restores', testAriaPressed);
    await check('modal focus trap, escape, and focus return', testModalFocus);
    await check('skin picker focus trap, escape, and focus return', testSkinPickerFocus);
    await check('file naming popup focus trap, escape, and focus return', testFileNamingModalFocus);
    await check('CSP-safe typed attributes and zero inline styles', testTypedAttributesAndInlineStyles);
    await check('free text, split instrument pools, one-per-column rolls, and locked harmony', testPromptRandomizerSeparationAndFreeform);
    await check('prompt sections lock without rerolling and persist across randomization', testPromptOptionMuting);
    await check('four-chord progressor resolves, persists, and locks', testChordProgressor);
    const cancelResult = await check('stubbed queued job transitions to cancelled', testQueuedCancellation, {
        skipWhen: details => details?.skipped,
    });
    if (cancelResult && !cancelResult.skipped) {
        const queued = cancelResult.queued;
        const cancelled = cancelResult.cancelled;
        const calledGenerate = cancelResult.calls?.some(call => call.url.endsWith('/api/generate'));
        const calledCancel = cancelResult.calls?.some(call => call.url.endsWith('/api/cancel/qa-queued-job'));
        if (queued?.id !== 'qa-queued-job' || queued?.state !== 'active'
            || cancelled?.state !== 'cancelled' || !calledGenerate || !calledCancel) {
            evidence.tests.push({
                name: 'queued cancellation contract assertions',
                status: 'fail',
                durationMs: 0,
                details: { queued, cancelled, calls: cancelResult.calls },
            });
        }
    }
    await check('shared Web Audio effect graph renders finite audio', testWebAudioContract, {
        skipWhen: details => details?.skipped,
    });
    await check('optional skin preview capture', captureSkinPreviews, {
        skipWhen: () => !CAPTURE_SKINS,
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    const consoleErrors = evidence.console.filter(entry => {
        const level = String(entry.level || '').toLowerCase();
        return level === 'error' || /content security policy|refused to (load|execute|apply)/i.test(entry.message);
    });
    evidence.tests.push({
        name: 'no console errors or CSP violations',
        status: consoleErrors.length === 0 ? 'pass' : 'fail',
        durationMs: 0,
        details: consoleErrors,
    });
    process.stdout.write(`${consoleErrors.length === 0 ? 'PASS' : 'FAIL'} no console errors or CSP violations\n`);
    evidence.tests.push({
        name: 'no resource load failures',
        status: evidence.resourceFailures.length === 0 ? 'pass' : 'fail',
        durationMs: 0,
        details: evidence.resourceFailures,
    });
    process.stdout.write(`${evidence.resourceFailures.length === 0 ? 'PASS' : 'FAIL'} no resource load failures\n`);
    const unsafeRequests = evidence.requests.filter(request =>
        request.method !== 'GET' && request.method !== 'HEAD'
        || /^\/api\/(generate|cancel|status)/.test(request.url)
    );
    evidence.tests.push({
        name: 'no backend or generation requests escaped the fetch stub',
        status: unsafeRequests.length === 0 ? 'pass' : 'fail',
        durationMs: 0,
        details: unsafeRequests,
    });
    process.stdout.write(`${unsafeRequests.length === 0 ? 'PASS' : 'FAIL'} no backend or generation requests escaped the fetch stub\n`);
}

async function cleanup() {
    collectNetwork = false;
    if (qaSession) {
        try { await qaSession.clearStorageData(); } catch (_) { /* best-effort isolated QA cleanup */ }
    }
    if (server) {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
        server = null;
    }
}

async function finish(exitCode) {
    if (finishing) return;
    finishing = true;
    clearTimeout(watchdog);
    evidence.finishedAt = new Date().toISOString();
    evidence.summary = {
        passed: evidence.tests.filter(test => test.status === 'pass').length,
        failed: evidence.tests.filter(test => test.status === 'fail').length,
        skipped: evidence.tests.filter(test => test.status === 'skip').length,
    };
    try {
        await cleanup();
    } catch (error) {
        evidence.fatal = evidence.fatal || summarizeError(error);
        evidence.summary.failed += 1;
        exitCode = 1;
    }
    // Keep the final hidden window alive until after the evidence is flushed:
    // destroying the last Windows window can terminate Electron immediately.
    const compactEvidence = {
        command: evidence.command,
        platform: evidence.platform,
        startedAt: evidence.startedAt,
        finishedAt: evidence.finishedAt,
        summary: evidence.summary,
        fatal: evidence.fatal,
        failures: evidence.tests.filter(test => test.status !== 'pass'),
        consoleErrors: evidence.console.filter(entry => String(entry.level).toLowerCase() === 'error'),
        resourceFailures: evidence.resourceFailures,
        escapedRequests: evidence.tests.find(test => test.name === 'no backend or generation requests escaped the fetch stub')?.details || [],
        skinPreviews: evidence.skinPreviews,
    };
    await new Promise((resolve, reject) => {
        process.stdout.write(`QA_EVIDENCE ${JSON.stringify(compactEvidence)}\n`, error => {
            if (error) reject(error);
            else resolve();
        });
    });
    if (windowUnderTest && !windowUnderTest.isDestroyed()) windowUnderTest.destroy();
    windowUnderTest = null;
    process.exitCode = exitCode;
    process.exit(exitCode);
}

watchdog = setTimeout(() => {
    evidence.fatal = { name: 'TimeoutError', message: `Frontend QA exceeded ${TIMEOUT_MS}ms`, stack: null };
    void finish(1);
}, TIMEOUT_MS);

run()
    .then(() => {
        const failed = evidence.tests.some(test => test.status === 'fail');
        return finish(failed ? 1 : 0);
    })
    .catch(error => {
        evidence.fatal = summarizeError(error);
        return finish(1);
    });

process.on('uncaughtException', error => {
    evidence.fatal = summarizeError(error);
    void finish(1);
});
process.on('unhandledRejection', error => {
    evidence.fatal = summarizeError(error);
    void finish(1);
});
