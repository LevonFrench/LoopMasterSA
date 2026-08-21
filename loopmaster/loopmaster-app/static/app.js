/* ============================================================
   Stable Audio 3 — Multi-Track Grid Generator
   Simultaneous playback with per-row mixer (solo/mute/pan/level)
   ============================================================ */

(function () {
    'use strict';

    // --- DOM ---
    const bpmInput = document.getElementById('bpm-input');
    const btnGenerate = document.getElementById('btn-generate');
    const statusBar = document.getElementById('status-bar');
    const statusText = document.getElementById('status-text');
    const btnPlayPause = document.getElementById('btn-play-pause');
    const tPosition = document.getElementById('t-position');
    const tDuration = document.getElementById('t-duration');
    const btnStopAll = document.getElementById('btn-stop-all');
    const tracksContainer = document.getElementById('tracks-container');
    const welcomeBoardHTML = tracksContainer ? tracksContainer.innerHTML : '';
    const btnRenderMix = document.getElementById('btn-render-mix');
    const btnExportLoops = document.getElementById('btn-export-loops');
    const btnSaveProject = document.getElementById('btn-save-project');
    const btnLoadProject = document.getElementById('btn-load-project');
    const projectFileInput = document.getElementById('project-file-input');
    const btnRecord = document.getElementById('btn-record');
    const recordLogDrawer = document.getElementById('record-log-drawer');
    const recordLogList = document.getElementById('record-log-list');
    const btnClearRecordLog = document.getElementById('btn-clear-record-log');
    const btnCancelGeneration = document.getElementById('btn-cancel-generation');
    const packNameInput = document.getElementById('pack-name-input');
    const descriptorInput = document.getElementById('descriptor-input');
    const btnFileNaming = document.getElementById('btn-file-naming');
    const fileNamingModal = document.getElementById('file-naming-modal');
    const btnFileNamingSave = document.getElementById('btn-file-naming-save');
    const btnFileNamingCancel = document.getElementById('btn-file-naming-cancel');

    const ASSET_PREFS_KEY = 'loopmaster_asset_metadata_v1';
    let assetPrefsTimer = null;
    let promptBuilder = null;
    let fileNamingOpenSnapshot = null;
    let fileNamingReturnFocus = null;

    function currentFileNamingPreferences() {
        return {
            pack_name: packNameInput?.value.trim() || 'loopmaster',
            descriptor: descriptorInput?.value.trim() || ''
        };
    }

    function currentAssetPreferences() {
        return {
            ...currentFileNamingPreferences(),
            chord_track: promptBuilder?.currentChordTrack?.() || ''
        };
    }

    function persistAssetPreferences() {
        if (assetPrefsTimer) {
            clearTimeout(assetPrefsTimer);
            assetPrefsTimer = null;
        }
        try {
            localStorage.setItem(ASSET_PREFS_KEY, JSON.stringify(currentFileNamingPreferences()));
        } catch (error) {
            console.warn('Could not persist loop-pack metadata fields:', error);
        }
    }

    try {
        const savedAssetPreferences = JSON.parse(localStorage.getItem(ASSET_PREFS_KEY) || '{}');
        if (packNameInput && typeof savedAssetPreferences.pack_name === 'string') {
            packNameInput.value = savedAssetPreferences.pack_name || 'loopmaster';
        }
        if (descriptorInput && typeof savedAssetPreferences.descriptor === 'string') {
            descriptorInput.value = savedAssetPreferences.descriptor;
        }
    } catch (error) {
        console.warn('Ignoring invalid saved loop-pack metadata fields:', error);
    }
    [packNameInput, descriptorInput].filter(Boolean).forEach(input => {
        input.addEventListener('input', () => {
            if (assetPrefsTimer) clearTimeout(assetPrefsTimer);
            assetPrefsTimer = setTimeout(persistAssetPreferences, 250);
        });
        input.addEventListener('blur', persistAssetPreferences);
    });
    window.addEventListener('pagehide', persistAssetPreferences);

    function setFileNamingModal(open) {
        if (!fileNamingModal) return;
        fileNamingModal.classList.toggle('is-visible', Boolean(open));
        fileNamingModal.setAttribute('aria-hidden', String(!open));
        btnFileNaming?.setAttribute('aria-expanded', String(Boolean(open)));
        if (open) {
            fileNamingReturnFocus = document.activeElement;
            fileNamingOpenSnapshot = {
                pack: packNameInput?.value || 'loopmaster',
                descriptor: descriptorInput?.value || ''
            };
            packNameInput?.focus();
        } else if (fileNamingReturnFocus instanceof HTMLElement) {
            fileNamingReturnFocus.focus();
            fileNamingReturnFocus = null;
        }
    }

    function visibleFileNamingControls() {
        if (!fileNamingModal) return [];
        return Array.from(fileNamingModal.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(control => control.getClientRects().length > 0);
    }

    btnFileNaming?.addEventListener('click', () => setFileNamingModal(true));
    btnFileNamingSave?.addEventListener('click', () => {
        persistAssetPreferences();
        setFileNamingModal(false);
    });
    btnFileNamingCancel?.addEventListener('click', () => {
        if (fileNamingOpenSnapshot) {
            if (packNameInput) packNameInput.value = fileNamingOpenSnapshot.pack;
            if (descriptorInput) descriptorInput.value = fileNamingOpenSnapshot.descriptor;
        }
        persistAssetPreferences();
        setFileNamingModal(false);
    });
    fileNamingModal?.addEventListener('click', event => {
        if (event.target === fileNamingModal) btnFileNamingCancel?.click();
    });
    document.addEventListener('keydown', event => {
        if (!fileNamingModal?.classList.contains('is-visible')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            btnFileNamingCancel?.click();
            return;
        }
        if (event.key === 'Tab') {
            const controls = visibleFileNamingControls();
            if (!controls.length) {
                event.preventDefault();
                return;
            }
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    // CSP-safe presentation state.  Dynamic values live in data attributes and
    // are consumed by CSS; code never creates inline style attributes.
    function setPresentation(el, values) {
        if (!el) return;
        Object.entries(values).forEach(([key, value]) => {
            if (key === 'transform') {
                const rotation = String(value).match(/^rotate\(([^)]+)\)$/);
                if (rotation) el.setAttribute('data-rotation', rotation[1]);
                else el.removeAttribute('data-rotation');
                return;
            }
            if (key === 'boxShadow') {
                el.toggleAttribute('data-glow-active', Boolean(value && value !== 'none'));
                return;
            }
            const name = `data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
            if (value === null || value === undefined || value === '') el.removeAttribute(name);
            else el.setAttribute(name, String(value));
        });
    }

    function setHidden(el, hidden) {
        if (!el) return;
        el.hidden = Boolean(hidden);
        el.classList.toggle('is-hidden', Boolean(hidden));
    }

    let activeGenerationJob = null;
    function setGenerationCancelState(jobId, state = 'active') {
        activeGenerationJob = jobId ? { id: jobId, state } : null;
        if (!btnCancelGeneration) return;
        setHidden(btnCancelGeneration, !activeGenerationJob);
        btnCancelGeneration.disabled = !activeGenerationJob || state === 'cancelling';
        btnCancelGeneration.textContent = state === 'cancelling' ? 'Cancelling…' : 'Cancel generation';
        btnCancelGeneration.setAttribute('aria-label', state === 'cancelling'
            ? 'Cancelling queued generation'
            : 'Cancel queued generation. Running audio generation cannot be interrupted.');
    }

    async function cancelActiveGeneration() {
        if (!activeGenerationJob || activeGenerationJob.state === 'cancelling') return;
        const jobId = activeGenerationJob.id;
        setGenerationCancelState(jobId, 'cancelling');
        try {
            const response = await fetch(`/api/cancel/${encodeURIComponent(jobId)}`, { method: 'POST' });
            if (response.status === 200) {
                activeGenerationJob = { id: jobId, state: 'cancelled' };
                showStatus('Queued generation cancelled.', 'done');
                return;
            }
            if (response.status === 409) {
                setGenerationCancelState(jobId, 'active');
                showStatus('Generation is already running and cannot be cancelled.', 'error');
                return;
            }
            if (response.status === 404) {
                setGenerationCancelState(null);
                showStatus('Generation is no longer available.', 'error');
                return;
            }
            throw new Error(`Cancel failed: ${response.status}`);
        } catch (error) {
            console.error('Unable to cancel generation:', error);
            setGenerationCancelState(jobId, 'active');
            showStatus('Could not cancel generation. It may still be running.', 'error');
        }
    }
    if (btnCancelGeneration) btnCancelGeneration.addEventListener('click', cancelActiveGeneration);



    // --- State ---
    let audioCtx = null;
    let tracks = [];          // array of TrackRow objects
    let isPlaying = false;
    let playStartCtxTime = 0; // audioCtx.currentTime when playback started
    let playOffset = 0;       // seconds into the loop
    let globalDuration = 8;   // updated per BPM
    let generateLoop = true;
    let rafId = null;
    let audioSchedulerWorker = null;
    try {
        const workerCode = `
            let timerId = null;
            self.onmessage = function(e) {
                if (e.data === 'start') {
                    if (timerId) clearInterval(timerId);
                    timerId = setInterval(() => {
                        self.postMessage('tick');
                    }, 25);
                } else if (e.data === 'stop') {
                    if (timerId) {
                        clearInterval(timerId);
                        timerId = null;
                    }
                }
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        audioSchedulerWorker = new Worker(workerUrl);
        audioSchedulerWorker.onmessage = function (e) {
            if (e.data === 'tick') {
                runAudioSchedulerTick();
            }
        };
    } catch (err) {
        console.error('Failed to initialize background Web Worker timer:', err);
    }
    let isRecording = false;

    let recordedLoopCounter = 1;
    let isProjectLoading = false;
    let totalVariantsToLoad = 0;
    let loadedVariantsCount = 0;

    // --- Audio Nodes & Metering State ---
    let masterGain = null;
    let masterLimiter = null;
    let masterMakeup = null;
    let masterFilterNode = null;
    let masterVolumeNode = null;
    let masterAnalyser = null;
    let masterMeterState = { rms: -60, peak: -60, peakHold: -60, peakHoldTime: 0 };
    let meterLoopRunning = false;
    let _modBypassElCache = null;
    function getModBypassEl() {
        if (!_modBypassElCache) _modBypassElCache = document.getElementById('toggle-modulators-bypass');
        return _modBypassElCache;
    }
    let _masterUiCache = null;
    const _lfoVizEls = {};
    function getLfoVizEls(num) {
        let els = _lfoVizEls[num];
        if (!els) {
            els = _lfoVizEls[num] = {
                led: document.getElementById(`lfo${num}-timing-light`),
                canvas: document.getElementById(`lfo${num}-canvas`)
            };
        }
        return els;
    }
    const ZERO_MOD_OFFSETS = Object.freeze({
        level: 0, pan: 0, filter: 0, space: 0,
        chorusRate: 0, chorusDepth: 0, chorusFeedback: 0,
        phaserRate: 0, phaserDepth: 0, phaserFeedback: 0,
        crusherBits: 0, crusherNormfreq: 0
    });
    let meterRafId = null;
    let copiedFxSettings = null;
    let copiedTrackSettings = null;

    // --- Init Audio State ---
    let selectedInitAudio = null; // { trackId, variantIndex, filePath, name }
    let remixMode = 'variation';  // 'variation' | 'inpaint' | 'continuation'

    // --- MIDI State ---
    let midiAccess = null;
    let midiAccessRequested = false;
    let midiLearnActive = false;
    let midiLearningControl = null; // data-midi-id string
    let midiMappings = {};          // data-midi-id -> { channel, cc }

    // --- Global Modulators State ---
    const globalModulators = {
        lfo1: { enabled: true, shape: 'sine', mode: 'sync', syncRate: '1', freeRate: 10, phase: 0 },
        lfo2: { enabled: true, shape: 'sine', mode: 'sync', syncRate: '1', freeRate: 10, phase: 0 },
        lfo3: { enabled: true, shape: 'sine', mode: 'sync', syncRate: '1', freeRate: 10, phase: 0 },
        lfo4: { enabled: true, shape: 'sine', mode: 'sync', syncRate: '1', freeRate: 10, phase: 0 },
        env1: { enabled: false, a: 10, d: 20, s: 50, r: 20, trig: 'play', active: false, triggerTime: 0 },
        env2: { enabled: false, a: 10, d: 20, s: 50, r: 20, trig: 'loop', active: false, triggerTime: 0 }
    };
    let modMatrixSlots = []; // 8 slots: { src, trackId, param, depth }
    for (let i = 0; i < 8; i++) {
        modMatrixSlots.push({ src: 'none', trackId: 'none', param: 'none', depth: 0 });
    }

    let activeLfoMapping = null; // null or 1, 2, 3, 4

    function startLfoMapping(num) {
        cancelLfoMapping();
        activeLfoMapping = num;

        const mapBtn = document.querySelector(`.lfo${num}-map-btn`);
        if (mapBtn) mapBtn.classList.add('active');

        const color = ['#10b981', '#00f2fe', '#facc15', '#ec4899'][num - 1];
        document.body.dataset.lfoMapping = String(num);

        const targets = document.querySelectorAll('.level-knob, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .chorus-rate, .chorus-depth, .chorus-feedback, .phaser-rate, .phaser-depth, .phaser-feedback, .crusher-bits, .crusher-normfreq, #master-volume-slider');
        targets.forEach(target => {
            target.classList.add('lfo-mappable-active');
        });
    }

    function cancelLfoMapping() {
        if (activeLfoMapping !== null) {
            const mapBtn = document.querySelector(`.lfo${activeLfoMapping}-map-btn`);
            if (mapBtn) mapBtn.classList.remove('active');
            activeLfoMapping = null;
        }
        document.querySelectorAll('.lfo-mappable-active').forEach(target => {
            target.classList.remove('lfo-mappable-active');
        });
    }

    // --- Song Arranger State ---
    let arrangerModeActive = false;
    let arrangerLengthLoops = 8;
    let arrangerGrid = {}; // trackId -> Array(arrangerLengthLoops) of bool

    function getActiveDuration() {
        if (arrangerModeActive) {
            return arrangerLengthLoops * globalDuration;
        }
        let maxDur = globalDuration;
        tracks.forEach(t => {
            if (t.selectedVariant !== -1) {
                const v = t.variants[t.selectedVariant];
                if (v && v.buffer) {
                    const mult = v.loopMultiplier || 1;
                    const dur = mult * globalDuration;
                    if (dur > maxDur) {
                        maxDur = dur;
                    }
                }
            }
        });
        return maxDur;
    }


    /*
     * TrackRow = {
     *   id: number,
     *   prompt: string,
     *   el: HTMLElement,                  // .track-row
     *   gainNode: GainNode,               // volume
     *   panNode: StereoPannerNode,        // pan
     *   muted: bool,
     *   soloed: bool,
     *   level: number (0-1),
     *   pan: number (-1 to 1),
     *   selectedVariant: number,          // index of selected variant in this row
     *   variants: [{
     *     name, buffer, el, sourceNode
     *   }]
     * }
     */

    let trackIdCounter = 0;

    // --- Helpers ---
    function makeDistortionCurve(amount) {
        const k = typeof amount === 'number' ? amount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    function makeBitcrusherCurve(bits) {
        const steps = Math.pow(2, bits);
        const curve = new Float32Array(4096);
        for (let i = 0; i < 4096; i++) {
            let x = (i * 2) / 4096 - 1;
            curve[i] = Math.round(x * steps) / steps;
        }
        return curve;
    }

    function createNativeChorus(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const delay = ctx.createDelay();
        delay.delayTime.value = 0.0045;
        
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 1.5;
        
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.002;
        
        const feedback = ctx.createGain();
        feedback.gain.value = 0.2;
        
        input.connect(delay);
        delay.connect(output); // Wet only
        delay.connect(feedback);
        feedback.connect(delay);
        
        lfo.connect(lfoGain);
        lfoGain.connect(delay.delayTime);
        lfo.start();
        
        return {
            input, output, lfo, lfoGain, delay,
            get rate() { return lfo.frequency.value; },
            set rate(r) { lfo.frequency.setTargetAtTime(r, ctx.currentTime, 0.01); },
            get depth() { return lfoGain.gain.value / 0.003; },
            set depth(d) { lfoGain.gain.setTargetAtTime(d * 0.003, ctx.currentTime, 0.01); },
            get feedback() { return feedback.gain.value; },
            set feedback(f) { feedback.gain.setTargetAtTime(f, ctx.currentTime, 0.01); },
            // Time-aware setters for OfflineAudioContext automation, where
            // ctx.currentTime is 0 before startRendering() and plain setters
            // collapse the whole automation lane to the last written value.
            setRateAtTime: (r, t) => lfo.frequency.setTargetAtTime(r, t, 0.01),
            setDepthAtTime: (d, t) => lfoGain.gain.setTargetAtTime(d * 0.003, t, 0.01),
            setFeedbackAtTime: (f, t) => feedback.gain.setTargetAtTime(f, t, 0.01),
            disconnect: () => {
                input.disconnect(); output.disconnect(); delay.disconnect(); feedback.disconnect();
                lfo.disconnect(); lfoGain.disconnect();
            }
        };
    }

    function createNativePhaser(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        
        const filters = [];
        const stages = 4;
        for (let i = 0; i < stages; i++) {
            const f = ctx.createBiquadFilter();
            f.type = 'allpass';
            f.frequency.value = 1000;
            f.Q.value = 1;
            filters.push(f);
            if (i > 0) {
                filters[i-1].connect(f);
            }
        }
        
        input.connect(filters[0]);
        filters[stages-1].connect(output); // Wet only
        
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 1.2;
        
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 500;
        
        lfo.connect(lfoGain);
        for (let i = 0; i < stages; i++) {
            lfoGain.connect(filters[i].frequency);
        }
        lfo.start();
        
        const feedback = ctx.createGain();
        feedback.gain.value = 0.2;
        filters[stages-1].connect(feedback);
        feedback.connect(filters[0]);
        
        return {
            input, output, lfo, lfoGain, filters, feedback,
            get rate() { return lfo.frequency.value; },
            set rate(r) { lfo.frequency.setTargetAtTime(r, ctx.currentTime, 0.01); },
            get depth() { return lfoGain.gain.value / 800; },
            set depth(d) { lfoGain.gain.setTargetAtTime(d * 800, ctx.currentTime, 0.01); },
            get feedback() { return feedback.gain.value; },
            set feedback(f) { feedback.gain.setTargetAtTime(f, ctx.currentTime, 0.01); },
            // Time-aware setters for OfflineAudioContext automation (see chorus).
            setRateAtTime: (r, t) => lfo.frequency.setTargetAtTime(r, t, 0.01),
            setDepthAtTime: (d, t) => lfoGain.gain.setTargetAtTime(d * 800, t, 0.01),
            setFeedbackAtTime: (f, t) => feedback.gain.setTargetAtTime(f, t, 0.01),
            disconnect: () => {
                input.disconnect(); output.disconnect(); feedback.disconnect();
                for (let i=0; i<stages; i++) filters[i].disconnect();
                lfo.disconnect(); lfoGain.disconnect();
            }
        };
    }

    function createNativeBitcrusher(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const shaper = ctx.createWaveShaper();
        shaper.curve = makeBitcrusherCurve(8);
        
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 20000;
        
        input.connect(shaper);
        shaper.connect(filter);
        filter.connect(output);
        
        let currentBits = 8;
        return {
            input, output, shaper, filter,
            get bits() { return currentBits; },
            set bits(b) {
                const next = Math.max(1, Math.min(16, b));
                // The scheduler assigns this 40x/s; rebuilding the 4096-float
                // curve on unchanged values allocates and glitches the render thread.
                if (next === currentBits) return;
                currentBits = next;
                shaper.curve = makeBitcrusherCurve(currentBits);
            },
            get normfreq() { return filter.frequency.value / 20000; },
            set normfreq(nf) { filter.frequency.setTargetAtTime(Math.max(20, nf * 20000), ctx.currentTime, 0.01); },
            // Time-aware setter for OfflineAudioContext automation (see chorus).
            setNormfreqAtTime: (nf, t) => filter.frequency.setTargetAtTime(Math.max(20, nf * 20000), t, 0.01),
            disconnect: () => {
                input.disconnect(); output.disconnect(); shaper.disconnect(); filter.disconnect();
            }
        };
    }

    /*
     * TrackEffectGraph is the seam shared by the live AudioContext and the
     * OfflineAudioContext renderer.  Its small interface accepts a source node
     * plus the persisted track settings, and returns the nodes that callers
     * need for UI updates or offline automation.  Keeping the wet/dry routing,
     * effect order, and setting-to-node mapping here prevents the two playback
     * adapters from silently drifting apart.
     */
    function normalizeTrackEffectSettings(settings = {}) {
        const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
        const enabled = (value, fallback) => typeof value === 'boolean' ? value : fallback;
        const oscillatorType = (value, fallback) => (
            ['sine', 'square', 'sawtooth', 'triangle'].includes(value) ? value : fallback
        );

        return {
            chorus: {
                enabled: enabled(settings.tunaChorusEnabled, false),
                rate: number(settings.tunaChorusRate, 1.5),
                depth: number(settings.tunaChorusDepth, 0.7),
                feedback: number(settings.tunaChorusFeedback, 0.2),
                mix: number(settings.tunaChorusMix, 0.5)
            },
            phaser: {
                enabled: enabled(settings.tunaPhaserEnabled, false),
                rate: number(settings.tunaPhaserRate, 1.2),
                depth: number(settings.tunaPhaserDepth, 0.6),
                feedback: number(settings.tunaPhaserFeedback, 0.2),
                mix: number(settings.tunaPhaserMix, 0.5)
            },
            crusher: {
                enabled: enabled(settings.tunaBitcrusherEnabled, false),
                bits: number(settings.tunaBitcrusherBits, 8),
                normfreq: number(settings.tunaBitcrusherNormfreq, 0.1),
                mix: number(settings.tunaBitcrusherMix, 0.5)
            },
            delay: {
                enabled: enabled(settings.aelapseDelayEnabled, true),
                time: number(settings.aelapseDelayTime, 0.3),
                feedback: number(settings.aelapseFeedback, 0.3),
                mix: number(settings.aelapseDelayMix, 0),
                wowRate: number(settings.aelapseDelayWowRate, 2.0),
                wowDepth: number(settings.aelapseDelayWowDepth, 0)
            },
            reverb: {
                enabled: enabled(settings.aelapseReverbEnabled, true),
                mix: number(settings.aelapseReverbMix, 0),
                size: number(settings.aelapseReverbSize, 2.0),
                preDelay: number(settings.aelapseReverbPreDelay, 0),
                damp: number(settings.aelapseReverbDamp, 20000)
            },
            tremolo: {
                enabled: enabled(settings.tremoloEnabled, false),
                rate: number(settings.tremoloRate, 5.0),
                depth: number(settings.tremoloDepth, 0),
                shape: oscillatorType(settings.tremoloShape, 'sine')
            },
            gate: {
                enabled: enabled(settings.gateEnabled, false),
                syncIndex: number(settings.gateSyncIndex, 2),
                width: number(settings.gateWidth, 0.5),
                shape: oscillatorType(settings.gateShape, 'square'),
                mix: number(settings.gateMix, 0.5)
            }
        };
    }

    function getTempoGateFrequency(bpm, rawSyncIndex) {
        const syncBeats = [0.25, 0.333, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
        const syncIndex = Math.max(0, Math.min(syncBeats.length - 1, Math.round(rawSyncIndex)));
        const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
        return 1.0 / ((60.0 / safeBpm) * syncBeats[syncIndex]);
    }

    const TrackEffectGraph = Object.freeze({
        buildInsertChain(ctx, input, rawSettings = {}) {
            const settings = normalizeTrackEffectSettings(rawSettings);
            const createWetDryStage = (source, effectNode, isEnabled, mix) => {
                const dry = ctx.createGain();
                const wet = ctx.createGain();
                const sum = ctx.createGain();
                const safeMix = Math.max(0, Math.min(1, mix));
                dry.gain.value = isEnabled ? 1.0 - safeMix : 1.0;
                wet.gain.value = isEnabled ? safeMix : 0.0;
                source.connect(dry);
                dry.connect(sum);
                source.connect(effectNode.input);
                effectNode.output.connect(wet);
                wet.connect(sum);
                return { dry, wet, sum };
            };

            const chorusNode = createNativeChorus(ctx);
            chorusNode.rate = settings.chorus.rate;
            chorusNode.depth = settings.chorus.depth;
            chorusNode.feedback = settings.chorus.feedback;
            const chorus = createWetDryStage(input, chorusNode, settings.chorus.enabled, settings.chorus.mix);

            const phaserNode = createNativePhaser(ctx);
            phaserNode.rate = settings.phaser.rate;
            phaserNode.depth = settings.phaser.depth;
            phaserNode.feedback = settings.phaser.feedback;
            const phaser = createWetDryStage(chorus.sum, phaserNode, settings.phaser.enabled, settings.phaser.mix);

            const crusherNode = createNativeBitcrusher(ctx);
            crusherNode.bits = settings.crusher.bits;
            crusherNode.normfreq = settings.crusher.normfreq;
            const crusher = createWetDryStage(phaser.sum, crusherNode, settings.crusher.enabled, settings.crusher.mix);

            return {
                input,
                output: crusher.sum,
                tunaChorusNode: chorusNode,
                tunaChorusDryGain: chorus.dry,
                tunaChorusWetGain: chorus.wet,
                tunaChorusSum: chorus.sum,
                tunaPhaserNode: phaserNode,
                tunaPhaserDryGain: phaser.dry,
                tunaPhaserWetGain: phaser.wet,
                tunaPhaserSum: phaser.sum,
                tunaBitcrusherNode: crusherNode,
                tunaBitcrusherDryGain: crusher.dry,
                tunaBitcrusherWetGain: crusher.wet,
                tunaBitcrusherSum: crusher.sum
            };
        },

        // Tremolo and gate are one ordered modulation stage for both realtime
        // playback and OfflineAudioContext rendering.  Callers retain the
        // returned nodes for their existing realtime controls and automation.
        buildModulationChain(ctx, input, rawSettings = {}, bpm = 120) {
            const settings = normalizeTrackEffectSettings(rawSettings);
            const tremoloGainNode = ctx.createGain();
            tremoloGainNode.gain.value = 1.0;
            const tremoloLfoNode = ctx.createOscillator();
            tremoloLfoNode.type = settings.tremolo.shape;
            tremoloLfoNode.frequency.value = settings.tremolo.rate;
            const tremoloLfoGainNode = ctx.createGain();
            tremoloLfoGainNode.gain.value = settings.tremolo.enabled ? settings.tremolo.depth : 0.0;
            tremoloLfoNode.connect(tremoloLfoGainNode);
            tremoloLfoGainNode.connect(tremoloGainNode.gain);
            tremoloLfoNode.start();

            const gateInputNode = ctx.createGain();
            const gateOutputNode = ctx.createGain();
            const gateDryGainNode = ctx.createGain();
            const gateWetGainNode = ctx.createGain();
            const gateGatedGainNode = ctx.createGain();
            const gateLfoNode = ctx.createOscillator();
            gateLfoNode.type = settings.gate.shape;
            gateLfoNode.frequency.value = getTempoGateFrequency(bpm, settings.gate.syncIndex);
            const gateBiasNode = ctx.createGain();
            gateBiasNode.gain.value = 2.0 * (settings.gate.width - 0.5);
            const gateDcSource = ctx.createConstantSource ? ctx.createConstantSource() : null;
            if (gateDcSource) {
                gateDcSource.offset.value = 1.0;
                gateDcSource.start();
                gateDcSource.connect(gateBiasNode);
            }
            const gateSumNode = ctx.createGain();
            const gateShaperNode = ctx.createWaveShaper();
            gateShaperNode.curve = Float32Array.from([0.0, 1.0]);

            gateLfoNode.connect(gateSumNode);
            gateBiasNode.connect(gateSumNode);
            gateSumNode.connect(gateShaperNode);
            gateShaperNode.connect(gateGatedGainNode.gain);
            gateLfoNode.start();

            const safeGateMix = Math.max(0, Math.min(1, settings.gate.mix));
            gateDryGainNode.gain.value = settings.gate.enabled ? 1.0 - safeGateMix : 1.0;
            gateWetGainNode.gain.value = settings.gate.enabled ? safeGateMix : 0.0;
            input.connect(tremoloGainNode);
            tremoloGainNode.connect(gateInputNode);
            gateInputNode.connect(gateDryGainNode);
            gateDryGainNode.connect(gateOutputNode);
            gateInputNode.connect(gateWetGainNode);
            gateWetGainNode.connect(gateGatedGainNode);
            gateGatedGainNode.connect(gateOutputNode);

            return {
                input,
                output: gateOutputNode,
                tremoloGainNode,
                tremoloLfoNode,
                tremoloLfoGainNode,
                gateInputNode,
                gateOutputNode,
                gateDryGainNode,
                gateWetGainNode,
                gateGatedGainNode,
                gateLfoNode,
                gateBiasNode,
                gateSumNode,
                gateShaperNode,
                gateDcSource
            };
        },

        buildSendChain(ctx, input, rawSettings = {}) {
            const settings = normalizeTrackEffectSettings(rawSettings);
            const dryGain = ctx.createGain();
            dryGain.gain.value = 1.0;
            const sum = ctx.createGain();
            input.connect(dryGain);
            dryGain.connect(sum);

            const delay = ctx.createDelay(5.0);
            delay.delayTime.value = settings.delay.time;
            const delayFeedback = ctx.createGain();
            delayFeedback.gain.value = settings.delay.feedback;
            const delayGain = ctx.createGain();
            delayGain.gain.value = settings.delay.enabled ? settings.delay.mix : 0.0;
            const delayLfo = ctx.createOscillator();
            delayLfo.frequency.value = settings.delay.wowRate;
            const delayLfoGain = ctx.createGain();
            delayLfoGain.gain.value = settings.delay.wowDepth;
            delayLfo.connect(delayLfoGain);
            delayLfoGain.connect(delay.delayTime);
            delayLfo.start();
            input.connect(delay);
            delay.connect(delayFeedback);
            delayFeedback.connect(delay);
            delay.connect(delayGain);
            delayGain.connect(sum);

            const reverbPreDelay = ctx.createDelay(1.0);
            reverbPreDelay.delayTime.value = settings.reverb.preDelay;
            const reverb = ctx.createConvolver();
            reverb.buffer = createSpringImpulseResponse(ctx, settings.reverb.size, 2.5);
            const reverbDampFilter = ctx.createBiquadFilter();
            reverbDampFilter.type = 'lowpass';
            reverbDampFilter.frequency.value = settings.reverb.damp;
            const reverbGain = ctx.createGain();
            reverbGain.gain.value = settings.reverb.enabled ? settings.reverb.mix : 0.0;
            input.connect(reverbPreDelay);
            reverbPreDelay.connect(reverb);
            reverb.connect(reverbDampFilter);
            reverbDampFilter.connect(reverbGain);
            reverbGain.connect(sum);

            return {
                input,
                output: sum,
                aelapseDryGain: dryGain,
                aelapseDelay: delay,
                aelapseFeedbackNode: delayFeedback,
                aelapseDelayGain: delayGain,
                aelapseLFO: delayLfo,
                aelapseLFOGain: delayLfoGain,
                reverbPreDelay,
                aelapseReverb: reverb,
                reverbDampFilter,
                aelapseReverbGain: reverbGain,
                sendSumGain: sum
            };
        }
    });

    function createSpringImpulseResponse(audioCtx, duration, decay) {
        const sampleRate = audioCtx.sampleRate;
        const len = sampleRate * duration;
        const buffer = audioCtx.createBuffer(2, len, sampleRate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);

        let lastValL = 0;
        let lastValR = 0;
        for (let i = 0; i < len; i++) {
            const percent = i / len;
            const envelope = Math.pow(1 - percent, decay);
            const noiseL = Math.random() * 2 - 1;
            const noiseR = Math.random() * 2 - 1;
            // 1-pole lowpass filter for warmer, less metallic/pitchy sound
            lastValL = lastValL * 0.9 + noiseL * 0.1;
            lastValR = lastValR * 0.9 + noiseR * 0.1;
            left[i] = lastValL * envelope * 3.0; // scale up to compensate for lowpass attenuation
            right[i] = lastValR * envelope * 3.0;
        }
        return buffer;
    }

    function toggleGlobalModulators() {
        const modulatorsPanel = document.getElementById('modulators-panel');
        if (!modulatorsPanel) return;
        const isOpen = !modulatorsPanel.classList.contains('is-open');
        modulatorsPanel.classList.toggle('is-open', isOpen);

        // Update all MOD buttons to match the drawer open state
        document.querySelectorAll('.mod-btn').forEach(btn => {
            btn.classList.toggle('is-on', isOpen);
            setToggleButtonPressed(btn, isOpen);
        });
    }

    function setToggleButtonPressed(button, pressed) {
        if (button) button.setAttribute('aria-pressed', String(Boolean(pressed)));
    }

    function syncTrackTogglePressed(track, selector, pressed) {
        setToggleButtonPressed(track.wrapper?.querySelector(selector), pressed);
    }

    function calcDuration(bpm) { return 960 / bpm; }

    function formatTime(s) {
        if (!Number.isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
    }

    function updateDurationLabel() {
        const bpm = parseInt(bpmInput.value) || 120;
        globalDuration = calcDuration(bpm);
        bpmInput.title = `4 bars = ${globalDuration.toFixed(2)}s`;
        tDuration.textContent = formatTime(globalDuration);

        // Update delay times for all tracks to keep them tempo-synced!
        tracks.forEach(t => {
            const syncBeats = [0.25, 0.333, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
            const beats = syncBeats[t.delaySyncIndex || 3];
            const delayTimeSec = (60.0 / bpm) * beats;
            t.aelapseDelayTime = delayTimeSec;
            if (t.aelapseDelayNode) {
                t.aelapseDelayNode.delayTime.setValueAtTime(delayTimeSec, audioCtx.currentTime);
            }
            updateTunaTempoSync(t);
        });
    }

    function getMasterFaderParams(sliderVal) {
        const val = sliderVal / 100;
        if (val <= 0.001) {
            return {
                volumeGain: 0.0,
                threshold: -1.0,
                displayDb: -Infinity
            };
        }
        const targetDb = (val - 1.0) * 40.0;
        const volumeGain = Math.pow(10, targetDb / 20);
        return {
            volumeGain: volumeGain,
            threshold: -1.0,
            displayDb: targetDb
        };
    }

    function ensureAudioCtx() {
        if (!audioCtx) {
            audioCtx = new AudioContext({ latencyHint: 'playback' });

            // Create master nodes
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 1.0;

            masterLimiter = audioCtx.createDynamicsCompressor();
            const masterVolSlider = document.getElementById('master-volume-slider');
            const sliderVal = masterVolSlider ? parseInt(masterVolSlider.value) : 100;
            const params = getMasterFaderParams(sliderVal);

            masterLimiter.threshold.setValueAtTime(params.threshold, audioCtx.currentTime);
            masterLimiter.knee.setValueAtTime(8.0, audioCtx.currentTime);
            masterLimiter.ratio.setValueAtTime(20.0, audioCtx.currentTime);
            masterLimiter.attack.setValueAtTime(0.003, audioCtx.currentTime);
            masterLimiter.release.setValueAtTime(0.25, audioCtx.currentTime);

            // Makeup gain set to 1.0 (0 dB) so we don't apply static gain
            masterMakeup = audioCtx.createGain();
            masterMakeup.gain.setValueAtTime(1.0, audioCtx.currentTime);

            masterFilterNode = audioCtx.createBiquadFilter();
            masterFilterNode.type = 'lowpass';
            // Default to 22000Hz (essentially bypassed)
            masterFilterNode.frequency.setValueAtTime(22000, audioCtx.currentTime);
            masterFilterNode.Q.setValueAtTime(0.5, audioCtx.currentTime);

            masterVolumeNode = audioCtx.createGain();
            masterVolumeNode.gain.setValueAtTime(params.volumeGain, audioCtx.currentTime);

            masterAnalyser = audioCtx.createAnalyser();
            masterAnalyser.fftSize = 1024;

            // Connect master chain: masterGain -> masterLimiter -> masterMakeup -> masterFilterNode -> masterVolumeNode -> masterAnalyser -> destination
            masterGain.connect(masterLimiter);
            masterLimiter.connect(masterMakeup);
            masterMakeup.connect(masterFilterNode);
            masterFilterNode.connect(masterVolumeNode);
            masterVolumeNode.connect(masterAnalyser);
            masterAnalyser.connect(audioCtx.destination);

            // Show master meter section
            const masterMeterSection = document.getElementById('master-meter-section');
            if (masterMeterSection) {
                setPresentation(masterMeterSection, { display: 'flex' });
            }

            // Start meter animation loop
            startMeterLoop();

            // Initialize visualizer tray analyser
            initVizAnalyser();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    // --- BPM ---
    let _bpmRestartDebounce = null;
    bpmInput.addEventListener('input', () => {
        const activeDurationBefore = getActiveDuration();
        let currentTime = 0;
        if (isPlaying && audioCtx) {
            currentTime = (audioCtx.currentTime - playStartCtxTime) % activeDurationBefore;
        } else {
            currentTime = playOffset % activeDurationBefore;
        }
        const pct = activeDurationBefore > 0 ? currentTime / activeDurationBefore : 0;

        updateDurationLabel();

        const activeDurationAfter = getActiveDuration();
        playOffset = pct * activeDurationAfter;
        if (isPlaying) {
            playStartCtxTime = audioCtx.currentTime - playOffset;
            // BPM drags fire this per mousemove; restarting every source per
            // pixel churns nodes and stutters. Coalesce until the drag settles.
            if (_bpmRestartDebounce) clearTimeout(_bpmRestartDebounce);
            _bpmRestartDebounce = setTimeout(() => {
                _bpmRestartDebounce = null;
                if (!isPlaying) return;
                tracks.forEach(t => {
                    stopTrackSource(t);
                    startTrackSource(t);
                });
            }, 140);
        }
        updatePlayheads();

        updateAllTracksTempoSync();
    });

    function updateAllTracksTempoSync() {
        const bpm = parseInt(bpmInput.value) || 120;
        const syncBeats = [0.25, 0.333, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
        const ctx = ensureAudioCtx();
        tracks.forEach(track => {
            if (track.aelapseDelayNode && track.delaySyncIndex !== undefined) {
                const delaySec = (60.0 / bpm) * syncBeats[track.delaySyncIndex];
                track.aelapseDelayTime = delaySec;
                track.aelapseDelayNode.delayTime.setValueAtTime(delaySec, ctx.currentTime);
                const el = track.wrapper?.querySelector('.aelapse-sync-val');
                if (el) el.textContent = ['1/16', '1/8T', '1/8', 'd8th', '1/4', 'd1/4', '1/2', 'd1/2', '1/1'][track.delaySyncIndex];
            }
            if (track.gateLfoNode && track.gateSyncIndex !== undefined) {
                track.gateLfoNode.frequency.setValueAtTime(
                    getTempoGateFrequency(bpm, track.gateSyncIndex), ctx.currentTime
                );
                const el = track.wrapper?.querySelector('.gate-sync-val');
                if (el) el.textContent = ['1/16', '1/8T', '1/8', 'd8th', '1/4', 'd1/4', '1/2', 'd1/2', '1/1'][track.gateSyncIndex];
            }
            updateTunaTempoSync(track);
        });
    }

    updateDurationLabel();

    // --- Unified drag-or-type for number inputs ---
    // Single click = focus for typing. Drag 3px+ = drag mode.
    function makeDraggableInput(inputEl, { min, max, step, sensitivity }) {
        if (!inputEl) return;
        const DEADZONE = 3;
        let pending = false, activated = false, startY = 0, startVal = 0;

        setPresentation(inputEl, { cursor: 'ns-resize' });

        inputEl.addEventListener('mousedown', (e) => {
            // If already focused (typing), don't interfere
            if (document.activeElement === inputEl) return;
            e.preventDefault();
            pending = true;
            activated = false;
            startY = e.clientY;
            startVal = parseFloat(inputEl.value) || 0;
        });

        document.addEventListener('mousemove', (e) => {
            if (!pending) return;
            const dy = Math.abs(e.clientY - startY);
            if (!activated && dy >= DEADZONE) {
                activated = true;
                inputEl.blur();
                setPresentation(document.body, { cursor: 'ns-resize' });
            }
            if (activated) {
                const delta = (startY - e.clientY) * (sensitivity || 1);
                let newVal = startVal + delta * step;
                newVal = Math.max(min, Math.min(max, Math.round(newVal / step) * step));
                inputEl.value = step < 1 ? newVal.toFixed(1) : newVal;
                inputEl.dispatchEvent(new Event('input'));
            }
        });

        document.addEventListener('mouseup', () => {
            if (pending) {
                if (!activated) {
                    // Was a click, not a drag — focus for typing
                    inputEl.focus();
                    inputEl.select();
                }
                pending = false;
                activated = false;
                setPresentation(document.body, { cursor: null });
            }
        });

        inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') inputEl.blur(); });
    }

    makeDraggableInput(bpmInput, { min: 40, max: 300, step: 1, sensitivity: 0.08 });
    makeDraggableInput(document.getElementById('seed-input'), { min: -1, max: 999999, step: 1, sensitivity: 0.1 });
    makeDraggableInput(document.getElementById('cfg-input'), { min: 0.5, max: 15, step: 0.5, sensitivity: 0.1 });
    makeDraggableInput(document.getElementById('steps-input'), { min: 1, max: 100, step: 1, sensitivity: 0.08 });

    // --- Split toggle: show/hide card center lines ---
    const splitToggle = document.getElementById('toggle-split');
    if (splitToggle) {
        splitToggle.addEventListener('change', () => {
            document.body.classList.toggle('split-mode', splitToggle.checked);
        });
    }

    // --- Solo/Mute logic ---
    function updateMixerState() {
        const anySoloed = tracks.some(t => t.soloed);
        tracks.forEach(t => {
            // Effective mute: muted, or (some track is soloed and this one isn't)
            const effectivelyMuted = t.muted || (anySoloed && !t.soloed);
            t.gainNode.gain.value = effectivelyMuted ? 0 : t.level;
            t.el.classList.toggle('is-muted', effectivelyMuted);
            t.el.classList.toggle('is-solo', t.soloed);
        });
    }

    // --- Play / Pause / Stop ---
    btnPlayPause.addEventListener('click', () => {
        if (tracks.length === 0) return;
        if (isPlaying) pauseAll();
        else playAll();
    });

    if (btnStopAll) btnStopAll.addEventListener('click', () => {
        stopAll();
    });

    function playAll() {
        if (tracks.length === 0) return;
        ensureAudioCtx();

        // Auto-collapse shortcuts footer when playback starts
        const appFooter = document.getElementById('app-footer');
        if (appFooter && !appFooter.classList.contains('is-collapsed')) {
            appFooter.classList.add('is-collapsed');
            localStorage.setItem('loopmaster_footer_collapsed', 'true');
        }

        // Start a source for each track's selected variant
        tracks.forEach(t => {
            startTrackSource(t);
        });

        playStartCtxTime = audioCtx.currentTime - playOffset;
        isPlaying = true;
        btnPlayPause.classList.add('is-playing');
        btnPlayPause.setAttribute('aria-label', 'Pause');

        // Trigger start/loop/bar envelopes on play start
        lastBarIndex = -1;
        if (playOffset === 0) {
            triggerEnvelopes('play', playStartCtxTime);
            triggerEnvelopes('loop', playStartCtxTime);
            triggerEnvelopes('bar', playStartCtxTime);
        }

        if (isRecording) {
            recordedLoopCounter = Math.floor(playOffset / globalDuration) + 1;
            captureTrackStates(recordedLoopCounter, 'Start');
        }

        startRAF();
        if (audioSchedulerWorker) {
            audioSchedulerWorker.postMessage('start');
        }
    }

    function pauseAll() {
        // Capture current position
        if (audioCtx) {
            const elapsed = audioCtx.currentTime - playStartCtxTime;
            playOffset = elapsed % getActiveDuration();
        }

        if (isRecording) {
            captureTrackStates(recordedLoopCounter, 'Pause');
        }

        // Stop all sources
        tracks.forEach(t => stopTrackSource(t));

        isPlaying = false;
        btnPlayPause.classList.remove('is-playing');
        btnPlayPause.setAttribute('aria-label', 'Play');
        cancelRAF();
        if (audioSchedulerWorker) {
            audioSchedulerWorker.postMessage('stop');
        }
    }

    function zeroAllMeters() {
        if (masterMeterState) {
            masterMeterState.rms = -60;
            masterMeterState.peak = -60;
            masterMeterState.peakHold = -60;
            masterMeterState.peakHoldTime = 0;
            const masterCanvas = document.getElementById('master-meter-canvas');
            if (masterCanvas) drawMeter(masterCanvas, masterMeterState);
        }
        tracks.forEach(t => {
            if (t.meterState && t.meterCanvas) {
                t.meterState.rms = -60;
                t.meterState.peak = -60;
                t.meterState.peakHold = -60;
                t.meterState.peakHoldTime = 0;
                drawMeter(t.meterCanvas, t.meterState);
            }
        });
    }

    function stopAll() {
        if (isRecording) {
            captureTrackStates(recordedLoopCounter, 'Stop');
        }
        tracks.forEach(t => stopTrackSource(t));
        playOffset = 0;
        isPlaying = false;
        btnPlayPause.classList.remove('is-playing');
        btnPlayPause.setAttribute('aria-label', 'Play');
        cancelRAF();
        if (audioSchedulerWorker) {
            audioSchedulerWorker.postMessage('stop');
        }
        updatePlayheads();
        zeroAllMeters();
    }

    // --- Undo system ---
    let undoStack = [];
    const btnUndo = document.getElementById('btn-undo');

    function pushUndo(action, data) {
        undoStack.push({ action, data });
        if (undoStack.length > 3) {
            const old = undoStack.shift();
            if (old.action === 'deleteTrack') {
                destroyTrackAudio(old.data.track);
            }
        }
        if (btnUndo) setPresentation(btnUndo, { display: 'inline-flex' });
    }

    function performUndo() {
        if (undoStack.length === 0) return;
        const entry = undoStack.pop();
        if (entry.action === 'deleteTrack') {
            const { wrapperEl, track: t, index } = entry.data;
            // Re-insert into DOM and tracks array
            tracks.splice(index, 0, t);
            const children = tracksContainer.children;
            if (index < children.length) {
                tracksContainer.insertBefore(wrapperEl, children[index]);
            } else {
                tracksContainer.appendChild(wrapperEl);
            }
            tracksContainer.classList.remove('empty');
            const emptyEl = tracksContainer.querySelector('.grid-empty-state');
            if (emptyEl) emptyEl.remove();
            btnPlayPause.disabled = false;
            if (btnStopAll) btnStopAll.disabled = false;
            if (btnRenderMix) btnRenderMix.disabled = false;
            if (btnSaveProject) btnSaveProject.disabled = false;
            if (btnRecord) btnRecord.disabled = false;
            // Restore gain level and connection
            t.gainNode.gain.value = t.level;
            t.gainNode.connect(masterInputNode);
            updateModMatrixTracks();
            if (arrangerModeActive) renderArrangerTimeline();
            updateMixerState();
            // If playing, start the restored track in sync
            if (isPlaying && audioCtx) {
                const elapsed = audioCtx.currentTime - playStartCtxTime;
                playOffset = elapsed % getActiveDuration();
                startTrackSource(t);
            }
        }
        if (undoStack.length === 0 && btnUndo) setPresentation(btnUndo, { display: 'none' });
    }

    if (btnUndo) {
        btnUndo.addEventListener('click', performUndo);
        setPresentation(btnUndo, { display: 'none' });
    }

    function deleteTrackRow(track) {
        // Stop playback of this track immediately
        stopTrackSource(track);

        // Mute and disconnect from master to stop background processing (allows undo)
        track.gainNode.gain.value = 0;
        try { track.gainNode.disconnect(); } catch(e) {}

        // Remove from DOM (but keep the element for undo)
        track.wrapper.remove();

        // Remove from tracks array
        tracks = tracks.filter(t => t.id !== track.id);
        updateModMatrixTracks();
        if (arrangerModeActive) renderArrangerTimeline();

        // Update Mixer Mute/Solo state (in case this track was soloed)
        updateMixerState();

        // If no tracks left, show empty state
        if (tracks.length === 0) {
            tracksContainer.classList.add('empty');
            tracksContainer.innerHTML = welcomeBoardHTML;
            btnPlayPause.disabled = true;
            if (btnStopAll) btnStopAll.disabled = true;
            if (btnRenderMix) btnRenderMix.disabled = true;
            if (btnSaveProject) btnSaveProject.disabled = true;
            if (btnRecord) btnRecord.disabled = true;
            stopAll();
        }
    }

    function scheduleSourceNode(track, startTime, bufferOffset) {
        if (track.selectedVariant === -1) return null;
        const v = track.variants[track.selectedVariant];
        if (!v || !v.buffer) return null;

        const ctx = ensureAudioCtx();
        const source = ctx.createBufferSource();
        source.buffer = v.buffer;
        source.loop = false; // Disable native loop so tail plays past loop boundary

        const creationBpm = track.originalParams?.bpm || 120;
        const currentBpm = parseInt(bpmInput.value) || 120;
        const rate = currentBpm / creationBpm;
        source.playbackRate.value = rate;

        source.connect(track.fxInputNode);

        const safeOffset = Math.max(0, Math.min(v.buffer.duration - 0.01, bufferOffset));
        source.start(startTime, safeOffset);

        if (!track.scheduledSourceNodes) {
            track.scheduledSourceNodes = [];
        }
        track.scheduledSourceNodes.push(source);

        source.onended = () => {
            if (track.scheduledSourceNodes) {
                track.scheduledSourceNodes = track.scheduledSourceNodes.filter(n => n !== source);
            }
            try { source.disconnect(); } catch (_) { }
        };

        // Keep a reference to the latest scheduled node for backward compatibility
        v.sourceNode = source;

        return source;
    }

    function startTrackSource(track) {
        stopTrackSource(track);
        if (track.selectedVariant === -1) return;
        const v = track.variants[track.selectedVariant];
        if (!v || !v.buffer) return;

        const ctx = ensureAudioCtx();
        const creationBpm = track.originalParams?.bpm || 120;
        const currentBpm = parseInt(bpmInput.value) || 120;
        const rate = currentBpm / creationBpm;

        const loopDurRealTime = (v.loopMultiplier || 1) * globalDuration;
        const offsetRealTime = playOffset % loopDurRealTime;
        const offsetBuffer = offsetRealTime * rate;

        const now = ctx.currentTime;

        if (track.looping || playOffset < loopDurRealTime) {
            scheduleSourceNode(track, now, offsetBuffer);
            if (track.looping) {
                track.nextScheduleTime = now + (loopDurRealTime - offsetRealTime);
            } else {
                track.nextScheduleTime = null;
            }
        } else {
            track.nextScheduleTime = null;
        }
    }

    function updateTrackLoopState(track) {
        if (track.selectedVariant === -1) return;
        if (!track.looping) {
            track.nextScheduleTime = null;
        } else if (isPlaying && audioCtx && track.nextScheduleTime === null) {
            const v = track.variants[track.selectedVariant];
            if (v && v.buffer) {
                const loopDurRealTime = (v.loopMultiplier || 1) * globalDuration;
                const elapsed = audioCtx.currentTime - playStartCtxTime;
                const trackOffsetRealTime = elapsed % loopDurRealTime;
                track.nextScheduleTime = audioCtx.currentTime + (loopDurRealTime - trackOffsetRealTime);
            }
        }
    }

    function stopTrackSource(track) {
        if (track.scheduledSourceNodes) {
            track.scheduledSourceNodes.forEach(node => {
                try {
                    node.onended = null;
                    node.stop();
                } catch (_) { }
                try { node.disconnect(); } catch (_) { }
            });
            track.scheduledSourceNodes = [];
        }
        if (track.selectedVariant !== -1) {
            const v = track.variants[track.selectedVariant];
            if (v) v.sourceNode = null;
        }
        track.nextScheduleTime = null;
    }

    // --- Variant selection (switch which variant plays in a row) ---
    function selectVariant(track, variantIndex) {
        const wasPlaying = isPlaying;

        // If variantIndex is -1 or same as currently selected, deselect it (disable track)
        if (variantIndex === -1 || variantIndex === track.selectedVariant) {
            if (track.selectedVariant !== -1) {
                track.variants[track.selectedVariant].el.classList.remove('is-selected');
                if (wasPlaying) stopTrackSource(track);
                track.selectedVariant = -1;
            }

            // Redraw waveforms for this row to show non-selected state
            track.variants.forEach((v, i) => {
                drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, false, track.originalParams?.bpm);
            });
            return;
        }

        // Deselect old
        if (track.selectedVariant !== -1) {
            track.variants[track.selectedVariant].el.classList.remove('is-selected');
            if (wasPlaying) stopTrackSource(track);
        }

        // Select new
        track.selectedVariant = variantIndex;
        track.variants[variantIndex].el.classList.add('is-selected');

        // Redraw waveforms for this row
        track.variants.forEach((v, i) => {
            drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, i === variantIndex, track.originalParams?.bpm);
        });

        // Start new source if playing
        if (wasPlaying) {
            // Recalculate offset to stay in sync
            if (audioCtx) {
                playOffset = (audioCtx.currentTime - playStartCtxTime) % getActiveDuration();
            }
            startTrackSource(track);
        }
    }

    // --- Seek ---
    function seekTo(pct) {
        const activeDuration = getActiveDuration();
        playOffset = pct * activeDuration;
        if (isPlaying) {
            // Restart all sources at new offset
            tracks.forEach(t => {
                stopTrackSource(t);
                startTrackSource(t);
            });
            playStartCtxTime = audioCtx.currentTime - playOffset;
        }
        updatePlayheads();
    }

    // --- RAF ---
    // --- Visualizer Tray ---
    const vizSpectrumCanvas = document.getElementById('viz-spectrum');
    const vizOscCanvas = document.getElementById('viz-oscilloscope');
    const vizMetersCanvas = document.getElementById('viz-meters');
    let vizAnalyser = null; // separate analyser with larger FFT for spectrum
    let vizTimeDomain = null;
    let vizFreqData = null;
    let vizPeakL = 0, vizPeakR = 0;
    const vizDecay = 0.92;

    function initVizAnalyser() {
        if (vizAnalyser || !audioCtx) return;
        vizAnalyser = audioCtx.createAnalyser();
        vizAnalyser.fftSize = 2048;
        vizAnalyser.smoothingTimeConstant = 0.8;
        // Tap off the masterGain node (before limiter, same as master chain)
        masterGain.connect(vizAnalyser);
        vizFreqData = new Uint8Array(vizAnalyser.frequencyBinCount);
        vizTimeDomain = new Uint8Array(vizAnalyser.fftSize);
    }

    function renderVizSpectrum() {
        if (!vizSpectrumCanvas || !vizAnalyser) return;
        const canvas = vizSpectrumCanvas;
        const ctx2d = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas._cachedRect || canvas.getBoundingClientRect();
        const expectedW = Math.round(rect.width * dpr);
        const expectedH = Math.round(rect.height * dpr);
        if (canvas.width !== expectedW || canvas.height !== expectedH) {
            canvas.width = expectedW;
            canvas.height = expectedH;
            ctx2d.scale(dpr, dpr);
        } else {
            // Reset transform for clearRect
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        
        const w = rect.width, h = rect.height;

        ctx2d.clearRect(0, 0, w, h);
        vizAnalyser.getByteFrequencyData(vizFreqData);

        // Log-scale spectrum bars (pulse-style)
        const binCount = vizAnalyser.frequencyBinCount;
        const nyquist = audioCtx.sampleRate / 2;
        const minFreq = 20, maxFreq = 20000;
        const logMin = Math.log(minFreq), logMax = Math.log(maxFreq);
        const barCount = Math.min(128, Math.floor(w / 2));

        // Create gradient
        const grad = ctx2d.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, 'rgba(59, 130, 246, 0.6)');
        grad.addColorStop(0.4, 'rgba(139, 92, 246, 0.7)');
        grad.addColorStop(0.7, 'rgba(236, 72, 153, 0.8)');
        grad.addColorStop(1.0, 'rgba(239, 68, 68, 0.9)');

        for (let i = 0; i < barCount; i++) {
            // Log-spaced frequency bands
            const f0 = Math.exp(logMin + (i / barCount) * (logMax - logMin));
            const f1 = Math.exp(logMin + ((i + 1) / barCount) * (logMax - logMin));
            const bin0 = Math.max(0, Math.floor(f0 / nyquist * binCount));
            const bin1 = Math.min(binCount - 1, Math.floor(f1 / nyquist * binCount));

            // Average bins in this band
            let sum = 0, count = 0;
            for (let b = bin0; b <= bin1; b++) { sum += vizFreqData[b]; count++; }
            const val = count > 0 ? sum / count / 255 : 0;

            const barW = w / barCount;
            const barH = val * h * 0.95;
            const x = i * barW;

            ctx2d.fillStyle = grad;
            ctx2d.fillRect(x, h - barH, barW - 1, barH);
        }
    }

    function renderVizOscilloscope() {
        if (!vizOscCanvas || !vizAnalyser) return;
        const canvas = vizOscCanvas;
        const ctx2d = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas._cachedRect || canvas.getBoundingClientRect();
        
        const expectedW = Math.round(rect.width * dpr);
        const expectedH = Math.round(rect.height * dpr);
        if (canvas.width !== expectedW || canvas.height !== expectedH) {
            canvas.width = expectedW;
            canvas.height = expectedH;
            ctx2d.scale(dpr, dpr);
        } else {
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const w = rect.width, h = rect.height;

        ctx2d.clearRect(0, 0, w, h);
        vizAnalyser.getByteTimeDomainData(vizTimeDomain);

        // Center line
        ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(0, h / 2);
        ctx2d.lineTo(w, h / 2);
        ctx2d.stroke();

        // Waveform with glow
        ctx2d.shadowColor = 'rgba(59, 130, 246, 0.5)';
        ctx2d.shadowBlur = 6;
        ctx2d.strokeStyle = 'rgba(139, 200, 255, 0.85)';
        ctx2d.lineWidth = 1.5;
        ctx2d.beginPath();

        const bufLen = vizTimeDomain.length;
        const sliceW = w / bufLen;
        for (let i = 0; i < bufLen; i++) {
            const v = vizTimeDomain[i] / 128.0;
            const y = (v * h) / 2;
            if (i === 0) ctx2d.moveTo(0, y);
            else ctx2d.lineTo(i * sliceW, y);
        }
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
    }

    function renderVizMeters() {
        if (!vizMetersCanvas || !vizAnalyser) return;
        const canvas = vizMetersCanvas;
        const ctx2d = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas._cachedRect || canvas.getBoundingClientRect();

        const expectedW = Math.round(rect.width * dpr);
        const expectedH = Math.round(rect.height * dpr);
        if (canvas.width !== expectedW || canvas.height !== expectedH) {
            canvas.width = expectedW;
            canvas.height = expectedH;
            ctx2d.scale(dpr, dpr);
        } else {
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        const w = rect.width, h = rect.height;

        ctx2d.clearRect(0, 0, w, h);

        // Get peak from time domain
        vizAnalyser.getByteTimeDomainData(vizTimeDomain);
        let peakNow = 0;
        for (let i = 0; i < vizTimeDomain.length; i++) {
            const v = Math.abs(vizTimeDomain[i] - 128) / 128;
            if (v > peakNow) peakNow = v;
        }
        vizPeakL = Math.max(peakNow, vizPeakL * vizDecay);
        vizPeakR = Math.max(peakNow * (0.9 + Math.random() * 0.1), vizPeakR * vizDecay);

        const barW = Math.floor(w / 3);
        const gap = Math.floor((w - barW * 2) / 3);

        // Draw L and R meter bars
        [vizPeakL, vizPeakR].forEach((peak, ch) => {
            const x = gap + ch * (barW + gap);
            const barH = peak * h * 0.9;

            // Gradient from green to yellow to red
            const grad = ctx2d.createLinearGradient(0, h, 0, 0);
            grad.addColorStop(0, '#22c55e');
            grad.addColorStop(0.6, '#eab308');
            grad.addColorStop(0.85, '#ef4444');
            ctx2d.fillStyle = grad;
            ctx2d.fillRect(x, h - barH - 2, barW, barH);

            // Label
            ctx2d.fillStyle = 'rgba(255,255,255,0.4)';
            ctx2d.font = '8px sans-serif';
            ctx2d.textAlign = 'center';
            ctx2d.fillText(ch === 0 ? 'L' : 'R', x + barW / 2, h - 1);
        });
    }

    let lastBarIndex = -1;
    let lastLoopIndex = -1;

    function runAudioSchedulerTick() {
        if (!audioCtx) return;

        const bpm = parseInt(bpmInput.value) || 120;
        const barDuration = 240.0 / bpm;
        const activeDuration = getActiveDuration();

        let currentTime = 0;
        if (isPlaying) {
            currentTime = (audioCtx.currentTime - playStartCtxTime) % activeDuration;
        } else {
            currentTime = playOffset % activeDuration;
        }

        // Pump manual look-ahead loop scheduler
        if (isPlaying) {
            const now = audioCtx.currentTime;
            const lookAheadTime = 0.15; // 150ms look-ahead
            tracks.forEach(track => {
                if (track.selectedVariant === -1 || !track.looping) return;
                const v = track.variants[track.selectedVariant];
                if (!v || !v.buffer) return;

                const loopDurRealTime = (v.loopMultiplier || 1) * globalDuration;

                while (track.nextScheduleTime !== null && track.nextScheduleTime < now + lookAheadTime) {
                    scheduleSourceNode(track, track.nextScheduleTime, 0);
                    track.nextScheduleTime += loopDurRealTime;
                }
            });
        }

        // Track bar index boundary
        const barIndex = Math.floor(currentTime / barDuration);
        if (isPlaying && barIndex !== lastBarIndex) {
            lastBarIndex = barIndex;
            triggerEnvelopes('bar', audioCtx.currentTime);
        }

        // Track loop index boundary for arranger
        const loopIndex = Math.floor(currentTime / globalDuration);
        if (isPlaying && arrangerModeActive && loopIndex !== lastLoopIndex) {
            lastLoopIndex = loopIndex;
            applyArrangerMutingForLoop(loopIndex);
        }

        // Smooth arranger/mute gates
        const anySoloed = tracks.some(t => t.soloed);
        tracks.forEach(t => {
            t._arrangerGate = t._arrangerGate !== undefined ? t._arrangerGate : 1.0;
            if (arrangerModeActive) {
                const gridArray = arrangerGrid[t.id];
                const isCellActive = gridArray ? !!gridArray[loopIndex] : false;
                const standardMuted = t.muted || (anySoloed && !t.soloed);
                t._targetGate = (isCellActive && !standardMuted) ? 1.0 : 0.0;
            } else {
                t._targetGate = (t.muted || (anySoloed && !t.soloed)) ? 0.0 : 1.0;
            }
            t._arrangerGate += (t._targetGate - t._arrangerGate) * 0.3;
        });

        // Calculate LFOs
        const getLfoValue = (lfo, num) => {
            if (!lfo.enabled) return 0.0;
            let period = 1.0;
            if (lfo.mode === 'sync') {
                const bars = parseFloat(lfo.syncRate) || 1.0;
                period = bars * (240.0 / bpm);
            } else {
                period = 1.0 / (lfo.freeRate || 1.0);
            }
            const phase = (currentTime / period) % 1.0;
            switch (lfo.shape) {
                case 'sine': return Math.sin(2.0 * Math.PI * phase);
                case 'triangle': return phase < 0.5 ? (4.0 * phase - 1.0) : (3.0 - 4.0 * phase);
                case 'sawtooth': return 2.0 * phase - 1.0;
                case 'square': return phase < 0.5 ? 1.0 : -1.0;
                case 'random': {
                    const cycleIndex = Math.floor(currentTime / period);
                    const stateKey = `lfo${num}_sh`;
                    if (globalModulators[stateKey] === undefined || globalModulators[stateKey].cycle !== cycleIndex) {
                        globalModulators[stateKey] = {
                            cycle: cycleIndex,
                            val: Math.random() * 2.0 - 1.0
                        };
                    }
                    return globalModulators[stateKey].val;
                }
                default: return 0.0;
            }
        };

        const lfo1Val = getLfoValue(globalModulators.lfo1, 1);
        const lfo2Val = getLfoValue(globalModulators.lfo2, 2);
        const lfo3Val = getLfoValue(globalModulators.lfo3, 3);
        const lfo4Val = getLfoValue(globalModulators.lfo4, 4);

        // Calculate Envelopes (Disabled)
        const getEnvValue = (env) => {
            return 0.0;
        };

        const env1Val = getEnvValue(globalModulators.env1);
        const env2Val = getEnvValue(globalModulators.env2);

        const modBypassEl = getModBypassEl();
        const isModBypassed = modBypassEl ? modBypassEl.checked : false;

        const modOffsets = {};
        const masterOffsets = { level: 0 };

        if (!isModBypassed) {
            modMatrixSlots.forEach(slot => {
                if (slot.src === 'none' || slot.trackId === 'none' || slot.param === 'none' || slot.depth === 0) return;
                let modVal = 0.0;
                if (slot.src === 'lfo1') modVal = lfo1Val;
                else if (slot.src === 'lfo2') modVal = lfo2Val;
                else if (slot.src === 'lfo3') modVal = lfo3Val;
                else if (slot.src === 'lfo4') modVal = lfo4Val;
                else if (slot.src === 'env1') modVal = env1Val;
                else if (slot.src === 'env2') modVal = env2Val;

                const offset = (slot.depth / 100) * modVal;
                if (slot.trackId === 'master') {
                    masterOffsets[slot.param] = (masterOffsets[slot.param] || 0) + offset;
                } else {
                    const tid = parseInt(slot.trackId);
                    if (!modOffsets[tid]) {
                        modOffsets[tid] = {
                            level: 0,
                            pan: 0,
                            filter: 0,
                            space: 0,
                            chorusRate: 0,
                            chorusDepth: 0,
                            chorusFeedback: 0,
                            phaserRate: 0,
                            phaserDepth: 0,
                            phaserFeedback: 0,
                            crusherBits: 0,
                            crusherNormfreq: 0
                        };
                    }
                    modOffsets[tid][slot.param] += offset;
                }
            });
        }

        // Apply offsets to tracks. This runs every 25ms: cache DOM lookups on
        // the track and skip node/DOM writes whose value did not change.
        tracks.forEach(track => {
            const offsets = modOffsets[track.id] || ZERO_MOD_OFFSETS;

            const rampTime = audioCtx.currentTime + 0.015;
            const last = track._lastApplied || (track._lastApplied = {});

            // Volume
            let level = track.level + offsets.level;
            level = Math.max(0, Math.min(1, level));
            const gainTarget = level * track._arrangerGate;
            if (track.gainNode && gainTarget !== last.gain) {
                last.gain = gainTarget;
                track.gainNode.gain.setTargetAtTime(gainTarget, rampTime, 0.02);
            }
            updateSliderModDot(track, '.level-knob', level);

            // Pan
            let pan = track.pan + offsets.pan * 2.0;
            pan = Math.max(-1, Math.min(1, pan));
            if (pan !== last.pan) {
                last.pan = pan;
                if (track.panNode) {
                    track.panNode.pan.setTargetAtTime(pan, rampTime, 0.025);
                }
                let panUi = track._panUi;
                if (panUi === undefined) {
                    const panKnob = track.wrapper.querySelector('.pan-knob');
                    panUi = track._panUi = panKnob ? {
                        indicator: panKnob.querySelector('.pan-knob-indicator'),
                        text: track.wrapper.querySelector('.pan-value')
                    } : null;
                }
                if (panUi) {
                    if (panUi.indicator) setPresentation(panUi.indicator, { transform: `rotate(${pan * 135}deg)` });
                    const displayVal = Math.round(pan * 100);
                    if (panUi.text && displayVal !== last.panDisplay) {
                        last.panDisplay = displayVal;
                        panUi.text.textContent = displayVal === 0 ? 'C' : displayVal < 0 ? `L${Math.abs(displayVal)}` : `R${displayVal}`;
                    }
                }
            }

            // Filter
            let filterCutoff = track.filtrCutoff + offsets.filter * 15000;
            filterCutoff = Math.max(20, Math.min(20000, filterCutoff));
            if (filterCutoff !== last.filterCutoff) {
                last.filterCutoff = filterCutoff;
                if (track.filtrFilterNode) {
                    track.filtrFilterNode.frequency.setTargetAtTime(filterCutoff, rampTime, 0.025);
                }
            }
            updateSliderModDot(track, '.filtr-cutoff', (filterCutoff - 20) / 19980);
            // Space
            let space = offsets.space;
            let dMix = Math.max(0, Math.min(1, track.aelapseDelayMix + space));
            let rMix = Math.max(0, Math.min(1, track.aelapseReverbMix + space));
            if (dMix !== last.dMix) {
                last.dMix = dMix;
                if (track.aelapseDelayGainNode) {
                    track.aelapseDelayGainNode.gain.setTargetAtTime(dMix, rampTime, 0.02);
                }
            }
            if (rMix !== last.rMix) {
                last.rMix = rMix;
                if (track.aelapseReverbGainNode) {
                    track.aelapseReverbGainNode.gain.setTargetAtTime(rMix, rampTime, 0.02);
                }
            }
            updateSliderModDot(track, '.aelapse-delay-mix', dMix);
            updateSliderModDot(track, '.aelapse-reverb-mix', rMix);

            // Chorus Rate
            let chorusRate = track.tunaChorusRate + offsets.chorusRate * 8.0;
            chorusRate = Math.max(0.01, Math.min(8.0, chorusRate));
            if (chorusRate !== last.chorusRate) {
                last.chorusRate = chorusRate;
                if (track.tunaChorusRateSync === 'Free' && track.tunaChorusNode) {
                    track.tunaChorusNode.rate = chorusRate;
                }
            }
            updateSliderModDot(track, '.chorus-rate', (chorusRate - 0.01) / 7.99);

            // Chorus Depth
            let chorusDepth = track.tunaChorusDepth + offsets.chorusDepth;
            chorusDepth = Math.max(0.0, Math.min(1.0, chorusDepth));
            if (chorusDepth !== last.chorusDepth) {
                last.chorusDepth = chorusDepth;
                if (track.tunaChorusNode) {
                    track.tunaChorusNode.depth = chorusDepth;
                }
            }
            updateSliderModDot(track, '.chorus-depth', chorusDepth);

            // Chorus Feedback
            let chorusFeedback = track.tunaChorusFeedback + offsets.chorusFeedback;
            chorusFeedback = Math.max(0.0, Math.min(0.95, chorusFeedback));
            if (chorusFeedback !== last.chorusFeedback) {
                last.chorusFeedback = chorusFeedback;
                if (track.tunaChorusNode) {
                    track.tunaChorusNode.feedback = chorusFeedback;
                }
            }
            updateSliderModDot(track, '.chorus-feedback', chorusFeedback / 0.95);

            // Phaser Rate
            let phaserRate = track.tunaPhaserRate + offsets.phaserRate * 8.0;
            phaserRate = Math.max(0.01, Math.min(8.0, phaserRate));
            if (phaserRate !== last.phaserRate) {
                last.phaserRate = phaserRate;
                if (track.tunaPhaserRateSync === 'Free' && track.tunaPhaserNode) {
                    track.tunaPhaserNode.rate = phaserRate;
                }
            }
            updateSliderModDot(track, '.phaser-rate', (phaserRate - 0.01) / 7.99);

            // Phaser Depth
            let phaserDepth = track.tunaPhaserDepth + offsets.phaserDepth;
            phaserDepth = Math.max(0.0, Math.min(1.0, phaserDepth));
            if (phaserDepth !== last.phaserDepth) {
                last.phaserDepth = phaserDepth;
                if (track.tunaPhaserNode) {
                    track.tunaPhaserNode.depth = phaserDepth;
                }
            }
            updateSliderModDot(track, '.phaser-depth', phaserDepth);

            // Phaser Feedback
            let phaserFeedback = track.tunaPhaserFeedback + offsets.phaserFeedback;
            phaserFeedback = Math.max(0.0, Math.min(1.0, phaserFeedback));
            if (phaserFeedback !== last.phaserFeedback) {
                last.phaserFeedback = phaserFeedback;
                if (track.tunaPhaserNode) {
                    track.tunaPhaserNode.feedback = phaserFeedback;
                }
            }
            updateSliderModDot(track, '.phaser-feedback', phaserFeedback);

            // Crusher Bits
            let crusherBits = track.tunaBitcrusherBits + offsets.crusherBits * 16.0;
            crusherBits = Math.max(1, Math.min(16, Math.round(crusherBits)));
            if (crusherBits !== last.crusherBits) {
                last.crusherBits = crusherBits;
                if (track.tunaBitcrusherNode) {
                    track.tunaBitcrusherNode.bits = crusherBits;
                }
            }
            updateSliderModDot(track, '.crusher-bits', (crusherBits - 1) / 15.0);

            // Crusher Freq Div
            let crusherNormfreq = track.tunaBitcrusherNormfreq + offsets.crusherNormfreq;
            crusherNormfreq = Math.max(0.001, Math.min(1.0, crusherNormfreq));
            if (crusherNormfreq !== last.crusherNormfreq) {
                last.crusherNormfreq = crusherNormfreq;
                if (track.tunaBitcrusherNode) {
                    track.tunaBitcrusherNode.normfreq = crusherNormfreq;
                }
            }
            updateSliderModDot(track, '.crusher-normfreq', (crusherNormfreq - 0.001) / 0.999);
        });

        // Master Volume
        if (!_masterUiCache) {
            _masterUiCache = {
                slider: document.getElementById('master-volume-slider'),
                readout: document.getElementById('master-volume-readout')
            };
        }
        const masterValSlider = _masterUiCache.slider;
        if (masterVolumeNode && masterValSlider) {
            const baseVal = parseInt(masterValSlider.value) || 100;
            const modBaseVal = baseVal + masterOffsets.level * 100;
            const clampedVal = Math.max(0, Math.min(100, modBaseVal));
            const p = getMasterFaderParams(clampedVal);
            if (masterVolumeNode.gain.value !== p.volumeGain) masterVolumeNode.gain.value = p.volumeGain;
            if (masterLimiter.threshold.value !== p.threshold) masterLimiter.threshold.value = p.threshold;

            const masterReadout = _masterUiCache.readout;
            if (masterReadout) {
                const readoutText = `${p.displayDb === -Infinity ? '-inf' : p.displayDb.toFixed(1)} dB`;
                if (masterReadout.textContent !== readoutText) masterReadout.textContent = readoutText;
            }
        }
    }

    function startRAF() {
        cancelRAF();
        function tick() {
            updatePlayheads();

            if (isPlaying && vizAnalyser) {
                renderVizSpectrum();
                renderVizOscilloscope();
                renderVizMeters();
            }
            rafId = requestAnimationFrame(tick);
        }
        rafId = requestAnimationFrame(tick);
    }

    function cancelRAF() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function renderLFOVisualizers(currentTime) {
        const modulatorsPanel = document.getElementById('modulators-panel');
        if (!modulatorsPanel || !modulatorsPanel.classList.contains('is-open')) return;

        const bpm = parseInt(bpmInput.value) || 120;
        const colors = ['#10b981', '#00f2fe', '#facc15', '#ec4899'];

        for (let num = 1; num <= 4; num++) {
            const lfo = globalModulators[`lfo${num}`];
            if (!lfo) continue;

            // 1. Update timing LED
            const led = getLfoVizEls(num).led;
            let period = 1.0;
            if (lfo.mode === 'sync') {
                const bars = parseFloat(lfo.syncRate) || 1.0;
                period = bars * (240.0 / bpm);
            } else {
                period = 1.0 / (lfo.freeRate || 1.0);
            }
            const phase = (currentTime / period) % 1.0;

            let val = 0.0;
            switch (lfo.shape) {
                case 'sine':
                    val = Math.sin(2.0 * Math.PI * phase);
                    break;
                case 'triangle':
                    val = phase < 0.5 ? (4.0 * phase - 1.0) : (3.0 - 4.0 * phase);
                    break;
                case 'sawtooth':
                    val = 2.0 * phase - 1.0;
                    break;
                case 'square':
                    val = phase < 0.5 ? 1.0 : -1.0;
                    break;
                case 'random': {
                    const cycleIndex = Math.floor(currentTime / period);
                    const stateKey = `lfo${num}_sh`;
                    if (globalModulators[stateKey] === undefined || globalModulators[stateKey].cycle !== cycleIndex) {
                        globalModulators[stateKey] = {
                            cycle: cycleIndex,
                            val: Math.random() * 2.0 - 1.0
                        };
                    }
                    val = globalModulators[stateKey].val;
                    break;
                }
            }

            if (led) {
                if (lfo.enabled) {
                    const intensity = (val + 1.0) / 2.0; // 0 to 1
                    setPresentation(led, { opacity: (0.2 + 0.8 * intensity).toString() });
                    setPresentation(led, { boxShadow: `0 0 ${Math.round(2 + 8 * intensity)}px ${colors[num - 1]}` });
                    setPresentation(led, { color: colors[num - 1] });
                } else {
                    setPresentation(led, { opacity: '0.15' });
                    setPresentation(led, { boxShadow: 'none' });
                    setPresentation(led, { color: 'var(--text-tertiary)' });
                }
            }

            // 2. Draw waveform canvas
            const canvas = getLfoVizEls(num).canvas;
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                if (!lfo.enabled) {
                    // Draw disabled straight line
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(0, canvas.height / 2);
                    ctx.lineTo(canvas.width, canvas.height / 2);
                    ctx.stroke();
                } else {
                    const color = colors[num - 1];
                    const steps = 8;
                    const stepW = canvas.width / steps;

                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.5;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.beginPath();

                    if (lfo.shape === 'random') {
                        // Draw sample and hold steps
                        for (let s = 0; s < steps; s++) {
                            const stepVal = Math.sin(s * 13.37) * 0.75;
                            const y = (canvas.height / 2) - stepVal * (canvas.height / 2 - 6);
                            const xStart = s * stepW;
                            const xEnd = (s + 1) * stepW;
                            if (s === 0) {
                                ctx.moveTo(xStart, y);
                            } else {
                                ctx.lineTo(xStart, y);
                            }
                            ctx.lineTo(xEnd, y);
                        }
                    } else {
                        // Draw smooth wave
                        for (let x = 0; x <= canvas.width; x++) {
                            const tPhase = x / canvas.width;
                            let yVal = 0.0;
                            switch (lfo.shape) {
                                case 'sine':
                                    yVal = Math.sin(2.0 * Math.PI * tPhase);
                                    break;
                                case 'triangle':
                                    yVal = tPhase < 0.5 ? (4.0 * tPhase - 1.0) : (3.0 - 4.0 * tPhase);
                                    break;
                                case 'sawtooth':
                                    yVal = 2.0 * tPhase - 1.0;
                                    break;
                                case 'square':
                                    yVal = tPhase < 0.5 ? 1.0 : -1.0;
                                    break;
                            }
                            const y = (canvas.height / 2) - yVal * (canvas.height / 2 - 6);
                            if (x === 0) {
                                ctx.moveTo(x, y);
                            } else {
                                ctx.lineTo(x, y);
                            }
                        }
                    }
                    ctx.stroke();

                    // Draw vertical playhead
                    const px = phase * canvas.width;
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
                    ctx.lineWidth = 1.0;
                    ctx.beginPath();
                    ctx.moveTo(px, 0);
                    ctx.lineTo(px, canvas.height);
                    ctx.stroke();

                    // Draw playhead cursor dot on wave
                    let pyVal = val;
                    if (lfo.shape === 'random') {
                        const activeStep = Math.floor(phase * steps);
                        pyVal = Math.sin(activeStep * 13.37) * 0.75;
                    }
                    const py = (canvas.height / 2) - pyVal * (canvas.height / 2 - 6);
                    ctx.fillStyle = '#ffffff';
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 4;
                    ctx.beginPath();
                    ctx.arc(px, py, 3, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.shadowBlur = 0; // reset
                }
            }
        }
    }

    let prevPlayPct = 0;

    function updatePlayheads() {
        let currentTime;
        const bpm = parseInt(bpmInput.value) || 120;
        const activeDuration = getActiveDuration();

        if (isPlaying && audioCtx) {
            currentTime = (audioCtx.currentTime - playStartCtxTime) % activeDuration;
        } else {
            currentTime = playOffset % activeDuration;
        }

        renderLFOVisualizers(currentTime);

        const pct = activeDuration > 0 ? currentTime / activeDuration : 0;
        // Runs per rAF frame: only touch the DOM when the text changed.
        const posText = formatTime(currentTime);
        if (tPosition.textContent !== posText) tPosition.textContent = posText;
        const durText = formatTime(activeDuration);
        if (tDuration.textContent !== durText) tDuration.textContent = durText;

        // Detect loop boundary
        if (isPlaying && pct < prevPlayPct - 0.5) {
            if (isRecording) {
                captureTrackStates(recordedLoopCounter, 'End');
                recordedLoopCounter++;
                captureTrackStates(recordedLoopCounter, 'Start');
            }
            tracks.forEach(t => {
                if (t._pendingVariant !== undefined && t._pendingVariant !== null) {
                    const qi = t._pendingVariant;
                    t._pendingVariant = null;
                    t.variants.forEach(v => v.el.classList.remove('is-queued'));
                    selectVariant(t, qi);
                }
            });
            triggerEnvelopes('loop', audioCtx.currentTime);
            lastBarIndex = -1;
            lastLoopIndex = -1;
        }
        prevPlayPct = pct;

        // Update card playheads.
        // data-progress must land on the elements whose CSS reads it —
        // .card-playhead and .card-progress-fill. attr() does not inherit,
        // so writing it to the .card-seek-bar parent leaves both at 0.
        tracks.forEach(t => {
            t.variants.forEach(v => {
                if (!v.seekBarEl && v.el) {
                    v.seekBarEl = v.el.querySelector('.card-seek-bar');
                    v.playheadEl = v.el.querySelector('.card-playhead');
                    v.progressFillEl = v.el.querySelector('.card-progress-fill');
                }
                if (v.seekBarEl) {
                    const dur = (v.loopMultiplier || 1) * globalDuration;
                    // Quantize to ~0.1% steps and skip unchanged writes so
                    // idle frames don't invalidate style on every card.
                    const localProgress = Math.round(((currentTime % dur) / dur) * 1000) / 1000;
                    if (v._lastProgress !== localProgress) {
                        v._lastProgress = localProgress;
                        const progress = localProgress.toString();
                        setPresentation(v.playheadEl, { progress });
                        setPresentation(v.progressFillEl, { progress });
                    }
                }
            });
        });

        if (arrangerModeActive) {
            const playheadLine = document.getElementById('arranger-playhead-line');
            if (playheadLine) {
                setPresentation(playheadLine, { left: `${pct * 100}%` });
            }
            const timeBarProgress = document.getElementById('arranger-time-bar-progress');
            if (timeBarProgress) {
                setPresentation(timeBarProgress, { width: `${pct * 100}%` });
            }
        }
    }

    // --- Waveform ---
    function drawWaveform(canvas, buffer, isSelected, trackBpm) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);

        if (w === 0 || h === 0) return;

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.clearRect(0, 0, w, h);

        if (!buffer || buffer.length === 0) return;

        const bpm = trackBpm || (bpmInput ? parseInt(bpmInput.value) : 120);
        const oneLoopDur = 960 / bpm;
        const loopMultiplier = Math.max(1, Math.round(buffer.duration / oneLoopDur));
        const activeDuration = loopMultiplier * oneLoopDur;

        // Draw visual 1/8th tempo grid behind waveform
        const eighthNoteDuration = 30 / bpm;
        const numEighthNotes = Math.round(activeDuration / eighthNoteDuration);

        for (let i = 1; i < numEighthNotes; i++) {
            const x = (i / numEighthNotes) * w;
            if (i % 8 === 0) {
                // Bar line (every 8 eighth notes)
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
                ctx.lineWidth = 1.5;
            } else if (i % 2 === 0) {
                // Beat line (every 2 eighth notes)
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
                ctx.lineWidth = 1.0;
            } else {
                // 1/8 note division line
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
                ctx.lineWidth = 0.5;
            }
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        const data = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;
        const playSamples = Math.min(data.length, Math.round(activeDuration * sampleRate));
        const barCount = Math.max(1, Math.floor(w / 2.5));
        const samplesPerBar = Math.floor(playSamples / barCount);

        // First pass: compute per-bar peaks and find the global max
        const peaks = new Float32Array(barCount);
        let globalPeak = 0;
        for (let i = 0; i < barCount; i++) {
            let max = 0;
            const start = i * samplesPerBar;
            const end = Math.min(start + samplesPerBar, playSamples);
            for (let j = start; j < end; j++) {
                const abs = Math.abs(data[j]);
                if (abs > max) max = abs;
            }
            peaks[i] = max;
            if (max > globalPeak) globalPeak = max;
        }

        // Scale factor: tallest bar fills 90% of height
        const scale = globalPeak > 0.001 ? 0.9 / globalPeak : 1;

        ctx.fillStyle = isSelected
            ? 'rgba(59, 130, 246, 0.55)'
            : 'rgba(59, 130, 246, 0.25)';

        // Second pass: draw scaled bars
        for (let i = 0; i < barCount; i++) {
            const barH = peaks[i] * scale * h;
            const y = (h - barH) / 2;
            ctx.fillRect(i * (w / barCount), y, Math.max(1, w / barCount - 1), barH);
        }
    }

    function updateEqBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.eq-toggle', track.eqEnabled);
        if (track.eqEnabled) {
            track.eqDryGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
            track.eqWetGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
        } else {
            track.eqDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.eqWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }



    function updateAelapseBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.aelapse-delay-toggle', track.aelapseDelayEnabled);
        syncTrackTogglePressed(track, '.aelapse-reverb-toggle', track.aelapseReverbEnabled);
        const delayMix = track.aelapseDelayEnabled ? track.aelapseDelayMix : 0.0;
        const reverbMix = track.aelapseReverbEnabled ? track.aelapseReverbMix : 0.0;
        track.aelapseDelayGainNode.gain.setTargetAtTime(delayMix, ctx.currentTime, 0.01);
        track.aelapseReverbGainNode.gain.setTargetAtTime(reverbMix, ctx.currentTime, 0.01);
        track.aelapseDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
    }

    function updateFiltrBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.filtr-toggle', track.filtrEnabled);
        if (track.filtrEnabled) {
            const mix = track.filtrMix;
            track.filtrDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.filtrWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.filtrDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.filtrWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateScreamBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.scream-toggle', track.screamEnabled);
        if (track.screamEnabled) {
            const mix = track.screamMix;
            track.screamDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.screamWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.screamDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.screamWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateTunaChorusBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.chorus-toggle', track.tunaChorusEnabled);
        if (track.tunaChorusEnabled) {
            const mix = track.tunaChorusMix;
            track.tunaChorusDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.tunaChorusWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.tunaChorusDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.tunaChorusWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateTunaPhaserBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.phaser-toggle', track.tunaPhaserEnabled);
        if (track.tunaPhaserEnabled) {
            const mix = track.tunaPhaserMix;
            track.tunaPhaserDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.tunaPhaserWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.tunaPhaserDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.tunaPhaserWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateTunaBitcrusherBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.crusher-toggle', track.tunaBitcrusherEnabled);
        if (track.tunaBitcrusherEnabled) {
            const mix = track.tunaBitcrusherMix;
            track.tunaBitcrusherDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.tunaBitcrusherWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.tunaBitcrusherDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.tunaBitcrusherWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateTremoloBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.tremolo-toggle', track.tremoloEnabled);
        if (track.tremoloEnabled) {
            track.tremoloLfoGainNode.gain.setTargetAtTime(track.tremoloDepth, ctx.currentTime, 0.01);
        } else {
            track.tremoloLfoGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateGateBypass(track) {
        const ctx = ensureAudioCtx();
        syncTrackTogglePressed(track, '.gate-toggle', track.gateEnabled);
        if (track.gateEnabled) {
            const mix = track.gateMix;
            track.gateDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.gateWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.gateDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.gateWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateGateFrequency(track) {
        const ctx = ensureAudioCtx();
        const bpm = parseInt(bpmInput.value) || 120;
        const syncIdx = track.gateSyncIndex !== undefined ? track.gateSyncIndex : 2;
        track.gateLfoNode.frequency.setTargetAtTime(
            getTempoGateFrequency(bpm, syncIdx), ctx.currentTime, 0.02
        );
    }

    function updateGateWidth(track) {
        const ctx = ensureAudioCtx();
        const width = track.gateWidth;
        track.gateBiasNode.gain.setTargetAtTime(2.0 * (width - 0.5), ctx.currentTime, 0.01);
    }

    function updateTunaTempoSync(track) {
        const bpm = parseInt(bpmInput.value) || 120;
        const fxDrawer = track.wrapper ? track.wrapper.querySelector('.fx-drawer') : null;

        // Chorus
        if (track.tunaChorusRateSync && track.tunaChorusRateSync !== 'Free') {
            const syncValue = track.tunaChorusRateSync;
            let divisor = 240;
            if (syncValue === '4/1') divisor = 960;
            else if (syncValue === '8/1') divisor = 1920;
            else if (syncValue === '16/1') divisor = 3840;
            else if (syncValue === '32/1') divisor = 7680;
            else if (syncValue === '1/1') divisor = 240;
            else if (syncValue === '1/2') divisor = 120;
            else if (syncValue === '1/4') divisor = 60;
            else if (syncValue === '1/8') divisor = 30;
            else if (syncValue === '1/16') divisor = 15;

            const rateHz = bpm / divisor;
            track.tunaChorusRate = rateHz;
            if (track.tunaChorusNode) {
                track.tunaChorusNode.rate = rateHz;
            }
            if (fxDrawer) {
                const slider = fxDrawer.querySelector('.chorus-rate');
                const label = fxDrawer.querySelector('.chorus-rate-val');
                if (slider) {
                    slider.value = rateHz;
                    slider.disabled = true;
                }
                if (label) {
                    label.textContent = rateHz.toFixed(3) + 'Hz';
                }
            }
        } else {
            if (fxDrawer) {
                const slider = fxDrawer.querySelector('.chorus-rate');
                if (slider) {
                    slider.disabled = track.locked;
                }
            }
        }

        // Phaser
        if (track.tunaPhaserRateSync && track.tunaPhaserRateSync !== 'Free') {
            const syncValue = track.tunaPhaserRateSync;
            let divisor = 240;
            if (syncValue === '4/1') divisor = 960;
            else if (syncValue === '8/1') divisor = 1920;
            else if (syncValue === '16/1') divisor = 3840;
            else if (syncValue === '32/1') divisor = 7680;
            else if (syncValue === '1/1') divisor = 240;
            else if (syncValue === '1/2') divisor = 120;
            else if (syncValue === '1/4') divisor = 60;
            else if (syncValue === '1/8') divisor = 30;
            else if (syncValue === '1/16') divisor = 15;

            const rateHz = bpm / divisor;
            track.tunaPhaserRate = rateHz;
            if (track.tunaPhaserNode) {
                track.tunaPhaserNode.rate = rateHz;
            }
            if (fxDrawer) {
                const slider = fxDrawer.querySelector('.phaser-rate');
                const label = fxDrawer.querySelector('.phaser-rate-val');
                if (slider) {
                    slider.value = rateHz;
                    slider.disabled = true;
                }
                if (label) {
                    label.textContent = rateHz.toFixed(3) + 'Hz';
                }
            }
        } else {
            if (fxDrawer) {
                const slider = fxDrawer.querySelector('.phaser-rate');
                if (slider) {
                    slider.disabled = track.locked;
                }
            }
        }
    }

    function setupKeyboardSlider(knobEl, options) {
        const { min, max, step, getValue, setValue, label, isDisabled, signal } = options;
        knobEl.setAttribute('role', 'slider');
        knobEl.setAttribute('tabindex', '0');
        knobEl.setAttribute('aria-label', label || knobEl.title || 'Audio control');
        knobEl.setAttribute('aria-valuemin', String(min));
        knobEl.setAttribute('aria-valuemax', String(max));

        const sync = () => {
            const value = getValue();
            knobEl.setAttribute('aria-valuenow', String(value));
            knobEl.setAttribute('aria-valuetext', String(value));
        };
        const listenerOptions = signal ? { signal } : undefined;
        knobEl.addEventListener('keydown', (e) => {
            if (isDisabled && isDisabled()) return;
            const value = getValue();
            const multiplier = e.shiftKey ? 10 : 1;
            let nextValue = null;
            if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nextValue = value + step * multiplier;
            else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nextValue = value - step * multiplier;
            else if (e.key === 'PageUp') nextValue = value + step * 10;
            else if (e.key === 'PageDown') nextValue = value - step * 10;
            else if (e.key === 'Home') nextValue = min;
            else if (e.key === 'End') nextValue = max;
            if (nextValue === null) return;
            e.preventDefault();
            setValue(Math.max(min, Math.min(max, nextValue)));
            sync();
        }, listenerOptions);
        sync();
        return sync;
    }

    function initKnob(knobEl, onChange, options = {}) {
        const min = options.min !== undefined ? options.min : 0;
        const max = options.max !== undefined ? options.max : 100;
        const step = options.step !== undefined ? options.step : 1;
        const defaultVal = options.defaultVal !== undefined ? options.defaultVal : min;
        let value = options.value !== undefined ? options.value : defaultVal;
        const sensitivity = options.sensitivity || 0.005;
        const ariaLabel = options.ariaLabel || knobEl.getAttribute('aria-label') || knobEl.title || 'Audio control';

        function updateKnobRotation(val) {
            const fraction = (val - min) / (max - min);
            const deg = -135 + fraction * 270;
            const indicator = knobEl.querySelector('.knob-indicator, .macro-knob-indicator, .pan-knob-indicator, .mini-knob-indicator');
            if (indicator) {
                setPresentation(indicator, { transform: `rotate(${deg}deg)` });
            }
        }

        function updateAccessibility(val) {
            syncKnobAccessibility();
            knobEl.setAttribute('aria-valuenow', String(val));
            knobEl.setAttribute('aria-valuetext', options.formatValue ? options.formatValue(val) : String(val));
        }

        function setValue(nextValue, emitInput = false) {
            const parsed = parseFloat(nextValue);
            if (Number.isNaN(parsed)) return false;
            value = Math.max(min, Math.min(max, parsed));
            updateKnobRotation(value);
            onChange(value);
            updateAccessibility(value);
            if (emitInput) knobEl.dispatchEvent(new Event('input'));
            return true;
        }

        const syncKnobAccessibility = setupKeyboardSlider(knobEl, {
            min,
            max,
            step,
            label: ariaLabel,
            getValue: () => value,
            setValue: (nextValue) => setValue(nextValue, true),
            isDisabled: () => knobEl.disabled || knobEl.closest('.track-wrapper')?.classList.contains('track-locked'),
            signal: options.signal
        });

        // Set initial rotation
        updateKnobRotation(value);
        updateAccessibility(value);

        // Define .value property on the DOM element
        Object.defineProperty(knobEl, 'value', {
            get: () => value,
            set: (val) => {
                setValue(val);
            },
            configurable: true
        });

        let dragging = false;
        let startY = 0;
        let startVal = 0;

        knobEl.addEventListener('mousedown', (e) => {
            if (knobEl.disabled) return;
            if (knobEl.closest('.track-wrapper')?.classList.contains('track-locked')) return;
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            startY = e.clientY;
            startVal = value;
            setPresentation(document.body, { cursor: 'ns-resize' });
        });

        const listenerOpts = options.signal ? { signal: options.signal } : undefined;

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const deltaY = startY - e.clientY;
            const range = max - min;
            const valDelta = deltaY * sensitivity * range;
            let newVal = startVal + valDelta;
            if (step > 0) {
                newVal = Math.round(newVal / step) * step;
            }
            newVal = Math.max(min, Math.min(max, newVal));

            setValue(newVal, true);
        }, listenerOpts);

        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                setPresentation(document.body, { cursor: null });
            }
        }, listenerOpts);

        knobEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (knobEl.disabled) return;
            if (knobEl.closest('.track-wrapper')?.classList.contains('track-locked')) return;
            setValue(defaultVal, true);
        });

        knobEl.addEventListener('input', () => {
            updateKnobRotation(value);
            updateAccessibility(value);
        });

        return knobEl;
    }

    
    function destroyTrackAudio(track) {
        if (!track) return;
        
        // Abort all document-level event listeners bound for this track
        if (track._abort) {
            track._abort.abort();
        }
        
        // Stop playing variants
        track.variants.forEach(v => {
            if (v.sourceNode) {
                try { v.sourceNode.stop(); } catch (e) {}
                try { v.sourceNode.disconnect(); } catch (e) {}
                v.sourceNode = null;
            }
            v.buffer = null; // free audio buffer
        });
        track.variants = [];

        // Stop all tracked oscillators
        if (track._oscillators) {
            track._oscillators.forEach(osc => {
                if (osc) {
                    try { osc.stop(); } catch (e) {}
                }
            });
            track._oscillators = [];
        }

        // Disconnect all tracked nodes
        if (track._allNodes) {
            track._allNodes.forEach(node => {
                if (node && typeof node.disconnect === 'function') {
                    try { node.disconnect(); } catch (e) {}
                }
            });
            track._allNodes = [];
        }

        // Clear refs
        track.gainNode = null;
        track.panNode = null;
        track.analyserNode = null;
        track.fxInputNode = null;
        track.fxOutputNode = null;
    }

function updateTrackLockState(track) {
        const isLocked = !!track.locked;

        // Disable/enable mixer sliders
        const levelKnobEl = track.el.querySelector('.level-knob');
        const panKnobEl = track.el.querySelector('.pan-knob');
        if (levelKnobEl) {
            levelKnobEl.disabled = isLocked;
            setPresentation(levelKnobEl, { pointerEvents: isLocked ? 'none' : '' });
        }
        if (panKnobEl) setPresentation(panKnobEl, { pointerEvents: isLocked ? 'none' : '' });
        const pasteTrackBtnEl = track.el.querySelector('.paste-track-btn');
        if (pasteTrackBtnEl) pasteTrackBtnEl.disabled = isLocked;

        // Disable/enable FX drawer inputs
        const inputs = track.wrapper.querySelectorAll('.fx-drawer input');
        inputs.forEach(input => {
            input.disabled = isLocked;
        });

        // Disable/enable FX bypass buttons
        const bypassBtns = track.wrapper.querySelectorAll('.fx-toggle-btn');
        bypassBtns.forEach(btn => {
            btn.disabled = isLocked;
        });

        // Add visual styling to show it's locked
        track.wrapper.classList.toggle('track-locked', isLocked);
    }

    // --- Hover mappings ---
    const macroHoverTargets = {
        space: ['.aelapse-mix', '.aelapse-reverb-mix'],
        drive: ['.scream-mix', '.scream-amount'],
        tone: ['.eq-slider'],
        filter: ['.filtr-cutoff'],
        reso: ['.filtr-reso'],
        delay: ['.aelapse-mix'],
        feedback: ['.chorus-feedback', '.phaser-feedback'],
        crush: ['.scream-cutoff', '.scream-amount'],

        depth: ['.filtr-mix', '.scream-mix', '.chorus-mix', '.phaser-mix', '.crusher-mix'],
        rate: ['.chorus-rate', '.phaser-rate'],
        warmth: ['.eq-slider[data-band="0"]', '.eq-slider[data-band="1"]', '.scream-amount'],
        air: ['.eq-slider[data-band="5"]', '.filtr-cutoff'],
        grit: ['.crusher-bits', '.crusher-normfreq', '.scream-amount'],
        wobble: ['.chorus-depth', '.phaser-depth', '.chorus-rate'],
        presence: ['.chorus-depth', '.phaser-depth', '.aelapse-reverb-mix'],
        pump: ['.scream-amount', '.eq-slider[data-band="2"]', '.eq-slider[data-band="3"]']
    };

    const mixerMacroHoverTargets = {
        filter: ['.filtr-cutoff'],
        reso: ['.filtr-reso'],
        tone: ['.eq-slider'],
        dlyMix: ['.aelapse-mix'],
        revMix: ['.aelapse-reverb-mix']
    };

    // --- Create a track row ---
    function createTrackRow(prompt, batchFiles, trackNum) {
        const ctx = ensureAudioCtx();
        const id = trackNum;
        const macroKnobState = {};
        const fxMacroState = {};
        
        const trackAbort = new AbortController();
        const _allNodes = [];
        const _oscillators = [];

        function trackInitKnob(el, onChange, options = {}) {
            options.signal = trackAbort.signal;
            return initKnob(el, onChange, options);
        }

        // 1. Core Web Audio Nodes
        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.8;

        // Custom panner to avoid clicks/zipper noise in StereoPannerNode
        const panningInput = ctx.createGain();
        panningInput.channelCount = 2;
        panningInput.channelCountMode = 'explicit';

        const splitter = ctx.createChannelSplitter(2);
        const leftGain = ctx.createGain();
        const rightGain = ctx.createGain();
        const merger = ctx.createChannelMerger(2);

        panningInput.connect(splitter);
        splitter.connect(leftGain, 0);
        splitter.connect(rightGain, 1);
        leftGain.connect(merger, 0, 0);
        rightGain.connect(merger, 0, 1);
        merger.connect(gainNode);

        const panNode = panningInput;
        panNode.pan = {
            _val: 0,
            get value() {
                return this._val;
            },
            set value(targetVal) {
                this._val = targetVal;
                const panVal = Math.max(-1, Math.min(1, targetVal));
                let leftGainVal = 1.0;
                let rightGainVal = 1.0;
                if (panVal <= 0) {
                    rightGainVal = Math.cos((Math.PI / 2) * -panVal);
                } else {
                    leftGainVal = Math.cos((Math.PI / 2) * panVal);
                }
                leftGain.gain.value = leftGainVal;
                rightGain.gain.value = rightGainVal;
            },
            setTargetAtTime: function(targetVal, startTime, timeConstant) {
                this._val = targetVal;
                const panVal = Math.max(-1, Math.min(1, targetVal));
                let leftGainVal = 1.0;
                let rightGainVal = 1.0;
                if (panVal <= 0) {
                    rightGainVal = Math.cos((Math.PI / 2) * -panVal);
                } else {
                    leftGainVal = Math.cos((Math.PI / 2) * panVal);
                }
                leftGain.gain.setTargetAtTime(leftGainVal, startTime, timeConstant);
                rightGain.gain.setTargetAtTime(rightGainVal, startTime, timeConstant);
            },
            setValueAtTime: function(targetVal, startTime) {
                this._val = targetVal;
                const panVal = Math.max(-1, Math.min(1, targetVal));
                let leftGainVal = 1.0;
                let rightGainVal = 1.0;
                if (panVal <= 0) {
                    rightGainVal = Math.cos((Math.PI / 2) * -panVal);
                } else {
                    leftGainVal = Math.cos((Math.PI / 2) * panVal);
                }
                leftGain.gain.setValueAtTime(leftGainVal, startTime);
                rightGain.gain.setValueAtTime(rightGainVal, startTime);
            }
        };

        // Track-level compressor (Comprez-style: -6dB threshold, 5:1, 10ms attack)
        const trackCompressor = ctx.createDynamicsCompressor();
        trackCompressor.threshold.value = -6;
        trackCompressor.ratio.value = 5;
        trackCompressor.attack.value = 0.01; // 10ms
        trackCompressor.release.value = 0.15;
        trackCompressor.knee.value = 6;
        gainNode.connect(trackCompressor);

        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 1024;
        trackCompressor.connect(analyserNode);
        analyserNode.connect(masterGain);

        // 2. DSP Chain Stage A0: Filtr (HP/LP Split + Saturation Drive)
        const filtrHpFilter = ctx.createBiquadFilter();
        filtrHpFilter.type = 'highpass';
        filtrHpFilter.frequency.value = 10;
        filtrHpFilter.Q.value = 0.707;

        const filtrLpFilter = ctx.createBiquadFilter();
        filtrLpFilter.type = 'lowpass';
        filtrLpFilter.frequency.value = 20000;
        filtrLpFilter.Q.value = 0.707;

        const filtrDriveShaper = ctx.createWaveShaper();
        filtrDriveShaper.curve = makeDistortionCurve(0);

        const filtrDryGain = ctx.createGain();
        filtrDryGain.gain.value = 1.0;
        const filtrWetGain = ctx.createGain();
        filtrWetGain.gain.value = 0.0; // dry by default
        const filtrSum = ctx.createGain();
        const filtrInputNode = ctx.createGain();
        filtrInputNode.gain.value = 1.0;

        filtrInputNode.connect(filtrDryGain);
        filtrDryGain.connect(filtrSum);

        filtrInputNode.connect(filtrHpFilter);
        filtrHpFilter.connect(filtrLpFilter);
        filtrLpFilter.connect(filtrDriveShaper);
        filtrDriveShaper.connect(filtrWetGain);
        filtrWetGain.connect(filtrSum);

        const fxInputNode = filtrInputNode;

        // 2. DSP Chain Stage A: Luftikus EQ (6 bands)
        const eqFilters = [];
        const eqFreqs = [10, 40, 160, 640, 2500, 12000];
        const eqTypes = ['peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf'];

        let lastNode = null;
        for (let b = 0; b < 6; b++) {
            const filter = ctx.createBiquadFilter();
            filter.type = eqTypes[b];
            filter.frequency.value = eqFreqs[b];
            filter.Q.value = 1;
            filter.gain.value = 0;
            if (lastNode) {
                lastNode.connect(filter);
            }
            eqFilters.push(filter);
            lastNode = filter;
        }

        const eqInput = ctx.createGain();
        eqInput.gain.value = 1.0;
        const eqOutput = ctx.createGain();
        eqOutput.gain.value = 1.0;
        const eqDry = ctx.createGain();
        eqDry.gain.value = 0.0;
        const eqWet = ctx.createGain();
        eqWet.gain.value = 1.0;

        // Filtr -> EQ
        filtrSum.connect(eqInput);

        eqInput.connect(eqFilters[0]);
        eqFilters[5].connect(eqWet);
        eqWet.connect(eqOutput);
        eqInput.connect(eqDry);
        eqDry.connect(eqOutput);

        const eqOutputNode = eqOutput;

        // 2.5. DSP Chain Stage A1: Scream (Resonant Distortion Filter)
        const screamFilter = ctx.createBiquadFilter();
        screamFilter.type = 'lowpass';
        screamFilter.frequency.value = 8000;
        screamFilter.Q.value = 0.707;

        const screamShaper = ctx.createWaveShaper();
        screamShaper.curve = makeDistortionCurve(5);

        const screamDryGain = ctx.createGain();
        screamDryGain.gain.value = 1.0;
        const screamWetGain = ctx.createGain();
        screamWetGain.gain.value = 0.0; // dry by default
        const screamSum = ctx.createGain();

        eqOutputNode.connect(screamDryGain);
        screamDryGain.connect(screamSum);

        eqOutputNode.connect(screamFilter);
        screamFilter.connect(screamShaper);
        screamShaper.connect(screamWetGain);
        screamWetGain.connect(screamSum);

        // 3. Shared native insert stages. The offline renderer uses this same
        // interface, so the chorus -> phaser -> crusher route has one source.
        const liveInsertEffects = TrackEffectGraph.buildInsertChain(ctx, screamSum);
        const {
            tunaChorusNode, tunaChorusDryGain, tunaChorusWetGain, tunaChorusSum,
            tunaPhaserNode, tunaPhaserDryGain, tunaPhaserWetGain, tunaPhaserSum,
            tunaBitcrusherNode, tunaBitcrusherDryGain, tunaBitcrusherWetGain, tunaBitcrusherSum
        } = liveInsertEffects;

        // 4.5. Shared tremolo -> gate stage.  This is deliberately built by
        // TrackEffectGraph as well, so live playback and export cannot drift.
        const liveModulationEffects = TrackEffectGraph.buildModulationChain(
            ctx, liveInsertEffects.output, {}, parseInt(bpmInput.value) || 120
        );
        const {
            tremoloGainNode, tremoloLfoNode, tremoloLfoGainNode,
            gateInputNode, gateOutputNode, gateDryGainNode, gateWetGainNode,
            gateGatedGainNode, gateLfoNode, gateBiasNode, gateSumNode,
            gateShaperNode, gateDcSource
        } = liveModulationEffects;

        // The send graph is also shared with OfflineAudioContext rendering.
        const liveSendEffects = TrackEffectGraph.buildSendChain(ctx, gateOutputNode);
        const {
            aelapseDryGain, aelapseDelay, aelapseFeedbackNode, aelapseDelayGain,
            aelapseLFO, aelapseLFOGain, reverbPreDelay, aelapseReverb,
            reverbDampFilter, aelapseReverbGain, sendSumGain
        } = liveSendEffects;
        const fxOutputNode = liveSendEffects.output;

        // Connect final DSP output to pan node
        fxOutputNode.connect(panNode);

        const currentBpm = parseInt(bpmInput.value) || 120;
        const initialDelayTime = 45.0 / currentBpm;
        aelapseDelay.delayTime.value = initialDelayTime;

        _allNodes.push(
            gainNode, panningInput, splitter, leftGain, rightGain, merger, trackCompressor, analyserNode,
            filtrHpFilter, filtrLpFilter, filtrDriveShaper, filtrDryGain, filtrWetGain, filtrSum, filtrInputNode,
            eqInput, eqOutput, eqDry, eqWet, ...eqFilters,
            screamFilter, screamShaper, screamDryGain, screamWetGain, screamSum,
            tunaChorusNode.input, tunaChorusNode.output, tunaChorusNode.delay, tunaChorusNode.feedback, tunaChorusNode.lfoGain,
            tunaChorusDryGain, tunaChorusWetGain, tunaChorusSum,
            tunaPhaserNode.input, tunaPhaserNode.output, tunaPhaserNode.feedback, tunaPhaserNode.lfoGain, ...tunaPhaserNode.filters,
            tunaPhaserDryGain, tunaPhaserWetGain, tunaPhaserSum,
            tunaBitcrusherNode.input, tunaBitcrusherNode.output, tunaBitcrusherNode.shaper, tunaBitcrusherNode.filter,
            tunaBitcrusherDryGain, tunaBitcrusherWetGain, tunaBitcrusherSum,
            aelapseDryGain, aelapseDelay, aelapseFeedbackNode, aelapseDelayGain, aelapseLFOGain,
            reverbPreDelay, aelapseReverb, reverbDampFilter, aelapseReverbGain, sendSumGain,
            tremoloGainNode, tremoloLfoGainNode,
            gateInputNode, gateOutputNode, gateDryGainNode, gateWetGainNode, gateGatedGainNode, gateBiasNode, gateSumNode, gateShaperNode
        );

        _oscillators.push(
            tunaChorusNode.lfo, tunaPhaserNode.lfo, aelapseLFO, tremoloLfoNode, gateLfoNode
        );
        if (gateDcSource) {
            _allNodes.push(gateDcSource);
            _oscillators.push(gateDcSource);
        }

        // 5. Track State
        const track = {
            id,
            prompt,
            _allNodes,
            _oscillators,
            _abort: trackAbort,
            el: null,
            wrapper: null,
            gainNode,
            panNode,
            analyserNode,
            fxInputNode,
            fxOutputNode,
            aelapseDelayNode: aelapseDelay,
            aelapseReverbNode: aelapseReverb,
            meterCanvas: null,
            meterState: { rms: -60, peak: -60, peakHold: -60, peakHoldTime: 0 },
            muted: false,
            soloed: false,
            looping: true,
            level: 0.8,
            pan: 0,
            selectedVariant: 0,
            variants: [],

            locked: false,
            _arrangerGate: 1.0,
            _targetGate: 1.0,
            filtrEnabled: false,
            screamEnabled: false,
            eqEnabled: true,
            aelapseDelayEnabled: true,
            aelapseReverbEnabled: true,
            filtrDryGainNode: filtrDryGain,
            filtrWetGainNode: filtrWetGain,
            filtrHpFilterNode: filtrHpFilter,
            filtrLpFilterNode: filtrLpFilter,
            filtrDriveShaperNode: filtrDriveShaper,
            filtrFilterNode: filtrLpFilter, // for backward compatibility
            screamDryGainNode: screamDryGain,
            screamWetGainNode: screamWetGain,
            screamFilterNode: screamFilter,
            screamShaperNode: screamShaper,
            eqDryGainNode: eqDry,
            eqWetGainNode: eqWet,
            aelapseDryGainNode: aelapseDryGain,
            aelapseDelayGainNode: aelapseDelayGain,
            aelapseReverbGainNode: aelapseReverbGain,
            aelapseFeedbackNode: aelapseFeedbackNode,

            // Tremolo Nodes
            tremoloGainNode,
            tremoloLfoNode,
            tremoloLfoGainNode,

            // Gate Nodes
            gateInputNode,
            gateOutputNode,
            gateDryGainNode,
            gateWetGainNode,
            gateGatedGainNode,
            gateLfoNode,
            gateBiasNode,

            tunaChorusNode,
            tunaChorusDryGainNode: tunaChorusDryGain,
            tunaChorusWetGainNode: tunaChorusWetGain,
            tunaChorusSumNode: tunaChorusSum,

            tunaPhaserNode,
            tunaPhaserDryGainNode: tunaPhaserDryGain,
            tunaPhaserWetGainNode: tunaPhaserWetGain,
            tunaPhaserSumNode: tunaPhaserSum,

            tunaBitcrusherNode,
            tunaBitcrusherDryGainNode: tunaBitcrusherDryGain,
            tunaBitcrusherWetGainNode: tunaBitcrusherWetGain,
            tunaBitcrusherSumNode: tunaBitcrusherSum,

            // FX state values for offline rendering
            filtrHpCutoff: 10,
            filtrHpResonance: 0.707,
            filtrLpCutoff: 20000,
            filtrLpResonance: 0.707,
            filtrDrive: 0,
            filtrMix: 1.0,
            filtrType: 'lowpass', // kept for backwards compatibility
            filtrCutoff: 20000, // kept for backwards compatibility
            filtrResonance: 0.707, // kept for backwards compatibility
            screamCutoff: 8000,
            screamAmount: 0.707,
            screamDriveAmount: 5,
            screamMix: 1.0,
            eqGains: [0, 0, 0, 0, 0, 0],
            aelapseDelayTime: initialDelayTime,
            aelapseFeedback: 0.3,
            aelapseDelayMix: 0.0,
            aelapseDelayWowRate: 2.0,
            aelapseDelayWowDepth: 0.0,
            aelapseReverbMix: 0.0,
            aelapseReverbSize: 2.0,
            aelapseReverbPreDelay: 0.0,
            aelapseReverbDamp: 20000,
            delaySyncIndex: 3,

            // Tuna FX state values
            tunaChorusEnabled: false,
            tunaChorusRateSync: 'Free',
            tunaChorusRateSyncIndex: 0,
            tunaChorusRate: 1.5,
            tunaChorusDepth: 0.7,
            tunaChorusFeedback: 0.2,
            tunaChorusMix: 0.5,

            tunaPhaserEnabled: false,
            tunaPhaserRateSync: 'Free',
            tunaPhaserRateSyncIndex: 0,
            tunaPhaserRate: 1.2,
            tunaPhaserDepth: 0.6,
            tunaPhaserFeedback: 0.2,
            tunaPhaserMix: 0.5,

            tunaBitcrusherEnabled: false,
            tunaBitcrusherBits: 8,
            tunaBitcrusherNormfreq: 0.1,
            tunaBitcrusherMix: 0.5,

            // Tremolo
            tremoloEnabled: false,
            tremoloRate: 5.0,
            tremoloDepth: 0.0,
            tremoloShape: 'sine',

            // Gate
            gateEnabled: false,
            gateSync: '1/8',
            gateSyncIndex: 2,
            gateWidth: 0.5,
            gateShape: 'square',
            gateMix: 0.5,

            scheduledSourceNodes: [],
            nextScheduleTime: null
        };

        updateFiltrBypass(track);
        updateEqBypass(track);
        updateScreamBypass(track);
        updateTunaChorusBypass(track);
        updateTunaPhaserBypass(track);
        updateTunaBitcrusherBypass(track);
        updateAelapseBypass(track);
        updateTremoloBypass(track);
        updateGateBypass(track);
        updateGateFrequency(track);
        updateGateWidth(track);
        updateTunaTempoSync(track);

        // 6. Build wrapper container
        const wrapperEl = document.createElement('div');
        wrapperEl.className = 'track-wrapper';
        wrapperEl.dataset.lmPart = 'track';

        // 7. Build track-row DOM
        const rowEl = document.createElement('div');
        rowEl.className = 'track-row';
        rowEl.dataset.lmPart = 'track-row';

        const mixerEl = document.createElement('div');
        mixerEl.className = 'mixer-strip';
        mixerEl.dataset.lmPart = 'mixer';
        mixerEl.innerHTML = `
            <div class="mixer-label"></div>
            <div class="mixer-buttons">
                <button class="mixer-btn solo-btn" title="Solo">S</button>
                <button class="mixer-btn mute-btn" title="Mute">M</button>
                <button class="mixer-btn fx-btn" title="Toggle FX Drawer">FX</button>
                <button class="mixer-btn mod-btn" title="Toggle Global Modulators">MOD</button>
                <button class="mixer-btn copy-track-btn" title="Copy Track Settings"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                <button class="mixer-btn paste-track-btn" title="Paste Track Settings"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg></button>
                <button class="mixer-btn regen-btn" title="Regenerate Unlocked"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
                <button class="mixer-btn delete-btn" title="Delete Track"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            </div>
            <div class="mixer-knobs-row">
                <div class="macro-knob-group">
                    <div class="macro-knob" data-param="tone" title="Tone: Flat">
                        <div class="macro-knob-indicator"></div>
                    </div>
                    <span class="macro-knob-label">Tone</span>
                </div>
                <div class="macro-knob-group">
                    <div class="macro-knob" data-param="dlyMix" title="Delay Mix: 0%">
                        <div class="macro-knob-indicator"></div>
                    </div>
                    <span class="macro-knob-label">DMX</span>
                </div>
                <div class="macro-knob-group">
                    <div class="macro-knob" data-param="revMix" title="Reverb Mix: 0%">
                        <div class="macro-knob-indicator"></div>
                    </div>
                    <span class="macro-knob-label">RMX</span>
                </div>
                <div class="macro-knob-group">
                    <div class="pan-knob" title="Pan: C">
                        <div class="pan-knob-indicator"></div>
                    </div>
                    <span class="pan-value">C</span>
                </div>
                <div class="macro-knob-group">
                    <div class="level-knob" title="Vol: 80">
                        <div class="knob-indicator"></div>
                    </div>
                    <span class="level-value">80</span>
                </div>
            </div>
        `;
        const mixerLabel = mixerEl.querySelector('.mixer-label');
        mixerLabel.textContent = prompt;
        mixerLabel.title = prompt;

        const meterEl = document.createElement('div');
        meterEl.className = 'mixer-meter vertical';
        meterEl.innerHTML = `<canvas class="meter-canvas vertical" width="8"></canvas>`;
        track.meterCanvas = meterEl.querySelector('.meter-canvas');

        rowEl.appendChild(mixerEl);
        rowEl.appendChild(meterEl);

        // 8. Build FX Drawer DOM
        const fxDrawerEl = document.createElement('div');
        fxDrawerEl.className = 'fx-drawer is-collapsed';
        fxDrawerEl.dataset.lmPart = 'fx-drawer';
        fxDrawerEl.innerHTML = `
            <!-- Row 1 -->
            <!-- 1. Macro Controls A -->
            <div class="fx-section macros-section a-group">
                <div class="fx-section-title" class="fx-section-title-row">
                    <span>Macros A</span>
                    <div class="fx-clipboard-btns" class="fx-clipboard-btns">
                        <button class="fx-copy-btn" type="button" class="fx-title-action" title="Copy FX Settings">Copy</button>
                        <button class="fx-paste-btn" type="button" class="fx-title-action" title="Paste FX Settings">Paste</button>
                        <button class="fx-reset-btn" type="button" class="fx-title-action" title="Reset FX to Defaults">Reset</button>
                    </div>
                </div>
                <div class="macros-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Space</span>
                        <div class="fx-macro-knob" data-macro="space" title="Space: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Space</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Drive</span>
                        <div class="fx-macro-knob" data-macro="drive" title="Drive: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Drive</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Tone</span>
                        <div class="fx-macro-knob" data-macro="tone" title="Tone: Flat">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Tone</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Filter</span>
                        <div class="fx-macro-knob" data-macro="filter" title="Filter: Off">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Filter</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Reso</span>
                        <div class="fx-macro-knob" data-macro="reso" title="Reso: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Reso</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Delay</span>
                        <div class="fx-macro-knob" data-macro="delay" title="Delay: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Delay</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Feedbk</span>
                        <div class="fx-macro-knob" data-macro="feedback" title="Feedback: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Feedbk</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Crush</span>
                        <div class="fx-macro-knob" data-macro="crush" title="Crush: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Crush</span>
                    </div>
                </div>
            </div>

            <!-- 2. Filtr Filter -->
            <div class="fx-section filtr-section">
                <div class="fx-section-title">
                    <span>Filtr Filter</span>
                    <div class="mini-knob-group" title="Mix: 100%">
                        <div class="fx-mini-knob filtr-mix" title="Filter Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val filtr-mix-val">100%</span>
                        <button class="fx-toggle-btn filtr-toggle" type="button">Off</button>
                    </div>
                </div>
                <div class="filtr-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">LP Freq</span>
                        <div class="fx-knob filtr-lp-cutoff" title="LP Cutoff">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value filtr-lp-cutoff-val">20kHz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">LP Res</span>
                        <div class="fx-knob filtr-lp-reso" title="LP Resonance">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value filtr-lp-reso-val">0.7</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Drive</span>
                        <div class="fx-knob filtr-drive" title="Saturation Drive">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value filtr-drive-val">0%</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">HP Freq</span>
                        <div class="fx-knob filtr-hp-cutoff" title="HP Cutoff">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value filtr-hp-cutoff-val">10Hz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">HP Res</span>
                        <div class="fx-knob filtr-hp-reso" title="HP Resonance">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value filtr-hp-reso-val">0.7</span>
                    </div>
                    <div class="fx-knob-group" class="fx-knob-group is-visibility-hidden"></div>
                </div>
            </div>

            <!-- 3. Luftikus EQ -->
            <div class="fx-section eq-section">
                <div class="fx-section-title">
                    <span>Luftikus EQ</span>
                    <button class="fx-toggle-btn eq-toggle" type="button">On</button>
                </div>
                <div class="eq-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">10Hz</span>
                        <div class="fx-knob eq-slider" data-band="0" title="10 Hz Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">40Hz</span>
                        <div class="fx-knob eq-slider" data-band="1" title="40 Hz Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">160Hz</span>
                        <div class="fx-knob eq-slider" data-band="2" title="160 Hz Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">640Hz</span>
                        <div class="fx-knob eq-slider" data-band="3" title="640 Hz Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">2.5k</span>
                        <div class="fx-knob eq-slider" data-band="4" title="2.5 kHz Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Air</span>
                        <div class="fx-knob eq-slider" data-band="5" title="Air Band Gain">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value eq-val">0.0dB</span>
                    </div>
                </div>
            </div>

            <!-- 4. Scream Distortion -->
            <div class="fx-section scream-section">
                <div class="fx-section-title">
                    <span>Scream Dist</span>
                    <div class="mini-knob-group" title="Mix: 100%">
                        <div class="fx-mini-knob scream-mix" title="Scream Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val scream-mix-val">100%</span>
                        <button class="fx-toggle-btn scream-toggle" type="button">Off</button>
                    </div>
                </div>
                <div class="fx-controls-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Cutoff</span>
                        <div class="fx-knob scream-cutoff" title="Scream Cutoff">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value scream-cutoff-val">8.0kHz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Scream</span>
                        <div class="fx-knob scream-amount" title="Scream Amount">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value scream-amount-val">0%</span>
                    </div>
                </div>
            </div>

            <!-- 5. Tuna Chorus -->
            <div class="fx-section chorus-section is-bypassed">
                <div class="fx-section-title">
                    <span>Tuna Chorus</span>
                    <div class="mini-knob-group" title="Mix: 50%">
                        <div class="fx-mini-knob chorus-mix" title="Chorus Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val chorus-mix-val">50%</span>
                        <button class="fx-toggle-btn chorus-toggle is-off" type="button">Off</button>
                    </div>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Rate</span>
                        <div class="fx-knob chorus-rate" title="Chorus Rate">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value chorus-rate-val">1.5Hz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Sync</span>
                        <div class="fx-knob chorus-rate-sync-knob" title="Chorus Sync">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value chorus-rate-sync-val">Free</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Depth</span>
                        <div class="fx-knob chorus-depth" title="Chorus Depth">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value chorus-depth-val">70%</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Feedbk</span>
                        <div class="fx-knob chorus-feedback" title="Chorus Feedback">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value chorus-feedback-val">20%</span>
                    </div>
                </div>
            </div>

            <!-- 6. Tuna Phaser -->
            <div class="fx-section phaser-section is-bypassed">
                <div class="fx-section-title">
                    <span>Tuna Phaser</span>
                    <div class="mini-knob-group" title="Mix: 50%">
                        <div class="fx-mini-knob phaser-mix" title="Phaser Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val phaser-mix-val">50%</span>
                        <button class="fx-toggle-btn phaser-toggle is-off" type="button">Off</button>
                    </div>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Rate</span>
                        <div class="fx-knob phaser-rate" title="Phaser Rate">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value phaser-rate-val">1.2Hz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Sync</span>
                        <div class="fx-knob phaser-rate-sync-knob" title="Phaser Sync">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value phaser-rate-sync-val">Free</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Depth</span>
                        <div class="fx-knob phaser-depth" title="Phaser Depth">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value phaser-depth-val">60%</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Feedbk</span>
                        <div class="fx-knob phaser-feedback" title="Phaser Feedback">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value phaser-feedback-val">20%</span>
                    </div>
                </div>
            </div>

            <!-- Row 2 -->
            <!-- 7. Macro Controls B -->
            <div class="fx-section macros-section b-group">
                <div class="fx-section-title">
                    <span>Macros B</span>
                </div>
                <div class="macros-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Depth</span>
                        <div class="fx-macro-knob" data-macro="depth" title="Depth: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Depth</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Rate</span>
                        <div class="fx-macro-knob" data-macro="rate" title="Rate: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Rate</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Warmth</span>
                        <div class="fx-macro-knob" data-macro="warmth" title="Warmth: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Warmth</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Air</span>
                        <div class="fx-macro-knob" data-macro="air" title="Air: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Air</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Grit</span>
                        <div class="fx-macro-knob" data-macro="grit" title="Grit: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Grit</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Wobble</span>
                        <div class="fx-macro-knob" data-macro="wobble" title="Wobble: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Wobble</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Presence</span>
                        <div class="fx-macro-knob" data-macro="presence" title="Presence: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Presence</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Pump</span>
                        <div class="fx-macro-knob" data-macro="pump" title="Pump: 0%">
                            <div class="macro-knob-indicator"></div>
                        </div>
                        <span class="macro-knob-label">Pump</span>
                    </div>
                </div>
            </div>

            <!-- 8. Tuna Bitcrusher -->
            <div class="fx-section crusher-section is-bypassed">
                <div class="fx-section-title">
                    <span>Tuna Crush</span>
                    <div class="mini-knob-group" title="Mix: 50%">
                        <div class="fx-mini-knob crusher-mix" title="Crusher Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val crusher-mix-val">50%</span>
                        <button class="fx-toggle-btn crusher-toggle is-off" type="button">Off</button>
                    </div>
                </div>
                <div class="fx-controls-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Bits</span>
                        <div class="fx-knob crusher-bits" title="Crusher Bits">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value crusher-bits-val">8 bits</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Freq Div</span>
                        <div class="fx-knob crusher-normfreq" title="Crusher Frequency Division">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value crusher-normfreq-val">0.10</span>
                    </div>
                </div>
            </div>

            <!-- 9. Tape Delay -->
            <div class="fx-section delay-section">
                <div class="fx-section-title">
                    <span>Tape Delay</span>
                    <div class="mini-knob-group" title="Mix: 0%">
                        <div class="fx-mini-knob aelapse-mix" title="Delay Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val aelapse-mix-val">0%</span>
                        <button class="fx-toggle-btn aelapse-delay-toggle" type="button">On</button>
                    </div>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Sync</span>
                        <div class="fx-knob aelapse-sync" title="Delay Tempo Sync">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-sync-val">1/8</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Feedbk</span>
                        <div class="fx-knob aelapse-feedback-knob" title="Delay Feedback">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-feedback-val">30%</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Wow Rate</span>
                        <div class="fx-knob aelapse-wow-rate" title="Wow Rate">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-wow-rate-val">2.0Hz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Wow Dpt</span>
                        <div class="fx-knob aelapse-wow-depth" title="Wow Depth">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-wow-depth-val">0.0%</span>
                    </div>
                </div>
            </div>

            <!-- 10. Spring Reverb -->
            <div class="fx-section reverb-section">
                <div class="fx-section-title">
                    <span>Spring Rev</span>
                    <div class="mini-knob-group" title="Mix: 0%">
                        <div class="fx-mini-knob aelapse-reverb-mix" title="Reverb Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val aelapse-reverb-val">0%</span>
                        <button class="fx-toggle-btn aelapse-reverb-toggle" type="button">On</button>
                    </div>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Size</span>
                        <div class="fx-knob aelapse-reverb-size" title="Reverb Size">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-reverb-size-val">2.0s</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Pre-Dly</span>
                        <div class="fx-knob aelapse-reverb-predelay" title="Reverb Pre-Delay">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-reverb-predelay-val">0ms</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Damp</span>
                        <div class="fx-knob aelapse-reverb-damp" title="Reverb Damp Filter">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value aelapse-reverb-damp-val">20kHz</span>
                    </div>
                </div>
            </div>

            <!-- 11. Tremolo -->
            <div class="fx-section tremolo-section is-bypassed">
                <div class="fx-section-title">
                    <span>Tremolo</span>
                    <button class="fx-toggle-btn tremolo-toggle is-off" type="button">Off</button>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Rate</span>
                        <div class="fx-knob tremolo-rate" title="Tremolo Rate">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value tremolo-rate-val">5.0Hz</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Depth</span>
                        <div class="fx-knob tremolo-depth" title="Tremolo Depth">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value tremolo-depth-val">0%</span>
                    </div>
                    <div class="fx-knob-group fx-knob-group-compact">
                        <span class="fx-knob-label fx-knob-label-compact">Shape</span>
                        <select class="tremolo-shape fx-shape-select">
                            <option value="sine">Sine</option>
                            <option value="triangle">Tri</option>
                            <option value="sawtooth">Saw</option>
                            <option value="square">Square</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- 12. Tempo Gate -->
            <div class="fx-section gate-section is-bypassed">
                <div class="fx-section-title">
                    <span>Tempo Gate</span>
                    <div class="mini-knob-group" title="Mix: 50%">
                        <div class="fx-mini-knob gate-mix" title="Gate Mix">
                            <div class="mini-knob-indicator"></div>
                        </div>
                        <span class="mini-knob-val gate-mix-val">50%</span>
                        <button class="fx-toggle-btn gate-toggle is-off" type="button">Off</button>
                    </div>
                </div>
                <div class="chorus-knobs-grid">
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Sync</span>
                        <div class="fx-knob gate-sync-knob" title="Gate Sync">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value gate-sync-val">1/8</span>
                    </div>
                    <div class="fx-knob-group">
                        <span class="fx-knob-label">Width</span>
                        <div class="fx-knob gate-width" title="Gate Width">
                            <div class="knob-indicator"></div>
                        </div>
                        <span class="fx-knob-value gate-width-val">50%</span>
                    </div>
                    <div class="fx-knob-group fx-knob-group-compact">
                        <span class="fx-knob-label fx-knob-label-compact">Shape</span>
                        <select class="gate-shape fx-shape-select">
                            <option value="square">Square</option>
                            <option value="sine">Sine</option>
                            <option value="triangle">Tri</option>
                            <option value="sawtooth">Saw</option>
                        </select>
                    </div>
                </div>
            </div>
        `;

        // 9. Wire mixer control event listeners
        const soloBtn = mixerEl.querySelector('.solo-btn');
        const muteBtn = mixerEl.querySelector('.mute-btn');
        const fxBtn = mixerEl.querySelector('.fx-btn');
        const modBtn = mixerEl.querySelector('.mod-btn');
        const copyTrackBtn = mixerEl.querySelector('.copy-track-btn');
        const pasteTrackBtn = mixerEl.querySelector('.paste-track-btn');
        const deleteBtn = mixerEl.querySelector('.delete-btn');
        const levelKnob = mixerEl.querySelector('.level-knob');
        const levelValue = mixerEl.querySelector('.level-value');
        const panKnob = mixerEl.querySelector('.pan-knob');
        const panValue = mixerEl.querySelector('.pan-value');

        setToggleButtonPressed(soloBtn, track.soloed);
        setToggleButtonPressed(muteBtn, track.muted);
        setToggleButtonPressed(fxBtn, !fxDrawerEl.classList.contains('is-collapsed'));
        fxDrawerEl.querySelectorAll('.fx-toggle-btn').forEach(button => {
            setToggleButtonPressed(button, !button.classList.contains('is-off'));
        });

        soloBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.soloed = !track.soloed;
            soloBtn.classList.toggle('is-on', track.soloed);
            setToggleButtonPressed(soloBtn, track.soloed);
            updateMixerState();
        });

        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.muted = !track.muted;
            muteBtn.classList.toggle('is-on', track.muted);
            setToggleButtonPressed(muteBtn, track.muted);
            updateMixerState();
        });



        fxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isCollapsed = fxDrawerEl.classList.contains('is-collapsed');
            if (isCollapsed) {
                fxDrawerEl.classList.remove('is-collapsed');
                fxBtn.classList.add('is-on');
                setToggleButtonPressed(fxBtn, true);
            } else {
                fxDrawerEl.classList.add('is-collapsed');
                fxBtn.classList.remove('is-on');
                setToggleButtonPressed(fxBtn, false);
            }
        });

        if (modBtn) {
            const modulatorsPanel = document.getElementById('modulators-panel');
            const modIsOpen = modulatorsPanel ? modulatorsPanel.classList.contains('is-open') : false;
            modBtn.classList.toggle('is-on', modIsOpen);
            setToggleButtonPressed(modBtn, modIsOpen);

            modBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleGlobalModulators();
            });
        }

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (track.locked) return;
            const idx = tracks.indexOf(track);
            pushUndo('deleteTrack', { wrapperEl: track.wrapper, track, index: idx });
            deleteTrackRow(track);
        });

        if (copyTrackBtn) {
            copyTrackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copiedTrackSettings = {
                    level: track.level,
                    pan: track.pan,
                    muted: track.muted,
                    macroValues: {
                        filter: macroKnobState.filter ? macroKnobState.filter.value : 50,
                        reso: macroKnobState.reso ? macroKnobState.reso.value : 0,
                        tone: macroKnobState.tone ? macroKnobState.tone.value : 50,
                        dlyMix: macroKnobState.dlyMix ? macroKnobState.dlyMix.value : 0,
                        revSize: macroKnobState.revSize ? macroKnobState.revSize.value : 0,
                        revMix: macroKnobState.revMix ? macroKnobState.revMix.value : 0
                    },
                    fxSettings: {
                        filtrEnabled: track.filtrEnabled,
                        screamEnabled: track.screamEnabled,
                        eqEnabled: track.eqEnabled,
                        aelapseDelayEnabled: track.aelapseDelayEnabled,
                        aelapseReverbEnabled: track.aelapseReverbEnabled,

                        filtrHpCutoff: track.filtrHpCutoff,
                        filtrHpReso: track.filtrHpResonance,
                        filtrLpCutoff: track.filtrLpCutoff,
                        filtrLpReso: track.filtrLpResonance,
                        filtrDrive: track.filtrDrive,
                        filtrMix: track.filtrMix,

                        screamCutoff: track.screamCutoff,
                        screamAmount: track.screamAmount,
                        screamMix: track.screamMix,

                        eqGains: [...track.eqGains],

                        aelapseSync: track.delaySyncIndex,
                        aelapseMix: track.aelapseDelayMix,
                        aelapseReverbMix: track.aelapseReverbMix,
                        aelapseReverbSize: track.aelapseReverbSize,
                        aelapseDelayWowRate: track.aelapseDelayWowRate,
                        aelapseDelayWowDepth: track.aelapseDelayWowDepth,
                        aelapseReverbPreDelay: track.aelapseReverbPreDelay,
                        aelapseReverbDamp: track.aelapseReverbDamp,

                        tunaChorusEnabled: track.tunaChorusEnabled,
                        tunaChorusRateSync: track.tunaChorusRateSync,
                        tunaChorusRateSyncIndex: track.tunaChorusRateSyncIndex,
                        tunaChorusRate: track.tunaChorusRate,
                        tunaChorusDepth: track.tunaChorusDepth,
                        tunaChorusFeedback: track.tunaChorusFeedback,
                        tunaChorusMix: track.tunaChorusMix,

                        tunaPhaserEnabled: track.tunaPhaserEnabled,
                        tunaPhaserRateSync: track.tunaPhaserRateSync,
                        tunaPhaserRateSyncIndex: track.tunaPhaserRateSyncIndex,
                        tunaPhaserRate: track.tunaPhaserRate,
                        tunaPhaserDepth: track.tunaPhaserDepth,
                        tunaPhaserFeedback: track.tunaPhaserFeedback,
                        tunaPhaserMix: track.tunaPhaserMix,

                        tunaBitcrusherEnabled: track.tunaBitcrusherEnabled,
                        tunaBitcrusherBits: track.tunaBitcrusherBits,
                        tunaBitcrusherNormfreq: track.tunaBitcrusherNormfreq,
                        tunaBitcrusherMix: track.tunaBitcrusherMix,

                        tremoloEnabled: track.tremoloEnabled,
                        tremoloRate: track.tremoloRate,
                        tremoloDepth: track.tremoloDepth,
                        tremoloShape: track.tremoloShape,

                        gateEnabled: track.gateEnabled,
                        gateSyncIndex: track.gateSyncIndex,
                        gateWidth: track.gateWidth,
                        gateShape: track.gateShape,
                        gateMix: track.gateMix,

                        macros: {
                            space: fxMacroState.space ? fxMacroState.space.value : 0,
                            drive: fxMacroState.drive ? fxMacroState.drive.value : 0,
                            tone: fxMacroState.tone ? fxMacroState.tone.value : 50,
                            filter: fxMacroState.filter ? fxMacroState.filter.value : 50,
                            reso: fxMacroState.reso ? fxMacroState.reso.value : 0,
                            delay: fxMacroState.delay ? fxMacroState.delay.value : 0,
                            feedback: fxMacroState.feedback ? fxMacroState.feedback.value : 0,
                            crush: fxMacroState.crush ? fxMacroState.crush.value : 0,
                            depth: fxMacroState.depth ? fxMacroState.depth.value : 0,
                            rate: fxMacroState.rate ? fxMacroState.rate.value : 0,
                            warmth: fxMacroState.warmth ? fxMacroState.warmth.value : 0,
                            air: fxMacroState.air ? fxMacroState.air.value : 0,
                            grit: fxMacroState.grit ? fxMacroState.grit.value : 0,
                            wobble: fxMacroState.wobble ? fxMacroState.wobble.value : 0,
                            presence: fxMacroState.presence ? fxMacroState.presence.value : 0,
                            pump: fxMacroState.pump ? fxMacroState.pump.value : 0,
                        }
                    }
                };

                copyTrackBtn.classList.add('is-feedback-success');
                setTimeout(() => copyTrackBtn.classList.remove('is-feedback-success'), 1000);
            });
        }

        // Shared FX-settings application used by both the track paste
        // button and the FX drawer's Paste button (state-driven; the FX
        // drawer buttons previously read stale selectors and threw).
        function applyFxSettingsToTrack(fx) {
                track.filtrEnabled = fx.filtrEnabled;
                const filtrToggleBtn = fxDrawerEl.querySelector('.filtr-toggle');
                if (filtrToggleBtn) {
                    filtrToggleBtn.textContent = track.filtrEnabled ? 'On' : 'Off';
                    filtrToggleBtn.classList.toggle('is-off', !track.filtrEnabled);
                }
                const filtrSection = fxDrawerEl.querySelector('.filtr-section');
                if (filtrSection) {
                    filtrSection.classList.toggle('is-bypassed', !track.filtrEnabled);
                }
                updateFiltrBypass(track);

                track.eqEnabled = fx.eqEnabled;
                const eqToggleBtn = fxDrawerEl.querySelector('.eq-toggle');
                if (eqToggleBtn) {
                    eqToggleBtn.textContent = track.eqEnabled ? 'On' : 'Bypass';
                    eqToggleBtn.classList.toggle('is-off', !track.eqEnabled);
                }
                const eqSection = fxDrawerEl.querySelector('.eq-section');
                if (eqSection) {
                    eqSection.classList.toggle('is-bypassed', !track.eqEnabled);
                }
                updateEqBypass(track);

                track.screamEnabled = fx.screamEnabled;
                const screamToggleBtn = fxDrawerEl.querySelector('.scream-toggle');
                if (screamToggleBtn) {
                    screamToggleBtn.textContent = track.screamEnabled ? 'On' : 'Off';
                    screamToggleBtn.classList.toggle('is-off', !track.screamEnabled);
                }
                const screamSection = fxDrawerEl.querySelector('.scream-section');
                if (screamSection) {
                    screamSection.classList.toggle('is-bypassed', !track.screamEnabled);
                }
                updateScreamBypass(track);

                // Split delay
                track.aelapseDelayEnabled = fx.aelapseDelayEnabled;
                const aeDelayToggleBtn = fxDrawerEl.querySelector('.aelapse-delay-toggle');
                if (aeDelayToggleBtn) {
                    aeDelayToggleBtn.textContent = track.aelapseDelayEnabled ? 'On' : 'Off';
                    aeDelayToggleBtn.classList.toggle('is-off', !track.aelapseDelayEnabled);
                }
                const delaySection = fxDrawerEl.querySelector('.delay-section');
                if (delaySection) {
                    delaySection.classList.toggle('is-bypassed', !track.aelapseDelayEnabled);
                }

                // Split Reverb
                track.aelapseReverbEnabled = fx.aelapseReverbEnabled;
                const aeReverbToggleBtn = fxDrawerEl.querySelector('.aelapse-reverb-toggle');
                if (aeReverbToggleBtn) {
                    aeReverbToggleBtn.textContent = track.aelapseReverbEnabled ? 'On' : 'Off';
                    aeReverbToggleBtn.classList.toggle('is-off', !track.aelapseReverbEnabled);
                }
                const reverbSection = fxDrawerEl.querySelector('.reverb-section');
                if (reverbSection) {
                    reverbSection.classList.toggle('is-bypassed', !track.aelapseReverbEnabled);
                }
                updateAelapseBypass(track);

                track.tunaChorusEnabled = fx.tunaChorusEnabled;
                const chorusToggleBtn = fxDrawerEl.querySelector('.chorus-toggle');
                if (chorusToggleBtn) {
                    chorusToggleBtn.textContent = track.tunaChorusEnabled ? 'On' : 'Off';
                    chorusToggleBtn.classList.toggle('is-off', !track.tunaChorusEnabled);
                }
                const chorusSection = fxDrawerEl.querySelector('.chorus-section');
                if (chorusSection) {
                    chorusSection.classList.toggle('is-bypassed', !track.tunaChorusEnabled);
                }
                updateTunaChorusBypass(track);

                track.tunaPhaserEnabled = fx.tunaPhaserEnabled;
                const phaserToggleBtn = fxDrawerEl.querySelector('.phaser-toggle');
                if (phaserToggleBtn) {
                    phaserToggleBtn.textContent = track.tunaPhaserEnabled ? 'On' : 'Off';
                    phaserToggleBtn.classList.toggle('is-off', !track.tunaPhaserEnabled);
                }
                const phaserSection = fxDrawerEl.querySelector('.phaser-section');
                if (phaserSection) {
                    phaserSection.classList.toggle('is-bypassed', !track.tunaPhaserEnabled);
                }
                updateTunaPhaserBypass(track);

                track.tunaBitcrusherEnabled = fx.tunaBitcrusherEnabled;
                const crusherToggleBtn = fxDrawerEl.querySelector('.crusher-toggle');
                if (crusherToggleBtn) {
                    crusherToggleBtn.textContent = track.tunaBitcrusherEnabled ? 'On' : 'Off';
                    crusherToggleBtn.classList.toggle('is-off', !track.tunaBitcrusherEnabled);
                }
                const crusherSection = fxDrawerEl.querySelector('.crusher-section');
                if (crusherSection) {
                    crusherSection.classList.toggle('is-bypassed', !track.tunaBitcrusherEnabled);
                }
                updateTunaBitcrusherBypass(track);

                // Split Filtr parameters
                track.filtrHpCutoff = fx.filtrHpCutoff !== undefined ? fx.filtrHpCutoff : 10;
                track.filtrHpResonance = fx.filtrHpReso !== undefined ? fx.filtrHpReso : 0.707;
                track.filtrLpCutoff = fx.filtrLpCutoff !== undefined ? fx.filtrLpCutoff : 20000;
                track.filtrLpResonance = fx.filtrLpReso !== undefined ? fx.filtrLpReso : 0.707;
                track.filtrDrive = fx.filtrDrive !== undefined ? fx.filtrDrive : 0;
                track.filtrMix = fx.filtrMix !== undefined ? fx.filtrMix : 1.0;

                // Tremolo
                track.tremoloEnabled = fx.tremoloEnabled || false;
                track.tremoloRate = fx.tremoloRate !== undefined ? fx.tremoloRate : 5.0;
                track.tremoloDepth = fx.tremoloDepth !== undefined ? fx.tremoloDepth : 0.0;
                track.tremoloShape = fx.tremoloShape || 'sine';

                const tremoloToggleBtn = fxDrawerEl.querySelector('.tremolo-toggle');
                if (tremoloToggleBtn) {
                    tremoloToggleBtn.textContent = track.tremoloEnabled ? 'On' : 'Off';
                    tremoloToggleBtn.classList.toggle('is-off', !track.tremoloEnabled);
                }
                const tremoloSection = fxDrawerEl.querySelector('.tremolo-section');
                if (tremoloSection) {
                    tremoloSection.classList.toggle('is-bypassed', !track.tremoloEnabled);
                }
                updateTremoloBypass(track);

                const tremoloShapeSelect = fxDrawerEl.querySelector('.tremolo-shape');
                if (tremoloShapeSelect) {
                    tremoloShapeSelect.value = track.tremoloShape;
                    tremoloShapeSelect.dispatchEvent(new Event('change'));
                }

                // Gate
                track.gateEnabled = fx.gateEnabled || false;
                track.gateSyncIndex = fx.gateSyncIndex !== undefined ? fx.gateSyncIndex : 2;
                track.gateWidth = fx.gateWidth !== undefined ? fx.gateWidth : 0.5;
                track.gateShape = fx.gateShape || 'square';
                track.gateMix = fx.gateMix !== undefined ? fx.gateMix : 0.5;

                const gateToggleBtn = fxDrawerEl.querySelector('.gate-toggle');
                if (gateToggleBtn) {
                    gateToggleBtn.textContent = track.gateEnabled ? 'On' : 'Off';
                    gateToggleBtn.classList.toggle('is-off', !track.gateEnabled);
                }
                const gateSection = fxDrawerEl.querySelector('.gate-section');
                if (gateSection) {
                    gateSection.classList.toggle('is-bypassed', !track.gateEnabled);
                }
                updateGateBypass(track);
                updateGateFrequency(track);
                updateGateWidth(track);

                const gateShapeSelect = fxDrawerEl.querySelector('.gate-shape');
                if (gateShapeSelect) {
                    gateShapeSelect.value = track.gateShape;
                    gateShapeSelect.dispatchEvent(new Event('change'));
                }

                const sliders = {
                    '.filtr-lp-cutoff': track.filtrLpCutoff,
                    '.filtr-lp-reso': Math.round(track.filtrLpResonance * 10),
                    '.filtr-drive': track.filtrDrive,
                    '.filtr-hp-cutoff': track.filtrHpCutoff,
                    '.filtr-hp-reso': Math.round(track.filtrHpResonance * 10),
                    '.filtr-mix': Math.round(track.filtrMix * 100),
                    '.scream-cutoff': fx.screamCutoff,
                    '.scream-amount': fx.screamAmount,
                    '.scream-mix': fx.screamMix,
                    '.aelapse-sync': fx.aelapseSync,
                    '.aelapse-mix': fx.aelapseMix,
                    '.aelapse-reverb-mix': fx.aelapseReverbMix,
                    '.aelapse-reverb-size': fx.aelapseReverbSize,
                    '.aelapse-wow-rate': fx.aelapseDelayWowRate !== undefined ? fx.aelapseDelayWowRate : 2.0,
                    '.aelapse-wow-depth': fx.aelapseDelayWowDepth !== undefined ? Math.round(fx.aelapseDelayWowDepth * 1000) : 0,
                    '.aelapse-reverb-predelay': fx.aelapseReverbPreDelay !== undefined ? fx.aelapseReverbPreDelay : 0,
                    '.aelapse-reverb-damp': fx.aelapseReverbDamp !== undefined ? fx.aelapseReverbDamp : 20000,
                    '.chorus-rate-sync-knob': fx.tunaChorusRateSyncIndex !== undefined ? fx.tunaChorusRateSyncIndex : 0,
                    '.chorus-rate': fx.tunaChorusRate,
                    '.chorus-depth': fx.tunaChorusDepth,
                    '.chorus-feedback': fx.tunaChorusFeedback,
                    '.chorus-mix': fx.tunaChorusMix,
                    '.phaser-rate-sync-knob': fx.tunaPhaserRateSyncIndex !== undefined ? fx.tunaPhaserRateSyncIndex : 0,
                    '.phaser-rate': fx.tunaPhaserRate,
                    '.phaser-depth': fx.tunaPhaserDepth,
                    '.phaser-feedback': fx.tunaPhaserFeedback,
                    '.phaser-mix': fx.tunaPhaserMix,
                    '.crusher-bits': fx.tunaBitcrusherBits,
                    '.crusher-normfreq': fx.tunaBitcrusherNormfreq,
                    '.crusher-mix': fx.tunaBitcrusherMix,
                    '.tremolo-rate': track.tremoloRate,
                    '.tremolo-depth': Math.round(track.tremoloDepth * 100),
                    '.gate-sync-knob': track.gateSyncIndex,
                    '.gate-width': Math.round(track.gateWidth * 100),
                    '.gate-mix': Math.round(track.gateMix * 100),
                };

                for (const selector in sliders) {
                    const el = fxDrawerEl.querySelector(selector);
                    if (el) {
                        el.value = sliders[selector];
                        el.dispatchEvent(new Event('input'));
                    }
                }

                const eqSliders = fxDrawerEl.querySelectorAll('.eq-slider');
                eqSliders.forEach((slider, b) => {
                    if (fx.eqGains[b] !== undefined) {
                        slider.value = fx.eqGains[b];
                        slider.dispatchEvent(new Event('input'));
                    }
                });

                if (fx.macros) {
                    for (const key in fx.macros) {
                        if (fxMacroState[key]) {
                            fxMacroState[key].value = fx.macros[key];
                            applyFxMacro(key, fx.macros[key]);
                        }
                    }
                }
        }

        if (pasteTrackBtn) {
            pasteTrackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (track.locked) return;
                if (!copiedTrackSettings) {
                    alert('No track settings copied yet!');
                    return;
                }
                const settings = copiedTrackSettings;

                // Mute
                if (track.muted !== settings.muted) {
                    track.muted = settings.muted;
                    muteBtn.classList.toggle('is-on', track.muted);
                }

                // Volume
                track.level = settings.level;
                const targetVal = Math.round(settings.level * 100);
                if (levelKnob) {
                    levelKnob.value = targetVal;
                    levelKnob.title = `Vol: ${targetVal}`;
                }
                levelValue.textContent = targetVal;
                updateMixerState();

                // Pan
                const panVal = Math.round(settings.pan * 100);
                updatePanKnob(panVal);

                // Front-facing macro knobs
                for (const param in settings.macroValues) {
                    if (macroKnobState[param]) {
                        macroKnobState[param].value = settings.macroValues[param];
                        applyMacroKnob(param, settings.macroValues[param]);
                    }
                }

                // Detailed FX
                applyFxSettingsToTrack(settings.fxSettings);

                pasteTrackBtn.classList.add('is-feedback-success');
                setTimeout(() => pasteTrackBtn.classList.remove('is-feedback-success'), 1000);
            });
        }

        const regenBtn = mixerEl.querySelector('.regen-btn');
        if (regenBtn) {
            regenBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (track.locked) return;

                let trackDuration = 960.0 / (track.originalParams?.bpm || 120);
                for (let v of track.variants) {
                    if (v && v.buffer) {
                        trackDuration = v.buffer.duration;
                        break;
                    }
                }

                const unlockedVariants = track.variants.filter(v => !v.locked);
                if (unlockedVariants.length === 0) {
                    showStatus('No variants are unlocked to regenerate!', 'error');
                    return;
                }

                const N = unlockedVariants.length;
                showStatus('Submitting regeneration...');

                unlockedVariants.forEach(v => {
                    v.el.classList.add('is-loading');
                    v.buffer = null;
                    const titleEl = v.el.querySelector('.card-title');
                    if (titleEl) titleEl.textContent = 'loading…';
                });

                regenBtn.disabled = true;
                regenBtn.classList.add('is-generating');

                try {
                    const unlockedIndices = track.variants.map((v, idx) => v.locked ? -1 : idx).filter(idx => idx !== -1);

                    const payload = {
                        track_num: track.id,
                        prompt: track.originalParams?.prompt || track.prompt,
                        bpm: track.originalParams?.bpm || parseInt(bpmInput.value) || 120,
                        seed: track.originalParams?.seed ?? -1,
                        cfg_scale: track.originalParams?.cfgScale ?? 1.0,
                        steps: track.originalParams?.steps ?? 8,
                        unlocked_indices: unlockedIndices,
                        duration_padding_sec: 2.0,
                        duration: trackDuration,
                        loop: true,
                        prompt_sections: track.originalParams?.promptSections || {},
                        negative_prompt: track.originalParams?.negativePrompt || '',
                        quality_tier: track.originalParams?.qualityTier || 'final',
                        ...(track.originalParams?.asset || currentAssetPreferences())
                    };

                    const res = await fetch('/api/regenerate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });

                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error || `HTTP ${res.status}`);
                    }

                    const { job_id } = await res.json();
                    setGenerationCancelState(job_id);
                    const result = await pollJob(job_id);
                    if (!tracks.includes(track)) return;
                    if (result.status !== 'done') throw new Error(result.error || 'Failed');

                    for (let idx of unlockedIndices) {
                        const newFilePath = result.files[idx];
                        if (newFilePath) {
                            const variant = track.variants[idx];
                            variant.filePath = newFilePath;
                            const name = newFilePath.split('/').pop();
                            variant.name = name;

                            const titleEl = variant.el.querySelector('.card-title');
                            if (titleEl) {
                                titleEl.textContent = name;
                                titleEl.title = name;
                            }

                            await loadVariantAudio(variant, `/outputs/${newFilePath}`, track.selectedVariant === idx, track);
                        }
                    }

                    showStatus(`Regeneration done in ${result.elapsed?.toFixed(1) || '?'}s`, 'done');

                    if (isPlaying && unlockedIndices.includes(track.selectedVariant)) {
                        stopTrackSource(track);
                        startTrackSource(track);
                    }

                } catch (err) {
                    if (err.name !== 'GenerationCancelledError') console.error('Regeneration failed:', err);
                    showStatus(err.name === 'GenerationCancelledError' ? 'Queued generation cancelled.' : `Regeneration failed: ${err.message}`, err.name === 'GenerationCancelledError' ? 'done' : 'error');
                    unlockedVariants.forEach(v => {
                        v.el.classList.remove('is-loading');
                        const titleEl = v.el.querySelector('.card-title');
                        if (titleEl) titleEl.textContent = v.name;
                    });
                } finally {
                    setGenerationCancelState(null);
                    regenBtn.disabled = false;
                    regenBtn.classList.remove('is-generating');
                }
            });
        }

        trackInitKnob(levelKnob, (val) => {
            track.level = val / 100;
            levelValue.textContent = Math.round(val);
            levelKnob.title = `Vol: ${Math.round(val)}`;
            updateMixerState();
        }, { min: 0, max: 100, defaultVal: 80, value: Math.round(track.level * 100) });

        const syncPanKnobAccessibility = setupKeyboardSlider(panKnob, {
            min: -100,
            max: 100,
            step: 1,
            label: 'Track pan',
            getValue: () => Math.round(track.pan * 100),
            setValue: (value) => updatePanKnob(value),
            isDisabled: () => track.locked,
            signal: trackAbort.signal
        });

        // Pan knob drag interaction
        function updatePanKnob(panVal) {
            track.pan = panVal / 100;
            track.panNode.pan.value = track.pan;
            const deg = (panVal / 100) * 135; // -135 to +135
            setPresentation(panKnob.querySelector('.pan-knob-indicator'), { transform: `rotate(${deg}deg)` });
            panKnob.title = `Pan: ${panVal === 0 ? 'C' : panVal < 0 ? 'L' + Math.abs(panVal) : 'R' + panVal}`;
            panValue.textContent = panVal === 0 ? 'C' : panVal < 0 ? `L${Math.abs(panVal)}` : `R${panVal}`;
            syncPanKnobAccessibility();
        }

        let panDragging = false;
        let panStartY = 0;
        let panStartVal = 0;

        panKnob.addEventListener('mousedown', (e) => {
            if (track.locked) return;
            e.preventDefault();
            panDragging = true;
            panStartY = e.clientY;
            panStartVal = Math.round(track.pan * 100);
            setPresentation(document.body, { cursor: 'ns-resize' });
        });

        document.addEventListener('mousemove', (e) => {
            if (!panDragging) return;
            const delta = panStartY - e.clientY; // up = right
            const newVal = Math.max(-100, Math.min(100, panStartVal + delta));
            updatePanKnob(newVal);
        }, { signal: trackAbort.signal });

        document.addEventListener('mouseup', () => {
            if (panDragging) {
                panDragging = false;
                setPresentation(document.body, { cursor: null });
            }
        }, { signal: trackAbort.signal });

        panKnob.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (track.locked) return;
            updatePanKnob(0);
        });

        // 9.5. Wire mixer macro knobs
        const macroKnobs = mixerEl.querySelectorAll('.macro-knob');
        // macroKnobState is declared at the top of createTrackRow

        function applyMacroKnob(param, value) {
            const knobEl = mixerEl.querySelector(`.macro-knob[data-param="${param}"]`);
            const indicator = knobEl ? knobEl.querySelector('.macro-knob-indicator') : null;
            const ctx = ensureAudioCtx();

            if (param === 'filter') {
                if (indicator) {
                    // Bipolar: -100 to +100. Left = LP (cutoff sweeps down), Right = HP (cutoff sweeps up)
                    const deg = (value / 100) * 135;
                    setPresentation(indicator, { transform: `rotate(${deg}deg)` });
                }
                if (value === 0) {
                    if (knobEl) knobEl.title = 'Filter: Off';
                    // Disable filtr
                    if (track.filtrEnabled) {
                        const toggle = track.wrapper.querySelector('.filtr-toggle');
                        if (toggle) toggle.click();
                    }
                } else {
                    // Enable filtr if off
                    if (!track.filtrEnabled) {
                        const toggle = track.wrapper.querySelector('.filtr-toggle');
                        if (toggle) toggle.click();
                    }
                    if (value < 0) {
                        // LP: map -100..-1 → cutoff 20000..60 (log scale)
                        const norm = (100 + value) / 100; // 0..1 (0 = fully closed, 1 = wide open)
                        const cutoff = 60 * Math.pow(20000 / 60, norm); // exponential sweep
                        track.filtrType = 'lowpass';
                        track.filtrFilterNode.type = 'lowpass';
                        track.filtrFilterNode.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.02);
                        track.filtrCutoff = cutoff;
                        track.filtrMix = 1.0;
                        track.filtrDryGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
                        track.filtrWetGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
                        if (knobEl) knobEl.title = `LP: ${cutoff >= 1000 ? (cutoff / 1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    } else {
                        // HP: map 1..100 → cutoff 20..12000 (log scale)
                        const norm = value / 100; // 0..1
                        const cutoff = 20 * Math.pow(12000 / 20, norm); // exponential sweep
                        track.filtrType = 'highpass';
                        track.filtrFilterNode.type = 'highpass';
                        track.filtrFilterNode.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.02);
                        track.filtrCutoff = cutoff;
                        track.filtrMix = 1.0;
                        track.filtrDryGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
                        track.filtrWetGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
                        if (knobEl) knobEl.title = `HP: ${cutoff >= 1000 ? (cutoff / 1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    }
                }
            } else {
                // Unipolar 0-100
                if (indicator) {
                    const deg = -135 + (value / 100) * 270;
                    setPresentation(indicator, { transform: `rotate(${deg}deg)` });
                }

                if (param === 'reso') {
                    const q = 0.707 + (value / 100) * 24.293;
                    track.filtrResonance = q;
                    track.filtrFilterNode.Q.setTargetAtTime(q, ctx.currentTime, 0.02);
                    if (knobEl) knobEl.title = `Reso: ${value}%`;
                } else if (param === 'tone') {
                    if (knobEl) {
                        if (value === 50) {
                            knobEl.title = 'Tone: Flat';
                        } else if (value < 50) {
                            knobEl.title = 'Tone: Dark';
                        } else {
                            knobEl.title = 'Tone: Bright';
                        }
                    }
                    // Push to EQ sliders
                    const eqSlidersList = track.wrapper.querySelectorAll('.eq-slider');
                    if (eqSlidersList.length === 6) {
                        let bandGains = [0, 0, 0, 0, 0, 0];
                        if (value < 50) {
                            const factor = (50 - value) / 50;
                            bandGains = [7.8 * factor * 1.3, 7.8 * factor * 1.3, 5.2 * factor * 1.3, 0, -7.8 * factor * 1.3, -7.8 * factor * 1.3];
                        } else if (value > 50) {
                            const factor = (value - 50) / 50;
                            bandGains = [-7.8 * factor * 1.3, -7.8 * factor * 1.3, -3.9 * factor * 1.3, 0, 7.8 * factor * 1.3, 10.4 * factor * 1.3];
                        }
                        eqSlidersList.forEach((slider, b) => {
                            slider.value = bandGains[b];
                        });
                    }
                } else if (param === 'dlyMix') {
                    const slider = track.wrapper.querySelector('.aelapse-mix');
                    if (slider) {
                        slider.value = value;
                    }
                    if (knobEl) knobEl.title = `Delay: ${value.toFixed(1)}%`;
                } else if (param === 'revMix') {
                    const slider = track.wrapper.querySelector('.aelapse-reverb-mix');
                    if (slider) {
                        slider.value = value;
                    }
                    if (knobEl) knobEl.title = `Reverb: ${value.toFixed(1)}%`;
                }
            }
            if (knobEl && knobEl._syncSliderAria) knobEl._syncSliderAria();
        }

        macroKnobs.forEach(knobEl => {
            const param = knobEl.dataset.param;
            const isBipolar = param === 'filter';
            const defaultVal = param === 'tone' ? 50 : 0;
            macroKnobState[param] = { value: defaultVal, dragging: false, startY: 0, startVal: 0 };
            const macroMin = isBipolar ? -100 : 0;
            const syncMacroAccessibility = setupKeyboardSlider(knobEl, {
                min: macroMin,
                max: 100,
                step: 1,
                label: `${param} macro control`,
                getValue: () => macroKnobState[param].value,
                setValue: (value) => {
                    macroKnobState[param].value = value;
                    applyMacroKnob(param, value);
                },
                isDisabled: () => track.locked,
                signal: trackAbort.signal
            });
            knobEl._syncSliderAria = syncMacroAccessibility;

            knobEl.addEventListener('mousedown', (e) => {
                if (track.locked) return;
                e.preventDefault();
                e.stopPropagation();
                const st = macroKnobState[param];
                st.dragging = true;
                st.startY = e.clientY;
                st.startVal = st.value;
                setPresentation(document.body, { cursor: 'ns-resize' });
            });

            document.addEventListener('mousemove', (e) => {
                const st = macroKnobState[param];
                if (!st.dragging) return;
                const delta = st.startY - e.clientY;
                const min = isBipolar ? -100 : 0;
                const max = 100;
                let newVal = st.startVal + delta * 0.4;
                if (param === 'dlyMix' || param === 'revMix' || param === 'tone' || param === 'filter' || param === 'reso') {
                    newVal = Math.round(newVal * 10) / 10;
                }
                newVal = Math.max(min, Math.min(max, newVal));
                st.value = newVal;
                applyMacroKnob(param, newVal);
                syncMacroAccessibility();
            }, { signal: trackAbort.signal });

            document.addEventListener('mouseup', () => {
                const st = macroKnobState[param];
                if (st.dragging) {
                    st.dragging = false;
                    setPresentation(document.body, { cursor: null });
                }
            }, { signal: trackAbort.signal });

            knobEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (track.locked) return;
                macroKnobState[param].value = defaultVal;
                applyMacroKnob(param, defaultVal);
                syncMacroAccessibility();
            });

            // Init indicator position
            if (isBipolar) {
                setPresentation(knobEl.querySelector('.macro-knob-indicator'), { transform: 'rotate(0deg)' });
            } else {
                const initDeg = -135 + (defaultVal / 100) * 270;
                setPresentation(knobEl.querySelector('.macro-knob-indicator'), { transform: `rotate(${initDeg}deg)` });
            }

            // Wire hover highlighting for mixer macro knobs
            const targetSelectors = mixerMacroHoverTargets[param];
            if (targetSelectors) {
                knobEl.addEventListener('mouseenter', () => {
                    targetSelectors.forEach(selector => {
                        const targets = fxDrawerEl.querySelectorAll(selector);
                        targets.forEach(target => {
                            target.classList.add('macro-target-highlight');
                        });
                    });
                });
                knobEl.addEventListener('mouseleave', () => {
                    targetSelectors.forEach(selector => {
                        const targets = fxDrawerEl.querySelectorAll(selector);
                        targets.forEach(target => {
                            target.classList.remove('macro-target-highlight');
                        });
                    });
                });
            }
        });

        // Stash feedback node ref for macro knob access
        track.__aelapseFbNode = aelapseFeedbackNode;

        // 10. Wire FX drawer slider event listeners
        // 10. Wire FX drawer parameter knobs
        const eqSliders = fxDrawerEl.querySelectorAll('.eq-slider');
        const eqVals = fxDrawerEl.querySelectorAll('.eq-val');
        eqSliders.forEach((slider, b) => {
            trackInitKnob(slider, (val) => {
                eqVals[b].textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + 'dB';
                track.eqGains[b] = val;
                eqFilters[b].gain.value = val;
            }, {
                min: -16,
                max: 16,
                step: 0.1,
                defaultVal: 0,
                value: track.eqGains[b]
            });
        });

        // The shared FX bypass wiring below owns the Filtr toggle.  Keeping
        // one listener prevents a click from immediately toggling it twice.

        const filtrLpCutoffSlider = fxDrawerEl.querySelector('.filtr-lp-cutoff');
        const filtrLpCutoffVal = fxDrawerEl.querySelector('.filtr-lp-cutoff-val');
        trackInitKnob(filtrLpCutoffSlider, (val) => {
            filtrLpCutoffVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.filtrLpCutoff = val;
            if (track.filtrLpFilterNode) {
                track.filtrLpFilterNode.frequency.setValueAtTime(val, ctx.currentTime);
            }
        }, {
            min: 20,
            max: 20000,
            step: 1,
            defaultVal: 20000,
            value: track.filtrLpCutoff
        });

        const filtrLpResoSlider = fxDrawerEl.querySelector('.filtr-lp-reso');
        const filtrLpResoVal = fxDrawerEl.querySelector('.filtr-lp-reso-val');
        trackInitKnob(filtrLpResoSlider, (val) => {
            const q = val / 10;
            filtrLpResoVal.textContent = q.toFixed(1);
            track.filtrLpResonance = q;
            if (track.filtrLpFilterNode) {
                track.filtrLpFilterNode.Q.setValueAtTime(q, ctx.currentTime);
            }
        }, {
            min: 1,
            max: 250,
            step: 1,
            defaultVal: 7,
            value: Math.round(track.filtrLpResonance * 10)
        });

        const filtrDriveSlider = fxDrawerEl.querySelector('.filtr-drive');
        const filtrDriveVal = fxDrawerEl.querySelector('.filtr-drive-val');
        trackInitKnob(filtrDriveSlider, (val) => {
            filtrDriveVal.textContent = val + '%';
            track.filtrDrive = val;
            if (track.filtrDriveShaperNode) {
                track.filtrDriveShaperNode.curve = makeDistortionCurve(val);
            }
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 0,
            value: track.filtrDrive
        });

        const filtrHpCutoffSlider = fxDrawerEl.querySelector('.filtr-hp-cutoff');
        const filtrHpCutoffVal = fxDrawerEl.querySelector('.filtr-hp-cutoff-val');
        trackInitKnob(filtrHpCutoffSlider, (val) => {
            filtrHpCutoffVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.filtrHpCutoff = val;
            if (track.filtrHpFilterNode) {
                track.filtrHpFilterNode.frequency.setValueAtTime(val, ctx.currentTime);
            }
        }, {
            min: 10,
            max: 20000,
            step: 1,
            defaultVal: 10,
            value: track.filtrHpCutoff
        });

        const filtrHpResoSlider = fxDrawerEl.querySelector('.filtr-hp-reso');
        const filtrHpResoVal = fxDrawerEl.querySelector('.filtr-hp-reso-val');
        trackInitKnob(filtrHpResoSlider, (val) => {
            const q = val / 10;
            filtrHpResoVal.textContent = q.toFixed(1);
            track.filtrHpResonance = q;
            if (track.filtrHpFilterNode) {
                track.filtrHpFilterNode.Q.setValueAtTime(q, ctx.currentTime);
            }
        }, {
            min: 1,
            max: 250,
            step: 1,
            defaultVal: 7,
            value: Math.round(track.filtrHpResonance * 10)
        });

        const filtrMixSlider = fxDrawerEl.querySelector('.filtr-mix');
        const filtrMixVal = fxDrawerEl.querySelector('.filtr-mix-val');
        trackInitKnob(filtrMixSlider, (val) => {
            const pct = val / 100;
            filtrMixVal.textContent = val + '%';
            track.filtrMix = pct;
            updateFiltrBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 100,
            value: Math.round(track.filtrMix * 100)
        });

        // Wire Scream controls
        const screamCutoffSlider = fxDrawerEl.querySelector('.scream-cutoff');
        const screamCutoffVal = fxDrawerEl.querySelector('.scream-cutoff-val');
        trackInitKnob(screamCutoffSlider, (val) => {
            screamCutoffVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.screamCutoff = val;
            screamFilter.frequency.value = val;
        }, {
            min: 20,
            max: 20000,
            step: 1,
            defaultVal: 8000,
            value: track.screamCutoff
        });

        const screamAmountSlider = fxDrawerEl.querySelector('.scream-amount');
        const screamAmountVal = fxDrawerEl.querySelector('.scream-amount-val');
        trackInitKnob(screamAmountSlider, (val) => {
            screamAmountVal.textContent = val + '%';
            const q = 0.707 + (24.293 * val / 100);
            const drive = 5 + (75 * val / 100);
            track.screamAmount = q;
            track.screamDriveAmount = drive;
            screamFilter.Q.value = q;
            screamShaper.curve = makeDistortionCurve(drive);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 0,
            value: Math.round(((track.screamAmount - 0.707) / 24.293) * 100)
        });

        const screamMixSlider = fxDrawerEl.querySelector('.scream-mix');
        const screamMixVal = fxDrawerEl.querySelector('.scream-mix-val');
        trackInitKnob(screamMixSlider, (val) => {
            const pct = val / 100;
            screamMixVal.textContent = val + '%';
            track.screamMix = pct;
            updateScreamBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 100,
            value: Math.round(track.screamMix * 100)
        });

        // Wire Aelapse delay/reverb controls
        const aeMix = fxDrawerEl.querySelector('.aelapse-mix');
        const aeMixVal = fxDrawerEl.querySelector('.aelapse-mix-val');
        trackInitKnob(aeMix, (val) => {
            const pct = (val / 100) * 0.7;
            const mix = pct;
            const feedback = pct * 0.95;
            track.aelapseDelayMix = mix;
            track.aelapseFeedback = feedback;
            track.aelapseDelayGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
            track.aelapseFeedbackNode.gain.setTargetAtTime(feedback, ctx.currentTime, 0.01);
            const displayMix = val;
            const displayFb = val * 0.95;
            aeMixVal.textContent = `${displayMix.toFixed(1)}% (Fb: ${displayFb.toFixed(1)}%)`;
            updateAelapseBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 0.1,
            defaultVal: 0,
            value: track.aelapseDelayMix * 100
        });

        const aeReverbMix = fxDrawerEl.querySelector('.aelapse-reverb-mix');
        const aeReverbVal = fxDrawerEl.querySelector('.aelapse-reverb-val');
        trackInitKnob(aeReverbMix, (val) => {
            const pct = (val / 100) * 0.7;
            const mix = pct;
            track.aelapseReverbMix = mix;
            track.aelapseReverbGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
            const displayMix = val;
            aeReverbVal.textContent = `${displayMix.toFixed(1)}%`;
            updateAelapseBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 0.1,
            defaultVal: 0,
            value: track.aelapseReverbMix * 100
        });

        const aeReverbSize = fxDrawerEl.querySelector('.aelapse-reverb-size');
        const aeReverbSizeVal = fxDrawerEl.querySelector('.aelapse-reverb-size-val');
        trackInitKnob(aeReverbSize, (val) => {
            track.aelapseReverbSize = val;
            aeReverbSizeVal.textContent = val.toFixed(1) + 's';
            try {
                track.aelapseReverbNode.buffer = createSpringImpulseResponse(ctx, val, 2.5);
            } catch (err) {
                console.error('Failed to update convolver buffer:', err);
            }
        }, {
            min: 0.5,
            max: 5.0,
            step: 0.1,
            defaultVal: 2.0,
            value: track.aelapseReverbSize
        });

        const aeSync = fxDrawerEl.querySelector('.aelapse-sync');
        const aeSyncVal = fxDrawerEl.querySelector('.aelapse-sync-val');
        const syncLabels = ['1/16', '1/8T', '1/8', 'd8th', '1/4', 'd1/4', '1/2', 'd1/2', '1/1'];
        const syncBeats = [0.25, 0.333, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
        trackInitKnob(aeSync, (val) => {
            const idx = parseInt(val);
            track.delaySyncIndex = idx;
            aeSyncVal.textContent = syncLabels[idx];
            const bpm = parseInt(bpmInput.value) || 120;
            const delayTimeSec = (60.0 / bpm) * syncBeats[idx];
            track.aelapseDelayTime = delayTimeSec;
            track.aelapseDelayNode.delayTime.setValueAtTime(delayTimeSec, audioCtx.currentTime);
        }, {
            min: 0,
            max: 8,
            step: 1,
            defaultVal: 3,
            value: track.delaySyncIndex
        });

        // Wire Chorus controls
        const chorusRateSyncKnob = fxDrawerEl.querySelector('.chorus-rate-sync-knob');
        const chorusRateSyncVal = fxDrawerEl.querySelector('.chorus-rate-sync-val');
        const chorusRateSlider = fxDrawerEl.querySelector('.chorus-rate');
        const chorusPhaserSyncLabels = ['Free', '1/16', '1/8', '1/4', '1/2', '1/1', '4/1', '8/1', '16/1', '32/1'];
        trackInitKnob(chorusRateSyncKnob, (val) => {
            const idx = parseInt(val);
            track.tunaChorusRateSyncIndex = idx;
            track.tunaChorusRateSync = chorusPhaserSyncLabels[idx];
            chorusRateSyncVal.textContent = chorusPhaserSyncLabels[idx];
            if (chorusRateSlider) {
                if (idx === 0) {
                    chorusRateSlider.disabled = track.locked;
                } else {
                    chorusRateSlider.disabled = true;
                }
            }
            updateTunaTempoSync(track);
        }, {
            min: 0,
            max: 9,
            step: 1,
            defaultVal: 0,
            value: track.tunaChorusRateSyncIndex
        });


        const chorusRateVal = fxDrawerEl.querySelector('.chorus-rate-val');
        trackInitKnob(chorusRateSlider, (val) => {
            chorusRateVal.textContent = val.toFixed(2) + 'Hz';
            track.tunaChorusRate = val;
            if (track.tunaChorusRateSync === 'Free' && track.tunaChorusNode) {
                track.tunaChorusNode.rate = val;
            }
        }, {
            min: 0.01,
            max: 20.0,
            step: 0.01,
            defaultVal: 1.5,
            value: track.tunaChorusRate
        });

        const chorusDepthSlider = fxDrawerEl.querySelector('.chorus-depth');
        const chorusDepthVal = fxDrawerEl.querySelector('.chorus-depth-val');
        trackInitKnob(chorusDepthSlider, (val) => {
            chorusDepthVal.textContent = val + '%';
            const mappedVal = val / 100.0;
            track.tunaChorusDepth = mappedVal;
            if (track.tunaChorusNode) {
                track.tunaChorusNode.depth = mappedVal;
            }
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 70,
            value: Math.round(track.tunaChorusDepth * 100)
        });

        const chorusFeedbackSlider = fxDrawerEl.querySelector('.chorus-feedback');
        const chorusFeedbackVal = fxDrawerEl.querySelector('.chorus-feedback-val');
        trackInitKnob(chorusFeedbackSlider, (val) => {
            chorusFeedbackVal.textContent = val + '%';
            const mappedVal = val / 100.0;
            track.tunaChorusFeedback = mappedVal;
            if (track.tunaChorusNode) {
                track.tunaChorusNode.feedback = mappedVal;
            }
        }, {
            min: 0,
            max: 95,
            step: 1,
            defaultVal: 20,
            value: Math.round(track.tunaChorusFeedback * 100)
        });

        const chorusMixSlider = fxDrawerEl.querySelector('.chorus-mix');
        const chorusMixVal = fxDrawerEl.querySelector('.chorus-mix-val');
        trackInitKnob(chorusMixSlider, (val) => {
            const pct = val / 100;
            chorusMixVal.textContent = val + '%';
            track.tunaChorusMix = pct;
            updateTunaChorusBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 50,
            value: Math.round(track.tunaChorusMix * 100)
        });

        // Wire Phaser controls
        const phaserRateSyncKnob = fxDrawerEl.querySelector('.phaser-rate-sync-knob');
        const phaserRateSyncVal = fxDrawerEl.querySelector('.phaser-rate-sync-val');
        const phaserRateSlider = fxDrawerEl.querySelector('.phaser-rate');
        trackInitKnob(phaserRateSyncKnob, (val) => {
            const idx = parseInt(val);
            track.tunaPhaserRateSyncIndex = idx;
            track.tunaPhaserRateSync = chorusPhaserSyncLabels[idx];
            phaserRateSyncVal.textContent = chorusPhaserSyncLabels[idx];
            if (phaserRateSlider) {
                if (idx === 0) {
                    phaserRateSlider.disabled = track.locked;
                } else {
                    phaserRateSlider.disabled = true;
                }
            }
            updateTunaTempoSync(track);
        }, {
            min: 0,
            max: 9,
            step: 1,
            defaultVal: 0,
            value: track.tunaPhaserRateSyncIndex
        });


        const phaserRateVal = fxDrawerEl.querySelector('.phaser-rate-val');
        trackInitKnob(phaserRateSlider, (val) => {
            phaserRateVal.textContent = val.toFixed(2) + 'Hz';
            track.tunaPhaserRate = val;
            if (track.tunaPhaserRateSync === 'Free' && track.tunaPhaserNode) {
                track.tunaPhaserNode.rate = val;
            }
        }, {
            min: 0.01,
            max: 20.0,
            step: 0.01,
            defaultVal: 1.2,
            value: track.tunaPhaserRate
        });

        const phaserDepthSlider = fxDrawerEl.querySelector('.phaser-depth');
        const phaserDepthVal = fxDrawerEl.querySelector('.phaser-depth-val');
        trackInitKnob(phaserDepthSlider, (val) => {
            phaserDepthVal.textContent = val + '%';
            const mappedVal = val / 100.0;
            track.tunaPhaserDepth = mappedVal;
            if (track.tunaPhaserNode) {
                track.tunaPhaserNode.depth = mappedVal;
            }
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 60,
            value: Math.round(track.tunaPhaserDepth * 100)
        });

        const phaserFeedbackSlider = fxDrawerEl.querySelector('.phaser-feedback');
        const phaserFeedbackVal = fxDrawerEl.querySelector('.phaser-feedback-val');
        trackInitKnob(phaserFeedbackSlider, (val) => {
            phaserFeedbackVal.textContent = val + '%';
            const mappedVal = val / 100.0;
            track.tunaPhaserFeedback = mappedVal;
            if (track.tunaPhaserNode) {
                track.tunaPhaserNode.feedback = mappedVal;
            }
        }, {
            min: 0,
            max: 95,
            step: 1,
            defaultVal: 20,
            value: Math.round(track.tunaPhaserFeedback * 100)
        });

        const phaserMixSlider = fxDrawerEl.querySelector('.phaser-mix');
        const phaserMixVal = fxDrawerEl.querySelector('.phaser-mix-val');
        trackInitKnob(phaserMixSlider, (val) => {
            const pct = val / 100;
            phaserMixVal.textContent = val + '%';
            track.tunaPhaserMix = pct;
            updateTunaPhaserBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 50,
            value: Math.round(track.tunaPhaserMix * 100)
        });

        // Wire Crusher controls
        const crusherBitsSlider = fxDrawerEl.querySelector('.crusher-bits');
        const crusherBitsVal = fxDrawerEl.querySelector('.crusher-bits-val');
        trackInitKnob(crusherBitsSlider, (val) => {
            crusherBitsVal.textContent = val + ' bits';
            track.tunaBitcrusherBits = val;
            if (track.tunaBitcrusherNode) {
                track.tunaBitcrusherNode.bits = val;
            }
        }, {
            min: 1,
            max: 16,
            step: 1,
            defaultVal: 8,
            value: track.tunaBitcrusherBits
        });

        const crusherNormfreqSlider = fxDrawerEl.querySelector('.crusher-normfreq');
        const crusherNormfreqVal = fxDrawerEl.querySelector('.crusher-normfreq-val');
        trackInitKnob(crusherNormfreqSlider, (val) => {
            crusherNormfreqVal.textContent = val.toFixed(2);
            track.tunaBitcrusherNormfreq = val;
            if (track.tunaBitcrusherNode) {
                track.tunaBitcrusherNode.normfreq = val;
            }
        }, {
            min: 0.01,
            max: 1.0,
            step: 0.01,
            defaultVal: 0.1,
            value: track.tunaBitcrusherNormfreq
        });

        const crusherMixSlider = fxDrawerEl.querySelector('.crusher-mix');
        const crusherMixVal = fxDrawerEl.querySelector('.crusher-mix-val');
        trackInitKnob(crusherMixSlider, (val) => {
            const pct = val / 100;
            crusherMixVal.textContent = val + '%';
            track.tunaBitcrusherMix = pct;
            updateTunaBitcrusherBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 50,
            value: Math.round(track.tunaBitcrusherMix * 100)
        });

        // Wire Tape Delay wow/flutter additions
        const aeWowRateSlider = fxDrawerEl.querySelector('.aelapse-wow-rate');
        const aeWowRateVal = fxDrawerEl.querySelector('.aelapse-wow-rate-val');
        trackInitKnob(aeWowRateSlider, (val) => {
            aeWowRateVal.textContent = val.toFixed(1) + 'Hz';
            track.aelapseDelayWowRate = val;
            if (aelapseLFO) aelapseLFO.frequency.setValueAtTime(val, ctx.currentTime);
        }, {
            min: 0.1,
            max: 10.0,
            step: 0.1,
            defaultVal: 2.0,
            value: track.aelapseDelayWowRate
        });

        const aeWowDepthSlider = fxDrawerEl.querySelector('.aelapse-wow-depth');
        const aeWowDepthVal = fxDrawerEl.querySelector('.aelapse-wow-depth-val');
        trackInitKnob(aeWowDepthSlider, (val) => {
            aeWowDepthVal.textContent = val.toFixed(1) + '%';
            track.aelapseDelayWowDepth = val / 1000;
            if (aelapseLFOGain) aelapseLFOGain.gain.setValueAtTime(val / 1000, ctx.currentTime);
        }, {
            min: 0,
            max: 5, // maps to 0.0 to 0.005 (0.5% max)
            step: 1,
            defaultVal: 0, // default is 0% (off)
            value: Math.round(track.aelapseDelayWowDepth * 1000)
        });

        const aeReverbPreDelaySlider = fxDrawerEl.querySelector('.aelapse-reverb-predelay');
        const aeReverbPreDelayVal = fxDrawerEl.querySelector('.aelapse-reverb-predelay-val');
        trackInitKnob(aeReverbPreDelaySlider, (val) => {
            aeReverbPreDelayVal.textContent = val + 'ms';
            track.aelapseReverbPreDelay = val;
            if (reverbPreDelay) reverbPreDelay.delayTime.setValueAtTime(val / 1000, ctx.currentTime);
        }, {
            min: 0,
            max: 200,
            step: 1,
            defaultVal: 0,
            value: track.aelapseReverbPreDelay
        });

        const aeReverbDampSlider = fxDrawerEl.querySelector('.aelapse-reverb-damp');
        const aeReverbDampVal = fxDrawerEl.querySelector('.aelapse-reverb-damp-val');
        trackInitKnob(aeReverbDampSlider, (val) => {
            aeReverbDampVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.aelapseReverbDamp = val;
            if (reverbDampFilter) reverbDampFilter.frequency.setValueAtTime(val, ctx.currentTime);
        }, {
            min: 100,
            max: 20000,
            step: 100,
            defaultVal: 20000,
            value: track.aelapseReverbDamp
        });

        // Wire Tremolo controls
        const tremoloToggle = fxDrawerEl.querySelector('.tremolo-toggle');
        if (tremoloToggle) {
            tremoloToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                track.tremoloEnabled = !track.tremoloEnabled;
                tremoloToggle.classList.toggle('is-off', !track.tremoloEnabled);
                tremoloToggle.classList.toggle('is-on', track.tremoloEnabled);
                tremoloToggle.textContent = track.tremoloEnabled ? 'On' : 'Off';
                setToggleButtonPressed(tremoloToggle, track.tremoloEnabled);
                const section = fxDrawerEl.querySelector('.tremolo-section');
                if (section) section.classList.toggle('is-bypassed', !track.tremoloEnabled);
                updateTremoloBypass(track);
            });
        }

        const tremoloRateSlider = fxDrawerEl.querySelector('.tremolo-rate');
        const tremoloRateVal = fxDrawerEl.querySelector('.tremolo-rate-val');
        trackInitKnob(tremoloRateSlider, (val) => {
            tremoloRateVal.textContent = val.toFixed(1) + 'Hz';
            track.tremoloRate = val;
            if (tremoloLfoNode) tremoloLfoNode.frequency.setValueAtTime(val, ctx.currentTime);
        }, {
            min: 0.1,
            max: 20.0,
            step: 0.1,
            defaultVal: 5.0,
            value: track.tremoloRate
        });

        const tremoloDepthSlider = fxDrawerEl.querySelector('.tremolo-depth');
        const tremoloDepthVal = fxDrawerEl.querySelector('.tremolo-depth-val');
        trackInitKnob(tremoloDepthSlider, (val) => {
            tremoloDepthVal.textContent = val + '%';
            const depth = val / 100;
            track.tremoloDepth = depth;
            updateTremoloBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 0,
            value: Math.round(track.tremoloDepth * 100)
        });

        const tremoloShapeSelect = fxDrawerEl.querySelector('.tremolo-shape');
        if (tremoloShapeSelect) {
            tremoloShapeSelect.addEventListener('change', () => {
                track.tremoloShape = tremoloShapeSelect.value;
                if (tremoloLfoNode) tremoloLfoNode.type = tremoloShapeSelect.value;
            });
        }

        // Wire Tempo Gate controls
        const gateToggle = fxDrawerEl.querySelector('.gate-toggle');
        if (gateToggle) {
            gateToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                track.gateEnabled = !track.gateEnabled;
                gateToggle.classList.toggle('is-off', !track.gateEnabled);
                gateToggle.classList.toggle('is-on', track.gateEnabled);
                gateToggle.textContent = track.gateEnabled ? 'On' : 'Off';
                setToggleButtonPressed(gateToggle, track.gateEnabled);
                const section = fxDrawerEl.querySelector('.gate-section');
                if (section) section.classList.toggle('is-bypassed', !track.gateEnabled);
                updateGateBypass(track);
            });
        }

        const gateSyncKnob = fxDrawerEl.querySelector('.gate-sync-knob');
        const gateSyncVal = fxDrawerEl.querySelector('.gate-sync-val');
        const gateSyncLabels = ['1/16', '1/8T', '1/8', 'd8th', '1/4', 'd1/4', '1/2', 'd1/2', '1/1'];
        trackInitKnob(gateSyncKnob, (val) => {
            const idx = parseInt(val);
            track.gateSyncIndex = idx;
            gateSyncVal.textContent = gateSyncLabels[idx];
            updateGateFrequency(track);
        }, {
            min: 0,
            max: 8,
            step: 1,
            defaultVal: 2, // 1/8 note default
            value: track.gateSyncIndex
        });

        const gateWidthSlider = fxDrawerEl.querySelector('.gate-width');
        const gateWidthVal = fxDrawerEl.querySelector('.gate-width-val');
        trackInitKnob(gateWidthSlider, (val) => {
            gateWidthVal.textContent = val + '%';
            track.gateWidth = val / 100;
            updateGateWidth(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 50,
            value: Math.round(track.gateWidth * 100)
        });

        const gateMixSlider = fxDrawerEl.querySelector('.gate-mix');
        const gateMixVal = fxDrawerEl.querySelector('.gate-mix-val');
        trackInitKnob(gateMixSlider, (val) => {
            gateMixVal.textContent = val + '%';
            track.gateMix = val / 100;
            updateGateBypass(track);
        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 50,
            value: Math.round(track.gateMix * 100)
        });

        const gateShapeSelect = fxDrawerEl.querySelector('.gate-shape');
        if (gateShapeSelect) {
            gateShapeSelect.addEventListener('change', () => {
                track.gateShape = gateShapeSelect.value;
                if (gateLfoNode) gateLfoNode.type = gateShapeSelect.value;
            });
        }

        // 12. Wire FX Drawer Macro Knobs
        const fxMacroKnobs = fxDrawerEl.querySelectorAll('.fx-macro-knob');
        fxMacroKnobs.forEach(knobEl => {
            const macroName = knobEl.dataset.macro;
            const defaultVal = (macroName === 'tone' || macroName === 'filter') ? 50 : 0;

            trackInitKnob(knobEl, (val) => {
                applyFxMacro(macroName, val);
            }, {
                min: 0,
                max: 100,
                step: 1,
                defaultVal: defaultVal,
                value: defaultVal
            });

            fxMacroState[macroName] = knobEl;

            // Wire hover highlighting for macro knobs
            const targetSelectors = macroHoverTargets[macroName];
            if (targetSelectors) {
                knobEl.addEventListener('mouseenter', () => {
                    targetSelectors.forEach(selector => {
                        const targets = fxDrawerEl.querySelectorAll(selector);
                        targets.forEach(target => {
                            target.classList.add('macro-target-highlight');
                        });
                    });
                });
                knobEl.addEventListener('mouseleave', () => {
                    targetSelectors.forEach(selector => {
                        const targets = fxDrawerEl.querySelectorAll(selector);
                        targets.forEach(target => {
                            target.classList.remove('macro-target-highlight');
                        });
                    });
                });
            }
        });

        function applyFxMacro(macroName, value) {
            const knobEl = fxDrawerEl.querySelector(`.fx-macro-knob[data-macro="${macroName}"]`);
            const indicator = knobEl.querySelector('.macro-knob-indicator');

            if (macroName === 'tone') {
                const deg = -135 + (value / 100) * 270;
                setPresentation(indicator, { transform: `rotate(${deg}deg)` });
                if (value === 50) {
                    knobEl.title = 'Tone: Flat';
                } else if (value < 50) {
                    knobEl.title = 'Tone: Dark';
                } else {
                    knobEl.title = 'Tone: Bright';
                }
                const eqSlidersList = fxDrawerEl.querySelectorAll('.eq-slider');
                if (eqSlidersList.length === 6) {
                    let bandGains = [0, 0, 0, 0, 0, 0];
                    if (value < 50) {
                        const factor = (50 - value) / 50;
                        bandGains = [7.8 * factor * 1.3, 7.8 * factor * 1.3, 5.2 * factor * 1.3, 0, -7.8 * factor * 1.3, -7.8 * factor * 1.3];
                    } else if (value > 50) {
                        const factor = (value - 50) / 50;
                        bandGains = [-7.8 * factor * 1.3, -7.8 * factor * 1.3, -3.9 * factor * 1.3, 0, 7.8 * factor * 1.3, 10.4 * factor * 1.3];
                    }
                    eqSlidersList.forEach((slider, b) => {
                        slider.value = bandGains[b];
                    });
                }
            } else if (macroName === 'filter') {
                const deg = -135 + (value / 100) * 270;
                setPresentation(indicator, { transform: `rotate(${deg}deg)` });
                const ctx = ensureAudioCtx();
                if (value === 50) {
                    knobEl.title = 'Filter: Off';
                    if (track.filtrEnabled) {
                        const toggle = fxDrawerEl.querySelector('.filtr-toggle');
                        if (toggle) toggle.click();
                    }
                } else {
                    if (!track.filtrEnabled) {
                        const toggle = fxDrawerEl.querySelector('.filtr-toggle');
                        if (toggle) toggle.click();
                    }
                    if (value < 50) {
                        const norm = value / 50;
                        const cutoff = 60 * Math.pow(20000 / 60, norm);
                        track.filtrFilterNode.type = 'lowpass';
                        track.filtrFilterNode.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.02);
                        track.filtrDryGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
                        track.filtrWetGainNode.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
                        knobEl.title = `LP: ${cutoff >= 1000 ? (cutoff / 1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    } else {
                        const norm = (value - 50) / 50;
                        const cutoff = 20 * Math.pow(12000 / 20, norm);
                        track.filtrFilterNode.type = 'highpass';
                        track.filtrFilterNode.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.02);
                        track.filtrDryGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
                        track.filtrWetGainNode.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
                        knobEl.title = `HP: ${cutoff >= 1000 ? (cutoff / 1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    }
                }
            } else {
                const deg = -135 + (value / 100) * 270;
                setPresentation(indicator, { transform: `rotate(${deg}deg)` });
                knobEl.title = `${macroName.charAt(0).toUpperCase() + macroName.slice(1)}: ${value}%`;

                if (macroName === 'space') {
                    const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
                    const reverbMixSlider = fxDrawerEl.querySelector('.aelapse-reverb-mix');
                    if (delayMixSlider) { delayMixSlider.value = value; }
                    if (reverbMixSlider) { reverbMixSlider.value = value; }
                } else if (macroName === 'drive') {
                    const screamVal = Math.round(value * 0.6);
                    const screamAmtSlider = fxDrawerEl.querySelector('.scream-amount');
                    const screamMxSlider = fxDrawerEl.querySelector('.scream-mix');
                    if (screamAmtSlider) { screamAmtSlider.value = screamVal; }
                    if (screamMxSlider) { screamMxSlider.value = 100; }
                    if (value > 0 && !track.screamEnabled) {
                        const screamToggle = fxDrawerEl.querySelector('.scream-toggle');
                        if (screamToggle) screamToggle.click();
                    }
                } else if (macroName === 'reso') {
                    const resoSlider = fxDrawerEl.querySelector('.filtr-lp-reso');
                    if (resoSlider) { resoSlider.value = Math.round(1 + (249 * value / 100)); }
                } else if (macroName === 'delay') {
                    const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
                    if (!track.aelapseDelayEnabled && value > 0) {
                        const toggle = fxDrawerEl.querySelector('.aelapse-delay-toggle');
                        if (toggle) toggle.click();
                    }
                    if (delayMixSlider) { delayMixSlider.value = value; }
                } else if (macroName === 'feedback') {
                    const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
                    if (delayMixSlider) {
                        const feedback = Math.round(value * 0.95);
                        track.aelapseFeedback = feedback / 100;
                        track.aelapseFeedbackNode.gain.setTargetAtTime(track.aelapseFeedback, ctx.currentTime, 0.01);
                        const aeMixVal = fxDrawerEl.querySelector('.aelapse-mix-val');
                        if (aeMixVal) {
                            const mixPct = Math.round(track.aelapseDelayMix * 100);
                            aeMixVal.textContent = `${mixPct}% (Fb: ${feedback}%)`;
                        }
                    }
                    if (track.tunaChorusNode) {
                        track.tunaChorusFeedback = value / 100;
                        track.tunaChorusNode.feedback = track.tunaChorusFeedback;
                        const chorusFbVal = fxDrawerEl.querySelector('.chorus-feedback-val');
                        if (chorusFbVal) chorusFbVal.textContent = value + '%';
                        const chorusFbKnob = fxDrawerEl.querySelector('.chorus-feedback');
                        if (chorusFbKnob) chorusFbKnob.value = value;
                    }
                    if (track.tunaPhaserNode) {
                        track.tunaPhaserFeedback = value / 100;
                        track.tunaPhaserNode.feedback = track.tunaPhaserFeedback;
                        const phaserFbVal = fxDrawerEl.querySelector('.phaser-feedback-val');
                        if (phaserFbVal) phaserFbVal.textContent = value + '%';
                        const phaserFbKnob = fxDrawerEl.querySelector('.phaser-feedback');
                        if (phaserFbKnob) phaserFbKnob.value = value;
                    }
                } else if (macroName === 'crush') {
                    const screamCutoffSlider = fxDrawerEl.querySelector('.scream-cutoff');
                    const screamAmtSlider = fxDrawerEl.querySelector('.scream-amount');
                    if (!track.screamEnabled && value > 0) {
                        const toggle = fxDrawerEl.querySelector('.scream-toggle');
                        if (toggle) toggle.click();
                    }
                    if (screamCutoffSlider) {
                        const cutoff = Math.round(16000 - (15800 * value / 100));
                        screamCutoffSlider.value = cutoff;
                    }
                    if (screamAmtSlider) { screamAmtSlider.value = value; }
                } else if (macroName === 'depth') {
                    if (value > 0) {
                        if (!track.filtrEnabled) {
                            const btn = fxDrawerEl.querySelector('.filtr-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.screamEnabled) {
                            const btn = fxDrawerEl.querySelector('.scream-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaChorusEnabled) {
                            const btn = fxDrawerEl.querySelector('.chorus-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaPhaserEnabled) {
                            const btn = fxDrawerEl.querySelector('.phaser-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaBitcrusherEnabled) {
                            const btn = fxDrawerEl.querySelector('.crusher-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const fMix = fxDrawerEl.querySelector('.filtr-mix');
                    const sMix = fxDrawerEl.querySelector('.scream-mix');
                    const cMix = fxDrawerEl.querySelector('.chorus-mix');
                    const pMix = fxDrawerEl.querySelector('.phaser-mix');
                    const crMix = fxDrawerEl.querySelector('.crusher-mix');
                    if (fMix) fMix.value = value;
                    if (sMix) sMix.value = value;
                    if (cMix) cMix.value = value;
                    if (pMix) pMix.value = value;
                    if (crMix) crMix.value = value;
                } else if (macroName === 'rate') {
                    if (value > 0) {
                        if (!track.tunaChorusEnabled) {
                            const btn = fxDrawerEl.querySelector('.chorus-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaPhaserEnabled) {
                            const btn = fxDrawerEl.querySelector('.phaser-toggle');
                            if (btn) btn.click();
                        }
                    }
                    if (track.tunaChorusRateSync !== 'Free') {
                        track.tunaChorusRateSync = 'Free';
                        track.tunaChorusRateSyncIndex = 0;
                        const chorusSyncKnob = fxDrawerEl.querySelector('.chorus-rate-sync-knob');
                        if (chorusSyncKnob) chorusSyncKnob.value = 0;
                    }
                    if (track.tunaPhaserRateSync !== 'Free') {
                        track.tunaPhaserRateSync = 'Free';
                        track.tunaPhaserRateSyncIndex = 0;
                        const phaserSyncKnob = fxDrawerEl.querySelector('.phaser-rate-sync-knob');
                        if (phaserSyncKnob) phaserSyncKnob.value = 0;
                    }
                    const rateVal = 0.01 + (value / 100) * 19.99;
                    const cRate = fxDrawerEl.querySelector('.chorus-rate');
                    const pRate = fxDrawerEl.querySelector('.phaser-rate');
                    if (cRate) cRate.value = rateVal;
                    if (pRate) pRate.value = rateVal;
                } else if (macroName === 'warmth') {
                    if (value > 0) {
                        if (!track.eqEnabled) {
                            const btn = fxDrawerEl.querySelector('.eq-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.screamEnabled) {
                            const btn = fxDrawerEl.querySelector('.scream-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const eqGain = (value / 100) * 9.0;
                    const band0 = fxDrawerEl.querySelector('.eq-slider[data-band="0"]');
                    const band1 = fxDrawerEl.querySelector('.eq-slider[data-band="1"]');
                    if (band0) band0.value = eqGain;
                    if (band1) band1.value = eqGain;

                    const screamVal = Math.round(value * 0.3);
                    const sAmt = fxDrawerEl.querySelector('.scream-amount');
                    if (sAmt) sAmt.value = screamVal;
                } else if (macroName === 'air') {
                    if (value > 0) {
                        if (!track.eqEnabled) {
                            const btn = fxDrawerEl.querySelector('.eq-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.filtrEnabled) {
                            const btn = fxDrawerEl.querySelector('.filtr-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const eqGain = (value / 100) * 9.0;
                    const band5 = fxDrawerEl.querySelector('.eq-slider[data-band="5"]');
                    if (band5) band5.value = eqGain;

                    if (track.filtrFilterNode && track.filtrFilterNode.type !== 'lowpass') {
                        track.filtrFilterNode.type = 'lowpass';
                    }
                    const filterCutoffVal = 1000 + (value / 100) * 19000;
                    const fCutoff = fxDrawerEl.querySelector('.filtr-lp-cutoff');
                    if (fCutoff) fCutoff.value = filterCutoffVal;
                } else if (macroName === 'grit') {
                    if (value > 0) {
                        if (!track.tunaBitcrusherEnabled) {
                            const btn = fxDrawerEl.querySelector('.crusher-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.screamEnabled) {
                            const btn = fxDrawerEl.querySelector('.scream-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const bitsVal = Math.round(16 - (value / 100) * 12);
                    const normFreqVal = 1.0 - (value / 100) * 0.95;
                    const crBits = fxDrawerEl.querySelector('.crusher-bits');
                    const crFreq = fxDrawerEl.querySelector('.crusher-normfreq');
                    if (crBits) crBits.value = bitsVal;
                    if (crFreq) crFreq.value = normFreqVal;

                    const screamVal = Math.round(value * 0.5);
                    const sAmt = fxDrawerEl.querySelector('.scream-amount');
                    if (sAmt) sAmt.value = screamVal;
                } else if (macroName === 'wobble') {
                    if (value > 0) {
                        if (!track.tunaChorusEnabled) {
                            const btn = fxDrawerEl.querySelector('.chorus-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaPhaserEnabled) {
                            const btn = fxDrawerEl.querySelector('.phaser-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const cDepth = fxDrawerEl.querySelector('.chorus-depth');
                    const pDepth = fxDrawerEl.querySelector('.phaser-depth');
                    if (cDepth) cDepth.value = value;
                    if (pDepth) pDepth.value = value;

                    const chorusRateSyncSelect = fxDrawerEl.querySelector('.chorus-rate-sync');
                    if (chorusRateSyncSelect && chorusRateSyncSelect.value !== 'Free') {
                        chorusRateSyncSelect.value = 'Free';
                        track.tunaChorusRateSync = 'Free';
                    }
                    const rateVal = 1.0 + (value / 100) * 7.0;
                    const cRate = fxDrawerEl.querySelector('.chorus-rate');
                    if (cRate) cRate.value = rateVal;
                } else if (macroName === 'presence') {
                    if (value > 0) {
                        if (!track.tunaChorusEnabled) {
                            const btn = fxDrawerEl.querySelector('.chorus-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.tunaPhaserEnabled) {
                            const btn = fxDrawerEl.querySelector('.phaser-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.aelapseReverbEnabled) {
                            const btn = fxDrawerEl.querySelector('.aelapse-reverb-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const cDepth = fxDrawerEl.querySelector('.chorus-depth');
                    const pDepth = fxDrawerEl.querySelector('.phaser-depth');
                    if (cDepth) cDepth.value = Math.round(value * 0.8);
                    if (pDepth) pDepth.value = Math.round(value * 0.8);

                    const revMix = fxDrawerEl.querySelector('.aelapse-reverb-mix');
                    if (revMix) revMix.value = Math.round(value * 0.6);
                } else if (macroName === 'pump') {
                    if (value > 0) {
                        if (!track.screamEnabled) {
                            const btn = fxDrawerEl.querySelector('.scream-toggle');
                            if (btn) btn.click();
                        }
                        if (!track.eqEnabled) {
                            const btn = fxDrawerEl.querySelector('.eq-toggle');
                            if (btn) btn.click();
                        }
                    }
                    const screamVal = Math.round(value * 0.6);
                    const sAmt = fxDrawerEl.querySelector('.scream-amount');
                    if (sAmt) sAmt.value = screamVal;

                    const eqGain = (value / 100) * 8.0;
                    const band2 = fxDrawerEl.querySelector('.eq-slider[data-band="2"]');
                    const band3 = fxDrawerEl.querySelector('.eq-slider[data-band="3"]');
                    if (band2) band2.value = eqGain;
                    if (band3) band3.value = eqGain;
                }
            }
        }

        // 13. Wire Bypass Switches
        const filtrToggleBtn = fxDrawerEl.querySelector('.filtr-toggle');
        const filtrSection = fxDrawerEl.querySelector('.filtr-section');
        filtrToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.filtrEnabled = !track.filtrEnabled;
            filtrToggleBtn.textContent = track.filtrEnabled ? 'On' : 'Off';
            filtrToggleBtn.classList.toggle('is-off', !track.filtrEnabled);
            setToggleButtonPressed(filtrToggleBtn, track.filtrEnabled);
            filtrSection.classList.toggle('is-bypassed', !track.filtrEnabled);
            updateFiltrBypass(track);
        });

        const eqToggleBtn = fxDrawerEl.querySelector('.eq-toggle');
        const eqSection = fxDrawerEl.querySelector('.eq-section');
        eqToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.eqEnabled = !track.eqEnabled;
            eqToggleBtn.textContent = track.eqEnabled ? 'On' : 'Bypass';
            eqToggleBtn.classList.toggle('is-off', !track.eqEnabled);
            setToggleButtonPressed(eqToggleBtn, track.eqEnabled);
            eqSection.classList.toggle('is-bypassed', !track.eqEnabled);
            updateEqBypass(track);
        });

        const screamToggleBtn = fxDrawerEl.querySelector('.scream-toggle');
        const screamSection = fxDrawerEl.querySelector('.scream-section');
        screamToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.screamEnabled = !track.screamEnabled;
            screamToggleBtn.textContent = track.screamEnabled ? 'On' : 'Off';
            screamToggleBtn.classList.toggle('is-off', !track.screamEnabled);
            setToggleButtonPressed(screamToggleBtn, track.screamEnabled);
            screamSection.classList.toggle('is-bypassed', !track.screamEnabled);
            updateScreamBypass(track);
        });

        const aeDelayToggleBtn = fxDrawerEl.querySelector('.aelapse-delay-toggle');
        const delaySection = fxDrawerEl.querySelector('.delay-section');
        aeDelayToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.aelapseDelayEnabled = !track.aelapseDelayEnabled;
            aeDelayToggleBtn.textContent = track.aelapseDelayEnabled ? 'On' : 'Off';
            aeDelayToggleBtn.classList.toggle('is-off', !track.aelapseDelayEnabled);
            setToggleButtonPressed(aeDelayToggleBtn, track.aelapseDelayEnabled);
            delaySection.classList.toggle('is-bypassed', !track.aelapseDelayEnabled);
            updateAelapseBypass(track);
        });

        const aeReverbToggleBtn = fxDrawerEl.querySelector('.aelapse-reverb-toggle');
        const reverbSection = fxDrawerEl.querySelector('.reverb-section');
        aeReverbToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.aelapseReverbEnabled = !track.aelapseReverbEnabled;
            aeReverbToggleBtn.textContent = track.aelapseReverbEnabled ? 'On' : 'Off';
            aeReverbToggleBtn.classList.toggle('is-off', !track.aelapseReverbEnabled);
            setToggleButtonPressed(aeReverbToggleBtn, track.aelapseReverbEnabled);
            reverbSection.classList.toggle('is-bypassed', !track.aelapseReverbEnabled);
            updateAelapseBypass(track);
        });

        const chorusToggleBtn = fxDrawerEl.querySelector('.chorus-toggle');
        const chorusSection = fxDrawerEl.querySelector('.chorus-section');
        chorusToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.tunaChorusEnabled = !track.tunaChorusEnabled;
            chorusToggleBtn.textContent = track.tunaChorusEnabled ? 'On' : 'Off';
            chorusToggleBtn.classList.toggle('is-off', !track.tunaChorusEnabled);
            setToggleButtonPressed(chorusToggleBtn, track.tunaChorusEnabled);
            chorusSection.classList.toggle('is-bypassed', !track.tunaChorusEnabled);
            updateTunaChorusBypass(track);
        });

        const phaserToggleBtn = fxDrawerEl.querySelector('.phaser-toggle');
        const phaserSection = fxDrawerEl.querySelector('.phaser-section');
        phaserToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.tunaPhaserEnabled = !track.tunaPhaserEnabled;
            phaserToggleBtn.textContent = track.tunaPhaserEnabled ? 'On' : 'Off';
            phaserToggleBtn.classList.toggle('is-off', !track.tunaPhaserEnabled);
            setToggleButtonPressed(phaserToggleBtn, track.tunaPhaserEnabled);
            phaserSection.classList.toggle('is-bypassed', !track.tunaPhaserEnabled);
            updateTunaPhaserBypass(track);
        });

        const crusherToggleBtn = fxDrawerEl.querySelector('.crusher-toggle');
        const crusherSection = fxDrawerEl.querySelector('.crusher-section');
        crusherToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.tunaBitcrusherEnabled = !track.tunaBitcrusherEnabled;
            crusherToggleBtn.textContent = track.tunaBitcrusherEnabled ? 'On' : 'Off';
            crusherToggleBtn.classList.toggle('is-off', !track.tunaBitcrusherEnabled);
            setToggleButtonPressed(crusherToggleBtn, track.tunaBitcrusherEnabled);
            crusherSection.classList.toggle('is-bypassed', !track.tunaBitcrusherEnabled);
            updateTunaBitcrusherBypass(track);
        });

        // Copy and Paste FX Event Listeners
        const copyBtn = fxDrawerEl.querySelector('.fx-copy-btn');
        const pasteBtn = fxDrawerEl.querySelector('.fx-paste-btn');

        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copiedFxSettings = {
                    filtrEnabled: track.filtrEnabled,
                    screamEnabled: track.screamEnabled,
                    eqEnabled: track.eqEnabled,
                    aelapseDelayEnabled: track.aelapseDelayEnabled,
                    aelapseReverbEnabled: track.aelapseReverbEnabled,

                    filtrHpCutoff: track.filtrHpCutoff,
                    filtrHpReso: track.filtrHpResonance,
                    filtrLpCutoff: track.filtrLpCutoff,
                    filtrLpReso: track.filtrLpResonance,
                    filtrDrive: track.filtrDrive,
                    filtrMix: track.filtrMix,

                    screamCutoff: track.screamCutoff,
                    screamAmount: track.screamAmount,
                    screamMix: track.screamMix,

                    eqGains: [...track.eqGains],

                    aelapseSync: track.delaySyncIndex,
                    aelapseMix: track.aelapseDelayMix,
                    aelapseReverbMix: track.aelapseReverbMix,
                    aelapseReverbSize: track.aelapseReverbSize,
                    aelapseDelayWowRate: track.aelapseDelayWowRate,
                    aelapseDelayWowDepth: track.aelapseDelayWowDepth,
                    aelapseReverbPreDelay: track.aelapseReverbPreDelay,
                    aelapseReverbDamp: track.aelapseReverbDamp,

                    tunaChorusEnabled: track.tunaChorusEnabled,
                    tunaChorusRateSync: track.tunaChorusRateSync,
                    tunaChorusRateSyncIndex: track.tunaChorusRateSyncIndex,
                    tunaChorusRate: track.tunaChorusRate,
                    tunaChorusDepth: track.tunaChorusDepth,
                    tunaChorusFeedback: track.tunaChorusFeedback,
                    tunaChorusMix: track.tunaChorusMix,

                    tunaPhaserEnabled: track.tunaPhaserEnabled,
                    tunaPhaserRateSync: track.tunaPhaserRateSync,
                    tunaPhaserRateSyncIndex: track.tunaPhaserRateSyncIndex,
                    tunaPhaserRate: track.tunaPhaserRate,
                    tunaPhaserDepth: track.tunaPhaserDepth,
                    tunaPhaserFeedback: track.tunaPhaserFeedback,
                    tunaPhaserMix: track.tunaPhaserMix,

                    tunaBitcrusherEnabled: track.tunaBitcrusherEnabled,
                    tunaBitcrusherBits: track.tunaBitcrusherBits,
                    tunaBitcrusherNormfreq: track.tunaBitcrusherNormfreq,
                    tunaBitcrusherMix: track.tunaBitcrusherMix,

                    tremoloEnabled: track.tremoloEnabled,
                    tremoloRate: track.tremoloRate,
                    tremoloDepth: track.tremoloDepth,
                    tremoloShape: track.tremoloShape,

                    gateEnabled: track.gateEnabled,
                    gateSyncIndex: track.gateSyncIndex,
                    gateWidth: track.gateWidth,
                    gateShape: track.gateShape,
                    gateMix: track.gateMix,

                    macros: {
                        space: fxMacroState.space ? fxMacroState.space.value : 0,
                        drive: fxMacroState.drive ? fxMacroState.drive.value : 0,
                        tone: fxMacroState.tone ? fxMacroState.tone.value : 50,
                        filter: fxMacroState.filter ? fxMacroState.filter.value : 50,
                        reso: fxMacroState.reso ? fxMacroState.reso.value : 0,
                        delay: fxMacroState.delay ? fxMacroState.delay.value : 0,
                        feedback: fxMacroState.feedback ? fxMacroState.feedback.value : 0,
                        crush: fxMacroState.crush ? fxMacroState.crush.value : 0,
                        depth: fxMacroState.depth ? fxMacroState.depth.value : 0,
                        rate: fxMacroState.rate ? fxMacroState.rate.value : 0,
                        warmth: fxMacroState.warmth ? fxMacroState.warmth.value : 0,
                        air: fxMacroState.air ? fxMacroState.air.value : 0,
                        grit: fxMacroState.grit ? fxMacroState.grit.value : 0,
                        wobble: fxMacroState.wobble ? fxMacroState.wobble.value : 0,
                        presence: fxMacroState.presence ? fxMacroState.presence.value : 0,
                        pump: fxMacroState.pump ? fxMacroState.pump.value : 0,
                    }
                };

                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = originalText; }, 1000);
            });
        }

        if (pasteBtn) {
            pasteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!copiedFxSettings) {
                    alert('No FX settings copied yet!');
                    return;
                }
                applyFxSettingsToTrack(copiedFxSettings);

                const originalText = pasteBtn.textContent;
                pasteBtn.textContent = 'Pasted!';
                setTimeout(() => { pasteBtn.textContent = originalText; }, 1000);
            });
        }

        const resetBtn = fxDrawerEl.querySelector('.fx-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (track.locked) return;

                const ctx = ensureAudioCtx();

                // 1. Reset toggles & bypass state values
                track.filtrEnabled = false;
                track.screamEnabled = false;
                track.eqEnabled = true;
                track.aelapseDelayEnabled = true;
                track.aelapseReverbEnabled = true;
                track.tunaChorusEnabled = false;
                track.tunaPhaserEnabled = false;
                track.tunaBitcrusherEnabled = false;
                track.tremoloEnabled = false;
                track.gateEnabled = false;

                // Update UI toggle button classes and text
                const toggles = [
                    { selector: '.filtr-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.filtr-section' },
                    { selector: '.scream-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.scream-section' },
                    { selector: '.eq-toggle', enabled: true, activeText: 'On', inactiveText: 'Bypass', section: '.eq-section' },
                    { selector: '.aelapse-delay-toggle', enabled: true, activeText: 'On', inactiveText: 'Off', section: '.delay-section' },
                    { selector: '.aelapse-reverb-toggle', enabled: true, activeText: 'On', inactiveText: 'Off', section: '.reverb-section' },
                    { selector: '.chorus-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.chorus-section' },
                    { selector: '.phaser-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.phaser-section' },
                    { selector: '.crusher-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.crusher-section' },
                    { selector: '.tremolo-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.tremolo-section' },
                    { selector: '.gate-toggle', enabled: false, activeText: 'On', inactiveText: 'Off', section: '.gate-section' }
                ];

                toggles.forEach(t => {
                    const btn = fxDrawerEl.querySelector(t.selector);
                    if (btn) {
                        btn.textContent = t.enabled ? t.activeText : t.inactiveText;
                        btn.classList.toggle('is-off', !t.enabled);
                    }
                    const section = fxDrawerEl.querySelector(t.section);
                    if (section) {
                        section.classList.toggle('is-bypassed', !t.enabled);
                    }
                });

                // Call bypass functions to update Web Audio Graph
                updateFiltrBypass(track);
                updateScreamBypass(track);
                updateEqBypass(track);
                updateTunaChorusBypass(track);
                updateTunaPhaserBypass(track);
                updateTunaBitcrusherBypass(track);
                updateAelapseBypass(track);
                updateTremoloBypass(track);
                updateGateBypass(track);

                // 2. Reset select dropdowns
                const filtrType = fxDrawerEl.querySelector('.filtr-type');
                if (filtrType) {
                    filtrType.value = 'lowpass';
                    filtrType.dispatchEvent(new Event('change'));
                }
                const chorusSync = fxDrawerEl.querySelector('.chorus-rate-sync');
                if (chorusSync) {
                    chorusSync.value = 'Free';
                    chorusSync.dispatchEvent(new Event('change'));
                }
                const phaserSync = fxDrawerEl.querySelector('.phaser-rate-sync');
                if (phaserSync) {
                    phaserSync.value = 'Free';
                    phaserSync.dispatchEvent(new Event('change'));
                }
                const tremoloShape = fxDrawerEl.querySelector('.tremolo-shape');
                if (tremoloShape) {
                    tremoloShape.value = 'sine';
                    tremoloShape.dispatchEvent(new Event('change'));
                }
                const gateShape = fxDrawerEl.querySelector('.gate-shape');
                if (gateShape) {
                    gateShape.value = 'square';
                    gateShape.dispatchEvent(new Event('change'));
                }

                // 3. Reset EQ Gains
                const eqSliders = fxDrawerEl.querySelectorAll('.eq-slider');
                eqSliders.forEach(slider => {
                    slider.value = 0;
                    const valEl = slider.parentNode.querySelector('.slider-val');
                    if (valEl) valEl.textContent = '0dB';
                });
                track.eqGains = [0, 0, 0, 0, 0, 0];

                // 4. Reset detailed parameter knobs and sliders
                const sliders = {
                    '.filtr-cutoff': 20000,
                    '.filtr-reso': 7, // 0.707 * 10
                    '.filtr-mix': 100,
                    '.scream-cutoff': 8000,
                    '.scream-amount': 71,
                    '.scream-mix': 100,
                    '.aelapse-sync': 3, // maps to delaySyncIndex 3 ('1/8')
                    '.aelapse-mix': 0,
                    '.aelapse-reverb-mix': 0,
                    '.aelapse-reverb-size': 2.0,
                    '.aelapse-wow-rate': 2.0,
                    '.aelapse-wow-depth': 0,
                    '.aelapse-reverb-predelay': 0,
                    '.aelapse-reverb-damp': 20000,
                    '.chorus-rate-sync-knob': 0,
                    '.chorus-rate': 1.5,
                    '.chorus-depth': 70,
                    '.chorus-feedback': 20,
                    '.chorus-mix': 50,
                    '.phaser-rate-sync-knob': 0,
                    '.phaser-rate': 1.2,
                    '.phaser-depth': 60,
                    '.phaser-feedback': 20,
                    '.phaser-mix': 50,
                    '.crusher-bits': 8,
                    '.crusher-normfreq': 0.1,
                    '.crusher-mix': 50,
                    '.tremolo-rate': 5.0,
                    '.tremolo-depth': 0,
                    '.gate-sync-knob': 2,
                    '.gate-width': 50,
                    '.gate-mix': 50
                };

                for (const selector in sliders) {
                    const el = fxDrawerEl.querySelector(selector);
                    if (el) {
                        el.value = sliders[selector];
                        el.dispatchEvent(new Event('input'));
                    }
                }

                // 5. Reset all creative FX macro values Group B
                for (const key in fxMacroState) {
                    const defaultVal = (key === 'tone' || key === 'filter') ? 50 : 0;
                    if (fxMacroState[key]) {
                        fxMacroState[key].value = defaultVal;
                    }
                    applyFxMacro(key, defaultVal);
                }

                // 6. Reset front-panel macro knobs Group A
                ['filter', 'reso', 'tone', 'dlyMix', 'revMix'].forEach(param => {
                    const defaultVal = param === 'tone' ? 50 : 0;
                    if (macroKnobState[param]) {
                        macroKnobState[param].value = defaultVal;
                    }
                    applyMacroKnob(param, defaultVal);
                });

                const originalText = resetBtn.textContent;
                resetBtn.textContent = 'Reset!';
                setPresentation(resetBtn, { color: '#ef4444' }); // Red accent
                setTimeout(() => {
                    resetBtn.textContent = originalText;
                    setPresentation(resetBtn, { color: '' });
                }, 1000);
            });
        }

        // 11. Build variants card selection UI
        const variantsEl = document.createElement('div');
        variantsEl.className = 'variants-container';
        variantsEl.dataset.lmPart = 'variants';

        batchFiles.forEach((filePath, i) => {
            const name = filePath.split('/').pop() || `v${i + 1}`;
            const slotsPerCard = 4 / batchFiles.length;
            const cardEl = document.createElement('div');
            cardEl.className = 'audio-card is-loading';
            if (slotsPerCard === 2) cardEl.classList.add('span-2');
            else if (slotsPerCard === 4) cardEl.classList.add('span-4');
            if (i === 0) cardEl.classList.add('is-selected');

            cardEl.innerHTML = `
                <div class="card-header">
                    <span class="card-title"></span>
                    <span class="card-variant-num">#${i + 1}</span>
                </div>
                <div class="card-seek-bar">
                    <canvas class="card-waveform"></canvas>
                    <div class="card-progress-fill"></div>
                    <div class="card-playhead"></div>
                    <div class="card-split-line"></div>
                </div>
                <div class="card-controls-row">
                    <button class="btn-outpaint-2" title="Outpaint to 2 loops (2x)" type="button">2x</button>
                    <button class="btn-outpaint-4" title="Outpaint to 4 loops (4x)" type="button">4x</button>
                    <button class="btn-use-init" title="Use as Remix Audio" type="button">Remix</button>
                    <button class="btn-reverse" title="Reverse" type="button">⇄</button>
                    <button class="btn-lock-variant" title="Lock Variant" type="button">
                        <svg class="btn-icon icon-unlock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                    </button>
                    <button class="btn-delete-variant" title="Delete Variant" type="button">
                        <svg class="btn-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
            `;

            const cardTitle = cardEl.querySelector('.card-title');
            cardTitle.textContent = name;
            cardTitle.title = name;

            const variant = {
                name,
                filePath,
                buffer: null,
                el: cardEl,
                sourceNode: null,
                locked: false,
            };
            track.variants.push(variant);
            variantsEl.appendChild(cardEl);

            cardEl.addEventListener('click', (e) => {
                if (track.locked || cardEl.classList.contains('is-deleted')) return;
                const cardRect = cardEl.getBoundingClientRect();
                const clickX = e.clientX - cardRect.left;
                const isLeftHalf = clickX < cardRect.width / 2;


                const splitToggle = document.getElementById('toggle-split');
                const splitEnabled = splitToggle ? splitToggle.checked : false;

                if (splitEnabled && isLeftHalf && isPlaying) {
                    // Split ON + left half = queue at next loop boundary
                    if (i === track.selectedVariant) {
                        if (track._pendingVariant === -1) {
                            track._pendingVariant = null;
                            cardEl.classList.remove('is-queued');
                        } else {
                            track._pendingVariant = -1;
                            track.variants.forEach((v, vi) => v.el.classList.toggle('is-queued', vi === i));
                        }
                    } else {
                        if (track._pendingVariant === i) {
                            track._pendingVariant = null;
                            cardEl.classList.remove('is-queued');
                        } else {
                            track._pendingVariant = i;
                            track.variants.forEach((v, vi) => v.el.classList.toggle('is-queued', vi === i));
                        }
                    }
                } else if (splitEnabled && !isLeftHalf && isPlaying && (track._pendingVariant === i || (i === track.selectedVariant && track._pendingVariant === -1))) {
                    // Split ON + right half + this card is queued = unqueue it
                    track._pendingVariant = null;
                    cardEl.classList.remove('is-queued');
                } else {
                    // Default or right half = instant switch/toggle
                    selectVariant(track, i);
                }

                if (!isPlaying) playAll();
            });

            const useInitBtn = cardEl.querySelector('.btn-use-init');
            if (useInitBtn) {
                useInitBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    setInitAudio(track, i, filePath, name);
                });
            }

            const reverseBtn = cardEl.querySelector('.btn-reverse');
            if (reverseBtn) {
                setToggleButtonPressed(reverseBtn, false);
                reverseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    const v = track.variants[i];
                    if (!v || !v.buffer) return;
                    // Reverse all channel data in-place
                    for (let ch = 0; ch < v.buffer.numberOfChannels; ch++) {
                        v.buffer.getChannelData(ch).reverse();
                    }
                    v.reversed = !v.reversed;
                    reverseBtn.classList.toggle('is-on', v.reversed);
                    setToggleButtonPressed(reverseBtn, v.reversed);
                    drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, track.selectedVariant === i, track.originalParams?.bpm);
                    // If this is the playing variant, restart just this track source (not all playback)
                    if (isPlaying && track.selectedVariant === i) {
                        if (audioCtx) {
                            const elapsed = audioCtx.currentTime - playStartCtxTime;
                            playOffset = elapsed % getActiveDuration();
                        }
                        stopTrackSource(track);
                        startTrackSource(track);
                    }
                });
            }

            const lockVariantBtn = cardEl.querySelector('.btn-lock-variant');
            if (lockVariantBtn) {
                setToggleButtonPressed(lockVariantBtn, variant.locked);
                lockVariantBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    variant.locked = !variant.locked;
                    cardEl.classList.toggle('card-is-locked', variant.locked);
                    setToggleButtonPressed(lockVariantBtn, variant.locked);
                    lockVariantBtn.setAttribute('aria-label', variant.locked ? 'Unlock variant' : 'Lock variant');

                    if (variant.locked) {
                        lockVariantBtn.innerHTML = `<svg class="btn-icon icon-lock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
                    } else {
                        lockVariantBtn.innerHTML = `<svg class="btn-icon icon-unlock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
                    }
                });
            }

            const deleteVariantBtn = cardEl.querySelector('.btn-delete-variant');
            if (deleteVariantBtn) {
                deleteVariantBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (track.locked || variant.locked) return;

                    if (confirm('Are you sure you want to delete this variant generation?')) {
                        try {
                            const res = await fetch('/api/delete_variant', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ file_path: variant.filePath })
                            });
                            if (!res.ok) {
                                const err = await res.json().catch(() => ({}));
                                throw new Error(err.error || `HTTP ${res.status}`);
                            }

                            // Free memory and update UI
                            variant.buffer = null;
                            cardEl.classList.add('is-deleted');
                            const titleEl = cardEl.querySelector('.card-title');
                            if (titleEl) {
                                titleEl.textContent = `${variant.name} (Deleted)`;
                            }

                            // Deselect if playing
                            if (track.selectedVariant === i) {
                                stopTrackSource(track);
                                track.selectedVariant = -1;
                                track.variants.forEach(v => v.el.classList.remove('is-selected'));
                            }

                            // Clear canvas
                            const canvas = cardEl.querySelector('.card-waveform');
                            if (canvas) {
                                const ctx = canvas.getContext('2d');
                                ctx.clearRect(0, 0, canvas.width, canvas.height);
                            }
                        } catch (err) {
                            console.error('Error deleting variant:', err);
                            alert(`Failed to delete variant: ${err.message}`);
                        }
                    }
                });
            }

            const outpaint2Btn = cardEl.querySelector('.btn-outpaint-2');
            if (outpaint2Btn) {
                outpaint2Btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    runOutpaint(track, variant, 2);
                });
            }

            const outpaint4Btn = cardEl.querySelector('.btn-outpaint-4');
            if (outpaint4Btn) {
                outpaint4Btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    runOutpaint(track, variant, 4);
                });
            }

            loadVariantAudio(variant, `/outputs/${filePath}`, i === 0, track);
        });

        rowEl.appendChild(variantsEl);
        wrapperEl.appendChild(rowEl);
        wrapperEl.appendChild(fxDrawerEl);

        wrapperEl.dataset.trackId = track.id;
        rowEl.dataset.trackId = track.id;

        track.el = rowEl;
        track.wrapper = wrapperEl;
        track.updatePanKnobFn = updatePanKnob;
        track.applyMacroKnobFn = applyMacroKnob;
        track.applyFxMacroFn = applyFxMacro;
        track.applyFxSettingsFn = applyFxSettingsToTrack;
        track.macroKnobState = macroKnobState;
        track.fxMacroState = fxMacroState;

        return track;
    }

    async function loadVariantAudio(variant, url, isSelected, track) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            const ctx = ensureAudioCtx();
            const decoded = await ctx.decodeAudioData(buf);
            if (track && !tracks.includes(track)) return;
            if (variant.buffer) variant.buffer = null;
            variant.buffer = decoded;

            // Calculate and store loop multiplier based on creation BPM
            const creationBpm = track ? track.originalParams?.bpm : (parseInt(bpmInput.value) || 120);
            const oneLoopDur = 960.0 / creationBpm;
            variant.loopMultiplier = Math.max(1, Math.round(variant.buffer.duration / oneLoopDur));

            variant.el.classList.remove('is-loading');
            drawWaveform(variant.el.querySelector('.card-waveform'), variant.buffer, isSelected, track ? track.originalParams?.bpm : null);

            // Auto-play: if this is variant 0 and it just loaded, start it
            if (track && track.selectedVariant === 0 && variant === track.variants[0]) {
                if (isPlaying && audioCtx) {
                    const elapsed = audioCtx.currentTime - playStartCtxTime;
                    playOffset = elapsed % getActiveDuration();
                    startTrackSource(track);
                } else if (!isPlaying && track._autoPlay) {
                    playAll();
                }
            }
        } catch (err) {
            console.error(`Failed to load ${variant.name}:`, err);
            variant.el.classList.remove('is-loading');
            variant.el.querySelector('.card-title').textContent += ' (err)';
            variant.loadFailed = true;
        } finally {
            if (isProjectLoading) {
                loadedVariantsCount++;
                if (loadedVariantsCount >= totalVariantsToLoad) {
                    isProjectLoading = false;
                    onProjectLoadComplete();
                }
            }
        }
    }

    // --- Project Save & Load and Record Mode Implementation ---

    const PROJECT_FORMAT_VERSION = '1.0';
    const PROJECT_MIGRATIONS = Object.freeze({
        legacy: project => ({ ...project, version: PROJECT_FORMAT_VERSION }),
        '1.0': project => project
    });

    function isPlainProjectObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function requireProjectObject(value, path) {
        if (!isPlainProjectObject(value)) {
            throw new Error(`${path} must be an object`);
        }
        return value;
    }

    function normalizeProjectNumber(value, fallback, path, min, max, integer = false) {
        if (value === undefined) return fallback;
        if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
            throw new Error(`${path} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
        }
        return value;
    }

    function normalizeProjectBoolean(value, fallback, path) {
        if (value === undefined) return fallback;
        if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
        return value;
    }

    function normalizeProjectString(value, fallback, path, maxLength) {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || value.length > maxLength) {
            throw new Error(`${path} must be a string no longer than ${maxLength} characters`);
        }
        return value;
    }

    function sanitizeProjectValue(value, path, depth = 0) {
        if (depth > 12) throw new Error(`${path} is nested too deeply`);
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
            return value;
        }
        if (Array.isArray(value)) {
            if (value.length > 1024) throw new Error(`${path} contains too many items`);
            return value.map((item, index) => sanitizeProjectValue(item, `${path}[${index}]`, depth + 1));
        }
        requireProjectObject(value, path);
        const keys = Object.keys(value);
        if (keys.length > 256) throw new Error(`${path} contains too many properties`);
        const sanitized = Object.create(null);
        keys.forEach(key => {
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
                throw new Error(`${path} contains an unsafe property name`);
            }
            sanitized[key] = sanitizeProjectValue(value[key], `${path}.${key}`, depth + 1);
        });
        return sanitized;
    }

    function normalizeNumberRecord(value, path) {
        if (value === undefined) return Object.create(null);
        requireProjectObject(value, path);
        if (Object.keys(value).length > 256) throw new Error(`${path} contains too many properties`);
        const normalized = Object.create(null);
        Object.keys(value).forEach(key => {
            if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
                throw new Error(`${path} contains an unsafe property name`);
            }
            normalized[key] = normalizeProjectNumber(value[key], 0, `${path}.${key}`, -100000, 100000);
        });
        return normalized;
    }

    function normalizeVariantData(value, path) {
        const variant = requireProjectObject(value, path);
        const filePath = normalizeProjectString(variant.filePath, undefined, `${path}.filePath`, 4096);
        if (!filePath || /[\0?#]/.test(filePath) || /%(?:2e|2f|5c)/i.test(filePath) || /^(?:[a-z]+:|[\\/])/i.test(filePath) || filePath.split(/[\\/]/).some(part => part === '.' || part === '..')) {
            throw new Error(`${path}.filePath must be a safe relative output path`);
        }
        return {
            filePath,
            locked: normalizeProjectBoolean(variant.locked, false, `${path}.locked`),
            loopMultiplier: normalizeProjectNumber(variant.loopMultiplier, 1, `${path}.loopMultiplier`, 1, 64, true)
        };
    }

    function normalizeTrackData(value, index, seenIds) {
        const path = `tracks[${index}]`;
        const track = requireProjectObject(value, path);
        const id = normalizeProjectNumber(track.id, undefined, `${path}.id`, 1, 1000000000, true);
        if (id === undefined) throw new Error(`${path}.id is required`);
        if (seenIds.has(id)) throw new Error(`${path}.id duplicates track ${id}`);
        seenIds.add(id);

        if (!Array.isArray(track.variants) || track.variants.length < 1 || track.variants.length > 16) {
            throw new Error(`${path}.variants must contain between 1 and 16 variants`);
        }
        const variants = track.variants.map((variant, variantIndex) => normalizeVariantData(variant, `${path}.variants[${variantIndex}]`));
        const selectedVariant = normalizeProjectNumber(track.selectedVariant, 0, `${path}.selectedVariant`, 0, variants.length - 1, true);
        const parentTrackId = track.parentTrackId == null
            ? null
            : normalizeProjectNumber(track.parentTrackId, null, `${path}.parentTrackId`, 1, 1000000000, true);

        return {
            id,
            prompt: normalizeProjectString(track.prompt, '', `${path}.prompt`, 10000),
            level: normalizeProjectNumber(track.level, 0.8, `${path}.level`, 0, 1),
            pan: normalizeProjectNumber(track.pan, 0, `${path}.pan`, -1, 1),
            muted: normalizeProjectBoolean(track.muted, false, `${path}.muted`),
            soloed: normalizeProjectBoolean(track.soloed, false, `${path}.soloed`),
            looping: normalizeProjectBoolean(track.looping, true, `${path}.looping`),
            locked: normalizeProjectBoolean(track.locked, false, `${path}.locked`),
            selectedVariant,
            originalParams: track.originalParams === undefined || track.originalParams === null
                ? null
                : sanitizeProjectValue(requireProjectObject(track.originalParams, `${path}.originalParams`), `${path}.originalParams`),
            parentTrackId,
            variants,
            macroValues: normalizeNumberRecord(track.macroValues, `${path}.macroValues`),
            fxMacros: normalizeNumberRecord(track.fxMacros, `${path}.fxMacros`),
            fxSettings: track.fxSettings === undefined || track.fxSettings === null
                ? null
                : sanitizeProjectValue(requireProjectObject(track.fxSettings, `${path}.fxSettings`), `${path}.fxSettings`)
        };
    }

    function normalizeProjectData(rawProject) {
        requireProjectObject(rawProject, 'project');
        const sourceVersion = rawProject.version === undefined ? 'legacy' : rawProject.version;
        if (typeof sourceVersion !== 'string') throw new Error('Project version must be a string');
        const migrate = PROJECT_MIGRATIONS[sourceVersion];
        if (!migrate) throw new Error(`Unsupported project version: ${sourceVersion}`);

        const migrated = migrate(rawProject);
        requireProjectObject(migrated, 'project');
        if (!Array.isArray(migrated.tracks) || migrated.tracks.length < 1 || migrated.tracks.length > 128) {
            throw new Error('Project must contain between 1 and 128 tracks');
        }

        const seenIds = new Set();
        const normalizedTracks = migrated.tracks.map((track, index) => normalizeTrackData(track, index, seenIds));
        const totalVariants = normalizedTracks.reduce((total, track) => total + track.variants.length, 0);
        if (totalVariants > 512) throw new Error('Project contains too many audio variants');

        const arrangerLength = normalizeProjectNumber(migrated.arrangerLengthLoops, 8, 'arrangerLengthLoops', 1, 999, true);
        let normalizedGrid = null;
        if (migrated.arrangerGrid !== undefined && migrated.arrangerGrid !== null) {
            requireProjectObject(migrated.arrangerGrid, 'arrangerGrid');
            normalizedGrid = Object.create(null);
            normalizedTracks.forEach(track => {
                const row = migrated.arrangerGrid[String(track.id)];
                if (row === undefined) return;
                if (!Array.isArray(row) || row.length > 999 || row.some(cell => typeof cell !== 'boolean')) {
                    throw new Error(`arrangerGrid.${track.id} must be an array of booleans`);
                }
                normalizedGrid[track.id] = row.slice(0, arrangerLength);
            });
        }

        let normalizedSlots = null;
        if (migrated.modMatrixSlots !== undefined && migrated.modMatrixSlots !== null) {
            if (!Array.isArray(migrated.modMatrixSlots) || migrated.modMatrixSlots.length > 8) {
                throw new Error('modMatrixSlots must be an array of at most 8 slots');
            }
            normalizedSlots = migrated.modMatrixSlots.map((slot, index) => {
                requireProjectObject(slot, `modMatrixSlots[${index}]`);
                const rawTrackId = slot.trackId ?? 'none';
                if (typeof rawTrackId !== 'string' && typeof rawTrackId !== 'number') {
                    throw new Error(`modMatrixSlots[${index}].trackId must be a string or number`);
                }
                return {
                    src: normalizeProjectString(slot.src, 'none', `modMatrixSlots[${index}].src`, 32),
                    trackId: normalizeProjectString(String(rawTrackId), 'none', `modMatrixSlots[${index}].trackId`, 32),
                    param: normalizeProjectString(slot.param, 'none', `modMatrixSlots[${index}].param`, 64),
                    depth: normalizeProjectNumber(slot.depth, 0, `modMatrixSlots[${index}].depth`, -100, 100, true)
                };
            });
            while (normalizedSlots.length < 8) {
                normalizedSlots.push({ src: 'none', trackId: 'none', param: 'none', depth: 0 });
            }
        }

        return {
            version: PROJECT_FORMAT_VERSION,
            bpm: normalizeProjectNumber(migrated.bpm, 120, 'bpm', 20, 999),
            globalDuration: normalizeProjectNumber(migrated.globalDuration, 8, 'globalDuration', 0.01, 86400),
            arrangerModeActive: normalizeProjectBoolean(migrated.arrangerModeActive, false, 'arrangerModeActive'),
            arrangerLengthLoops: arrangerLength,
            globalModulators: migrated.globalModulators === undefined || migrated.globalModulators === null
                ? null
                : sanitizeProjectValue(requireProjectObject(migrated.globalModulators, 'globalModulators'), 'globalModulators'),
            modMatrixSlots: normalizedSlots,
            arrangerGrid: normalizedGrid,
            tracks: normalizedTracks
        };
    }

    function normalizeLegacyFxSettings(fx) {
        // Older project files saved one filtr cutoff/reso plus a type select
        // that no longer exists; map them onto the split HP/LP filter fields.
        const out = { ...fx };
        if (out.filtrLpCutoff === undefined && out.filtrCutoff !== undefined) {
            if (out.filtrType === 'highpass') {
                out.filtrHpCutoff = out.filtrCutoff;
                out.filtrHpReso = out.filtrReso;
            } else {
                out.filtrLpCutoff = out.filtrCutoff;
                out.filtrLpReso = out.filtrReso;
            }
        }
        return out;
    }

    function saveProject() {
        if (tracks.length === 0) {
            alert('No tracks to save!');
            return;
        }

        const projectData = {
            version: PROJECT_FORMAT_VERSION,
            bpm: parseInt(bpmInput.value) || 120,
            globalDuration,
            arrangerModeActive,
            arrangerLengthLoops,
            globalModulators,
            modMatrixSlots,
            arrangerGrid,
            tracks: tracks.map(t => {
                // Collect detailed FX settings from track state (the DOM held
                // stale selectors and silently saved defaults).
                const fxSettings = {
                    filtrEnabled: t.filtrEnabled,
                    screamEnabled: t.screamEnabled,
                    eqEnabled: t.eqEnabled,
                    aelapseDelayEnabled: t.aelapseDelayEnabled,
                    aelapseReverbEnabled: t.aelapseReverbEnabled,

                    filtrHpCutoff: t.filtrHpCutoff,
                    filtrHpReso: t.filtrHpResonance,
                    filtrLpCutoff: t.filtrLpCutoff,
                    filtrLpReso: t.filtrLpResonance,
                    filtrDrive: t.filtrDrive,
                    filtrMix: t.filtrMix,

                    screamCutoff: t.screamCutoff,
                    screamAmount: t.screamAmount,
                    screamMix: t.screamMix,

                    eqGains: [...t.eqGains],

                    aelapseSync: t.delaySyncIndex,
                    aelapseMix: t.aelapseDelayMix,
                    aelapseReverbMix: t.aelapseReverbMix,
                    aelapseReverbSize: t.aelapseReverbSize,
                    aelapseDelayWowRate: t.aelapseDelayWowRate,
                    aelapseDelayWowDepth: t.aelapseDelayWowDepth,
                    aelapseReverbPreDelay: t.aelapseReverbPreDelay,
                    aelapseReverbDamp: t.aelapseReverbDamp,

                    tunaChorusEnabled: t.tunaChorusEnabled,
                    tunaChorusRateSync: t.tunaChorusRateSync,
                    tunaChorusRateSyncIndex: t.tunaChorusRateSyncIndex,
                    tunaChorusRate: t.tunaChorusRate,
                    tunaChorusDepth: t.tunaChorusDepth,
                    tunaChorusFeedback: t.tunaChorusFeedback,
                    tunaChorusMix: t.tunaChorusMix,

                    tunaPhaserEnabled: t.tunaPhaserEnabled,
                    tunaPhaserRateSync: t.tunaPhaserRateSync,
                    tunaPhaserRateSyncIndex: t.tunaPhaserRateSyncIndex,
                    tunaPhaserRate: t.tunaPhaserRate,
                    tunaPhaserDepth: t.tunaPhaserDepth,
                    tunaPhaserFeedback: t.tunaPhaserFeedback,
                    tunaPhaserMix: t.tunaPhaserMix,

                    tunaBitcrusherEnabled: t.tunaBitcrusherEnabled,
                    tunaBitcrusherBits: t.tunaBitcrusherBits,
                    tunaBitcrusherNormfreq: t.tunaBitcrusherNormfreq,
                    tunaBitcrusherMix: t.tunaBitcrusherMix,

                    tremoloEnabled: t.tremoloEnabled,
                    tremoloRate: t.tremoloRate,
                    tremoloDepth: t.tremoloDepth,
                    tremoloShape: t.tremoloShape,

                    gateEnabled: t.gateEnabled,
                    gateSyncIndex: t.gateSyncIndex,
                    gateWidth: t.gateWidth,
                    gateShape: t.gateShape,
                    gateMix: t.gateMix,
                };

                const macroValues = {};
                for (const param in t.macroKnobState) {
                    macroValues[param] = t.macroKnobState[param].value;
                }

                const fxMacros = {};
                for (const param in t.fxMacroState) {
                    fxMacros[param] = t.fxMacroState[param].value;
                }

                return {
                    id: t.id,
                    prompt: t.prompt,
                    level: t.level,
                    pan: t.pan,
                    muted: t.muted,
                    soloed: t.soloed,
                    looping: t.looping,
                    locked: t.locked,
                    selectedVariant: t.selectedVariant,
                    originalParams: t.originalParams,
                    parentTrackId: t.parentTrackId || null,
                    variants: t.variants.map(v => ({
                        filePath: v.filePath,
                        locked: v.locked,
                        loopMultiplier: v.loopMultiplier || 1
                    })),
                    macroValues,
                    fxMacros,
                    fxSettings
                };
            })
        };

        const jsonStr = JSON.stringify(projectData, null, 4);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project_${new Date().toISOString().slice(0, 10)}.lproj`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function loadProject(rawProjectData) {
        // Validation and migration must complete before any active audio or UI state is destroyed.
        const projectData = normalizeProjectData(rawProjectData);

        // 1. Clear active state
        tracks.forEach(t => {
            stopTrackSource(t);
            destroyTrackAudio(t);
        });
        undoStack.forEach(entry => {
            if (entry.action === 'deleteTrack') {
                destroyTrackAudio(entry.data.track);
            }
        });
        tracksContainer.innerHTML = '';
        tracks = [];
        undoStack = [];
        if (btnUndo) setPresentation(btnUndo, { display: 'none' });

        isProjectLoading = true;
        totalVariantsToLoad = projectData.tracks.reduce((acc, t) => acc + (t.variants ? t.variants.length : 0), 0);
        loadedVariantsCount = 0;

        // 2. Set global settings
        bpmInput.value = projectData.bpm || 120;
        bpmInput.dispatchEvent(new Event('input'));

        arrangerLengthLoops = projectData.arrangerLengthLoops || 8;
        const arrangerSelect = document.getElementById('arranger-length');
        if (arrangerSelect) arrangerSelect.value = arrangerLengthLoops;

        arrangerModeActive = projectData.arrangerModeActive || false;
        const toggleArranger = document.getElementById('toggle-arranger');
        const arrangerPanel = document.getElementById('arranger-panel');
        if (toggleArranger && arrangerPanel) {
            toggleArranger.checked = arrangerModeActive;
            setPresentation(arrangerPanel, { display: arrangerModeActive ? 'flex' : 'none' });
            const playheadLine = document.getElementById('arranger-playhead-line');
            if (playheadLine) {
                setPresentation(playheadLine, { display: arrangerModeActive ? 'block' : 'none' });
            }
        }

        // 3. Load global modulators & matrix
        if (projectData.globalModulators) {
            Object.assign(globalModulators, projectData.globalModulators);
            syncModulatorsUI();
        }
        if (projectData.modMatrixSlots) {
            modMatrixSlots = projectData.modMatrixSlots;
        }
        if (projectData.arrangerGrid) {
            arrangerGrid = projectData.arrangerGrid;
        }

        // 4. Create tracks
        projectData.tracks.forEach(tData => {
            const files = tData.variants.map(v => v.filePath);
            addTrackRow(files, tData.prompt, tData.id, false, tData.parentTrackId || null, tData.originalParams);

            const track = tracks.find(tr => tr.id === tData.id);
            if (!track) return;

            track.level = tData.level;
            track.pan = tData.pan;
            track.muted = tData.muted;
            track.soloed = tData.soloed;
            track.looping = tData.looping !== undefined ? tData.looping : true;
            track.locked = tData.locked || false;
            track.selectedVariant = tData.selectedVariant !== undefined ? tData.selectedVariant : 0;

            const muteBtn = track.el.querySelector('.mute-btn');
            if (muteBtn) muteBtn.classList.toggle('is-on', track.muted);
            const soloBtn = track.el.querySelector('.solo-btn');
            if (soloBtn) soloBtn.classList.toggle('is-on', track.soloed);

            const levelKnob = track.el.querySelector('.level-knob');
            const levelValue = track.el.querySelector('.level-value');
            if (levelKnob) {
                const targetVal = Math.round(track.level * 100);
                levelKnob.value = targetVal;
                levelKnob.title = `Vol: ${targetVal}`;
                if (levelValue) levelValue.textContent = targetVal;
            }

            if (track.updatePanKnobFn) {
                track.updatePanKnobFn(Math.round(track.pan * 100));
            }

            tData.variants.forEach((vData, idx) => {
                if (track.variants[idx]) {
                    track.variants[idx].locked = vData.locked || false;
                    track.variants[idx].loopMultiplier = vData.loopMultiplier || 1;

                    const cardEl = track.variants[idx].el;
                    if (cardEl) {
                        cardEl.classList.toggle('card-locked', vData.locked);
                        const lockBtn = cardEl.querySelector('.btn-lock-variant');
                        if (lockBtn) {
                            setToggleButtonPressed(lockBtn, Boolean(vData.locked));
                            lockBtn.setAttribute('aria-label', vData.locked ? 'Unlock variant' : 'Lock variant');
                            lockBtn.innerHTML = vData.locked ?
                                `<svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>` :
                                `<svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
                        }
                    }
                }
            });

            track.variants.forEach((v, idx) => {
                if (v.el) {
                    v.el.classList.toggle('is-selected', idx === track.selectedVariant);
                }
            });

            for (const param in tData.macroValues) {
                if (track.macroKnobState[param]) {
                    track.macroKnobState[param].value = tData.macroValues[param];
                    if (track.applyMacroKnobFn) {
                        track.applyMacroKnobFn(param, tData.macroValues[param]);
                    }
                }
            }

            const fx = tData.fxSettings;
            if (fx && track.applyFxSettingsFn) {
                track.applyFxSettingsFn(normalizeLegacyFxSettings(fx));
            }

            for (const key in tData.fxMacros) {
                if (track.fxMacroState[key]) {
                    track.fxMacroState[key].value = tData.fxMacros[key];
                    if (track.applyFxMacroFn) {
                        track.applyFxMacroFn(key, tData.fxMacros[key]);
                    }
                }
            }

            updateTrackLockState(track, track.locked);
        });

        updateModMatrixTracks();
        syncModMatrixUI();

        if (arrangerModeActive) renderArrangerTimeline();
        updateMixerState();
        if (totalVariantsToLoad === 0) {
            isProjectLoading = false;
            showStatus('Project loaded successfully', 'done');
        }
    }

    function onProjectLoadComplete() {
        const missingTracks = tracks.filter(t => t.variants.some(v => !v.buffer));
        if (missingTracks.length > 0) {
            showMissingAudioBanner(missingTracks);
        } else {
            showStatus('Project loaded successfully', 'done');
        }
    }

    function showMissingAudioBanner(missingTracks) {
        const existing = document.getElementById('missing-audio-banner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'missing-audio-banner';
        banner.className = 'missing-audio-banner';
        banner.innerHTML = `
            <div class="banner-content">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="banner-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <span>Some track audio files are missing. Attempt to remake them from generation metadata?</span>
            </div>
            <button id="btn-remake-missing" class="banner-btn">Remake Missing Audio</button>
        `;

        tracksContainer.insertBefore(banner, tracksContainer.firstChild);

        const btnRemake = document.getElementById('btn-remake-missing');
        if (btnRemake) {
            btnRemake.addEventListener('click', () => {
                banner.remove();
                remakeMissingAudio(missingTracks);
            });
        }
    }

    async function remakeMissingAudio(missingTracks) {
        showStatus('Remaking missing audio...');
        btnGenerate.disabled = true;
        btnGenerate.classList.add('is-generating');

        try {
            for (const track of missingTracks) {
                showStatus(`Remaking track ${track.id}...`);

                const params = track.originalParams;
                if (!params) {
                    console.warn(`No originalParams for track ${track.id}, skipping`);
                    continue;
                }

                const bodyPayload = {
                    prompt: params.prompt,
                    bpm: params.bpm,
                    num_variants: track.variants.length,
                    loop: track.looping,
                    duration_padding_sec: track.looping ? 2.0 : 0.0,
                    seed: params.seed ?? -1,
                    cfg_scale: params.cfgScale ?? 1.0,
                    steps: params.steps ?? 8,
                    duration: params.duration ?? (960.0 / params.bpm)
                };

                if (track.parentTrackId !== null && track.parentTrackId !== undefined) {
                    const parentTrack = tracks.find(t => t.id === track.parentTrackId);
                    if (parentTrack) {
                        const parentSelIdx = parentTrack.selectedVariant;
                        const parentVar = parentTrack.variants[parentSelIdx === -1 ? 0 : parentSelIdx];
                        if (parentVar && parentVar.filePath) {
                            bodyPayload.init_audio_path = parentVar.filePath;
                            bodyPayload.remix_mode = params.remixMode || 'variation';
                            bodyPayload.invert_timing = params.invertTiming || false;
                            bodyPayload.init_noise_level = params.initNoiseLevel ?? 0.60;
                            bodyPayload.inpaint_start = params.inpaintStart ?? 0.0;
                            bodyPayload.inpaint_end = params.inpaintEnd ?? 0.0;
                            bodyPayload.continue_start = params.continueStart ?? 0.0;
                        }
                    }
                }

                const res = await fetch('/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyPayload)
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }

                const { job_id } = await res.json();
                setGenerationCancelState(job_id);
                const result = await pollJob(job_id);
                if (!tracks.includes(track)) return;
                if (result.status !== 'done') {
                    throw new Error(result.error || 'Failed generating track');
                }

                for (let idx = 0; idx < track.variants.length; idx++) {
                    const newFilePath = result.files[idx];
                    if (newFilePath) {
                        const variant = track.variants[idx];
                        variant.filePath = newFilePath;
                        const name = newFilePath.split('/').pop();
                        variant.name = name;

                        const titleEl = variant.el.querySelector('.card-title');
                        if (titleEl) {
                            titleEl.textContent = name;
                            titleEl.title = name;
                        }

                        variant.el.classList.add('is-loading');
                        await loadVariantAudio(variant, `/outputs/${newFilePath}`, track.selectedVariant === idx, track);
                    }
                }
            }

            showStatus('All missing audio remade!', 'done');
        } catch (err) {
            if (err.name !== 'GenerationCancelledError') console.error('Error remaking missing audio:', err);
            showStatus(err.name === 'GenerationCancelledError' ? 'Queued generation cancelled.' : `Remake failed: ${err.message}`, err.name === 'GenerationCancelledError' ? 'done' : 'error');
        } finally {
            setGenerationCancelState(null);
            btnGenerate.disabled = false;
            btnGenerate.classList.remove('is-generating');
        }
    }

    function syncModulatorsUI() {
        const modulatorsPanel = document.getElementById('modulators-panel');
        if (!modulatorsPanel) return;

        for (let num = 1; num <= 4; num++) {
            const shapeSelect = document.getElementById(`lfo${num}-shape`);
            const syncToggle = document.getElementById(`lfo${num}-sync-toggle`);
            const rateSyncSelect = document.getElementById(`lfo${num}-rate-sync`);
            const rateFreeSlider = document.getElementById(`lfo${num}-rate-free`);
            const rateFreeVal = document.getElementById(`lfo${num}-rate-val`);
            const rateSyncRow = document.getElementById(`lfo${num}-rate-sync-row`);
            const rateFreeRow = document.getElementById(`lfo${num}-rate-free-row`);
            const toggleBtn = modulatorsPanel.querySelector(`.lfo${num}-toggle`);
            const section = toggleBtn ? toggleBtn.closest('.fx-section') : null;

            const lfoState = globalModulators[`lfo${num}`];
            if (!lfoState) continue;

            if (shapeSelect) shapeSelect.value = lfoState.shape;
            if (syncToggle) syncToggle.checked = (lfoState.mode === 'sync');
            if (rateSyncSelect) rateSyncSelect.value = lfoState.syncRate;
            if (rateFreeSlider) {
                rateFreeSlider.value = lfoState.freeRate * 10.0;
                if (rateFreeVal) rateFreeVal.textContent = lfoState.freeRate.toFixed(1) + 'Hz';
            }
            const isSync = (lfoState.mode === 'sync');
            if (rateSyncRow) setPresentation(rateSyncRow, { display: isSync ? 'flex' : 'none' });
            if (rateFreeRow) setPresentation(rateFreeRow, { display: isSync ? 'none' : 'flex' });

            if (toggleBtn) {
                const enabled = lfoState.enabled !== false;
                toggleBtn.textContent = enabled ? 'On' : 'Off';
                toggleBtn.classList.toggle('is-off', !enabled);
                setToggleButtonPressed(toggleBtn, enabled);
                if (section) {
                    section.classList.toggle('is-bypassed', !enabled);
                }
            }
        }

        for (let num = 1; num <= 2; num++) {
            const envState = globalModulators[`env${num}`];
            if (!envState) continue;
            const aSlider = document.getElementById(`env${num}-a`);
            const dSlider = document.getElementById(`env${num}-d`);
            const sSlider = document.getElementById(`env${num}-s`);
            const rSlider = document.getElementById(`env${num}-r`);
            const trigSelect = document.getElementById(`env${num}-trig`);

            if (aSlider) aSlider.value = envState.a;
            if (dSlider) dSlider.value = envState.d;
            if (sSlider) sSlider.value = envState.s;
            if (rSlider) rSlider.value = envState.r;
            if (trigSelect) trigSelect.value = envState.trig;
        }
    }

    function syncModMatrixUI() {
        const slots = document.querySelectorAll('.mod-matrix-slot');
        slots.forEach(slotEl => {
            const slotIdx = parseInt(slotEl.dataset.slot);
            const slot = modMatrixSlots[slotIdx];
            if (!slot) return;

            const srcSelect = slotEl.querySelector('.mod-src');
            const destTrackSelect = slotEl.querySelector('.mod-dest-track');
            const destParamSelect = slotEl.querySelector('.mod-dest-param');
            const depthSlider = slotEl.querySelector('.mod-depth');
            const depthVal = slotEl.querySelector('.mod-depth-val');

            if (srcSelect) srcSelect.value = slot.src;
            if (destTrackSelect) destTrackSelect.value = slot.trackId;
            if (destParamSelect) destParamSelect.value = slot.param;
            if (depthSlider) {
                depthSlider.value = slot.depth;
                if (depthVal) depthVal.textContent = (slot.depth > 0 ? '+' : '') + slot.depth;
            }
        });
    }

    function captureTrackStates(loopIndex, eventType) {
        const timestamp = formatTime(isPlaying && audioCtx ? (audioCtx.currentTime - playStartCtxTime) : playOffset);

        const logEntry = document.createElement('div');
        logEntry.className = 'record-log-entry';
        const logHeader = document.createElement('div');
        logHeader.className = 'record-log-header';
        logHeader.textContent = `[${timestamp}] Loop ${loopIndex} - ${eventType}`;
        logEntry.appendChild(logHeader);

        tracks.forEach((track, idx) => {
            const trackNum = idx + 1;
            const volDb = (20 * Math.log10(track.level || 0.0001)).toFixed(1);
            const panVal = Math.round(track.pan * 100);

            const filterVal = track.macroKnobState.filter ? track.macroKnobState.filter.value : 50;
            const resoVal = track.macroKnobState.reso ? track.macroKnobState.reso.value : 0;
            const toneVal = track.macroKnobState.tone ? track.macroKnobState.tone.value : 50;
            const dlyMixVal = track.macroKnobState.dlyMix ? track.macroKnobState.dlyMix.value : 0;
            const revMixVal = track.macroKnobState.revMix ? track.macroKnobState.revMix.value : 0;

            const trackRow = document.createElement('div');
            trackRow.className = 'record-log-track-row';
            const values = [
                ['log-track-name', `T${trackNum} (${track.prompt.substring(0, 12)}...):`],
                ['log-track-param', `Vol: ${volDb} dB`],
                ['log-track-param', `Pan: ${panVal > 0 ? 'R' : panVal < 0 ? 'L' : ''}${Math.abs(panVal)}`],
                ['log-track-param', `Flt: ${filterVal}`],
                ['log-track-param', `Res: ${resoVal}`],
                ['log-track-param', `Ton: ${toneVal}`],
                ['log-track-param', `Dly: ${dlyMixVal}%`],
                ['log-track-param', `Rev: ${revMixVal}%`]
            ];
            values.forEach(([className, textValue], valueIndex) => {
                if (valueIndex === 1) trackRow.appendChild(document.createTextNode(' '));
                if (valueIndex > 1) trackRow.appendChild(document.createTextNode(' | '));
                const valueEl = document.createElement('span');
                valueEl.className = className;
                valueEl.textContent = textValue;
                trackRow.appendChild(valueEl);
            });
            logEntry.appendChild(trackRow);
        });

        if (recordLogList) {
            recordLogList.appendChild(logEntry);
            recordLogList.scrollTop = recordLogList.scrollHeight;
        }
    }

    // --- Structured Prompt Builder & Rolling History ---
    promptBuilder = PromptBuilder.createPromptBuilder({ storage: localStorage });

    async function submitCurrentGeneration(options = {}) {
        try {
            await promptBuilder.ready;
        } catch (_error) {
            showStatus('Prompt builder is unavailable.', 'error');
            return;
        }
        const prompt = promptBuilder.currentPrompt();
        if (!prompt) {
            showStatus('Choose at least one prompt section before generating.', 'error');
            return;
        }
        const historyEntry = promptBuilder.createHistoryEntry('pending', null);
        await runGeneration(prompt, {
            ...options,
            historyEntryId: historyEntry.id,
            selections: historyEntry.selections
        });
    }

    btnGenerate.addEventListener('click', () => submitCurrentGeneration());
    promptBuilder.setOnEnter(() => btnGenerate.click());
    promptBuilder.setOnResend(() => submitCurrentGeneration());
    // --- Kit Builder ---
    const kitPanel = document.getElementById('kit-builder-panel');
    const btnKitToggle = document.getElementById('btn-kit-toggle');
    const btnKitClose = document.getElementById('btn-kit-close');
    const kitPiecesEl = document.getElementById('kit-pieces');
    const kitResultsEl = document.getElementById('kit-results');
    const btnBuildKit = document.getElementById('btn-build-kit');

    const KIT_FALLBACK_PIECES = [
        { key: 'kick', label: 'kick drum' }, { key: 'snare', label: 'snare drum' },
        { key: 'rimshot', label: 'snare rimshot' }, { key: 'clap', label: 'hand clap' },
        { key: 'closed_hat', label: 'closed hi-hat' }, { key: 'open_hat', label: 'open hi-hat' },
        { key: 'tom_low', label: 'low floor tom' }, { key: 'tom_mid', label: 'mid tom' },
        { key: 'tom_high', label: 'high rack tom' }, { key: 'ride', label: 'ride cymbal' },
        { key: 'crash', label: 'crash cymbal' }, { key: 'shaker', label: 'shaker' },
        { key: 'cowbell', label: 'cowbell' }, { key: 'perc', label: 'percussion hit' }
    ];
    const KIT_DEFAULT_ON = new Set(['kick', 'snare', 'clap', 'closed_hat', 'open_hat', 'ride', 'crash', 'perc']);
    let kitPiecesLoaded = false;

    function renderKitPieces(pieces) {
        if (!kitPiecesEl) return;
        kitPiecesEl.textContent = '';
        pieces.forEach(piece => {
            const label = document.createElement('label');
            label.className = 'kit-check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = piece.key;
            input.checked = KIT_DEFAULT_ON.has(piece.key);
            label.appendChild(input);
            label.appendChild(document.createTextNode(piece.label));
            kitPiecesEl.appendChild(label);
        });
    }

    async function ensureKitPieces() {
        if (kitPiecesLoaded) return;
        kitPiecesLoaded = true;
        renderKitPieces(KIT_FALLBACK_PIECES);
        try {
            const res = await fetch('/api/kit_options');
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data.pieces) && data.pieces.length) renderKitPieces(data.pieces);
        } catch (e) {
            // The fallback list is already rendered.
        }
    }

    function setKitPanelOpen(open) {
        if (!kitPanel || !btnKitToggle) return;
        kitPanel.classList.toggle('is-open', open);
        btnKitToggle.classList.toggle('is-open', open);
        btnKitToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) ensureKitPieces();
    }

    if (btnKitToggle) btnKitToggle.addEventListener('click', () => setKitPanelOpen(!kitPanel.classList.contains('is-open')));
    if (btnKitClose) btnKitClose.addEventListener('click', () => setKitPanelOpen(false));

    let kitAuditionAudio = null;
    function auditionKitHit(btn, filePath) {
        if (kitAuditionAudio) {
            kitAuditionAudio.pause();
            kitAuditionAudio = null;
        }
        document.querySelectorAll('.kit-hit-btn.is-playing').forEach(b => b.classList.remove('is-playing'));
        const audio = new Audio(`/outputs/${filePath}`);
        kitAuditionAudio = audio;
        btn.classList.add('is-playing');
        audio.addEventListener('ended', () => btn.classList.remove('is-playing'));
        audio.play().catch(() => btn.classList.remove('is-playing'));
    }

    function renderKitResults(kit) {
        if (!kitResultsEl || !kit || !kit.manifest) return;
        kitResultsEl.textContent = '';
        kitResultsEl.classList.add('has-results');

        const header = document.createElement('div');
        header.className = 'kit-results-header';
        const title = document.createElement('span');
        title.className = 'kit-results-title';
        title.textContent = `${kit.manifest.name} — ${kit.manifest.entries.length} files`;
        const zipBtn = document.createElement('button');
        zipBtn.className = 'prompt-pill-btn';
        zipBtn.type = 'button';
        zipBtn.textContent = 'Download ZIP';
        zipBtn.addEventListener('click', () => downloadKitZip(kit, zipBtn));
        header.appendChild(title);
        header.appendChild(zipBtn);
        kitResultsEl.appendChild(header);

        const byPiece = new Map();
        kit.manifest.entries.forEach(entry => {
            if (!byPiece.has(entry.piece)) byPiece.set(entry.piece, []);
            byPiece.get(entry.piece).push(entry);
        });

        byPiece.forEach((entries, piece) => {
            const group = document.createElement('div');
            group.className = 'kit-piece-group';
            const name = document.createElement('span');
            name.className = 'kit-piece-name';
            name.textContent = piece.replace(/_/g, ' ');
            group.appendChild(name);
            entries.forEach(entry => {
                const btn = document.createElement('button');
                btn.type = 'button';
                const isSheet = (entry.tags || []).includes('hit_sheet');
                btn.className = 'kit-hit-btn' + (isSheet ? ' is-sheet' : '');
                btn.textContent = isSheet ? 'sheet' : `${entry.velocity} ${String(entry.variation).padStart(2, '0')}`;
                btn.title = entry.file;
                btn.addEventListener('click', () => auditionKitHit(btn, `${kit.dir}/${entry.file}`));
                group.appendChild(btn);
            });
            kitResultsEl.appendChild(group);
        });
    }

    async function downloadKitZip(kit, zipBtn) {
        const originalText = zipBtn.textContent;
        zipBtn.disabled = true;
        zipBtn.textContent = 'Zipping…';
        try {
            if (typeof JSZip === 'undefined') {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = '/static/vendor/jszip-3.10.1.min.js';
                    s.onload = resolve;
                    s.onerror = reject;
                    document.head.appendChild(s);
                });
            }
            const zip = new JSZip();
            zip.file('kit.json', JSON.stringify(kit.manifest, null, 2));
            for (const entry of kit.manifest.entries) {
                const res = await fetch(`/outputs/${kit.dir}/${entry.file}`);
                if (!res.ok) throw new Error(`Missing kit audio: ${entry.file}`);
                zip.file(entry.file, await res.blob());
                const metadataFile = entry.metadataFile || entry.metadata;
                if (!metadataFile) throw new Error(`Missing metadata reference for ${entry.file}`);
                const metadataResponse = await fetch(`/outputs/${kit.dir}/${metadataFile}`);
                if (!metadataResponse.ok) throw new Error(`Missing metadata sidecar: ${metadataFile}`);
                zip.file(metadataFile, await metadataResponse.text());
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(kit.manifest.name || 'kit').replace(/[^a-z0-9_-]+/gi, '_')}.zip`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (err) {
            showStatus(`Kit ZIP failed: ${err.message}`, 'error');
        } finally {
            zipBtn.disabled = false;
            zipBtn.textContent = originalText;
        }
    }

    async function runKitBuild() {
        const style = (document.getElementById('kit-style-input')?.value || '').trim();
        const kitName = (document.getElementById('kit-name-input')?.value || '').trim();
        const variations = parseInt(document.getElementById('kit-variations-input')?.value) || 1;
        const includeSheets = !!document.getElementById('kit-include-sheets')?.checked;
        const pieces = Array.from(kitPiecesEl?.querySelectorAll('input:checked') || []).map(i => i.value);
        const velocities = Array.from(document.getElementById('kit-velocities')?.querySelectorAll('input:checked') || []).map(i => i.value);
        if (!pieces.length) { showStatus('Pick at least one kit piece', 'error'); return; }
        if (!velocities.length) { showStatus('Pick at least one velocity layer', 'error'); return; }

        const stepsInput = document.getElementById('steps-input');
        const seedInput = document.getElementById('seed-input');

        btnBuildKit.disabled = true;
        btnBuildKit.classList.add('is-generating');
        btnBuildKit.textContent = 'Building…';
        showStatus('Submitting kit build…');
        try {
            const res = await fetch('/api/generate_kit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    style,
                    kit_name: kitName,
                    pieces,
                    velocities,
                    variations,
                    include_sheets: includeSheets,
                    steps: stepsInput ? parseInt(stepsInput.value) || 8 : 8,
                    seed: seedInput ? parseInt(seedInput.value) : -1
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const { job_id } = await res.json();
            const result = await pollJob(job_id);
            if (result.status !== 'done' || !result.kit) throw new Error(result.error || 'Kit build failed');
            const partialErrorCount = Array.isArray(result.partial_errors)
                ? result.partial_errors.length
                : 0;
            showStatus(
                partialErrorCount
                    ? `Kit done in ${result.elapsed?.toFixed(1) || '?'}s with ${partialErrorCount} skipped output${partialErrorCount === 1 ? '' : 's'}.`
                    : `Kit done in ${result.elapsed?.toFixed(1) || '?'}s`,
                partialErrorCount ? 'error' : 'done'
            );
            renderKitResults(result.kit);
        } catch (err) {
            if (err?.name !== 'GenerationCancelledError') {
                showStatus(`Kit build failed: ${err.message}`, 'error');
            }
        } finally {
            btnBuildKit.disabled = false;
            btnBuildKit.classList.remove('is-generating');
            btnBuildKit.textContent = 'Build Kit';
        }
    }

    if (btnBuildKit) btnBuildKit.addEventListener('click', runKitBuild);

    // Slicer-feed presets: normal loop generations tagged `sliceable` so the
    // upcoming slicer finds them in outputs/sliceable.json.
    const SLICER_FEED_PRESETS = {
        'btn-slice-break': 'raw drum break, live acoustic drums, funky breakbeat, punchy, dry',
        'btn-slice-perc': 'layered percussion loop, congas, shakers, bongos, tight groove, dry',
        'btn-slice-texture': 'evolving ambient texture, granular, tape-saturated, wide stereo field'
    };
    Object.entries(SLICER_FEED_PRESETS).forEach(([id, presetPrompt]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', async () => {
            await promptBuilder.ready;
            promptBuilder.restoreLegacyPrompt(presetPrompt);
            submitCurrentGeneration({ sliceable: true });
        });
    });

    async function runGeneration(prompt, options = {}) {
        const bpm = parseInt(bpmInput.value) || 120;
        const numVariants = 4;
        const loop = true;
        const seedInput = document.getElementById('seed-input');
        const cfgInput = document.getElementById('cfg-input');
        const stepsInput = document.getElementById('steps-input');
        const tierInput = document.getElementById('generation-tier');
        const seed = seedInput ? parseInt(seedInput.value) : -1;
        const cfgScale = cfgInput ? parseFloat(cfgInput.value) : 1.0;
        const steps = stepsInput ? parseInt(stepsInput.value) : 8;
        const qualityTier = tierInput ? tierInput.value : 'draft';

        btnGenerate.disabled = true;
        btnGenerate.classList.add('is-generating');
        btnGenerate.textContent = 'Generating…';
        showStatus('Submitting…');

        try {
            const serverPromptSections = { ...(options.selections || {}) };
            const assetPreferences = currentAssetPreferences();
            const bodyPayload = {
                prompt,
                bpm,
                num_variants: numVariants,
                loop,
                duration_padding_sec: loop ? 2.0 : 0.0,
                seed,
                cfg_scale: cfgScale,
                steps,
                quality_tier: qualityTier,
                prompt_sections: serverPromptSections,
                negative_prompt: promptBuilder.currentNegativePrompt(),
                sliceable: !!options.sliceable,
                ...assetPreferences
            };
            let parentTrackId = null;
            if (selectedInitAudio) {
                parentTrackId = selectedInitAudio.trackId;
                bodyPayload.init_audio_path = selectedInitAudio.filePath;
                bodyPayload.remix_mode = remixMode;
                const invertTimingCheckbox = document.getElementById('toggle-invert-timing');
                if (invertTimingCheckbox) {
                    bodyPayload.invert_timing = invertTimingCheckbox.checked;
                }
                if (remixMode === 'variation') {
                    const noiseSlider = document.getElementById('init-noise-slider');
                    bodyPayload.init_noise_level = noiseSlider ? parseInt(noiseSlider.value) / 100 : 0.60;
                } else if (remixMode === 'inpaint') {
                    const startSlider = document.getElementById('inpaint-start-slider');
                    const endSlider = document.getElementById('inpaint-end-slider');
                    bodyPayload.inpaint_start = startSlider ? parseFloat(startSlider.value) : 0.0;
                    bodyPayload.inpaint_end = endSlider ? parseFloat(endSlider.value) : 0.0;
                } else if (remixMode === 'continuation') {
                    const startSlider = document.getElementById('continue-start-slider');
                    bodyPayload.continue_start = startSlider ? parseFloat(startSlider.value) : 0.0;
                }
            }

            const res = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            const { job_id } = await res.json();
            if (options.historyEntryId) {
                promptBuilder.updateGeneration(options.historyEntryId, 'pending', { jobId: job_id });
            }
            setGenerationCancelState(job_id);
            showStatus('Submitting generation...');

            const result = await pollJob(job_id);
            if (result.status !== 'done') throw new Error(result.error || 'Failed');

            const successfulFiles = (result.files || []).filter(Boolean);
            const partialErrorCount = (result.partial_errors || []).length;
            showStatus(
                partialErrorCount
                    ? `Done with ${successfulFiles.length} result(s); ${partialErrorCount} variant(s) failed.`
                    : `Done in ${result.elapsed?.toFixed(1) || '?'}s`,
                partialErrorCount ? 'error' : 'done'
            );
            const originalParams = {
                prompt,
                bpm,
                seed,
                cfgScale,
                steps,
                duration: bodyPayload.duration || (960.0 / bpm),
                remixMode: selectedInitAudio ? remixMode : null,
                invertTiming: selectedInitAudio ? bodyPayload.invert_timing : false,
                initNoiseLevel: selectedInitAudio && remixMode === 'variation' ? bodyPayload.init_noise_level : null,
                inpaintStart: selectedInitAudio && remixMode === 'inpaint' ? bodyPayload.inpaint_start : null,
                inpaintEnd: selectedInitAudio && remixMode === 'inpaint' ? bodyPayload.inpaint_end : null,
                continueStart: selectedInitAudio && remixMode === 'continuation' ? bodyPayload.continue_start : null,
                parentTrackId: parentTrackId,
                promptSections: serverPromptSections,
                negativePrompt: bodyPayload.negative_prompt,
                qualityTier,
                asset: assetPreferences
            };
            addTrackRow(successfulFiles, prompt, result.track_num, true, parentTrackId, originalParams);
            if (options.historyEntryId) {
                promptBuilder.updateGeneration(options.historyEntryId, 'complete', {
                    jobId: job_id,
                    files: result.files,
                    metadataFiles: result.metadata_files || [],
                    trackNum: result.track_num,
                    partialErrors: result.partial_errors || []
                });
            }
            clearInitAudio();

        } catch (err) {
            if (err.name !== 'GenerationCancelledError') console.error('Generation error:', err);
            if (options.historyEntryId) {
                promptBuilder.updateGeneration(options.historyEntryId, 'failed', {
                    error: err.message,
                    cancelled: err.name === 'GenerationCancelledError'
                });
            }
            showStatus(err.name === 'GenerationCancelledError' ? 'Queued generation cancelled.' : `Error: ${err.message}`, err.name === 'GenerationCancelledError' ? 'done' : 'error');
        } finally {
            setGenerationCancelState(null);
            btnGenerate.disabled = false;
            btnGenerate.classList.remove('is-generating');
            btnGenerate.textContent = 'Generate';
        }
    }

    async function runOutpaint(track, variant, loopsCount) {
        if (btnGenerate.disabled) return; // Prevent concurrent generations

        const originalParams = track.originalParams || {
            prompt: track.prompt || "music loop",
            bpm: parseInt(bpmInput.value) || 120,
            seed: -1,
            cfgScale: 1.0,
            steps: 8
        };
        const prompt = originalParams.prompt;
        const bpm = originalParams.bpm;
        const parentDuration = 960.0 / bpm;
        const targetDuration = parentDuration * loopsCount;
        const numVariants = loopsCount === 2 ? 2 : 1;

        btnGenerate.disabled = true;
        btnGenerate.classList.add('is-generating');
        btnGenerate.textContent = 'Outpainting…';
        showStatus('Submitting Outpaint…');

        try {
            const bodyPayload = {
                prompt,
                bpm,
                num_variants: numVariants,
                loop: true,
                duration_padding_sec: 2.0,
                seed: -1,
                cfg_scale: originalParams.cfgScale,
                steps: originalParams.steps,
                duration: targetDuration,
                init_audio_path: variant.filePath,
                remix_mode: 'continuation',
                continue_start: parentDuration,
                prompt_sections: originalParams.promptSections || {},
                negative_prompt: originalParams.negativePrompt || '',
                quality_tier: originalParams.qualityTier || 'final',
                ...(originalParams.asset || currentAssetPreferences())
            };

            const res = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload)
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            const { job_id } = await res.json();
            setGenerationCancelState(job_id);
            showStatus('Submitting outpaint...');

            const result = await pollJob(job_id);
            if (result.status !== 'done') throw new Error(result.error || 'Failed');

            showStatus(`Done in ${result.elapsed?.toFixed(1) || '?'}s`, 'done');

            const outpaintParams = {
                prompt,
                bpm,
                seed: -1,
                cfgScale: originalParams.cfgScale,
                steps: originalParams.steps,
                duration: targetDuration,
                remixMode: 'continuation',
                invertTiming: false,
                continueStart: parentDuration,
                parentTrackId: track.id,
                promptSections: originalParams.promptSections || {},
                negativePrompt: originalParams.negativePrompt || '',
                qualityTier: originalParams.qualityTier || 'final',
                asset: originalParams.asset || currentAssetPreferences()
            };

            addTrackRow(result.files, prompt, result.track_num, true, track.id, outpaintParams);
        } catch (err) {
            if (err.name !== 'GenerationCancelledError') console.error('Outpaint error:', err);
            showStatus(err.name === 'GenerationCancelledError' ? 'Queued generation cancelled.' : `Error: ${err.message}`, err.name === 'GenerationCancelledError' ? 'done' : 'error');
        } finally {
            setGenerationCancelState(null);
            btnGenerate.disabled = false;
            btnGenerate.classList.remove('is-generating');
            btnGenerate.textContent = 'Generate';
        }
    }

    async function pollJob(jobId) {
        // A fixed 5-minute cap abandoned jobs still queued behind long
        // generations while the server later finished them. Give up only
        // after prolonged inactivity (no status/progress/queue movement).
        const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;
        let lastActivity = Date.now();
        let lastSignature = '';
        while (true) {
            if (activeGenerationJob?.id === jobId && activeGenerationJob.state === 'cancelled') {
                const cancelled = new Error('Generation cancelled before it started.');
                cancelled.name = 'GenerationCancelledError';
                throw cancelled;
            }
            await new Promise(r => setTimeout(r, 1000));
            if (activeGenerationJob?.id === jobId && activeGenerationJob.state === 'cancelled') {
                const cancelled = new Error('Generation cancelled before it started.');
                cancelled.name = 'GenerationCancelledError';
                throw cancelled;
            }
            const res = await fetch(`/api/status/${jobId}`);
            if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
            const data = await res.json();
            if (data.status === 'cancelled') {
                const cancelled = new Error('Generation cancelled before it started.');
                cancelled.name = 'GenerationCancelledError';
                throw cancelled;
            }
            if (data.status === 'done' || data.status === 'error') return data;
            if (data.progress) showStatus(data.progress);

            const signature = `${data.status}|${data.progress || ''}|${data.queue_position ?? ''}`;
            if (signature !== lastSignature) {
                lastSignature = signature;
                lastActivity = Date.now();
            } else if (Date.now() - lastActivity > INACTIVITY_LIMIT_MS) {
                throw new Error('Timed out: no progress from the generation server for 10 minutes.');
            }
        }
    }

    function addTrackRow(files, prompt, trackNum, autoPlay = false, parentTrackId = null, originalParams = null) {
        tracksContainer.classList.remove('empty');
        const empty = tracksContainer.querySelector('.grid-empty-state');
        if (empty) empty.remove();

        const track = createTrackRow(prompt, files, trackNum);
        track._autoPlay = autoPlay;
        track.parentTrackId = parentTrackId;
        if (originalParams) {
            track.originalParams = originalParams;
        } else {
            const bpmVal = parseInt(bpmInput.value) || 120;
            track.originalParams = {
                prompt,
                bpm: bpmVal,
                seed: -1,
                cfgScale: 1.0,
                steps: 8,
                duration: 960.0 / bpmVal,
                remixMode: null,
                invertTiming: false,
                parentTrackId: parentTrackId,
                promptSections: {},
                negativePrompt: '',
                qualityTier: 'final',
                asset: currentAssetPreferences()
            };
        }

        let inserted = false;
        if (parentTrackId !== null) {
            const parentIdx = tracks.findIndex(t => t.id === parentTrackId);
            if (parentIdx !== -1) {
                // Insert after parent in tracks array
                tracks.splice(parentIdx + 1, 0, track);

                // Insert after parent in DOM
                const parentTrack = tracks[parentIdx];
                if (parentTrack.wrapper) {
                    if (parentTrack.wrapper.nextElementSibling) {
                        tracksContainer.insertBefore(track.wrapper, parentTrack.wrapper.nextElementSibling);
                    } else {
                        tracksContainer.appendChild(track.wrapper);
                    }
                    inserted = true;
                }
            }
        }

        if (!inserted) {
            tracks.push(track);
            tracksContainer.appendChild(track.wrapper);
        }

        // Auto-select variant 0 visually
        if (track.variants[0] && track.variants[0].el) {
            track.variants[0].el.classList.add('is-selected');
        }

        btnPlayPause.disabled = false;
        if (btnStopAll) btnStopAll.disabled = false;
        if (btnRenderMix) btnRenderMix.disabled = false;
        if (btnExportLoops) btnExportLoops.disabled = false;
        if (btnSaveProject) btnSaveProject.disabled = false;
        if (btnRecord) btnRecord.disabled = false;
        updateDurationLabel();
        updateModMatrixTracks();
        if (arrangerModeActive) renderArrangerTimeline();

        // If already playing, buffer will auto-start via loadVariantAudio callback
    }

    // --- Status ---
    function showStatus(msg, type) {
        statusBar.classList.add('visible');
        statusText.textContent = msg;
        statusText.className = 'status-text';
        if (type === 'done') {
            statusText.classList.add('done');
            setPresentation(statusBar.querySelector('.status-spinner'), { display: 'none' });
            setTimeout(() => {
                statusBar.classList.remove('visible');
                setPresentation(statusBar.querySelector('.status-spinner'), { display: '' });
            }, 3000);
        } else if (type === 'error') {
            statusText.classList.add('error');
            setPresentation(statusBar.querySelector('.status-spinner'), { display: 'none' });
            setTimeout(() => {
                statusBar.classList.remove('visible');
                setPresentation(statusBar.querySelector('.status-spinner'), { display: '' });
            }, 5000);
        } else {
            setPresentation(statusBar.querySelector('.status-spinner'), { display: '' });
        }
    }

    // --- Resize observer ---
    let _waveformDrawDebounce = null;
    const ro = new ResizeObserver((entries) => {
        if (_waveformDrawDebounce) clearTimeout(_waveformDrawDebounce);
        _waveformDrawDebounce = setTimeout(() => {
            tracks.forEach(t => {
                t.variants.forEach((v, i) => {
                    if (v.el) {
                        const wf = v.el.querySelector('.card-waveform');
                        if (wf && v.buffer) drawWaveform(wf, v.buffer, i === t.selectedVariant, t.originalParams?.bpm);
                    }
                });
            });
        }, 100);
        
        document.querySelectorAll('.lfo-dot').forEach(d => d._cachedDims = null);
        entries.forEach(entry => {
            entry.target._cachedRect = entry.contentRect;
        });
    });
    ro.observe(tracksContainer);
    if (vizSpectrumCanvas) ro.observe(vizSpectrumCanvas);
    if (vizOscCanvas) ro.observe(vizOscCanvas);
    if (vizMetersCanvas) ro.observe(vizMetersCanvas);

    // --- Keyboard ---
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.code === 'Space') { e.preventDefault(); btnPlayPause.click(); }
    });

    // --- Metering Functions ---
    function dbToPct(db) {
        if (db <= -60) return 0;
        if (db >= 0) return 1;
        return (db + 60) / 60;
    }

    function updateMeterState(analyser, state, dT) {
        if (!analyser) return;
        const bufferLength = analyser.frequencyBinCount;
        if (!analyser._scratchBuffer || analyser._scratchBuffer.length !== bufferLength) {
            analyser._scratchBuffer = new Float32Array(bufferLength);
        }
        const dataArray = analyser._scratchBuffer;
        analyser.getFloatTimeDomainData(dataArray);

        let sumSquares = 0;
        let maxVal = 0;
        for (let i = 0; i < bufferLength; i++) {
            const val = dataArray[i];
            sumSquares += val * val;
            const absVal = Math.abs(val);
            if (absVal > maxVal) maxVal = absVal;
        }

        let rms = 0;
        if (bufferLength > 0) {
            rms = Math.sqrt(sumSquares / bufferLength);
        }

        let rmsDb = -60;
        if (rms > 0.000001) {
            rmsDb = 20 * Math.log10(rms);
        }
        rmsDb = Math.max(-60, Math.min(0, rmsDb));

        let peakDb = -60;
        if (maxVal > 0.000001) {
            peakDb = 20 * Math.log10(maxVal);
        }
        peakDb = Math.max(-60, Math.min(0, peakDb));

        // Smooth RMS (alpha = 0.85)
        const alpha = 0.85;
        state.rms = alpha * state.rms + (1 - alpha) * rmsDb;

        // Peak decay (12 dB per second)
        if (peakDb > state.peak) {
            state.peak = peakDb;
        } else {
            state.peak = Math.max(-60, state.peak - 12 * dT);
        }

        // Peak Hold logic
        if (peakDb >= state.peakHold) {
            state.peakHold = peakDb;
            state.peakHoldTime = 1.5;
        } else {
            if (state.peakHoldTime > 0) {
                state.peakHoldTime -= dT;
                if (state.peakHoldTime < 0) state.peakHoldTime = 0;
            } else {
                state.peakHold = Math.max(-60, state.peakHold - 15 * dT);
            }
        }
    }

    function drawMeter(canvas, state) {
        const ctx = canvas.getContext('2d');
        if (!canvas._roObserved) { ro.observe(canvas); canvas._roObserved = true; }
        const rect = canvas._cachedRect || canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const expectedW = Math.round(rect.width * dpr);
        const expectedH = Math.round(rect.height * dpr);

        if (canvas.width !== expectedW || canvas.height !== expectedH) {
            canvas.width = expectedW;
            canvas.height = expectedH;
            canvas._meterGrad = null;
            canvas._lastPeak = undefined;
        }

        const w = canvas.width;
        const h = canvas.height;

        // Idle meters decay to the floor and then hold constant — skip the
        // clear/redraw entirely when nothing changed since the last frame.
        if (canvas._lastPeak === state.peak && canvas._lastRms === state.rms && canvas._lastPeakHold === state.peakHold) {
            return;
        }
        canvas._lastPeak = state.peak;
        canvas._lastRms = state.rms;
        canvas._lastPeakHold = state.peakHold;

        ctx.clearRect(0, 0, w, h);

        if (w === 0 || h === 0) return;

        const isVertical = h > w;

        if (isVertical) {
            // Vertical gradient (bottom is green, top is red), cached per size
            let gradient = canvas._meterGrad;
            if (!gradient) {
                gradient = ctx.createLinearGradient(0, h, 0, 0);
                gradient.addColorStop(0, '#10b981');   // green
                gradient.addColorStop(0.7, '#10b981'); // -18dB
                gradient.addColorStop(0.71, '#fbbf24'); // yellow
                gradient.addColorStop(0.9, '#fbbf24');  // -6dB
                gradient.addColorStop(0.91, '#ef4444');  // red
                gradient.addColorStop(1, '#ef4444');
                canvas._meterGrad = gradient;
            }

            // 1. RMS (grows up from bottom)
            const rmsHeight = dbToPct(state.rms) * h;
            if (rmsHeight > 0) {
                ctx.globalAlpha = 0.4;
                ctx.fillStyle = gradient;
                ctx.fillRect(0, h - rmsHeight, w, rmsHeight);
                ctx.globalAlpha = 1.0;
            }

            // 2. Peak
            const peakHeight = dbToPct(state.peak) * h;
            if (peakHeight > 0) {
                ctx.fillStyle = gradient;
                const peakW = Math.max(2, Math.round(w * 0.4));
                const peakX = (w - peakW) / 2;
                ctx.fillRect(peakX, h - peakHeight, peakW, peakHeight);
            }

            // 3. Peak Hold
            const peakHoldY = h - (dbToPct(state.peakHold) * h);
            if (peakHoldY < h) {
                ctx.fillStyle = '#06b6d4'; // Cyan
                const tickH = dpr;
                ctx.fillRect(0, Math.min(h - tickH, Math.max(0, peakHoldY - tickH / 2)), w, tickH);
            }
        } else {
            // Horizontal gradient, cached per size
            let gradient = canvas._meterGrad;
            if (!gradient) {
                gradient = ctx.createLinearGradient(0, 0, w, 0);
                gradient.addColorStop(0, '#10b981');   // green
                gradient.addColorStop(0.7, '#10b981'); // -18dB
                gradient.addColorStop(0.71, '#fbbf24'); // yellow
                gradient.addColorStop(0.9, '#fbbf24');  // -6dB
                gradient.addColorStop(0.91, '#ef4444');  // red
                gradient.addColorStop(1, '#ef4444');
                canvas._meterGrad = gradient;
            }

            // 1. RMS
            const rmsWidth = dbToPct(state.rms) * w;
            if (rmsWidth > 0) {
                ctx.globalAlpha = 0.4;
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, rmsWidth, h);
                ctx.globalAlpha = 1.0;
            }

            // 2. Peak
            const peakWidth = dbToPct(state.peak) * w;
            if (peakWidth > 0) {
                ctx.fillStyle = gradient;
                const peakH = Math.max(2, Math.round(h * 0.4));
                const peakY = (h - peakH) / 2;
                ctx.fillRect(0, peakY, peakWidth, peakH);
            }

            // 3. Peak Hold
            const peakHoldX = dbToPct(state.peakHold) * w;
            if (peakHoldX > 0) {
                ctx.fillStyle = '#06b6d4'; // Cyan
                const tickW = dpr;
                ctx.fillRect(Math.min(w - tickW, Math.max(0, peakHoldX - tickW / 2)), 0, tickW, h);
            }
        }
    }

    function startMeterLoop() {
        if (meterLoopRunning) return;
        meterLoopRunning = true;
        let lastTime = performance.now();
        let lastFrameTime = performance.now();
        function tick() {
            meterRafId = requestAnimationFrame(tick);
            const now = performance.now();
            if (now - lastFrameTime < 33) return; // throttle to ~30fps
            lastFrameTime = now;

            const dT = Math.min(0.1, (now - lastTime) / 1000);
            lastTime = now;

            // Update master meter
            if (masterAnalyser) {
                updateMeterState(masterAnalyser, masterMeterState, dT);
                if (!startMeterLoop._masterCanvas) {
                    startMeterLoop._masterCanvas = document.getElementById('master-meter-canvas');
                }
                if (startMeterLoop._masterCanvas) {
                    drawMeter(startMeterLoop._masterCanvas, masterMeterState);
                }
            }

            // Update track meters
            tracks.forEach(t => {
                if (t.analyserNode && t.meterState && t.meterCanvas) {
                    if (t.gainNode && t.gainNode.gain.value === 0) {
                        // Decay meter visually to 0 without pulling FFT
                        t.meterState.peak -= (60 * dT);
                        if (t.meterState.peak < -80) t.meterState.peak = -80;
                    } else {
                        updateMeterState(t.analyserNode, t.meterState, dT);
                    }
                    drawMeter(t.meterCanvas, t.meterState);
                }
            });
        }
        meterRafId = requestAnimationFrame(tick);
    }

    // --- Init Audio Variation Handlers ---
    function updateRemixSlidersRange(duration) {
        const inpaintStartSlider = document.getElementById('inpaint-start-slider');
        const inpaintEndSlider = document.getElementById('inpaint-end-slider');
        const continueStartSlider = document.getElementById('continue-start-slider');

        if (inpaintStartSlider) {
            inpaintStartSlider.min = 0;
            inpaintStartSlider.max = duration;
            inpaintStartSlider.step = 0.1;
            inpaintStartSlider.value = (duration * 0.25).toFixed(1);
            const valEl = document.getElementById('inpaint-start-val');
            if (valEl) valEl.textContent = parseFloat(inpaintStartSlider.value).toFixed(1) + 's';
        }
        if (inpaintEndSlider) {
            inpaintEndSlider.min = 0;
            inpaintEndSlider.max = duration;
            inpaintEndSlider.step = 0.1;
            inpaintEndSlider.value = (duration * 0.75).toFixed(1);
            const valEl = document.getElementById('inpaint-end-val');
            if (valEl) valEl.textContent = parseFloat(inpaintEndSlider.value).toFixed(1) + 's';
        }
        if (continueStartSlider) {
            continueStartSlider.min = 0;
            continueStartSlider.max = duration;
            continueStartSlider.step = 0.1;
            continueStartSlider.value = (duration * 0.50).toFixed(1);
            const valEl = document.getElementById('continue-start-val');
            if (valEl) valEl.textContent = parseFloat(continueStartSlider.value).toFixed(1) + 's';
        }
    }

    function setInitAudio(track, variantIndex, filePath, name) {
        // If clicking the currently active init audio, clear it
        if (selectedInitAudio && selectedInitAudio.trackId === track.id && selectedInitAudio.variantIndex === variantIndex) {
            clearInitAudio();
            return;
        }

        // Set new active init audio
        selectedInitAudio = {
            trackId: track.id,
            variantIndex: variantIndex,
            filePath: filePath,
            name: name
        };

        // Update UI buttons across all track rows
        document.querySelectorAll('.btn-use-init').forEach(btn => {
            btn.classList.remove('is-active');
        });

        // Highlight active button in the DOM
        const trackRowEl = track.el;
        if (trackRowEl) {
            const cardEl = trackRowEl.querySelectorAll('.audio-card')[variantIndex];
            if (cardEl) {
                const btn = cardEl.querySelector('.btn-use-init');
                if (btn) btn.classList.add('is-active');
            }
        }

        // Update bounds of remix sliders based on variant buffer duration
        const v = track.variants[variantIndex];
        const duration = (track.originalParams && track.originalParams.duration) ? track.originalParams.duration : ((v && v.buffer) ? v.buffer.duration : globalDuration);
        updateRemixSlidersRange(duration);

        // Show top controls badge
        const badge = document.getElementById('init-audio-badge');
        const nameEl = document.getElementById('init-audio-name');
        if (badge && nameEl) {
            nameEl.textContent = name;
            setPresentation(badge, { display: 'flex' });
        }

        // Restore the original prompt from the track that generated this audio
        if (track.prompt) {
            promptBuilder.ready.then(() => {
                promptBuilder.restoreGenerationPrompt(
                    track.originalParams?.promptSections,
                    track.prompt
                );
            });
        }
    }

    function clearInitAudio() {
        selectedInitAudio = null;
        remixMode = 'variation';
        document.querySelectorAll('.btn-use-init').forEach(btn => {
            btn.classList.remove('is-active');
        });

        // Reset mode selector buttons
        document.querySelectorAll('.remix-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === 'variation');
        });

        // Reset subpanel visibility
        document.querySelectorAll('.remix-params-subpanel').forEach(panel => {
            setPresentation(panel, { display: panel.id === 'remix-params-variation' ? 'block' : 'none' });
        });

        const badge = document.getElementById('init-audio-badge');
        if (badge) {
            setPresentation(badge, { display: 'none' });
        }
    }

    // Wire Init Audio Badge controls
    const btnClearInit = document.getElementById('btn-clear-init');
    if (btnClearInit) {
        btnClearInit.addEventListener('click', clearInitAudio);
    }

    const initNoiseSlider = document.getElementById('init-noise-slider');
    const initNoiseValue = document.getElementById('init-noise-value');
    if (initNoiseSlider && initNoiseValue) {
        initNoiseSlider.addEventListener('input', () => {
            const val = parseInt(initNoiseSlider.value) / 100;
            initNoiseValue.textContent = val.toFixed(2);
        });
    }

    // Wire Remix Mode Selector
    document.querySelectorAll('.remix-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.remix-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            remixMode = btn.dataset.mode || 'variation';

            // Hide all subpanels, then show selected one
            document.querySelectorAll('.remix-params-subpanel').forEach(panel => {
                setPresentation(panel, { display: 'none' });
            });
            const selectedPanel = document.getElementById(`remix-params-${remixMode}`);
            if (selectedPanel) {
                setPresentation(selectedPanel, { display: remixMode === 'inpaint' ? 'flex' : 'block' });
            }
        });
    });

    // Wire sliders and readouts
    const inpaintStartSlider = document.getElementById('inpaint-start-slider');
    const inpaintEndSlider = document.getElementById('inpaint-end-slider');
    const inpaintStartVal = document.getElementById('inpaint-start-val');
    const inpaintEndVal = document.getElementById('inpaint-end-val');

    if (inpaintStartSlider && inpaintEndSlider) {
        inpaintStartSlider.addEventListener('input', () => {
            let startVal = parseFloat(inpaintStartSlider.value);
            let endVal = parseFloat(inpaintEndSlider.value);
            if (startVal > endVal) {
                inpaintStartSlider.value = endVal;
                startVal = endVal;
            }
            if (inpaintStartVal) {
                inpaintStartVal.textContent = startVal.toFixed(1) + 's';
            }
        });

        inpaintEndSlider.addEventListener('input', () => {
            let startVal = parseFloat(inpaintStartSlider.value);
            let endVal = parseFloat(inpaintEndSlider.value);
            if (endVal < startVal) {
                inpaintEndSlider.value = startVal;
                endVal = startVal;
            }
            if (inpaintEndVal) {
                inpaintEndVal.textContent = endVal.toFixed(1) + 's';
            }
        });
    }

    const continueStartSlider = document.getElementById('continue-start-slider');
    const continueStartVal = document.getElementById('continue-start-val');
    if (continueStartSlider) {
        continueStartSlider.addEventListener('input', () => {
            const val = parseFloat(continueStartSlider.value);
            if (continueStartVal) {
                continueStartVal.textContent = val.toFixed(1) + 's';
            }
        });
    }

    // --- Render Mix to WAV ---
    // Loop + beat-grid metadata, mirroring wav_metadata.acidize_wav_file on the
    // server. Without this a browser-side render exports a bare 44-byte-header
    // WAV: no tempo, no loop flag, no beat markers. Anything downloaded from
    // here lands in a DAW as an untagged one-shot.
    function buildAcidMetadata(bpm, durationSec, sampleRate, loop) {
        return WavMetadataCore.buildAcidMetadata(bpm, durationSec, sampleRate, loop);
    }

    function bufferToWav(buffer, meta) {
        const numOfChan = buffer.numberOfChannels;
        const pcmBytes = buffer.length * numOfChan * 2;
        const bpm = meta && meta.bpm > 0 ? meta.bpm : 0;
        const loop = !meta || meta.loop !== false;
        const acidBlock = bpm > 0
            ? buildAcidMetadata(bpm, buffer.duration, buffer.sampleRate, loop)
            : new Uint8Array(0);
        // RIFF(12) + fmt(24) + metadata + data header(8) + samples
        const headerLen = 44 + acidBlock.length;
        const length = headerLen + pcmBytes;
        const bufferArr = new ArrayBuffer(length);
        const view = new DataView(bufferArr);
        const channels = [];
        let i;
        let sample;
        let offset = 0;
        let pos = 0;

        function setUint16(data) {
            view.setUint16(pos, data, true);
            pos += 2;
        }

        function setUint32(data) {
            view.setUint32(pos, data, true);
            pos += 4;
        }

        // Write WAV header
        // "RIFF"
        setUint32(0x46464952);
        // file length - 8
        setUint32(length - 8);
        // "WAVE"
        setUint32(0x45564157);
        // "fmt " chunk
        setUint32(0x20746d66);
        // chunk length
        setUint32(16);
        // sample format (raw PCM = 1)
        setUint16(1);
        // channel count
        setUint16(numOfChan);
        // sample rate
        setUint32(buffer.sampleRate);
        // byte rate (sample rate * block align)
        setUint32(buffer.sampleRate * numOfChan * 2);
        // block align (channel count * bytes per sample)
        setUint16(numOfChan * 2);
        // bits per sample
        setUint16(16);
        // acid/cue/LIST chunks go BEFORE 'data', same as the server does
        if (acidBlock.length) {
            new Uint8Array(bufferArr).set(acidBlock, pos);
            pos += acidBlock.length;
        }
        // "data" chunk identifier
        setUint32(0x61746164);
        // chunk length
        setUint32(pcmBytes);

        // Fetch channel data
        for (i = 0; i < numOfChan; i++) {
            channels.push(buffer.getChannelData(i));
        }

        // Write PCM audio samples (use separate sampleIdx — pos is byte offset from header)
        let sampleIdx = 0;
        while (sampleIdx < buffer.length) {
            for (i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][sampleIdx]));
                sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(headerLen + offset, sample, true);
                offset += 2;
            }
            sampleIdx++;
        }

        return new Blob([bufferArr], { type: 'audio/wav' });
    }

    // --- Export Modal State and Events ---
    const exportModal = document.getElementById('export-modal');
    const exportModalTitle = document.getElementById('export-modal-title');
    const exportFilenameInput = document.getElementById('export-filename-input');
    const exportLoopsInput = document.getElementById('export-loops-input');
    const exportLoopsGroup = document.getElementById('export-loops-group');
    const exportFormatSelect = document.getElementById('export-format-select');
    const exportFormatGroup = document.getElementById('export-format-group');
    const btnExportConfirm = document.getElementById('btn-export-confirm');
    const btnExportCancel = document.getElementById('btn-export-cancel');

    let exportActionType = 'render';
    let exportModalTrigger = null;

    function getVisibleExportModalControls() {
        if (!exportModal) return [];
        return Array.from(exportModal.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(control => control.getClientRects().length > 0);
    }

    function openExportModal(type) {
        exportModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        exportActionType = type;
        if (type === 'render') {
            if (exportModalTitle) exportModalTitle.textContent = 'Render Mixdown';
            if (exportFilenameInput) exportFilenameInput.value = 'loopmastersa_mix';
            if (exportLoopsGroup) setPresentation(exportLoopsGroup, { display: 'flex' });
            if (exportFormatGroup) setPresentation(exportFormatGroup, { display: 'flex' });
            if (btnExportConfirm) btnExportConfirm.textContent = 'Render';
        } else {
            if (exportModalTitle) exportModalTitle.textContent = 'Export Loops (ZIP)';
            if (exportFilenameInput) exportFilenameInput.value = 'loopmastersa_loops';
            if (exportLoopsGroup) setPresentation(exportLoopsGroup, { display: 'none' });
            if (exportFormatGroup) setPresentation(exportFormatGroup, { display: 'none' });
            if (btnExportConfirm) btnExportConfirm.textContent = 'Export';
        }
        if (exportModal) exportModal.classList.add('is-visible');
        // Focus synchronously: hidden Electron windows may never deliver an
        // animation frame, which left keyboard focus behind the dialog.
        const firstControl = exportFilenameInput || getVisibleExportModalControls()[0];
        if (firstControl) {
            firstControl.focus();
            if (firstControl === exportFilenameInput) firstControl.select();
        }
    }

    function closeExportModal() {
        if (exportModal) exportModal.classList.remove('is-visible');
        const focusTarget = exportModalTrigger;
        exportModalTrigger = null;
        if (focusTarget && focusTarget.isConnected && !focusTarget.disabled) {
            focusTarget.focus();
        }
    }

    if (btnRenderMix) {
        btnRenderMix.addEventListener('click', () => {
            if (tracks.length === 0) return;
            openExportModal('render');
        });
    }

    if (btnExportLoops) {
        btnExportLoops.addEventListener('click', () => {
            const playing = tracks.filter(t => t.selectedVariant >= 0 && !t.muted);
            if (playing.length === 0) return;
            openExportModal('export');
        });
    }

    if (btnExportCancel) {
        btnExportCancel.addEventListener('click', closeExportModal);
    }

    if (exportModal) {
        exportModal.addEventListener('click', (e) => {
            if (e.target === exportModal) closeExportModal();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (!exportModal || !exportModal.classList.contains('is-visible')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeExportModal();
            return;
        }
        if (e.key === 'Tab') {
            const controls = getVisibleExportModalControls();
            if (controls.length === 0) {
                e.preventDefault();
                return;
            }
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    const triggerConfirmOnEnter = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (btnExportConfirm) btnExportConfirm.click();
        }
    };

    if (exportFilenameInput) exportFilenameInput.addEventListener('keydown', triggerConfirmOnEnter);
    if (exportLoopsInput) exportLoopsInput.addEventListener('keydown', triggerConfirmOnEnter);

    if (btnExportConfirm) {
        btnExportConfirm.addEventListener('click', () => {
            const filename = exportFilenameInput ? exportFilenameInput.value.trim() : '';
            const loopCount = exportLoopsInput ? Math.max(1, parseInt(exportLoopsInput.value) || 1) : 1;
            const targetFormat = (exportActionType === 'export') ? 'wav' : (exportFormatSelect ? exportFormatSelect.value : 'wav');

            closeExportModal();

            if (exportActionType === 'render') {
                runRenderMix(filename, loopCount, targetFormat);
            } else {
                runExportLoops(filename, targetFormat);
            }
        });
    }

    async function runRenderMix(filename, loopCount, targetFormat) {
        if (tracks.length === 0) return;
        const originalHTML = btnRenderMix.innerHTML;
        btnRenderMix.innerHTML = 'Rendering...';
        btnRenderMix.disabled = true;

        try {
            const currentCtx = ensureAudioCtx();
            const sampleRate = currentCtx.sampleRate;
            const singleLoopDuration = getActiveDuration();
            const contentDuration = singleLoopDuration * loopCount;
            const tailDuration = 5.0; // seconds of fade-out for delay/reverb tails
            const totalDuration = contentDuration + tailDuration;
            const offlineCtx = new OfflineAudioContext(2, sampleRate * totalDuration, sampleRate);

            // Create master chain on offline context
            const offlineMasterGain = offlineCtx.createGain();
            const masterVolSlider = document.getElementById('master-volume-slider');
            const sliderVal = masterVolSlider ? parseInt(masterVolSlider.value) : 100;
            const params = getMasterFaderParams(sliderVal);
            offlineMasterGain.gain.value = 1.0;

            const offlineLimiter = offlineCtx.createDynamicsCompressor();
            offlineLimiter.threshold.setValueAtTime(params.threshold, 0);
            offlineLimiter.knee.setValueAtTime(8.0, 0);
            offlineLimiter.ratio.setValueAtTime(20.0, 0);
            offlineLimiter.attack.setValueAtTime(0.003, 0);
            offlineLimiter.release.setValueAtTime(0.25, 0);

            const offlineMakeup = offlineCtx.createGain();
            offlineMakeup.gain.setValueAtTime(1.0, 0);

            const offlineVolumeNode = offlineCtx.createGain();
            offlineVolumeNode.gain.value = params.volumeGain;

            let offlineMasterFilter = null;
            if (typeof masterFilterNode !== 'undefined' && masterFilterNode) {
                offlineMasterFilter = offlineCtx.createBiquadFilter();
                offlineMasterFilter.type = masterFilterNode.type;
                offlineMasterFilter.frequency.value = masterFilterNode.frequency.value;
                offlineMasterFilter.Q.value = masterFilterNode.Q.value;
            }

            // Connect offline master chain
            offlineMasterGain.connect(offlineLimiter);
            offlineLimiter.connect(offlineMakeup);
            offlineMakeup.connect(offlineVolumeNode);
            if (offlineMasterFilter) {
                offlineVolumeNode.connect(offlineMasterFilter);
                offlineMasterFilter.connect(offlineCtx.destination);
            } else {
                offlineVolumeNode.connect(offlineCtx.destination);
            }

            // Schedule fade-out over the tail section on the master volume stage
            offlineVolumeNode.gain.setValueAtTime(params.volumeGain, contentDuration);
            offlineVolumeNode.gain.linearRampToValueAtTime(0.0, totalDuration);

            // Connect all active tracks
            const anySoloed = tracks.some(t => t.soloed);
            const offlineTrackData = {};

            tracks.forEach(t => {
                const effectivelyMuted = t.muted || (anySoloed && !t.soloed);
                if (effectivelyMuted) return;

                if (t.selectedVariant === -1) return;
                const v = t.variants[t.selectedVariant];
                if (!v || !v.buffer) return;

                const trackSourceBus = offlineCtx.createGain();
                trackSourceBus.gain.value = 1.0;

                const creationBpm = t.originalParams?.bpm || 120;
                const currentBpm = parseInt(bpmInput.value) || 120;
                const rate = currentBpm / creationBpm;

                // --- REPLICATE DSP EFFECTS ---
                // 0. Filtr Filter
                let lastNode = trackSourceBus;
                let offlineFiltrBiquad = null;
                if (t.filtrEnabled && t.filtrMix > 0) {
                    const filtrBiquad = offlineCtx.createBiquadFilter();
                    filtrBiquad.type = t.filtrType;
                    filtrBiquad.frequency.value = t.filtrCutoff;
                    filtrBiquad.Q.value = t.filtrResonance;
                    offlineFiltrBiquad = filtrBiquad;

                    const filtrDry = offlineCtx.createGain();
                    filtrDry.gain.value = 1.0 - t.filtrMix;
                    const filtrWet = offlineCtx.createGain();
                    filtrWet.gain.value = t.filtrMix;
                    const filtrSumNode = offlineCtx.createGain();

                    lastNode.connect(filtrDry);
                    filtrDry.connect(filtrSumNode);

                    lastNode.connect(filtrBiquad);
                    filtrBiquad.connect(filtrWet);
                    filtrWet.connect(filtrSumNode);

                    lastNode = filtrSumNode;
                }

                // 1. Luftikus EQ (6-band)
                if (t.eqEnabled) {
                    const freqs = [10, 40, 160, 640, 2500, 12000];
                    const types = ['peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf'];

                    for (let b = 0; b < 6; b++) {
                        const filter = offlineCtx.createBiquadFilter();
                        filter.type = types[b];
                        filter.frequency.value = freqs[b];
                        filter.Q.value = 1;
                        filter.gain.value = t.eqGains[b];
                        lastNode.connect(filter);
                        lastNode = filter;
                    }
                }

                // 1.5. Scream Distortion Filter
                if (t.screamEnabled && t.screamMix > 0) {
                    const screamBiquad = offlineCtx.createBiquadFilter();
                    screamBiquad.type = 'lowpass';
                    screamBiquad.frequency.value = t.screamCutoff;
                    screamBiquad.Q.value = t.screamAmount;

                    const screamShaperNode = offlineCtx.createWaveShaper();
                    screamShaperNode.curve = makeDistortionCurve(t.screamDriveAmount);

                    const screamDry = offlineCtx.createGain();
                    screamDry.gain.value = 1.0 - t.screamMix;
                    const screamWet = offlineCtx.createGain();
                    screamWet.gain.value = t.screamMix;
                    const screamSumNode = offlineCtx.createGain();

                    lastNode.connect(screamDry);
                    screamDry.connect(screamSumNode);

                    lastNode.connect(screamBiquad);
                    screamBiquad.connect(screamShaperNode);
                    screamShaperNode.connect(screamWet);
                    screamWet.connect(screamSumNode);

                    lastNode = screamSumNode;
                }

                // 2. Shared insert, modulation, and send stages. These use
                // the exact same routing and setting map as live playback.
                const offlineInsertEffects = TrackEffectGraph.buildInsertChain(offlineCtx, lastNode, t);
                const offlineModulationEffects = TrackEffectGraph.buildModulationChain(offlineCtx, offlineInsertEffects.output, t, currentBpm);
                const offlineSendEffects = TrackEffectGraph.buildSendChain(offlineCtx, offlineModulationEffects.output, t);
                lastNode = offlineSendEffects.output;

                const offlineTunaChorus = offlineInsertEffects.tunaChorusNode;
                const offlineTunaPhaser = offlineInsertEffects.tunaPhaserNode;
                const offlineTunaBitcrusher = offlineInsertEffects.tunaBitcrusherNode;
                const offlineAelapseDelayGain = offlineSendEffects.aelapseDelayGain;
                const offlineAelapseReverbGain = offlineSendEffects.aelapseReverbGain;

                // --- PAN & LEVEL ---
                const panner = offlineCtx.createStereoPanner();
                panner.pan.value = t.pan;

                const gain = offlineCtx.createGain();
                gain.gain.value = t.level;

                lastNode.connect(panner);
                panner.connect(gain);
                gain.connect(offlineMasterGain);

                const loopDurRealTime = (v.loopMultiplier || 1) * globalDuration;
                if (t.looping) {
                    for (let startTime = 0.0; startTime < contentDuration; startTime += loopDurRealTime) {
                        const source = offlineCtx.createBufferSource();
                        source.buffer = v.buffer;
                        source.loop = false;
                        source.playbackRate.value = rate;
                        source.connect(trackSourceBus);
                        source.start(startTime);
                    }
                } else {
                    const source = offlineCtx.createBufferSource();
                    source.buffer = v.buffer;
                    source.loop = false;
                    source.playbackRate.value = rate;
                    source.connect(trackSourceBus);
                    source.start(0);
                }

                // Record references for offline parameter automation
                offlineTrackData[t.id] = {
                    gain: gain,
                    panner: panner,
                    filtrBiquad: offlineFiltrBiquad,
                    // Keep disabled sends out of the automation surface so a
                    // modulation slot cannot accidentally enable them offline.
                    aelapseDelayGain: t.aelapseDelayEnabled ? offlineAelapseDelayGain : null,
                    aelapseReverbGain: t.aelapseReverbEnabled ? offlineAelapseReverbGain : null,
                    tunaChorusNode: offlineTunaChorus,
                    tunaPhaserNode: offlineTunaPhaser,
                    tunaBitcrusherNode: offlineTunaBitcrusher
                };
            });

            // Schedule arranger volume gates and LFO/Envelope modulations offline
            const stepSize = 0.05; // 50ms steps
            const modBypassEl = document.getElementById('toggle-modulators-bypass');
            const isModBypassed = modBypassEl ? modBypassEl.checked : false;

            const bpm = parseInt(bpmInput.value) || 120;
            const barDuration = 240.0 / bpm;
            const activeDuration = singleLoopDuration;

            const offlineLfo1SH = { cycle: -1, val: 0 };
            const offlineLfo2SH = { cycle: -1, val: 0 };
            const offlineLfo3SH = { cycle: -1, val: 0 };
            const offlineLfo4SH = { cycle: -1, val: 0 };

            const offlineEnvStates = {
                env1: { active: false, triggerTime: 0 },
                env2: { active: false, triggerTime: 0 }
            };

            let lastOfflineBarIndex = -1;

            for (let timeVal = 0.0; timeVal < contentDuration; timeVal += stepSize) {
                const loopTime = timeVal % activeDuration;
                const barIndex = Math.floor(loopTime / barDuration);
                const loopIndex = Math.floor(loopTime / globalDuration);

                // Bar triggers
                if (barIndex !== lastOfflineBarIndex) {
                    lastOfflineBarIndex = barIndex;
                    if (globalModulators.env1.trig === 'bar') { offlineEnvStates.env1.active = true; offlineEnvStates.env1.triggerTime = timeVal; }
                    if (globalModulators.env2.trig === 'bar') { offlineEnvStates.env2.active = true; offlineEnvStates.env2.triggerTime = timeVal; }
                }

                // Loop & Start triggers
                if (timeVal === 0.0 || (loopTime < stepSize && timeVal > 0.0)) {
                    if (globalModulators.env1.trig === 'loop' || globalModulators.env1.trig === 'play') { offlineEnvStates.env1.active = true; offlineEnvStates.env1.triggerTime = timeVal; }
                    if (globalModulators.env2.trig === 'loop' || globalModulators.env2.trig === 'play') { offlineEnvStates.env2.active = true; offlineEnvStates.env2.triggerTime = timeVal; }
                }

                // Calculate LFO values
                const getOfflineLfoVal = (lfo, num, shState) => {
                    if (!lfo.enabled) return 0.0;
                    let period = 1.0;
                    if (lfo.mode === 'sync') {
                        const bars = parseFloat(lfo.syncRate) || 1.0;
                        period = bars * (240.0 / bpm);
                    } else {
                        period = 1.0 / (lfo.freeRate || 1.0);
                    }
                    const phase = (loopTime / period) % 1.0;
                    switch (lfo.shape) {
                        case 'sine': return Math.sin(2.0 * Math.PI * phase);
                        case 'triangle': return phase < 0.5 ? (4.0 * phase - 1.0) : (3.0 - 4.0 * phase);
                        case 'sawtooth': return 2.0 * phase - 1.0;
                        case 'square': return phase < 0.5 ? 1.0 : -1.0;
                        case 'random': {
                            const cycleIndex = Math.floor(loopTime / period);
                            if (shState.cycle !== cycleIndex) {
                                shState.cycle = cycleIndex;
                                shState.val = Math.random() * 2.0 - 1.0;
                            }
                            return shState.val;
                        }
                        default: return 0.0;
                    }
                };

                const lfo1Val = getOfflineLfoVal(globalModulators.lfo1, 1, offlineLfo1SH);
                const lfo2Val = getOfflineLfoVal(globalModulators.lfo2, 2, offlineLfo2SH);
                const lfo3Val = getOfflineLfoVal(globalModulators.lfo3, 3, offlineLfo3SH);
                const lfo4Val = getOfflineLfoVal(globalModulators.lfo4, 4, offlineLfo4SH);

                // Calculate Envelope values (Disabled)
                const getOfflineEnvVal = (envKey) => {
                    return 0.0;
                };

                const env1Val = getOfflineEnvVal('env1');
                const env2Val = getOfflineEnvVal('env2');

                const modOffsets = {};
                const masterOffsets = { level: 0 };

                if (!isModBypassed) {
                    modMatrixSlots.forEach(slot => {
                        if (slot.src === 'none' || slot.trackId === 'none' || slot.param === 'none' || slot.depth === 0) return;
                        let modVal = 0.0;
                        if (slot.src === 'lfo1') modVal = lfo1Val;
                        else if (slot.src === 'lfo2') modVal = lfo2Val;
                        else if (slot.src === 'lfo3') modVal = lfo3Val;
                        else if (slot.src === 'lfo4') modVal = lfo4Val;
                        else if (slot.src === 'env1') modVal = env1Val;
                        else if (slot.src === 'env2') modVal = env2Val;

                        const offset = (slot.depth / 100) * modVal;
                        if (slot.trackId === 'master') {
                            masterOffsets[slot.param] = (masterOffsets[slot.param] || 0) + offset;
                        } else {
                            const tid = parseInt(slot.trackId);
                            if (!modOffsets[tid]) {
                                modOffsets[tid] = {
                                    level: 0,
                                    pan: 0,
                                    filter: 0,
                                    space: 0,
                                    chorusRate: 0,
                                    chorusDepth: 0,
                                    chorusFeedback: 0,
                                    phaserRate: 0,
                                    phaserDepth: 0,
                                    phaserFeedback: 0,
                                    crusherBits: 0,
                                    crusherNormfreq: 0
                                };
                            }
                            modOffsets[tid][slot.param] += offset;
                        }
                    });
                }

                // Apply automations to offline track parameters
                tracks.forEach(track => {
                    const offlineT = offlineTrackData[track.id];
                    if (!offlineT) return;

                    const offsets = modOffsets[track.id] || {
                        level: 0,
                        pan: 0,
                        filter: 0,
                        space: 0,
                        chorusRate: 0,
                        chorusDepth: 0,
                        chorusFeedback: 0,
                        phaserRate: 0,
                        phaserDepth: 0,
                        phaserFeedback: 0,
                        crusherBits: 0,
                        crusherNormfreq: 0
                    };

                    // Volume gating (with 50ms exponential ramp mapping)
                    let gate = 1.0;
                    if (arrangerModeActive) {
                        const gridArray = arrangerGrid[track.id];
                        const isCellActive = gridArray ? !!gridArray[loopIndex] : false;
                        const standardMuted = track.muted || (anySoloed && !track.soloed);
                        gate = (isCellActive && !standardMuted) ? 1.0 : 0.0;
                    } else {
                        gate = (track.muted || (anySoloed && !track.soloed)) ? 0.0 : 1.0;
                    }

                    if (offlineT._lastGate === undefined) offlineT._lastGate = gate;
                    if (gate !== offlineT._lastGate) {
                        offlineT.gain.gain.setValueAtTime(offlineT._lastGate * (track.level + offsets.level), timeVal);
                        offlineT.gain.gain.linearRampToValueAtTime(gate * (track.level + offsets.level), timeVal + 0.05);
                        offlineT._lastGate = gate;
                    } else {
                        let level = track.level + offsets.level;
                        level = Math.max(0, Math.min(1, level));
                        offlineT.gain.gain.setValueAtTime(level * gate, timeVal);
                    }

                    // Pan
                    let pan = track.pan + offsets.pan * 2.0;
                    pan = Math.max(-1, Math.min(1, pan));
                    offlineT.panner.pan.setValueAtTime(pan, timeVal);

                    // Filter
                    if (offlineT.filtrBiquad) {
                        let filterCutoff = track.filtrCutoff + offsets.filter * 15000;
                        filterCutoff = Math.max(20, Math.min(20000, filterCutoff));
                        offlineT.filtrBiquad.frequency.setValueAtTime(filterCutoff, timeVal);
                    }

                    // Space (Delay/Reverb Mix)
                    if (offlineT.aelapseDelayGain && offlineT.aelapseReverbGain) {
                        let space = offsets.space;
                        let dMix = Math.max(0, Math.min(1, track.aelapseDelayMix + space));
                        let rMix = Math.max(0, Math.min(1, track.aelapseReverbMix + space));
                        offlineT.aelapseDelayGain.gain.setValueAtTime(dMix, timeVal);
                        offlineT.aelapseReverbGain.gain.setValueAtTime(rMix, timeVal);
                    }

                    // Chorus Rate, Depth, Feedback
                    if (offlineT.tunaChorusNode) {
                        let chorusRate = track.tunaChorusRate + offsets.chorusRate * 8.0;
                        chorusRate = Math.max(0.01, Math.min(8.0, chorusRate));
                        if (track.tunaChorusRateSync && track.tunaChorusRateSync !== 'Free') {
                            const syncValue = track.tunaChorusRateSync;
                            let divisor = 240;
                            if (syncValue === '4/1') divisor = 960;
                            else if (syncValue === '8/1') divisor = 1920;
                            else if (syncValue === '16/1') divisor = 3840;
                            else if (syncValue === '32/1') divisor = 7680;
                            else if (syncValue === '1/1') divisor = 240;
                            else if (syncValue === '1/2') divisor = 120;
                            else if (syncValue === '1/4') divisor = 60;
                            else if (syncValue === '1/8') divisor = 30;
                            else if (syncValue === '1/16') divisor = 15;
                            chorusRate = bpm / divisor;
                        }
                        offlineT.tunaChorusNode.setRateAtTime(chorusRate, timeVal);

                        let chorusDepth = track.tunaChorusDepth + offsets.chorusDepth;
                        chorusDepth = Math.max(0.0, Math.min(1.0, chorusDepth));
                        offlineT.tunaChorusNode.setDepthAtTime(chorusDepth, timeVal);

                        let chorusFeedback = track.tunaChorusFeedback + offsets.chorusFeedback;
                        chorusFeedback = Math.max(0.0, Math.min(0.95, chorusFeedback));
                        offlineT.tunaChorusNode.setFeedbackAtTime(chorusFeedback, timeVal);
                    }

                    // Phaser Rate, Depth, Feedback
                    if (offlineT.tunaPhaserNode) {
                        let phaserRate = track.tunaPhaserRate + offsets.phaserRate * 8.0;
                        phaserRate = Math.max(0.01, Math.min(8.0, phaserRate));
                        if (track.tunaPhaserRateSync && track.tunaPhaserRateSync !== 'Free') {
                            const syncValue = track.tunaPhaserRateSync;
                            let divisor = 240;
                            if (syncValue === '4/1') divisor = 960;
                            else if (syncValue === '8/1') divisor = 1920;
                            else if (syncValue === '16/1') divisor = 3840;
                            else if (syncValue === '32/1') divisor = 7680;
                            else if (syncValue === '1/1') divisor = 240;
                            else if (syncValue === '1/2') divisor = 120;
                            else if (syncValue === '1/4') divisor = 60;
                            else if (syncValue === '1/8') divisor = 30;
                            else if (syncValue === '1/16') divisor = 15;
                            phaserRate = bpm / divisor;
                        }
                        offlineT.tunaPhaserNode.setRateAtTime(phaserRate, timeVal);

                        let phaserDepth = track.tunaPhaserDepth + offsets.phaserDepth;
                        phaserDepth = Math.max(0.0, Math.min(1.0, phaserDepth));
                        offlineT.tunaPhaserNode.setDepthAtTime(phaserDepth, timeVal);

                        let phaserFeedback = track.tunaPhaserFeedback + offsets.phaserFeedback;
                        phaserFeedback = Math.max(0.0, Math.min(1.0, phaserFeedback));
                        offlineT.tunaPhaserNode.setFeedbackAtTime(phaserFeedback, timeVal);
                    }

                    // Bitcrusher Bits, Normfreq
                    if (offlineT.tunaBitcrusherNode) {
                        let crusherBits = track.tunaBitcrusherBits + offsets.crusherBits * 16.0;
                        crusherBits = Math.max(1, Math.min(16, Math.round(crusherBits)));
                        offlineT.tunaBitcrusherNode.bits = crusherBits;

                        let crusherNormfreq = track.tunaBitcrusherNormfreq + offsets.crusherNormfreq;
                        crusherNormfreq = Math.max(0.001, Math.min(1.0, crusherNormfreq));
                        offlineT.tunaBitcrusherNode.setNormfreqAtTime(crusherNormfreq, timeVal);
                    }
                });

                // Master Volume fader modulation offline
                if (!isModBypassed && masterOffsets.level !== 0) {
                    let val = masterOffsets.level * 100;
                    let targetSliderVal = Math.max(0, Math.min(100, sliderVal + val));
                    const p = getMasterFaderParams(targetSliderVal);
                    offlineVolumeNode.gain.setValueAtTime(p.volumeGain, timeVal);
                    offlineLimiter.threshold.setValueAtTime(p.threshold, timeVal);
                }
            }

            const renderedBuffer = await offlineCtx.startRendering();
            // This mix contains a five-second effect tail, so it is deliberately
            // tagged as a one-shot rather than falsely claiming a seamless loop.
            const wavBlob = bufferToWav(renderedBuffer, { bpm, loop: false });

            let downloadBlob = wavBlob;
            let downloadFilename = filename || 'loopmastersa_mix';
            if (!downloadFilename.toLowerCase().endsWith('.' + targetFormat)) {
                downloadFilename += '.' + targetFormat;
            }

            if (targetFormat !== 'wav') {
                btnRenderMix.innerHTML = 'Converting...';
                const formData = new FormData();
                formData.append('file', wavBlob, `mix_${bpm}bpm.wav`);
                formData.append('format', targetFormat);

                const convertResp = await fetch('/api/convert', {
                    method: 'POST',
                    body: formData
                });
                if (!convertResp.ok) {
                    let errMsg = 'Audio conversion failed';
                    try {
                        const errData = await convertResp.json();
                        errMsg = errData.error || errMsg;
                    } catch (_) {
                        try {
                            const errText = await convertResp.text();
                            errMsg = errText ? errText.substring(0, 150) : `Server returned status ${convertResp.status}`;
                        } catch (__) {
                            errMsg = `Server returned status ${convertResp.status}`;
                        }
                    }
                    throw new Error(errMsg);
                }
                downloadBlob = await convertResp.blob();
            }

            const blobUrl = URL.createObjectURL(downloadBlob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = downloadFilename;
            link.click();
            URL.revokeObjectURL(blobUrl);

        } catch (err) {
            console.error('Failed to render mix:', err);
            alert('Failed to render mix: ' + err.message);
        } finally {
            btnRenderMix.innerHTML = originalHTML;
            btnRenderMix.disabled = false;
        }
    }

    async function runExportLoops(filename, targetFormat) {
        const playing = tracks.filter(t => t.selectedVariant >= 0 && !t.muted);
        if (playing.length === 0) return;

        const originalHTML = btnExportLoops.innerHTML;
        btnExportLoops.innerHTML = 'Zipping...';
        btnExportLoops.disabled = true;

        try {
            // Load JSZip from CDN if not already loaded
            if (typeof JSZip === 'undefined') {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = '/static/vendor/jszip-3.10.1.min.js';
                    s.onload = resolve;
                    s.onerror = reject;
                    document.head.appendChild(s);
                });
            }

            const zip = new JSZip();
            const bpm = parseInt(bpmInput.value) || 120;
            const addedNames = new Set();
            const manifest = {
                schema: 'com.loopmaster.pack-manifest',
                version: 1,
                name: filename || currentAssetPreferences().pack_name,
                createdAt: new Date().toISOString(),
                bpm,
                items: []
            };

            for (const t of playing) {
                const v = t.variants[t.selectedVariant];
                if (!v || !v.filePath) continue;

                let blob;
                let originalFilename = v.filePath.split('/').pop() || '';
                let outFilename = originalFilename;

                if (targetFormat === 'wav') {
                    const resp = await fetch(`/outputs/${v.filePath}`);
                    if (!resp.ok) continue;
                    blob = await resp.blob();
                } else {
                    const formData = new FormData();
                    formData.append('file_path', v.filePath);
                    formData.append('format', targetFormat);

                    const convertResp = await fetch('/api/convert', {
                        method: 'POST',
                        body: formData
                    });
                    if (!convertResp.ok) continue;
                    blob = await convertResp.blob();
                    outFilename = outFilename.replace(/\.wav$/i, `.${targetFormat}`);
                }
                if (addedNames.has(outFilename)) {
                    throw new Error(`Pack filename collision: ${outFilename}`);
                }
                addedNames.add(outFilename);
                zip.file(outFilename, blob);
                const item = { file: outFilename, source: v.filePath };
                if (targetFormat === 'wav') {
                    const metadataPath = v.filePath.replace(/\.wav$/i, '.meta.json');
                    const metadataFilename = originalFilename.replace(/\.wav$/i, '.meta.json');
                    const metadataResponse = await fetch(`/outputs/${metadataPath}`);
                    if (!metadataResponse.ok) {
                        throw new Error(`Missing metadata sidecar for ${originalFilename}`);
                    }
                    const metadataText = await metadataResponse.text();
                    if (addedNames.has(metadataFilename)) {
                        throw new Error(`Pack filename collision: ${metadataFilename}`);
                    }
                    addedNames.add(metadataFilename);
                    zip.file(metadataFilename, metadataText);
                    const metadata = JSON.parse(metadataText);
                    item.metadataFile = metadataFilename;
                    item.sha256 = metadata.audio?.sha256 || null;
                    item.kind = metadata.kind || null;
                    item.bpm = metadata.musical?.bpm || null;
                    item.beats = metadata.musical?.beats || null;
                    item.bars = metadata.musical?.bars || null;
                    item.key = metadata.musical?.key?.token || null;
                    item.chords = metadata.musical?.chords || [];
                    item.slices = { preferred: metadata.slices?.preferred || [] };
                }
                manifest.items.push(item);
            }

            zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            const link = document.createElement('a');
            link.href = url;

            let downloadFilename = filename || 'loopmastersa_loops';
            if (!downloadFilename.toLowerCase().endsWith('.zip')) {
                downloadFilename += '.zip';
            }
            link.download = downloadFilename;
            link.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Export failed:', err);
            alert('Export failed: ' + err.message);
        } finally {
            btnExportLoops.innerHTML = originalHTML;
            btnExportLoops.disabled = false;
        }
    }

    // --- Docs Module Toggle ---
    const docsToggle = document.getElementById('docs-toggle');
    const docsModule = document.getElementById('docs-module');
    if (docsToggle && docsModule) {
        docsToggle.setAttribute('aria-expanded', String(docsModule.classList.contains('is-open')));
        docsToggle.addEventListener('click', () => {
            const isOpen = docsModule.classList.toggle('is-open');
            docsToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }

    // ============================================================
    // --- MIDI LEARN, MODULATORS & ARRANGER HELPERS ---
    // ============================================================

    function requestMIDIAccessLazy() {
        if (midiAccessRequested) return;
        midiAccessRequested = true;

        if (navigator.requestMIDIAccess) {
            navigator.requestMIDIAccess().then(access => {
                midiAccess = access;
                for (let input of access.inputs.values()) {
                    input.onmidimessage = handleMidiMessage;
                }
                access.onstatechange = (e) => {
                    if (e.port.type === 'input' && e.port.state === 'connected') {
                        e.port.onmidimessage = handleMidiMessage;
                    }
                };
            }).catch(err => {
                console.warn('MIDI Access denied or unsupported:', err);
            });
        } else {
            console.warn('Web MIDI API not supported in this browser.');
        }
    }

    function initMIDI() {
        try {
            const saved = localStorage.getItem('loopmaster_midi_mappings');
            if (saved) {
                midiMappings = JSON.parse(saved);
            }
        } catch (e) {
            console.warn('Failed to load MIDI mappings:', e);
        }

        const btnMidiLearn = document.getElementById('btn-midi-learn');
        if (btnMidiLearn) {
            setToggleButtonPressed(btnMidiLearn, midiLearnActive);
            btnMidiLearn.addEventListener('click', () => {
                requestMIDIAccessLazy();
                midiLearnActive = !midiLearnActive;
                btnMidiLearn.classList.toggle('active', midiLearnActive);
                setToggleButtonPressed(btnMidiLearn, midiLearnActive);
                toggleMidiMappableClasses(midiLearnActive);
                if (!midiLearnActive) {
                    midiLearningControl = null;
                    document.querySelectorAll('.midi-waiting').forEach(el => el.classList.remove('midi-waiting'));
                }
            });
        }

        // Intercept clicks on mappable controls when MIDI Learn is active
        document.addEventListener('click', (e) => {
            if (!midiLearnActive) return;

            const el = e.target.closest('.level-knob, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .macro-knob, .fx-macro-knob, #master-volume-slider');
            if (el) {
                e.preventDefault();
                e.stopPropagation();

                document.querySelectorAll('.midi-waiting').forEach(other => other.classList.remove('midi-waiting'));

                midiLearningControl = getControlIdentifier(el);
                if (midiLearningControl) {
                    el.classList.add('midi-waiting');
                    console.log(`MIDI: Waiting for CC on control ${midiLearningControl}`);
                }
            }
        }, true);
    }

    function handleMidiMessage(e) {
        const status = e.data[0];
        const data1 = e.data[1];
        const data2 = e.data[2];

        // Check if CC (Control Change) message
        if ((status & 0xf0) === 0xb0) {
            const channel = status & 0x0f;
            const cc = data1;
            const value = data2;

            if (midiLearnActive && midiLearningControl) {
                midiMappings[midiLearningControl] = { channel, cc };
                try {
                    localStorage.setItem('loopmaster_midi_mappings', JSON.stringify(midiMappings));
                } catch (e) {
                    console.warn('Failed to save MIDI mappings to localStorage (quota exceeded?):', e);
                }
                console.log(`MIDI: Mapped CC ${cc} (Chan ${channel}) to ${midiLearningControl}`);

                const el = findElementByControlId(midiLearningControl);
                if (el) {
                    el.classList.remove('midi-waiting');
                    el.classList.add('midi-mapped-ui');
                }
                midiLearningControl = null;
            } else if (!midiLearnActive) {
                for (const [ctrlId, mapping] of Object.entries(midiMappings)) {
                    if (mapping.cc === cc && mapping.channel === channel) {
                        routeMidiValue(ctrlId, value);
                    }
                }
            }
        }
    }

    function routeMidiValue(controlId, ccValue) {
        if (controlId === 'master-volume') {
            const masterValSlider = document.getElementById('master-volume-slider');
            if (masterValSlider) {
                const sliderVal = Math.round((ccValue / 127) * 100);
                masterValSlider.value = sliderVal;
                masterValSlider.dispatchEvent(new Event('input'));
            }
            return;
        }

        const match = controlId.match(/^track-(\d+)-(.+)$/);
        if (!match) return;

        const trackId = parseInt(match[1]);
        const paramName = match[2];

        const track = tracks.find(t => t.id === trackId);
        if (!track || track.locked) return;

        applyControlValue(track, paramName, ccValue);
    }

    function applyControlValue(track, paramName, midiVal) {
        const normVal = midiVal / 127;
        const ctx = ensureAudioCtx();
        const currentTime = ctx.currentTime;

        if (paramName === 'level') {
            track.level = normVal;
            const knob = track.wrapper.querySelector('.level-knob');
            const targetVal = Math.round(normVal * 100);
            if (knob) {
                knob.value = targetVal;
                knob.title = `Vol: ${targetVal}`;
            }
            const levelValue = track.wrapper.querySelector('.level-value');
            if (levelValue) levelValue.textContent = targetVal;
            if (track.gainNode) {
                track.gainNode.gain.value = normVal * (track._arrangerGate !== undefined ? track._arrangerGate : 1.0);
            }
        } else if (paramName === 'pan') {
            const panVal = normVal * 2.0 - 1.0;
            track.pan = panVal;
            const panValInt = Math.round(panVal * 100);
            if (track.panNode) {
                track.panNode.pan.value = panVal;
            }
            const panKnob = track.wrapper.querySelector('.pan-knob');
            if (panKnob) {
                const deg = panVal * 135;
                setPresentation(panKnob.querySelector('.pan-knob-indicator'), { transform: `rotate(${deg}deg)` });
                panKnob.title = `Pan: ${panValInt === 0 ? 'C' : panValInt < 0 ? 'L' + Math.abs(panValInt) : 'R' + panValInt}`;
                const panValue = track.wrapper.querySelector('.pan-value');
                if (panValue) panValue.textContent = panValInt === 0 ? 'C' : panValInt < 0 ? `L${Math.abs(panValInt)}` : `R${panValInt}`;
            }
        } else if (paramName === 'filtr-cutoff') {
            const cutoff = 20 * Math.pow(20000 / 20, normVal);
            track.filtrCutoff = cutoff;
            if (track.filtrFilterNode) {
                track.filtrFilterNode.frequency.setValueAtTime(cutoff, currentTime);
            }
            const slider = track.wrapper.querySelector('.filtr-cutoff');
            if (slider) {
                slider.value = Math.round(normVal * 100);
                const valDisplay = slider.nextElementSibling;
                if (valDisplay) valDisplay.textContent = cutoff >= 1000 ? (cutoff / 1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz';
            }
        } else if (paramName === 'aelapse-delay-mix') {
            track.aelapseDelayMix = normVal;
            if (track.aelapseDelayGainNode) {
                track.aelapseDelayGainNode.gain.setValueAtTime(normVal, currentTime);
            }
            const slider = track.wrapper.querySelector('.aelapse-delay-mix');
            if (slider) {
                slider.value = Math.round(normVal * 100);
                const valDisplay = slider.nextElementSibling;
                if (valDisplay) valDisplay.textContent = Math.round(normVal * 100) + '%';
            }
        } else if (paramName === 'aelapse-reverb-mix') {
            track.aelapseReverbMix = normVal;
            if (track.aelapseReverbGainNode) {
                track.aelapseReverbGainNode.gain.setValueAtTime(normVal, currentTime);
            }
            const slider = track.wrapper.querySelector('.aelapse-reverb-mix');
            if (slider) {
                slider.value = Math.round(normVal * 100);
                const valDisplay = slider.nextElementSibling;
                if (valDisplay) valDisplay.textContent = Math.round(normVal * 100) + '%';
            }
        } else if (paramName.startsWith('macro-')) {
            const macroName = paramName.replace('macro-', '');
            let val;
            if (macroName === 'filter') {
                val = Math.round(normVal * 200 - 100);
            } else {
                val = Math.round(normVal * 100);
            }
            if (track.applyMacroKnobFn) {
                track.applyMacroKnobFn(macroName, val);
            }
        } else if (paramName.startsWith('fxmacro-')) {
            const macroName = paramName.replace('fxmacro-', '');
            const val = Math.round(normVal * 100);
            if (track.applyFxMacroFn) {
                track.applyFxMacroFn(macroName, val);
            }
        }
    }

    function getControlIdentifier(el) {
        if (el.id === 'master-volume-slider') {
            return 'master-volume';
        }
        const wrapper = el.closest('.track-wrapper');
        if (!wrapper) return null;
        const trackId = wrapper.dataset.trackId;
        if (!trackId) return null;

        if (el.classList.contains('level-knob')) return `track-${trackId}-level`;
        if (el.classList.contains('pan-knob')) return `track-${trackId}-pan`;
        if (el.classList.contains('filtr-cutoff')) return `track-${trackId}-filtr-cutoff`;
        if (el.classList.contains('aelapse-delay-mix')) return `track-${trackId}-aelapse-delay-mix`;
        if (el.classList.contains('aelapse-reverb-mix')) return `track-${trackId}-aelapse-reverb-mix`;

        if (el.classList.contains('macro-knob')) {
            return `track-${trackId}-macro-${el.dataset.param}`;
        }
        if (el.classList.contains('fx-macro-knob')) {
            return `track-${trackId}-fxmacro-${el.dataset.macro}`;
        }
        return null;
    }

    function findElementByControlId(controlId) {
        if (controlId === 'master-volume') {
            return document.getElementById('master-volume-slider');
        }
        const match = controlId.match(/^track-(\d+)-(.+)$/);
        if (!match) return null;

        const trackId = match[1];
        const param = match[2];

        const wrapper = document.querySelector(`.track-wrapper[data-track-id="${trackId}"]`);
        if (!wrapper) return null;

        if (param === 'level') return wrapper.querySelector('.level-knob');
        if (param === 'pan') return wrapper.querySelector('.pan-knob');
        if (param === 'filtr-cutoff') return wrapper.querySelector('.filtr-cutoff');
        if (param === 'aelapse-delay-mix') return wrapper.querySelector('.aelapse-delay-mix');
        if (param === 'aelapse-reverb-mix') return wrapper.querySelector('.aelapse-reverb-mix');

        if (param.startsWith('macro-')) {
            return wrapper.querySelector(`.macro-knob[data-param="${param.replace('macro-', '')}"]`);
        }
        if (param.startsWith('fxmacro-')) {
            return wrapper.querySelector(`.fx-macro-knob[data-macro="${param.replace('fxmacro-', '')}"]`);
        }
        return null;
    }

    function toggleMidiMappableClasses(active) {
        const elements = document.querySelectorAll(
            '.level-knob, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .macro-knob, .fx-macro-knob, #master-volume-slider'
        );
        elements.forEach(el => {
            if (active) {
                el.classList.add('midi-mappable');
                const ctrlId = getControlIdentifier(el);
                if (ctrlId && midiMappings[ctrlId]) {
                    el.classList.add('midi-mapped-ui');
                }
            } else {
                el.classList.remove('midi-mappable', 'midi-waiting', 'midi-mapped-ui');
            }
        });
    }

    function setupGlobalModulatorsListeners() {
        const modulatorsPanel = document.getElementById('modulators-panel');
        if (!modulatorsPanel) return;

        // Toggle Song Mode and Arranger visibility
        const toggleArranger = document.getElementById('toggle-arranger');
        const arrangerPanel = document.getElementById('arranger-panel');
        toggleArranger.addEventListener('change', () => {
            arrangerModeActive = toggleArranger.checked;
            setPresentation(arrangerPanel, { display: arrangerModeActive ? 'flex' : 'none' });

            const playheadLine = document.getElementById('arranger-playhead-line');
            if (playheadLine) {
                setPresentation(playheadLine, { display: arrangerModeActive ? 'block' : 'none' });
            }

            renderArrangerTimeline();
            updatePlayheads();
        });

        const arrangerLengthSelect = document.getElementById('arranger-length');
        if (arrangerLengthSelect) {
            arrangerLengthSelect.addEventListener('change', () => {
                arrangerLengthLoops = parseInt(arrangerLengthSelect.value) || 32;
                renderArrangerTimeline();
            });
        }

        const btnClearArrangement = document.getElementById('btn-clear-arrangement');
        if (btnClearArrangement) {
            btnClearArrangement.addEventListener('click', () => {
                tracks.forEach(track => {
                    arrangerGrid[track.id] = new Array(arrangerLengthLoops).fill(false);
                });
                renderArrangerTimeline();
            });
        }

        const setupLfoControls = (num) => {
            const shapeSelect = document.getElementById(`lfo${num}-shape`);
            const syncToggle = document.getElementById(`lfo${num}-sync-toggle`);
            const rateSyncSelect = document.getElementById(`lfo${num}-rate-sync`);
            const rateFreeSlider = document.getElementById(`lfo${num}-rate-free`);
            const rateFreeVal = document.getElementById(`lfo${num}-rate-val`);
            const rateSyncRow = document.getElementById(`lfo${num}-rate-sync-row`);
            const rateFreeRow = document.getElementById(`lfo${num}-rate-free-row`);

            const toggleBtn = modulatorsPanel.querySelector(`.lfo${num}-toggle`);
            const section = toggleBtn ? toggleBtn.closest('.fx-section') : null;

            // Initialize UI state from globalModulators state
            const lfoState = globalModulators[`lfo${num}`];
            if (shapeSelect) shapeSelect.value = lfoState.shape;
            if (syncToggle) syncToggle.checked = (lfoState.mode === 'sync');
            if (rateSyncSelect) rateSyncSelect.value = lfoState.syncRate;
            if (rateFreeSlider) {
                rateFreeSlider.value = lfoState.freeRate * 10.0;
                if (rateFreeVal) rateFreeVal.textContent = lfoState.freeRate.toFixed(1) + 'Hz';
            }
            const isSync = (lfoState.mode === 'sync');
            if (rateSyncRow) setPresentation(rateSyncRow, { display: isSync ? 'flex' : 'none' });
            if (rateFreeRow) setPresentation(rateFreeRow, { display: isSync ? 'none' : 'flex' });

            // On/Off button init
            if (toggleBtn) {
                const enabled = lfoState.enabled !== false;
                lfoState.enabled = enabled;
                toggleBtn.textContent = enabled ? 'On' : 'Off';
                toggleBtn.classList.toggle('is-off', !enabled);
                setToggleButtonPressed(toggleBtn, enabled);
                if (section) {
                    section.classList.toggle('is-bypassed', !enabled);
                }
            }

            if (shapeSelect) {
                shapeSelect.addEventListener('change', () => {
                    globalModulators[`lfo${num}`].shape = shapeSelect.value;
                    updatePlayheads();
                });
            }
            if (syncToggle) {
                syncToggle.addEventListener('change', () => {
                    const activeSync = syncToggle.checked;
                    globalModulators[`lfo${num}`].mode = activeSync ? 'sync' : 'free';
                    if (rateSyncRow) setPresentation(rateSyncRow, { display: activeSync ? 'flex' : 'none' });
                    if (rateFreeRow) setPresentation(rateFreeRow, { display: activeSync ? 'none' : 'flex' });
                    updatePlayheads();
                });
            }
            if (rateSyncSelect) {
                rateSyncSelect.addEventListener('change', () => {
                    globalModulators[`lfo${num}`].syncRate = rateSyncSelect.value;
                    updatePlayheads();
                });
            }
            if (rateFreeSlider) {
                rateFreeSlider.addEventListener('input', () => {
                    const hz = rateFreeSlider.value / 10.0;
                    globalModulators[`lfo${num}`].freeRate = hz;
                    if (rateFreeVal) rateFreeVal.textContent = hz.toFixed(1) + 'Hz';
                    updatePlayheads();
                });
            }
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const active = globalModulators[`lfo${num}`].enabled;
                    const newActive = !active;
                    globalModulators[`lfo${num}`].enabled = newActive;
                    toggleBtn.textContent = newActive ? 'On' : 'Off';
                    toggleBtn.classList.toggle('is-off', !newActive);
                    setToggleButtonPressed(toggleBtn, newActive);
                    if (section) {
                        section.classList.toggle('is-bypassed', !newActive);
                    }
                    updatePlayheads();
                });
            }
        };

        setupLfoControls(1);
        setupLfoControls(2);
        setupLfoControls(3);
        setupLfoControls(4);

        // Setup direct LFO map button listeners
        for (let num = 1; num <= 4; num++) {
            const mapBtn = modulatorsPanel.querySelector(`.lfo${num}-map-btn`);
            if (mapBtn) {
                mapBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (activeLfoMapping === num) {
                        cancelLfoMapping();
                    } else {
                        startLfoMapping(num);
                    }
                });
            }
        }

        // Intercept clicks on mappable parameters when LFO direct mapping is active
        document.addEventListener('click', (e) => {
            if (activeLfoMapping === null) return;

            const el = e.target.closest('.level-knob, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .chorus-rate, .chorus-depth, .chorus-feedback, .phaser-rate, .phaser-depth, .phaser-feedback, .crusher-bits, .crusher-normfreq, #master-volume-slider');
            if (el) {
                e.preventDefault();
                e.stopPropagation();

                let trackId = 'none';
                let paramName = '';

                if (el.id === 'master-volume-slider') {
                    trackId = 'master';
                    paramName = 'level';
                } else {
                    const wrapper = el.closest('.track-wrapper');
                    if (wrapper) {
                        trackId = wrapper.dataset.trackId;
                    }
                    if (el.classList.contains('level-knob')) paramName = 'level';
                    else if (el.classList.contains('pan-knob')) paramName = 'pan';
                    else if (el.classList.contains('filtr-cutoff')) paramName = 'filter';
                    else if (el.classList.contains('aelapse-delay-mix')) paramName = 'space';
                    else if (el.classList.contains('aelapse-reverb-mix')) paramName = 'space';
                    else if (el.classList.contains('chorus-rate')) paramName = 'chorusRate';
                    else if (el.classList.contains('chorus-depth')) paramName = 'chorusDepth';
                    else if (el.classList.contains('chorus-feedback')) paramName = 'chorusFeedback';
                    else if (el.classList.contains('phaser-rate')) paramName = 'phaserRate';
                    else if (el.classList.contains('phaser-depth')) paramName = 'phaserDepth';
                    else if (el.classList.contains('phaser-feedback')) paramName = 'phaserFeedback';
                    else if (el.classList.contains('crusher-bits')) paramName = 'crusherBits';
                    else if (el.classList.contains('crusher-normfreq')) paramName = 'crusherNormfreq';
                }

                if (trackId !== 'none' && paramName !== '') {
                    const lfoSrc = `lfo${activeLfoMapping}`;
                    
                    const existingSlotIdx = modMatrixSlots.findIndex(slot => 
                        slot.src === lfoSrc && 
                        slot.trackId === trackId.toString() && 
                        slot.param === paramName
                    );

                    if (existingSlotIdx !== -1) {
                        modMatrixSlots[existingSlotIdx] = { src: 'none', trackId: 'none', param: 'none', depth: 0 };
                        console.log(`LFO Direct Mapping: Cleared slot ${existingSlotIdx + 1} (${lfoSrc} -> ${trackId} ${paramName})`);
                    } else {
                        let slotIdx = modMatrixSlots.findIndex(slot => slot.src === 'none');
                        if (slotIdx === -1) {
                            slotIdx = 7; // overwrite last slot
                        }
                        modMatrixSlots[slotIdx] = {
                            src: lfoSrc,
                            trackId: trackId.toString(),
                            param: paramName,
                            depth: 50
                        };
                        console.log(`LFO Direct Mapping: Mapped slot ${slotIdx + 1} (${lfoSrc} -> ${trackId} ${paramName} @ 50%)`);
                    }

                    syncModMatrixUI();
                }

                cancelLfoMapping();
            }
        }, true);

        // Cancel direct mapping mode when clicking outside mappable elements
        document.addEventListener('mousedown', (e) => {
            if (activeLfoMapping === null) return;
            const isMapBtn = e.target.closest('.fx-map-btn');
            const isMappable = e.target.closest('.level-knob, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .chorus-rate, .chorus-depth, .chorus-feedback, .phaser-rate, .phaser-depth, .phaser-feedback, .crusher-bits, .crusher-normfreq, #master-volume-slider');
            if (!isMapBtn && !isMappable) {
                cancelLfoMapping();
            }
        });

        const setupEnvControls = (num) => {
            const aSlider = document.getElementById(`env${num}-a`);
            const dSlider = document.getElementById(`env${num}-d`);
            const sSlider = document.getElementById(`env${num}-s`);
            const rSlider = document.getElementById(`env${num}-r`);
            const trigSelect = document.getElementById(`env${num}-trig`);

            if (aSlider) {
                aSlider.addEventListener('input', () => {
                    globalModulators[`env${num}`].a = parseInt(aSlider.value);
                });
            }
            if (dSlider) {
                dSlider.addEventListener('input', () => {
                    globalModulators[`env${num}`].d = parseInt(dSlider.value);
                });
            }
            if (sSlider) {
                sSlider.addEventListener('input', () => {
                    globalModulators[`env${num}`].s = parseInt(sSlider.value);
                });
            }
            if (rSlider) {
                rSlider.addEventListener('input', () => {
                    globalModulators[`env${num}`].r = parseInt(rSlider.value);
                });
            }
            if (trigSelect) {
                trigSelect.addEventListener('change', () => {
                    globalModulators[`env${num}`].trig = trigSelect.value;
                });
            }
        };

        setupEnvControls(1);
        setupEnvControls(2);

        const slots = document.querySelectorAll('.mod-matrix-slot');
        slots.forEach(slotEl => {
            const slotIdx = parseInt(slotEl.dataset.slot);
            const srcSelect = slotEl.querySelector('.mod-src');
            const destTrackSelect = slotEl.querySelector('.mod-dest-track');
            const destParamSelect = slotEl.querySelector('.mod-dest-param');
            const depthSlider = slotEl.querySelector('.mod-depth');
            const depthVal = slotEl.querySelector('.mod-depth-val');

            const updateSlotState = () => {
                modMatrixSlots[slotIdx] = {
                    src: srcSelect ? srcSelect.value : 'none',
                    trackId: destTrackSelect ? destTrackSelect.value : 'none',
                    param: destParamSelect ? destParamSelect.value : 'none',
                    depth: depthSlider ? parseInt(depthSlider.value) : 0
                };
            };

            if (srcSelect) srcSelect.addEventListener('change', updateSlotState);
            if (destTrackSelect) destTrackSelect.addEventListener('change', updateSlotState);
            if (destParamSelect) destParamSelect.addEventListener('change', updateSlotState);
            if (depthSlider) {
                depthSlider.addEventListener('input', () => {
                    const val = parseInt(depthSlider.value);
                    if (depthVal) depthVal.textContent = (val > 0 ? '+' : '') + val;
                    updateSlotState();
                });
            }
        });

        updateModMatrixTracks();
    }

    function updateModMatrixTracks() {
        const destTrackSelects = document.querySelectorAll('.mod-dest-track');
        destTrackSelects.forEach(select => {
            const currentVal = select.value;
            select.innerHTML = '<option value="none">Track...</option><option value="master">Master</option>';

            tracks.forEach((track, idx) => {
                const trackNum = idx + 1;
                const opt = document.createElement('option');
                opt.value = track.id.toString();
                const displayPrompt = track.prompt.length > 20 ? track.prompt.substring(0, 18) + '...' : track.prompt;
                opt.textContent = `T${trackNum}: ${displayPrompt}`;
                select.appendChild(opt);
            });

            const optionExists = Array.from(select.options).some(o => o.value === currentVal);
            if (optionExists) {
                select.value = currentVal;
            } else {
                select.value = 'none';
            }
        });
    }

    function renderArrangerTimeline() {
        const container = document.getElementById('arranger-timeline-container');
        if (!container) return;
        setPresentation(container, { position: 'relative' });

        container.innerHTML = '';
        const numLoops = arrangerLengthLoops;

        const gridEl = document.createElement('div');
        gridEl.className = 'arranger-grid';

        const headerRow = document.createElement('div');
        headerRow.className = 'arranger-row arranger-header-row';

        const spacer = document.createElement('div');
        spacer.className = 'arranger-track-label';
        setPresentation(spacer, { border: 'none' });
        setPresentation(spacer, { background: 'transparent' });
        headerRow.appendChild(spacer);

        const cellsHeader = document.createElement('div');
        cellsHeader.className = 'arranger-cells';
        for (let l = 0; l < numLoops; l++) {
            const cell = document.createElement('div');
            cell.className = 'arranger-cell';
            setPresentation(cell, { border: 'none' });
            setPresentation(cell, { background: 'transparent' });
            setPresentation(cell, { fontSize: '0.6rem' });
            setPresentation(cell, { color: 'var(--text-secondary)' });
            setPresentation(cell, { textAlign: 'center' });
            setPresentation(cell, { lineHeight: '28px' });
            cell.textContent = (l + 1).toString();
            cellsHeader.appendChild(cell);
        }

        // Add visual time bar progress div inside header row (cellsHeader)
        const progressEl = document.createElement('div');
        progressEl.className = 'arranger-time-bar-progress';
        progressEl.id = 'arranger-time-bar-progress';

        const activeDuration = getActiveDuration();
        const currentProgress = activeDuration > 0 ? (isPlaying ? ((audioCtx.currentTime - playStartCtxTime) % activeDuration) : playOffset) / activeDuration : 0;
        setPresentation(progressEl, { width: `${currentProgress * 100}%` });
        cellsHeader.appendChild(progressEl);

        // Add Scrubbing behavior (click and drag to seek playhead)
        let isScrubbing = false;
        function handleScrub(e) {
            const rect = cellsHeader.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            seekTo(pct);
        }
        cellsHeader.addEventListener('mousedown', (e) => {
            isScrubbing = true;
            handleScrub(e);

            const onMouseMove = (moveEvent) => {
                if (isScrubbing) handleScrub(moveEvent);
            };
            const onMouseUp = () => {
                isScrubbing = false;
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            };
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });

        headerRow.appendChild(cellsHeader);
        gridEl.appendChild(headerRow);

        tracks.forEach((track, idx) => {
            const row = document.createElement('div');
            row.className = 'arranger-row';
            row.dataset.trackId = track.id;

            const label = document.createElement('div');
            label.className = 'arranger-track-label';
            const displayPrompt = track.prompt.length > 16 ? track.prompt.substring(0, 14) + '...' : track.prompt;
            label.textContent = `T${idx + 1}: ${displayPrompt}`;
            label.title = track.prompt;
            row.appendChild(label);

            const cells = document.createElement('div');
            cells.className = 'arranger-cells';

            if (!arrangerGrid[track.id]) {
                arrangerGrid[track.id] = new Array(numLoops).fill(true);
            } else if (arrangerGrid[track.id].length !== numLoops) {
                const newArr = new Array(numLoops).fill(true);
                for (let l = 0; l < Math.min(arrangerGrid[track.id].length, numLoops); l++) {
                    newArr[l] = arrangerGrid[track.id][l];
                }
                arrangerGrid[track.id] = newArr;
            }

            const gridArray = arrangerGrid[track.id];

            for (let l = 0; l < numLoops; l++) {
                const cell = document.createElement('div');
                cell.className = 'arranger-cell';
                if (gridArray[l]) {
                    cell.classList.add('active');
                }

                cell.addEventListener('click', () => {
                    gridArray[l] = !gridArray[l];
                    cell.classList.toggle('active', gridArray[l]);
                });

                cells.appendChild(cell);
            }

            row.appendChild(cells);
            gridEl.appendChild(row);
        });

        const playheadWrapper = document.createElement('div');
        setPresentation(playheadWrapper, { position: 'absolute' });
        setPresentation(playheadWrapper, { left: '128px' });
        setPresentation(playheadWrapper, { right: '4px' });
        setPresentation(playheadWrapper, { top: '0' });
        setPresentation(playheadWrapper, { bottom: '0' });
        setPresentation(playheadWrapper, { pointerEvents: 'none' });

        const playhead = document.createElement('div');
        playhead.className = 'arranger-playhead';
        playhead.id = 'arranger-playhead-line';
        setPresentation(playhead, { left: `${currentProgress * 100}%` });
        setPresentation(playhead, { display: arrangerModeActive ? 'block' : 'none' });

        playheadWrapper.appendChild(playhead);
        container.appendChild(gridEl);
        container.appendChild(playheadWrapper);
    }

    function applyArrangerMutingForLoop(loopIndex) {
        const arrangerTimeline = document.getElementById('arranger-timeline-container');
        if (!arrangerTimeline) return;

        arrangerTimeline.querySelectorAll('.arranger-cell').forEach(cell => {
            cell.classList.remove('loop-playing');
        });

        const rows = arrangerTimeline.querySelectorAll('.arranger-row');
        rows.forEach(row => {
            const cellsContainer = row.querySelector('.arranger-cells');
            if (cellsContainer) {
                const cells = cellsContainer.children;
                if (cells && cells[loopIndex]) {
                    cells[loopIndex].classList.add('loop-playing');
                }
            }
        });
    }

    function triggerEnvelopes(source, triggerTime) {
        if (globalModulators.env1.trig === source) {
            globalModulators.env1.active = true;
            globalModulators.env1.triggerTime = triggerTime;
        }
        if (globalModulators.env2.trig === source) {
            globalModulators.env2.active = true;
            globalModulators.env2.triggerTime = triggerTime;
        }
    }

    function updateSliderModDot(track, sliderSelector, normalizedVal) {
        const wrapper = track.wrapper;
        if (!wrapper) return;
        // Called from the 25ms scheduler for every param of every track:
        // cache the per-selector element lookup (including misses) on the track.
        const cache = track._modDotEls || (track._modDotEls = {});
        let slider = cache[sliderSelector];
        if (slider === undefined) {
            slider = cache[sliderSelector] = wrapper.querySelector(sliderSelector);
        }
        if (!slider) return;

        let dot = slider.parentNode.querySelector('.lfo-dot');

        let paramName = '';
        if (sliderSelector === '.level-knob') paramName = 'level';
        else if (sliderSelector === '.filtr-cutoff') paramName = 'filter';
        else if (sliderSelector === '.aelapse-delay-mix') paramName = 'space';
        else if (sliderSelector === '.aelapse-reverb-mix') paramName = 'space';
        else if (sliderSelector === '.chorus-rate') paramName = 'chorusRate';
        else if (sliderSelector === '.chorus-depth') paramName = 'chorusDepth';
        else if (sliderSelector === '.chorus-feedback') paramName = 'chorusFeedback';
        else if (sliderSelector === '.phaser-rate') paramName = 'phaserRate';
        else if (sliderSelector === '.phaser-depth') paramName = 'phaserDepth';
        else if (sliderSelector === '.phaser-feedback') paramName = 'phaserFeedback';
        else if (sliderSelector === '.crusher-bits') paramName = 'crusherBits';
        else if (sliderSelector === '.crusher-normfreq') paramName = 'crusherNormfreq';

        const isMod = isSliderModulated(track.id, paramName);

        if (!isMod) {
            if (dot) setPresentation(dot, { display: 'none' });
            return;
        }

        if (!dot) {
            dot = document.createElement('div');
            dot.className = 'lfo-dot';
            slider.parentNode.appendChild(dot);
            setPresentation(slider.parentNode, { position: 'relative' });
        }

        setPresentation(dot, { display: 'block' });

        if (!dot._cachedDims) {
            dot._cachedDims = {
                sliderWidth: slider.offsetWidth,
                sliderHeight: slider.offsetHeight,
                sliderLeft: slider.offsetLeft,
                sliderTop: slider.offsetTop,
                isKnob: slider.classList.contains('fx-knob') ||
                    slider.classList.contains('fx-mini-knob') ||
                    slider.classList.contains('pan-knob') ||
                    slider.classList.contains('macro-knob') ||
                    slider.classList.contains('fx-macro-knob') ||
                    slider.classList.contains('level-knob')
            };
        }

        const dims = dot._cachedDims;
        let dotLeft, dotTop;
        if (dims.isKnob) {
            dotLeft = dims.sliderLeft + dims.sliderWidth - 4;
            dotTop = dims.sliderTop - 2;
        } else {
            const pct = Math.max(0, Math.min(1, normalizedVal));
            dotLeft = dims.sliderLeft + 6 + pct * (dims.sliderWidth - 12);
            dotTop = dims.sliderTop + dims.sliderHeight / 2;
        }

        setPresentation(dot, { left: `${dotLeft}px` });
        setPresentation(dot, { top: `${dotTop}px` });
    }

    function isSliderModulated(trackId, paramName) {
        const modBypassEl = getModBypassEl();
        const isModBypassed = modBypassEl ? modBypassEl.checked : false;
        if (isModBypassed) return false;

        return modMatrixSlots.some(slot => {
            if (slot.src === 'none' || slot.depth === 0) return false;
            if (slot.src === 'lfo1' && !globalModulators.lfo1.enabled) return false;
            if (slot.src === 'lfo2' && !globalModulators.lfo2.enabled) return false;
            if (slot.src === 'lfo3' && !globalModulators.lfo3.enabled) return false;
            if (slot.src === 'lfo4' && !globalModulators.lfo4.enabled) return false;
            if (slot.src === 'env1' || slot.src === 'env2') return false; // Envelopes are disabled

            return slot.trackId === trackId.toString() &&
                slot.param === paramName;
        });
    }

    // --- Save & Load Project Event Listeners ---
    if (btnSaveProject) {
        btnSaveProject.addEventListener('click', () => {
            saveProject();
        });
    }

    if (btnLoadProject) {
        btnLoadProject.addEventListener('click', () => {
            if (projectFileInput) projectFileInput.click();
        });
    }

    if (projectFileInput) {
        projectFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    loadProject(data);
                } catch (err) {
                    console.error('Project load rejected:', err);
                    const message = `Project not loaded: ${err.message}`;
                    showStatus(message, 'error');
                    alert(message);
                }
            };
            reader.onerror = () => {
                const message = 'Project not loaded: the selected file could not be read';
                showStatus(message, 'error');
                alert(message);
            };
            reader.readAsText(file);
            projectFileInput.value = '';
        });
    }

    // --- Record Mode Event Listeners ---
    if (btnRecord) {
        setToggleButtonPressed(btnRecord, isRecording);
        btnRecord.addEventListener('click', () => {
            isRecording = !isRecording;
            btnRecord.classList.toggle('is-recording', isRecording);
            setToggleButtonPressed(btnRecord, isRecording);
            if (recordLogDrawer) {
                setPresentation(recordLogDrawer, { display: isRecording ? 'block' : 'none' });
            }
            if (isRecording) {
                if (recordLogList) recordLogList.innerHTML = '';
                if (isPlaying) {
                    recordedLoopCounter = 1;
                    captureTrackStates(recordedLoopCounter, 'Start Recording');
                }
            }
        });
    }

    if (btnClearRecordLog) {
        btnClearRecordLog.addEventListener('click', () => {
            if (recordLogList) recordLogList.innerHTML = '';
        });
    }



    // Initialize Master Volume Knob
    const masterVolSlider = document.getElementById('master-volume-slider');
    if (masterVolSlider) {
        initKnob(masterVolSlider, (val) => {
            const p = getMasterFaderParams(val);
            if (audioCtx && masterVolumeNode && masterLimiter) {
                masterVolumeNode.gain.setTargetAtTime(p.volumeGain, audioCtx.currentTime, 0.01);
                masterLimiter.threshold.setTargetAtTime(p.threshold, audioCtx.currentTime, 0.01);
            }
            // Update UI Readouts
            const masterReadout = document.getElementById('master-volume-readout');
            if (masterReadout) {
                if (p.displayDb === -Infinity) {
                    masterReadout.textContent = '-inf dB';
                } else if (p.displayDb === 0) {
                    masterReadout.textContent = '0.0 dB';
                } else {
                    masterReadout.textContent = p.displayDb.toFixed(1) + ' dB';
                }
            }

        }, {
            min: 0,
            max: 100,
            step: 1,
            defaultVal: 91,
            value: 91
        });
        masterVolSlider.value = 91;
    }

    // Initialize Master Filter Controls
    const masterFilterType = document.getElementById('master-filter-type');
    const masterCutoffSlider = document.getElementById('master-cutoff-slider');
    const masterResSlider = document.getElementById('master-res-slider');

    if (masterFilterType) {
        masterFilterType.addEventListener('change', (e) => {
            if (audioCtx && masterFilterNode) {
                masterFilterNode.type = e.target.value;
            }
        });
    }

    if (masterCutoffSlider) {
        initKnob(masterCutoffSlider, (val) => {
            if (audioCtx && masterFilterNode) {
                // Map 0-100 to 20Hz-22000Hz logarithmically
                const minFreq = 20;
                const maxFreq = 22000;
                const logMin = Math.log(minFreq);
                const logMax = Math.log(maxFreq);
                const scale = (logMax - logMin) / 100;
                const freq = Math.exp(logMin + scale * val);
                masterFilterNode.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.01);
            }
        }, { min: 0, max: 100, step: 1, defaultVal: 100, value: 100 });
        masterCutoffSlider.value = 100;
    }

    if (masterResSlider) {
        initKnob(masterResSlider, (val) => {
            if (audioCtx && masterFilterNode) {
                // Map 0-100 to Q 0.1 - 20 logarithmically
                const minQ = 0.1;
                const maxQ = 20;
                const logMin = Math.log(minQ);
                const logMax = Math.log(maxQ);
                const scale = (logMax - logMin) / 100;
                const qVal = Math.exp(logMin + scale * val);
                masterFilterNode.Q.setTargetAtTime(qVal, audioCtx.currentTime, 0.01);
            }
        }, { min: 0, max: 100, step: 1, defaultVal: 30, value: 30 });
        masterResSlider.value = 30; // 30 maps to roughly Q=0.5
    }

    // --- Initialize MIDI and Modulators ---
    initMIDI();
    setupGlobalModulatorsListeners();

    // --- Keyboard Shortcuts Framework ---
    function takeScreenshot() {
        const oldStatusText = statusText ? statusText.textContent : 'Ready';
        const hadVisibleStatus = statusBar?.classList.contains('visible');
        
        if (statusBar) setPresentation(statusBar, { display: 'flex' });
        if (statusText) statusText.textContent = 'Capturing screenshot...';
        
        html2canvas(document.body, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#07070a'
        }).then(canvas => {
            const dataUrl = canvas.toDataURL('image/png');
            
            fetch('/api/screenshot', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ image: dataUrl })
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    if (statusText) statusText.textContent = `Screenshot saved to screenshots/${data.filename}`;
                    console.log('Screenshot saved to', data.path);
                    setTimeout(() => {
                        if (statusBar && !hadVisibleStatus) setHidden(statusBar, true);
                        if (statusText) statusText.textContent = oldStatusText;
                    }, 4000);
                } else {
                    throw new Error(data.error || 'Server error saving screenshot');
                }
            })
            .catch(err => {
                console.error('Error saving screenshot:', err);
                if (statusText) statusText.textContent = `Screenshot failed: ${err.message}`;
                setTimeout(() => {
                    if (statusBar && !hadVisibleStatus) setHidden(statusBar, true);
                    if (statusText) statusText.textContent = oldStatusText;
                }, 4000);
            });
        }).catch(err => {
            console.error('html2canvas capture error:', err);
            if (statusText) statusText.textContent = `Screenshot failed: ${err.message}`;
            setTimeout(() => {
                if (statusBar && !hadVisibleStatus) setHidden(statusBar, true);
                if (statusText) statusText.textContent = oldStatusText;
            }, 4000);
        });
    }

    const KEYBOARD_SHORTCUTS = {
        'KeyP': { desc: 'Take Screenshot', action: () => takeScreenshot() },
        'Space': { desc: 'Play / Pause', action: () => btnPlayPause && btnPlayPause.click() },
        'KeyS': { desc: 'Stop / Rewind', action: () => btnStopAll && btnStopAll.click() },
        'KeyG': { desc: 'Generate Track', action: () => btnGenerate && btnGenerate.click() },
        'KeyN': { desc: 'Randomize Prompt Builder', action: () => promptBuilder.randomizeAll() },
        'KeyH': { desc: 'Toggle Generation History', action: () => document.getElementById('btn-generation-history')?.click() },
        'KeyV': { desc: 'Save Project', action: () => btnSaveProject && btnSaveProject.click() },
        'KeyO': { desc: 'Load Project', action: () => btnLoadProject && btnLoadProject.click() },
        'KeyX': { desc: 'Render Mix', action: () => btnRenderMix && btnRenderMix.click() },
        'KeyE': { desc: 'Export Loops', action: () => btnExportLoops && btnExportLoops.click() },
        'KeyT': { desc: 'Toggle Split Mode', action: () => splitToggle && splitToggle.click() },
        'KeyF': { desc: 'Toggle Song Mode', action: () => {
            const arr = document.getElementById('toggle-arranger');
            if (arr) arr.click();
        }},
        'KeyU': { desc: 'Toggle MIDI Learn', action: () => {
            const ml = document.getElementById('btn-midi-learn');
            if (ml) ml.click();
        }},
        'KeyW': { desc: 'Toggle Modulators Panel', action: () => toggleGlobalModulators() }
    };

    window.addEventListener('keydown', (e) => {
        // Ignore events with modifier keys (to avoid overriding browser commands like Ctrl+S, Ctrl+P, etc.)
        if (e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }

        const active = document.activeElement;
        if (active && (
            active.tagName === 'INPUT' || 
            active.tagName === 'TEXTAREA' || 
            active.tagName === 'SELECT' || 
            active.isContentEditable
        )) {
            return;
        }

        const shortcut = KEYBOARD_SHORTCUTS[e.code];
        if (shortcut) {
            e.preventDefault();
            shortcut.action();
        }
    });

    // --- Keyboard Shortcuts Collapse Toggle ---
    const appFooter = document.getElementById('app-footer');
    const btnToggleFooter = document.getElementById('btn-toggle-footer');
    if (appFooter && btnToggleFooter) {
        let isCollapsed = localStorage.getItem('loopmaster_footer_collapsed') === 'true';
        if (tracks.length === 0) {
            isCollapsed = false; // Force open before the first generation
        }
        appFooter.classList.toggle('is-collapsed', isCollapsed);
        btnToggleFooter.setAttribute('aria-expanded', String(!isCollapsed));

        btnToggleFooter.addEventListener('click', () => {
            const willCollapse = !appFooter.classList.contains('is-collapsed');
            appFooter.classList.toggle('is-collapsed', willCollapse);
            btnToggleFooter.setAttribute('aria-expanded', String(!willCollapse));
            localStorage.setItem('loopmaster_footer_collapsed', willCollapse);
        });
    }

    // Expose dev variables for testing
    window._dev = {
        // Narrow seams for the Electron QA harness. They do not expose the
        // mutable track collection or AudioContext.
        trackEffectGraph: TrackEffectGraph,
        pollGenerationJob: pollJob,
        requestGenerationCancellation: cancelActiveGeneration,
        getGenerationCancellationState: () => activeGenerationJob ? { ...activeGenerationJob } : null,
        openExportModalForQa: () => openExportModal('render'),
        restoreTrackPromptForQa: async ({ prompt, promptSections }) => {
            await promptBuilder.ready;
            clearInitAudio();
            setInitAudio({
                id: 'qa-prompt-restore',
                prompt,
                originalParams: { duration: 8, promptSections },
                variants: [{}],
                el: null
            }, 0, 'qa-prompt-restore.wav', 'QA prompt restore');
            await Promise.resolve();
            const restored = {
                prompt: promptBuilder.currentPrompt(),
                selections: promptBuilder.getSelections()
            };
            clearInitAudio();
            return restored;
        },
        isPlaying: () => isPlaying,
        globalDuration: () => globalDuration,
        getActiveDuration
    };

})();
