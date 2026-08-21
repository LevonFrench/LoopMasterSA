(function exposeLoopMasterSkinCore(root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LoopMasterSkinCore = api;
})(typeof window !== 'undefined' ? window : null, function buildLoopMasterSkinCore() {
    'use strict';

    const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

    function isSafeStylesheetHref(href, baseHref) {
        if (typeof href !== 'string' || !href.startsWith('/static/skins/')) return false;
        try {
            const url = new URL(href, baseHref);
            const base = new URL(baseHref);
            return url.origin === base.origin
                && url.pathname.startsWith('/static/skins/')
                && !url.pathname.includes('..')
                && url.pathname.endsWith('.css');
        } catch (_error) {
            return false;
        }
    }

    function validateCatalog(entries, options = {}) {
        const contractVersion = options.contractVersion ?? 1;
        const baseHref = options.baseHref || 'http://localhost/';
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error('The skin catalog must contain at least one entry.');
        }
        const ids = new Set();
        const validated = entries.map(raw => {
            if (!raw || typeof raw !== 'object') throw new Error('Skin catalog entries must be objects.');
            const entry = { ...raw };
            if (!ID_PATTERN.test(entry.id || '')) throw new Error(`Invalid skin id: ${entry.id}`);
            if (ids.has(entry.id)) throw new Error(`Duplicate skin id: ${entry.id}`);
            if (entry.contractVersion !== contractVersion) {
                throw new Error(`Unsupported skin contract for ${entry.id}.`);
            }
            if (!isSafeStylesheetHref(entry.cssHref, baseHref)) {
                throw new Error(`Unsafe skin stylesheet for ${entry.id}.`);
            }
            if (!['dark', 'light'].includes(entry.colorScheme)) {
                throw new Error(`Invalid color scheme for ${entry.id}.`);
            }
            for (const field of ['label', 'description', 'version']) {
                if (typeof entry[field] !== 'string' || !entry[field].trim()) {
                    throw new Error(`Skin ${entry.id} is missing ${field}.`);
                }
            }
            ids.add(entry.id);
            return Object.freeze(entry);
        });
        if (!ids.has('original')) throw new Error('The catalog must include the Original fallback skin.');
        return Object.freeze(validated);
    }

    function chooseInitialSkin(catalog, queryId, storedId) {
        const ids = new Set(catalog.map(entry => entry.id));
        if (queryId && ids.has(queryId)) return { id: queryId, source: 'query' };
        if (storedId && ids.has(storedId)) return { id: storedId, source: 'storage' };
        return { id: 'original', source: 'fallback' };
    }

    return Object.freeze({ isSafeStylesheetHref, validateCatalog, chooseInitialSkin });
});
