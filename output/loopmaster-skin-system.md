# LoopMaster skin system

Status: contract version 1

Scope: presentation and responsive layout only

Authority: the application DOM and behavior remain shared by every skin

## Purpose

LoopMaster skins can reinterpret the entire workstation without cloning controls, moving application state, or attaching skin-specific event handlers. A skin may change layout, density, typography, color, component treatment, responsive behavior, and visual hierarchy. It may not replace application logic.

This boundary is deliberate: prompt values, generated tracks, audio nodes, keyboard behavior, focus order, routing, and persistence survive a live skin switch because the underlying DOM nodes are never recreated.

## Audit findings that shaped v1

- The Original layout fixed both `body` and the application container to one viewport and hid overflow. At common window sizes the transport and track area existed below the viewport but could not be reached.
- The first CUTLINE pass proved that a skin could radically change the workspace with CSS alone, but its 460 px generator rail inherited a three-column prompt layout. Option labels collapsed to roughly 29 px.
- The first runtime allowed an older stylesheet request to win after the user had selected the already-active skin again. Skin intent now uses a monotonic request sequence.
- A JavaScript load failure could have left the boot veil in place forever. The core stylesheet now has an independent three-second fail-open.
- Several legacy controls were visually hidden with `display:none`, removing them from the keyboard focus order. The core contract uses visually-hidden native controls instead.
- The app emits many meaningful state classes. A skin needs both semantic region hooks and a documented state vocabulary; styling guessed class names is not reliable.

## Runtime API

The parser-blocking bootstrap exposes one frozen object:

```js
window.LoopMasterSkins.ready
window.LoopMasterSkins.list()
window.LoopMasterSkins.current()
window.LoopMasterSkins.apply('session-sheet')
window.LoopMasterSkins.apply('padmode', { persist: false })
```

`ready` resolves to the initial `SkinInfo`. `apply()` loads the registered stylesheet before changing the root skin, then removes the prior sheet. A failed load leaves the active skin and stored preference intact. Concurrent calls are latest-intent-wins.

Successful switches dispatch:

```js
document.addEventListener('loopmaster:skinchange', event => {
  console.log(event.detail.skin, event.detail.previous);
});
```

Failures dispatch `loopmaster:skinerror`. The stored preference key is `loopmaster.ui.skin.v1`. A registered `?skin=<id>` query value overrides storage for that load without allowing arbitrary URLs.

## Catalog contract

Skins are registered in `static/skins/skin_catalog.js`:

```js
{
  id: 'session-sheet',
  label: 'SESSION SHEET',
  shortLabel: 'Studio Score',
  description: 'A light editorial tracking sheet.',
  version: '1.0.0',
  contractVersion: 1,
  cssHref: '/static/skins/session-sheet.v1.css',
  colorScheme: 'light',
  preview: 'session-sheet'
}
```

Rules:

- IDs match lowercase `[a-z0-9-]` tokens and are unique.
- Contract version must match the runtime.
- Stylesheets must be same-origin files below `/static/skins/`.
- Remote URLs, data URLs, inline CSS, scripts, and runtime callbacks are rejected.
- `original` is the required fallback.

## Stable DOM hooks

Top-level regions use `data-lm-region`:

| Region | Meaning |
| --- | --- |
| `header` | identity and appearance entry point |
| `generator` | prompt, generation settings, history, kit builder |
| `transport` | playback, project actions, master and visualizer |
| `arranger` | song grid |
| `record-log` | automation/event log |
| `tracks` | generated track and take workspace |
| `modulators` | global modulation workspace |
| `help` | quick start and shortcuts |

Reusable parts use `data-lm-part`:

- `prompt-builder`, `prompt-column`, `prompt-section`, and `progressor`
- `tempo-control`, `seed-control`, `steps-control`, and `tier-control`
- `generate-action` and `kit-action`
- `track`, `track-row`, `mixer`, `variants`, and `fx-drawer`
- `modal`

