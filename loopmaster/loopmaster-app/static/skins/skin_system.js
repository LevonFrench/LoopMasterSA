(function createLoopMasterSkinSystem(root, document) {
    'use strict';

    const CONTRACT_VERSION = 1;
    const STORAGE_KEY = 'loopmaster.ui.skin.v1';
    const LINK_ID = 'lm-active-skin-stylesheet';
    const LOAD_TIMEOUT_MS = 2500;
    const rawCatalog = Array.isArray(root.LoopMasterSkinCatalog)
        ? root.LoopMasterSkinCatalog
        : [];

    let catalog;
    try {
        catalog = root.LoopMasterSkinCore.validateCatalog(rawCatalog, {
            baseHref: root.location.href,
            contractVersion: CONTRACT_VERSION
        });
    } catch (error) {
        console.error('LoopMaster skin catalog rejected:', error);
        catalog = Object.freeze([]);
    }
    const byId = new Map(catalog.map(entry => [entry.id, entry]));
    const fallback = byId.get('original') || catalog[0] || null;
    let active = fallback;
    let activeLink = null;
    let requestSequence = 0;

    function safeStorageGet() {
        try {
            return root.localStorage.getItem(STORAGE_KEY);
        } catch (_error) {
            return null;
        }
    }

    function safeStorageSet(value) {
        try {
            root.localStorage.setItem(STORAGE_KEY, value);
        } catch (_error) {
            // A disabled or full storage area must never block skin switching.
        }
    }

    function safeStorageRemove() {
        try {
            root.localStorage.removeItem(STORAGE_KEY);
        } catch (_error) {
            // Ignore unavailable storage.
        }
    }

    function emit(name, detail) {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function loadStylesheet(entry, sequence) {
        return new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = entry.cssHref;
            link.dataset.lmSkinSheet = entry.id;

            let finished = false;
            const finish = (error) => {
                if (finished) return;
                finished = true;
                root.clearTimeout(timer);
                link.onload = null;
                link.onerror = null;
                if (error) {
                    link.remove();
                    reject(error);
                } else {
                    resolve({ link, sequence });
                }
            };
            const timer = root.setTimeout(
                () => finish(new Error(`Skin ${entry.id} did not load in time.`)),
                LOAD_TIMEOUT_MS
            );
            link.onload = () => finish(null);
            link.onerror = () => finish(new Error(`Skin ${entry.id} could not be loaded.`));
            document.head.appendChild(link);
        });
    }

    async function apply(id, options = {}) {
        const persist = options.persist !== false;
        const entry = byId.get(id);
        if (!entry) {
            const error = new Error(`Unknown LoopMaster skin: ${id}`);
            emit('loopmaster:skinerror', { id, error });
            throw error;
        }

        // Every valid request becomes the latest intent, including choosing
        // the skin that is already active. Without this invalidation, an
        // older stylesheet load can finish afterward and undo that choice.
        const sequence = ++requestSequence;
        if (active?.id === entry.id && activeLink?.isConnected) {
            if (persist) safeStorageSet(entry.id);
            return entry;
        }

        try {
            const loaded = await loadStylesheet(entry, sequence);
            if (sequence !== requestSequence) {
                loaded.link.remove();
                return active;
            }
            const previous = active;
            const previousLink = activeLink;
            document.documentElement.dataset.lmSkin = entry.id;
            active = entry;
            activeLink = loaded.link;
            activeLink.id = LINK_ID;
            if (previousLink && previousLink !== activeLink) previousLink.remove();
            if (persist) safeStorageSet(entry.id);
            emit('loopmaster:skinchange', { skin: entry, previous });
            return entry;
        } catch (error) {
            // A superseded request no longer represents the user's choice.
            // Its late network failure should not replace the current picker
            // status with an error or reject an otherwise successful switch.
            if (sequence !== requestSequence) return active;
            emit('loopmaster:skinerror', { id: entry.id, error });
            throw error;
        }
    }

    function current() {
        return active;
    }

    function list() {
        return catalog.slice();
    }

    function initialSkinId() {
        let querySkin = null;
        try {
            querySkin = new URL(root.location.href).searchParams.get('skin');
        } catch (_error) {
            // Keep the stored/default selection.
        }
        const stored = safeStorageGet();
        const selected = root.LoopMasterSkinCore.chooseInitialSkin(catalog, querySkin, stored);
        if (stored && selected.source === 'fallback') safeStorageRemove();
        return { id: selected.id, persist: false };
    }

    const initial = initialSkinId();
    const failOpenTimer = root.setTimeout(() => {
        document.documentElement.removeAttribute('data-lm-skin-loading');
    }, LOAD_TIMEOUT_MS + 250);
    const ready = fallback
        ? apply(initial.id, { persist: initial.persist })
            .catch(async error => {
                if (initial.id !== fallback.id) {
                    try {
                        return await apply(fallback.id, { persist: false });
                    } catch (_fallbackError) {
                        // The base stylesheet remains usable even if the tiny
                        // Original marker sheet cannot be fetched.
                    }
                }
                console.error('LoopMaster skin bootstrap failed:', error);
                return fallback;
            })
            .finally(() => {
                root.clearTimeout(failOpenTimer);
                document.documentElement.removeAttribute('data-lm-skin-loading');
            })
        : Promise.resolve(null).finally(() => {
            root.clearTimeout(failOpenTimer);
            document.documentElement.removeAttribute('data-lm-skin-loading');
        });

    function modalControls(modal) {
        return Array.from(modal.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(control => !control.hidden && control.getClientRects().length > 0);
    }

    function mountPicker() {
        const trigger = document.getElementById('btn-skins');
        const modal = document.getElementById('skin-picker-modal');
        const grid = document.getElementById('skin-picker-grid');
        const done = document.getElementById('btn-skin-picker-done');
        const currentLabel = document.getElementById('skin-current-label');
        const status = document.getElementById('skin-picker-status');
        if (!trigger || !modal || !grid || !done || !currentLabel || !status) return;
        let returnFocus = null;

        function refresh(selected = current()) {
            currentLabel.textContent = selected?.label || 'Original';
            grid.querySelectorAll('[data-skin-option]').forEach(button => {
                const isActive = button.dataset.skinOption === selected?.id;
                button.classList.toggle('is-active', isActive);
                button.setAttribute('aria-pressed', String(isActive));
            });
        }

        function close() {
            modal.hidden = true;
            modal.classList.remove('is-visible');
            modal.setAttribute('aria-hidden', 'true');
            trigger.setAttribute('aria-expanded', 'false');
            if (returnFocus instanceof HTMLElement) returnFocus.focus();
            returnFocus = null;
        }

        function open() {
            returnFocus = document.activeElement;
            modal.hidden = false;
            modal.classList.add('is-visible');
            modal.setAttribute('aria-hidden', 'false');
            trigger.setAttribute('aria-expanded', 'true');
            const selected = grid.querySelector('.skin-option.is-active') || grid.querySelector('.skin-option');
            selected?.focus();
        }

        const fragment = document.createDocumentFragment();
        catalog.forEach(entry => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'skin-option';
            button.dataset.skinOption = entry.id;
            button.setAttribute('aria-pressed', 'false');

            const preview = document.createElement('span');
            preview.className = 'skin-option-preview';
            preview.dataset.skinPreview = entry.preview || entry.id;
            preview.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('span');
            copy.className = 'skin-option-copy';
            const title = document.createElement('strong');
            title.textContent = entry.label;
            const subtitle = document.createElement('span');
            subtitle.className = 'skin-option-subtitle';
            subtitle.textContent = entry.shortLabel || '';
            const description = document.createElement('span');
            description.className = 'skin-option-description';
            description.textContent = entry.description;
            copy.append(title, subtitle, description);
            button.append(preview, copy);
            button.addEventListener('click', async () => {
                status.textContent = `Loading ${entry.label}…`;
                modal.setAttribute('aria-busy', 'true');
                try {
                    const selected = await apply(entry.id);
                    refresh(selected);
                    status.textContent = `${selected.label} applied.`;
                } catch (error) {
                    status.textContent = error.message;
                } finally {
                    modal.removeAttribute('aria-busy');
                }
            });
            fragment.appendChild(button);
        });
        grid.replaceChildren(fragment);

        trigger.addEventListener('click', open);
        done.addEventListener('click', close);
        modal.addEventListener('click', event => {
            if (event.target === modal) close();
        });
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
            }
            if (event.key !== 'Tab') return;
            const controls = modalControls(modal);
            if (!controls.length) return;
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
        document.addEventListener('loopmaster:skinchange', event => refresh(event.detail.skin));
        document.addEventListener('loopmaster:skinerror', event => {
            status.textContent = event.detail?.error?.message || 'Skin could not be loaded.';
        });
        root.addEventListener('storage', event => {
            if (event.key !== STORAGE_KEY || !byId.has(event.newValue)) return;
            apply(event.newValue, { persist: false }).catch(() => {});
        });
        ready.then(refresh);
    }

    root.LoopMasterSkins = Object.freeze({ ready, list, current, apply });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountPicker, { once: true });
    } else {
        mountPicker();
    }
})(window, document);
