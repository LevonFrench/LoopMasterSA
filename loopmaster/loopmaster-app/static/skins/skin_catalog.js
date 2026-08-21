(function defineLoopMasterSkinCatalog(root) {
    'use strict';

    const skins = [
        {
            id: 'original',
            label: 'Original',
            shortLabel: 'Midnight Grid',
            description: 'The familiar indigo LoopMaster workspace.',
            version: '1.0.0',
            contractVersion: 1,
            cssHref: '/static/skins/original.v1.css',
            colorScheme: 'dark',
            preview: 'original'
        },
        {
            id: 'cutline',
            label: 'CUTLINE',
            shortLabel: 'Sampler Bench',
            description: 'A pale hardware workstation with dark media wells and tactile controls.',
            version: '1.0.0',
            contractVersion: 1,
            cssHref: '/static/skins/cutline.v1.css',
            colorScheme: 'light',
            preview: 'cutline'
        },
        {
            id: 'session-sheet',
            label: 'SESSION SHEET',
            shortLabel: 'Studio Score',
            description: 'A light editorial tracking sheet with ruled prompt lanes and a take-first workspace.',
            version: '1.0.0',
            contractVersion: 1,
            cssHref: '/static/skins/session-sheet.v1.css',
            colorScheme: 'light',
            preview: 'session-sheet'
        },
        {
            id: 'padmode',
            label: 'PADMODE',
            shortLabel: 'Live Deck',
            description: 'A dark touch-first performance console centered on transport and four large takes.',
            version: '1.0.0',
            contractVersion: 1,
            cssHref: '/static/skins/padmode.v1.css',
            colorScheme: 'dark',
            preview: 'padmode'
        }
    ].map(entry => Object.freeze({ ...entry }));

    root.LoopMasterSkinCatalog = Object.freeze(skins);
})(window);