Prompt sections also expose `data-lm-section=<config key>`. These hooks are additive and behavior-neutral.

## State vocabulary

Skin authors must style the classes and attributes the application actually emits:

| State | Selectors |
| --- | --- |
| active prompt source | `.prompt-builder-section.is-group-active` |
| dormant prompt source | `.prompt-builder-section.is-group-dormant` |
| randomizer lock | `.is-random-muted`, `.chip-mute.is-muted` |
| exact/assembled prompt mode | `[data-prompt-mode="manual"]`, `[data-prompt-mode="assembled"]` |
| active chord map | `.chord-progressor.is-active` |
| selected take | `.audio-card.is-selected` |
| queued/loading take | `.audio-card.is-queued`, `.audio-card.is-loading` |
| locked/deleted take | `.card-is-locked`, `.is-deleted` |
| muted/solo track | `.track-wrapper.is-muted`, `.track-wrapper.is-solo` |
| active toggle | `.is-on`, `[aria-pressed="true"]` |
| disabled/bypassed | `:disabled`, `.is-off`, `.is-bypassed` |
| generation pending | `.is-generating`, `.status-bar.visible` |
| completed/failed status | `.status-text.done`, `.status-text.error` |
| active arranger cell | `.arranger-cell.active` |
| modal visibility | `.modal-overlay.is-visible` |

Use `:focus-visible`, `:disabled`, ARIA state, and the table above. Do not invent parallel skin-only state.

## Shared accessibility and safety layer

`static/skin-core.css` owns invariants that skins must not undo:

- `[hidden]` behavior
- keyboard-focusable native switches
- visible focus for the appearance picker
- 44 px coarse-pointer control targets
- reduced-motion and forced-colors handling
- a script-independent boot fail-open
- the picker layout and modal states

A skin should preserve DOM reading order, keyboard reachability, visible focus, disabled-state contrast, and all primary controls. Hiding a control to simplify a skin is not allowed unless the application itself marked it hidden.

## Authoring a skin

1. Add one stylesheet to `static/skins/`.
2. Root every selector with `:root[data-lm-skin="<id>"]` or `[data-lm-skin="<id>"]`.
3. Define semantic tokens first, then alias the legacy application variables.
4. Layout regions with the stable `data-lm-region` hooks.
5. Style reusable parts and the state vocabulary.
6. Add responsive rules for at least 1280, 768, and 375 CSS pixels.
7. Add the entry to `skin_catalog.js` and a picker preview in `skin-core.css`.
8. Run the unit and Electron skin suites.

Do not use `@import`, network assets, inline styles, `url(javascript:)`, `expression()`, skin-specific JavaScript, DOM reparenting, duplicated controls, or selectors that escape the root skin scope.

## Included skins

- **Original / Midnight Grid** — the existing dark indigo visual language, with workspace reachability and prompt breakpoint repairs.
- **CUTLINE / Sampler Bench** — a pale hardware chassis with dark media wells, tactile controls, and a generator/performance split.
- **SESSION SHEET / Studio Score** — a restrained light tracking sheet with ruled rows, broad prompt fields, and track-first editorial hierarchy.
- **PADMODE / Live Deck** — a dark performance console organized around persistent transport and four large take pads.

## Verification

```powershell
node --test loopmaster/loopmaster-app/tests_js/skin_core.test.js loopmaster/loopmaster-app/tests_js/skin_system.test.js
node --check loopmaster/loopmaster-app/static/skins/skin_system.js
cd loopmaster-desktop
npm run qa:frontend
npm run qa:skins
```

The Electron harness switches every registered skin without recreating prompt state, rejects unregistered URLs, checks latest-intent-wins behavior, exercises all skins at 375/768/1280 px, checks global overflow and track reachability, and can capture the full skin matrix to `loopmaster-desktop/output/skin-previews/`.
