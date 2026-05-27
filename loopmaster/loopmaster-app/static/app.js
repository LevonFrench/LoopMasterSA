/* ============================================================
   Stable Audio 3 — Multi-Track Grid Generator
   Simultaneous playback with per-row mixer (solo/mute/pan/level)
   ============================================================ */

(function () {
    'use strict';

    // --- DOM ---
    const promptInput   = document.getElementById('prompt-input');
    const bpmInput      = document.getElementById('bpm-input');
    const btnGenerate   = document.getElementById('btn-generate');
    const statusBar     = document.getElementById('status-bar');
    const statusText    = document.getElementById('status-text');
    const btnPlayPause  = document.getElementById('btn-play-pause');
    const tPosition     = document.getElementById('t-position');
    const tDuration     = document.getElementById('t-duration');
    const btnStopAll    = document.getElementById('btn-stop-all');
    const tracksContainer = document.getElementById('tracks-container');
    const btnRandomPrompt = document.getElementById('btn-random-prompt');
    const btnRandomInKey = document.getElementById('btn-random-in-key');
    const btnChangeChord = document.getElementById('btn-change-chord');
    const btnChangeStyle = document.getElementById('btn-change-style');
    const btnChangeInstrument = document.getElementById('btn-change-instrument');
    const btnRandomDrums = document.getElementById('btn-random-drums');
    const btnRandomBass = document.getElementById('btn-random-bass');
    const btnRandomLead = document.getElementById('btn-random-lead');
    const btnRenderMix = document.getElementById('btn-render-mix');
    const btnExportLoops = document.getElementById('btn-export-loops');

    // --- State ---
    let audioCtx = null;
    let tracks = [];          // array of TrackRow objects
    let isPlaying = false;
    let playStartCtxTime = 0; // audioCtx.currentTime when playback started
    let playOffset = 0;       // seconds into the loop
    let globalDuration = 8;   // updated per BPM
    let generateLoop = true;
    let rafId = null;

    // --- Audio Nodes & Metering State ---
    let masterGain = null;
    let masterLimiter = null;
    let masterMakeup = null;
    let masterVolumeNode = null;
    let masterAnalyser = null;
    let masterMeterState = { rms: -60, peak: -60, peakHold: -60, peakHoldTime: 0 };
    let meterLoopRunning = false;
    let meterRafId = null;
    let copiedFxSettings = null;
    let copiedTrackSettings = null;

    // --- Init Audio & Prompt State ---
    let selectedInitAudio = null; // { trackId, variantIndex, filePath, name }
    let remixMode = 'variation';  // 'variation' | 'inpaint' | 'continuation'
    let currentKeyOrChord = null; // { type: 'key' | 'chord', value: string }

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

    // --- Song Arranger State ---
    let arrangerModeActive = false;
    let arrangerLengthLoops = 32;
    let arrangerGrid = {}; // trackId -> Array(arrangerLengthLoops) of bool


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

    function createSpringImpulseResponse(audioCtx, duration, decay) {
        const sampleRate = audioCtx.sampleRate;
        const len = sampleRate * duration;
        const buffer = audioCtx.createBuffer(2, len, sampleRate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        
        for (let i = 0; i < len; i++) {
            const percent = i / len;
            const envelope = Math.pow(1 - percent, decay);
            const noiseL = Math.random() * 2 - 1;
            const noiseR = Math.random() * 2 - 1;
            const springChirp = Math.sin(i * 0.05 * Math.exp(-percent * 2));
            left[i] = (noiseL * 0.7 + springChirp * 0.3) * envelope;
            right[i] = (noiseR * 0.7 + springChirp * 0.3) * envelope;
        }
        return buffer;
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
        });
    }

    function getMasterFaderParams(sliderVal) {
        const val = sliderVal / 100;
        if (val <= 0.001) {
            return {
                volumeGain: 0.0,
                threshold: -30.0,
                displayDb: -Infinity
            };
        }
        const threshold = (val - 1.0) * 28.889;
        const targetDb = (val - 1.0) * 40.0;
        const autoMakeup = -threshold * 0.95;
        const faderVolumeDb = targetDb - autoMakeup;
        const volumeGain = Math.pow(10, faderVolumeDb / 20);
        return {
            volumeGain: volumeGain,
            threshold: threshold,
            displayDb: targetDb
        };
    }

    function ensureAudioCtx() {
        if (!audioCtx) {
            audioCtx = new AudioContext();
            
            // Create master nodes
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 1.0;

            masterLimiter = audioCtx.createDynamicsCompressor();
            const masterVolSlider = document.getElementById('master-volume-slider');
            const sliderVal = masterVolSlider ? parseInt(masterVolSlider.value) : 100;
            const params = getMasterFaderParams(sliderVal);

            masterLimiter.threshold.setValueAtTime(params.threshold, audioCtx.currentTime);
            masterLimiter.knee.setValueAtTime(0.0, audioCtx.currentTime);
            masterLimiter.ratio.setValueAtTime(20.0, audioCtx.currentTime);
            masterLimiter.attack.setValueAtTime(0.003, audioCtx.currentTime);
            masterLimiter.release.setValueAtTime(0.1, audioCtx.currentTime);

            // Makeup gain set to 1.0 (0 dB) so we don't apply static gain
            masterMakeup = audioCtx.createGain();
            masterMakeup.gain.setValueAtTime(1.0, audioCtx.currentTime);

            masterVolumeNode = audioCtx.createGain();
            masterVolumeNode.gain.setValueAtTime(params.volumeGain, audioCtx.currentTime);

            masterAnalyser = audioCtx.createAnalyser();
            masterAnalyser.fftSize = 1024;

            // Connect master chain: masterGain -> masterLimiter -> masterMakeup -> masterVolumeNode -> masterAnalyser -> destination
            masterGain.connect(masterLimiter);
            masterLimiter.connect(masterMakeup);
            masterMakeup.connect(masterVolumeNode);
            masterVolumeNode.connect(masterAnalyser);
            masterAnalyser.connect(audioCtx.destination);

            // Show master meter section
            const masterMeterSection = document.getElementById('master-meter-section');
            if (masterMeterSection) {
                masterMeterSection.style.display = 'flex';
            }

            // Wire master volume slider
            const masterVolReadout = document.getElementById('master-volume-readout');
            const limiterLabel = document.querySelector('.limiter-label');

            function updateMasterSliderUI(sliderValue) {
                const p = getMasterFaderParams(sliderValue);
                if (masterVolReadout) {
                    if (p.displayDb === -Infinity) {
                        masterVolReadout.textContent = '-inf dB';
                    } else if (p.displayDb === 0) {
                        masterVolReadout.textContent = '0.0 dB';
                    } else {
                        masterVolReadout.textContent = p.displayDb.toFixed(1) + ' dB';
                    }
                }
                if (limiterLabel) {
                    limiterLabel.textContent = 'LIMITER ' + (p.threshold === 0 ? '0.0dB' : p.threshold.toFixed(1) + 'dB');
                }
            }

            if (masterVolSlider) {
                updateMasterSliderUI(sliderVal);
                masterVolSlider.addEventListener('input', () => {
                    const sVal = parseInt(masterVolSlider.value);
                    const p = getMasterFaderParams(sVal);
                    masterVolumeNode.gain.setTargetAtTime(p.volumeGain, audioCtx.currentTime, 0.01);
                    masterLimiter.threshold.setTargetAtTime(p.threshold, audioCtx.currentTime, 0.01);
                    updateMasterSliderUI(sVal);
                });
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
    bpmInput.addEventListener('input', () => {
        updateDurationLabel();
        // Sync BPM into the prompt text if it contains a BPM reference
        const newBpm = bpmInput.value;
        const current = promptInput.value;
        if (/\b\d+\s*bpm\b/i.test(current)) {
            promptInput.value = current.replace(/\b\d+\s*bpm\b/i, newBpm + ' bpm');
        }
    });
    updateDurationLabel();

    // --- Unified drag-or-type for number inputs ---
    // Single click = focus for typing. Drag 3px+ = drag mode.
    function makeDraggableInput(inputEl, { min, max, step, sensitivity }) {
        if (!inputEl) return;
        const DEADZONE = 3;
        let pending = false, activated = false, startY = 0, startVal = 0;

        inputEl.style.cursor = 'ns-resize';

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
                document.body.style.cursor = 'ns-resize';
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
                document.body.style.cursor = '';
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

        startRAF();
    }

    function pauseAll() {
        // Capture current position
        if (audioCtx) {
            const elapsed = audioCtx.currentTime - playStartCtxTime;
            playOffset = elapsed % globalDuration;
        }

        // Stop all sources
        tracks.forEach(t => stopTrackSource(t));

        isPlaying = false;
        btnPlayPause.classList.remove('is-playing');
        btnPlayPause.setAttribute('aria-label', 'Play');
        cancelRAF();
    }

    function stopAll() {
        tracks.forEach(t => stopTrackSource(t));
        playOffset = 0;
        isPlaying = false;
        btnPlayPause.classList.remove('is-playing');
        btnPlayPause.setAttribute('aria-label', 'Play');
        cancelRAF();
        updatePlayheads();
    }

    // --- Undo system ---
    let undoStack = [];
    const btnUndo = document.getElementById('btn-undo');

    function pushUndo(action, data) {
        undoStack.push({ action, data });
        if (btnUndo) btnUndo.style.display = 'inline-flex';
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
            if (btnRenderMix) btnRenderMix.disabled = false;
            // Restore gain level
            t.gainNode.gain.value = t.level;
            updateModMatrixTracks();
            if (arrangerModeActive) renderArrangerTimeline();
            updateMixerState();
            // If playing, start the restored track in sync
            if (isPlaying && audioCtx) {
                const elapsed = audioCtx.currentTime - playStartCtxTime;
                playOffset = elapsed % globalDuration;
                startTrackSource(t);
            }
        }
        if (undoStack.length === 0 && btnUndo) btnUndo.style.display = 'none';
    }

    if (btnUndo) {
        btnUndo.addEventListener('click', performUndo);
        btnUndo.style.display = 'none';
    }

    function deleteTrackRow(track) {
        // Stop playback of this track immediately
        stopTrackSource(track);

        // Mute but DON'T disconnect nodes (allows undo)
        track.gainNode.gain.value = 0;

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
            tracksContainer.innerHTML = `
                <div class="grid-empty-state">
                    <svg viewBox="0 0 24 24"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>
                    <div>Enter a prompt and hit <strong>Generate</strong> OR Hit Random & Generate (Use The Random Buttons to Fill Out Your Arrangement)</div>
                </div>
            `;
            btnPlayPause.disabled = true;
            if (btnRenderMix) btnRenderMix.disabled = true;
            stopAll();
        }
    }

    function startTrackSource(track) {
        stopTrackSource(track);
        if (track.selectedVariant === -1) return;
        const v = track.variants[track.selectedVariant];
        if (!v || !v.buffer) return;

        const ctx = ensureAudioCtx();
        const source = ctx.createBufferSource();
        source.buffer = v.buffer;
        source.loop = track.looping;
        if (track.looping) {
            source.loopStart = 0;
            source.loopEnd = globalDuration;
        }
        source.connect(track.fxInputNode);
        v.sourceNode = source;

        const offset = playOffset % (track.looping ? globalDuration : v.buffer.duration);
        if (track.looping || playOffset < v.buffer.duration) {
            source.start(0, offset);
        }
    }

    function updateTrackLoopState(track) {
        if (track.selectedVariant === -1) return;
        const v = track.variants[track.selectedVariant];
        if (v && v.sourceNode) {
            v.sourceNode.loop = track.looping;
            if (track.looping) {
                v.sourceNode.loopStart = 0;
                v.sourceNode.loopEnd = globalDuration;
            }
        }
    }

    function stopTrackSource(track) {
        if (track.selectedVariant === -1) return;
        const v = track.variants[track.selectedVariant];
        if (v && v.sourceNode) {
            try { v.sourceNode.stop(); } catch (_) {}
            v.sourceNode.disconnect();
            v.sourceNode = null;
        }
    }

    // --- Variant selection (switch which variant plays in a row) ---
    function selectVariant(track, variantIndex) {
        const wasPlaying = isPlaying;

        // If clicking the currently selected variant, deselect it (disable track)
        if (variantIndex === track.selectedVariant) {
            track.variants[variantIndex].el.classList.remove('is-selected');
            if (wasPlaying) stopTrackSource(track);
            track.selectedVariant = -1;

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
                playOffset = (audioCtx.currentTime - playStartCtxTime) % globalDuration;
            }
            startTrackSource(track);
        }
    }

    // --- Seek ---
    function seekTo(pct) {
        const activeDuration = arrangerModeActive ? (arrangerLengthLoops * globalDuration) : globalDuration;
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
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx2d.scale(dpr, dpr);
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
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx2d.scale(dpr, dpr);
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
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx2d.scale(dpr, dpr);
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

    function startRAF() {
        cancelRAF();
        function tick() {
            updatePlayheads();
            
            if (audioCtx) {
                const bpm = parseInt(bpmInput.value) || 120;
                const barDuration = 240.0 / bpm;
                const activeDuration = arrangerModeActive ? (arrangerLengthLoops * globalDuration) : globalDuration;
                
                let currentTime = 0;
                if (isPlaying) {
                    currentTime = (audioCtx.currentTime - playStartCtxTime) % activeDuration;
                } else {
                    currentTime = playOffset % activeDuration;
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
                
                const modBypassEl = document.getElementById('toggle-modulators-bypass');
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
                                modOffsets[tid] = { level: 0, pan: 0, filter: 0, space: 0 };
                            }
                            modOffsets[tid][slot.param] += offset;
                        }
                    });
                }
                
                // Apply offsets to tracks
                tracks.forEach(track => {
                    const offsets = modOffsets[track.id] || { level: 0, pan: 0, filter: 0, space: 0 };
                    
                    // Volume
                    let level = track.level + offsets.level;
                    level = Math.max(0, Math.min(1, level));
                    if (track.gainNode) {
                        track.gainNode.gain.value = level * track._arrangerGate;
                    }
                    updateSliderModDot(track, '.level-slider', level);
                    
                    // Pan
                    let pan = track.pan + offsets.pan * 2.0;
                    pan = Math.max(-1, Math.min(1, pan));
                    if (track.panNode) {
                        track.panNode.pan.value = pan;
                    }
                    const panKnob = track.wrapper.querySelector('.pan-knob');
                    if (panKnob) {
                        const deg = pan * 135;
                        const indicator = panKnob.querySelector('.pan-knob-indicator');
                        if (indicator) indicator.style.transform = `rotate(${deg}deg)`;
                        const panText = track.wrapper.querySelector('.pan-value');
                        const displayVal = Math.round(pan * 100);
                        if (panText) {
                            panText.textContent = displayVal === 0 ? 'C' : displayVal < 0 ? `L${Math.abs(displayVal)}` : `R${displayVal}`;
                        }
                    }
                    
                    // Filter
                    let filterCutoff = track.filtrCutoff + offsets.filter * 15000;
                    filterCutoff = Math.max(20, Math.min(20000, filterCutoff));
                    if (track.filtrFilterNode) {
                        track.filtrFilterNode.frequency.value = filterCutoff;
                    }
                    updateSliderModDot(track, '.filtr-cutoff', (filterCutoff - 20) / 19980);
                    // Space
                    let space = offsets.space;
                    let dMix = Math.max(0, Math.min(1, track.aelapseDelayMix + space));
                    let rMix = Math.max(0, Math.min(1, track.aelapseReverbMix + space));
                    if (track.aelapseDelayGainNode) track.aelapseDelayGainNode.gain.value = dMix;
                    if (track.aelapseReverbGainNode) track.aelapseReverbGainNode.gain.value = rMix;
                    updateSliderModDot(track, '.aelapse-delay-mix', dMix);
                    updateSliderModDot(track, '.aelapse-reverb-mix', rMix);
                });
                
                // Master Volume
                const masterValSlider = document.getElementById('master-volume-slider');
                if (masterVolumeNode && masterValSlider) {
                    const baseVal = parseInt(masterValSlider.value) || 91;
                    const modBaseVal = baseVal + masterOffsets.level * 100;
                    const clampedVal = Math.max(0, Math.min(100, modBaseVal));
                    const p = getMasterFaderParams(clampedVal);
                    masterVolumeNode.gain.value = p.volumeGain;
                    masterLimiter.threshold.value = p.threshold;
                    
                    const masterReadout = document.getElementById('master-volume-readout');
                    if (masterReadout) masterReadout.textContent = `${p.displayDb === -Infinity ? '-inf' : p.displayDb.toFixed(1)} dB`;
                    const limiterLabel = document.querySelector('.limiter-label');
                    if (limiterLabel) limiterLabel.textContent = `LIMITER ${p.threshold.toFixed(1)}dB`;
                }
            }
            
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

    let prevPlayPct = 0;

    function updatePlayheads() {
        let currentTime;
        const bpm = parseInt(bpmInput.value) || 120;
        const activeDuration = arrangerModeActive ? (arrangerLengthLoops * globalDuration) : globalDuration;
        
        if (isPlaying && audioCtx) {
            currentTime = (audioCtx.currentTime - playStartCtxTime) % activeDuration;
        } else {
            currentTime = playOffset % activeDuration;
        }

        const pct = activeDuration > 0 ? currentTime / activeDuration : 0;
        tPosition.textContent = formatTime(currentTime);

        // Detect loop boundary
        if (isPlaying && pct < prevPlayPct - 0.5) {
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

        // Update card playheads
        if (!arrangerModeActive) {
            tracks.forEach(t => {
                t.variants.forEach(v => {
                    const seekBar = v.el.querySelector('.card-seek-bar');
                    if (seekBar) seekBar.style.setProperty('--progress', pct.toString());
                });
            });
        } else {
            tracks.forEach(t => {
                t.variants.forEach(v => {
                    const seekBar = v.el.querySelector('.card-seek-bar');
                    if (seekBar) {
                        const localProgress = (currentTime % globalDuration) / globalDuration;
                        seekBar.style.setProperty('--progress', localProgress.toString());
                    }
                });
            });
            const playheadLine = document.getElementById('arranger-playhead-line');
            if (playheadLine) {
                playheadLine.style.left = `${pct * 100}%`;
            }
            const timeBarProgress = document.getElementById('arranger-time-bar-progress');
            if (timeBarProgress) {
                timeBarProgress.style.width = `${pct * 100}%`;
            }
        }
    }

    // --- Waveform ---
    function drawWaveform(canvas, buffer, isSelected, trackBpm) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = rect.width * dpr;
        const h = rect.height * dpr;
        canvas.width = w;
        canvas.height = h;
        ctx.clearRect(0, 0, w, h);

        if (!buffer || buffer.length === 0) return;

        // Draw visual 1/8th tempo grid behind waveform
        const bpm = trackBpm || (bpmInput ? parseInt(bpmInput.value) : 120);
        const duration = buffer.duration;
        const eighthNoteDuration = 30 / bpm;
        const numEighthNotes = Math.round(duration / eighthNoteDuration);

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
        const samples = data.length;
        const barCount = Math.max(1, Math.floor(w / 2.5));
        const samplesPerBar = Math.floor(samples / barCount);

        // First pass: compute per-bar peaks and find the global max
        const peaks = new Float32Array(barCount);
        let globalPeak = 0;
        for (let i = 0; i < barCount; i++) {
            let max = 0;
            const start = i * samplesPerBar;
            const end = Math.min(start + samplesPerBar, samples);
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
        if (track.aelapseEnabled) {
            const delayMix = track.aelapseDelayMix;
            const reverbMix = track.aelapseReverbMix;
            track.aelapseDelayGainNode.gain.setTargetAtTime(delayMix, ctx.currentTime, 0.01);
            track.aelapseReverbGainNode.gain.setTargetAtTime(reverbMix, ctx.currentTime, 0.01);
            track.aelapseDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
        } else {
            track.aelapseDelayGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
            track.aelapseReverbGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
            track.aelapseDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
        }
    }

    function updateFiltrBypass(track) {
        const ctx = ensureAudioCtx();
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
        if (track.screamEnabled) {
            const mix = track.screamMix;
            track.screamDryGainNode.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.01);
            track.screamWetGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
        } else {
            track.screamDryGainNode.gain.setTargetAtTime(1.0, ctx.currentTime, 0.01);
            track.screamWetGainNode.gain.setTargetAtTime(0.0, ctx.currentTime, 0.01);
        }
    }

    function updateTrackLockState(track) {
        const isLocked = !!track.locked;
        
        // Disable/enable mixer sliders
        const levelSlider = track.el.querySelector('.level-slider');
        const panKnobEl = track.el.querySelector('.pan-knob');
        if (levelSlider) levelSlider.disabled = isLocked;
        if (panKnobEl) panKnobEl.style.pointerEvents = isLocked ? 'none' : '';
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

    // --- Create a track row ---
    function createTrackRow(prompt, batchFiles, trackNum) {
        const ctx = ensureAudioCtx();
        const id = trackNum;
        const macroKnobState = {};
        const fxMacroState = {};

        // 1. Core Web Audio Nodes
        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.5;

        const panNode = ctx.createStereoPanner();
        panNode.pan.value = 0;
        panNode.connect(gainNode);

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

        // 2. DSP Chain Stage A0: Filtr (Multi-type filter)
        const filtrFilter = ctx.createBiquadFilter();
        filtrFilter.type = 'lowpass';
        filtrFilter.frequency.value = 20000;
        filtrFilter.Q.value = 0.707;

        const filtrDryGain = ctx.createGain();
        filtrDryGain.gain.value = 1.0;
        const filtrWetGain = ctx.createGain();
        filtrWetGain.gain.value = 0.0; // dry by default
        const filtrSum = ctx.createGain();
        const filtrInputNode = ctx.createGain();
        filtrInputNode.gain.value = 1.0;

        filtrInputNode.connect(filtrDryGain);
        filtrDryGain.connect(filtrSum);

        filtrInputNode.connect(filtrFilter);
        filtrFilter.connect(filtrWetGain);
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

        // 4. DSP Chain Stage C: Aelapse Delay & Spring Reverb (SEND EFFECT setup)
        const aelapseDryGain = ctx.createGain();
        aelapseDryGain.gain.value = 1.0; // Dry path always 1.0
        
        const aelapseDelay = ctx.createDelay(5.0);
        aelapseDelay.delayTime.value = 0.3;
        
        const aelapseFeedbackNode = ctx.createGain();
        aelapseFeedbackNode.gain.value = 0.3;
        
        const aelapseDelayGain = ctx.createGain();
        aelapseDelayGain.gain.value = 0.0; // mix 0%
        
        // Wow/flutter drift LFO modulation
        const aelapseLFO = ctx.createOscillator();
        aelapseLFO.frequency.value = 2.0;
        const aelapseLFOGain = ctx.createGain();
        aelapseLFOGain.gain.value = 0.002;
        aelapseLFO.connect(aelapseLFOGain);
        aelapseLFOGain.connect(aelapseDelay.delayTime);
        aelapseLFO.start();
        
        // Spring Reverb
        const aelapseReverb = ctx.createConvolver();
        aelapseReverb.buffer = createSpringImpulseResponse(ctx, 2.0, 2.5);
        
        const aelapseReverbGain = ctx.createGain();
        aelapseReverbGain.gain.value = 0.0; // mix 0%
        
        const sendSumGain = ctx.createGain();
        
        screamSum.connect(aelapseDryGain);
        aelapseDryGain.connect(sendSumGain);
        
        screamSum.connect(aelapseDelay);
        aelapseDelay.connect(aelapseFeedbackNode);
        aelapseFeedbackNode.connect(aelapseDelay);
        aelapseDelay.connect(aelapseDelayGain);
        aelapseDelayGain.connect(sendSumGain);
        
        screamSum.connect(aelapseReverb);
        aelapseReverb.connect(aelapseReverbGain);
        aelapseReverbGain.connect(sendSumGain);

        const fxOutputNode = sendSumGain;

        // Connect final DSP output to pan node
        fxOutputNode.connect(panNode);

        const currentBpm = parseInt(bpmInput.value) || 120;
        const initialDelayTime = 45.0 / currentBpm;
        aelapseDelay.delayTime.value = initialDelayTime;

        // 5. Track State
        const track = {
            id,
            prompt,
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
            level: 0.5,
            pan: 0,
            selectedVariant: 0,
            variants: [],
            
            locked: false,
            _arrangerGate: 1.0,
            _targetGate: 1.0,
            filtrEnabled: false,
            screamEnabled: false,
            eqEnabled: true,
            aelapseEnabled: true,
            filtrDryGainNode: filtrDryGain,
            filtrWetGainNode: filtrWetGain,
            filtrFilterNode: filtrFilter,
            screamDryGainNode: screamDryGain,
            screamWetGainNode: screamWetGain,
            screamFilterNode: screamFilter,
            screamShaperNode: screamShaper,
            eqDryGainNode: eqDry,
            eqWetGainNode: eqWet,
            aelapseDryGainNode: aelapseDryGain,
            aelapseDelayGainNode: aelapseDelayGain,
            aelapseReverbGainNode: aelapseReverbGain,
            
            // FX state values for offline rendering
            filtrType: 'lowpass',
            filtrCutoff: 20000,
            filtrResonance: 0.707,
            filtrMix: 1.0,
            screamCutoff: 8000,
            screamAmount: 0.707,
            screamDriveAmount: 5,
            screamMix: 1.0,
            eqGains: [0, 0, 0, 0, 0, 0],
            aelapseDelayTime: initialDelayTime,
            aelapseFeedback: 0.3,
            aelapseDelayMix: 0.0,
            aelapseReverbMix: 0.0,
            aelapseReverbSize: 2.0,
            delaySyncIndex: 3
        };

        // 6. Build wrapper container
        const wrapperEl = document.createElement('div');
        wrapperEl.className = 'track-wrapper';

        // 7. Build track-row DOM
        const rowEl = document.createElement('div');
        rowEl.className = 'track-row';

        const mixerEl = document.createElement('div');
        mixerEl.className = 'mixer-strip';
        mixerEl.innerHTML = `
            <div class="mixer-label" title="${prompt}">${prompt}</div>
            <div class="mixer-buttons">
                <button class="mixer-btn solo-btn" title="Solo">S</button>
                <button class="mixer-btn mute-btn" title="Mute">M</button>
                <button class="mixer-btn fx-btn" title="Toggle FX Drawer">FX</button>
                <button class="mixer-btn regen-btn" title="Regenerate Unlocked"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
                <button class="mixer-btn copy-track-btn" title="Copy Track Settings"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                <button class="mixer-btn paste-track-btn" title="Paste Track Settings"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg></button>
                <button class="mixer-btn delete-btn" title="Delete Track"><svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            </div>
            <div class="mixer-vol-pan">
                <div class="mixer-level">
                    <label>Vol</label>
                    <input type="range" class="level-slider" min="0" max="100" value="50" step="1">
                    <span class="level-value">50</span>
                </div>
                <div class="mixer-pan">
                    <div class="pan-knob" title="Pan: C">
                        <div class="pan-knob-indicator"></div>
                    </div>
                    <span class="pan-value">C</span>
                </div>
            </div>
            <div class="mixer-macros-row">
                <div class="macro-knob-group"><div class="macro-knob" data-param="filter" title="Filter: Off"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Flt</span></div>
                <div class="macro-knob-group"><div class="macro-knob" data-param="reso" title="Reso: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Res</span></div>
                <div class="macro-knob-group"><div class="macro-knob" data-param="tone" title="Tone: Flat"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Tone</span></div>
                <div class="macro-knob-group"><div class="macro-knob" data-param="dlyMix" title="Delay Mix: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">DMx</span></div>
                <div class="macro-knob-group"><div class="macro-knob" data-param="revSize" title="Reverb Size: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">RSz</span></div>
                <div class="macro-knob-group"><div class="macro-knob" data-param="revMix" title="Reverb Mix: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">RMx</span></div>
            </div>
            <div class="mixer-meter">
                <canvas class="meter-canvas" height="6"></canvas>
            </div>
        `;
        rowEl.appendChild(mixerEl);
        track.meterCanvas = mixerEl.querySelector('.meter-canvas');

        // 8. Build FX Drawer DOM
        const fxDrawerEl = document.createElement('div');
        fxDrawerEl.className = 'fx-drawer';
        fxDrawerEl.style.display = 'none';
        fxDrawerEl.innerHTML = `
            <div class="fx-section macros-section">
                <div class="fx-section-title" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <span>Macro Controls</span>
                    <div class="fx-clipboard-btns" style="display: flex; gap: 6px;">
                        <button class="fx-copy-btn" type="button" style="padding: 2px 6px; font-size: 0.65rem; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid var(--border-input); color: var(--text-primary); cursor: pointer; transition: all 0.15s ease;" title="Copy FX Settings">Copy FX</button>
                        <button class="fx-paste-btn" type="button" style="padding: 2px 6px; font-size: 0.65rem; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid var(--border-input); color: var(--text-primary); cursor: pointer; transition: all 0.15s ease;" title="Paste FX Settings">Paste FX</button>
                    </div>
                </div>
                <div class="fx-macro-knobs-row">
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="space" title="Space: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Space</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="drive" title="Drive: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Drive</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="tone" title="Tone: Flat"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Tone</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="filter" title="Filter: Off"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Filter</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="reso" title="Reso: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Reso</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="delay" title="Delay: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Delay</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="feedback" title="Feedback: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Feedbk</span></div>
                    <div class="macro-knob-group"><div class="fx-macro-knob" data-macro="crush" title="Crush: 0%"><div class="macro-knob-indicator"></div></div><span class="macro-knob-label">Crush</span></div>
                </div>
            </div>
            <div class="fx-section filtr-section">
                <div class="fx-section-title">
                    <span>Filtr Filter</span>
                    <button class="fx-toggle-btn filtr-toggle" type="button">Off</button>
                </div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Type</label><select class="filtr-type" style="flex:1; height:20px; font-size:0.65rem; background:var(--bg-input); color:var(--text-primary); border:1px solid var(--border-input); border-radius:3px;"><option value="lowpass">LP</option><option value="bandpass">BP</option><option value="highpass">HP</option><option value="notch">Notch</option></select></div>
                    <div class="fx-control-row"><label>Cutoff</label><input type="range" class="filtr-cutoff" min="20" max="20000" value="20000" step="1"><span class="filtr-cutoff-val">20kHz</span></div>
                    <div class="fx-control-row"><label>Reso</label><input type="range" class="filtr-reso" min="1" max="250" value="7" step="1"><span class="filtr-reso-val">0.7</span></div>
                    <div class="fx-control-row"><label>Mix</label><input type="range" class="filtr-mix" min="0" max="100" value="100" step="1"><span class="filtr-mix-val">100%</span></div>
                </div>
            </div>
            <div class="fx-section scream-section">
                <div class="fx-section-title">
                    <span>Scream Distortion</span>
                    <button class="fx-toggle-btn scream-toggle" type="button">Off</button>
                </div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Cutoff</label><input type="range" class="scream-cutoff" min="200" max="16000" value="8000" step="1"><span class="scream-cutoff-val">8.0kHz</span></div>
                    <div class="fx-control-row"><label>Scream</label><input type="range" class="scream-amount" min="0" max="100" value="0" step="1"><span class="scream-amount-val">0%</span></div>
                    <div class="fx-control-row"><label>Mix</label><input type="range" class="scream-mix" min="0" max="100" value="100" step="1"><span class="scream-mix-val">100%</span></div>
                </div>
            </div>
            <div class="fx-section eq-section">
                <div class="fx-section-title">
                    <span>Luftikus Analog EQ</span>
                    <button class="fx-toggle-btn eq-toggle" type="button">On</button>
                </div>
                <div class="fx-controls-grid eq-sliders-grid">
                    <div class="fx-control-row"><label>10 Hz</label><input type="range" class="eq-slider" data-band="0" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>40 Hz</label><input type="range" class="eq-slider" data-band="1" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>160 Hz</label><input type="range" class="eq-slider" data-band="2" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>640 Hz</label><input type="range" class="eq-slider" data-band="3" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>2.5 kHz</label><input type="range" class="eq-slider" data-band="4" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>Air Band</label><input type="range" class="eq-slider" data-band="5" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                </div>
            </div>

            <div class="fx-section aelapse-section">
                <div class="fx-section-title">
                    <span>Ælapse Tape Delay & Spring Reverb</span>
                    <button class="fx-toggle-btn aelapse-toggle" type="button">On</button>
                </div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Sync</label><input type="range" class="aelapse-sync" min="0" max="8" value="2" step="1"><span class="aelapse-sync-val">1/8</span></div>
                    <div class="fx-control-row"><label>Feedback</label><input type="range" class="aelapse-feedback" min="0" max="95" value="30" step="5"><span class="aelapse-fb-val">30%</span></div>
                    <div class="fx-control-row"><label>Delay Mix</label><input type="range" class="aelapse-mix" min="0" max="100" value="0" step="5"><span class="aelapse-mix-val">0%</span></div>
                    <div class="fx-control-row"><label>Reverb Size</label><input type="range" class="aelapse-size" min="5" max="50" value="20" step="1"><span class="aelapse-size-val">2.0s</span></div>
                    <div class="fx-control-row"><label>Reverb Mix</label><input type="range" class="aelapse-reverb-mix" min="0" max="100" value="0" step="5"><span class="aelapse-reverb-val">0%</span></div>
                </div>
            </div>
        `;

        // 9. Wire mixer control event listeners
        const soloBtn = mixerEl.querySelector('.solo-btn');
        const muteBtn = mixerEl.querySelector('.mute-btn');
        const fxBtn = mixerEl.querySelector('.fx-btn');
        const copyTrackBtn = mixerEl.querySelector('.copy-track-btn');
        const pasteTrackBtn = mixerEl.querySelector('.paste-track-btn');
        const deleteBtn = mixerEl.querySelector('.delete-btn');
        const levelSlider = mixerEl.querySelector('.level-slider');
        const levelValue = mixerEl.querySelector('.level-value');
        const panKnob = mixerEl.querySelector('.pan-knob');
        const panValue = mixerEl.querySelector('.pan-value');

        soloBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.soloed = !track.soloed;
            soloBtn.classList.toggle('is-on', track.soloed);
            updateMixerState();
        });

        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.muted = !track.muted;
            muteBtn.classList.toggle('is-on', track.muted);
            updateMixerState();
        });



        fxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = fxDrawerEl.style.display !== 'none';
            fxDrawerEl.style.display = isOpen ? 'none' : 'flex';
            fxBtn.classList.toggle('is-on', !isOpen);
        });

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
                        aelapseEnabled: track.aelapseEnabled,
                        
                        filtrType: fxDrawerEl.querySelector('.filtr-type').value,
                        filtrCutoff: fxDrawerEl.querySelector('.filtr-cutoff').value,
                        filtrReso: fxDrawerEl.querySelector('.filtr-reso').value,
                        filtrMix: fxDrawerEl.querySelector('.filtr-mix').value,
                        
                        screamCutoff: fxDrawerEl.querySelector('.scream-cutoff').value,
                        screamAmount: fxDrawerEl.querySelector('.scream-amount').value,
                        screamMix: fxDrawerEl.querySelector('.scream-mix').value,
                        
                        eqGains: Array.from(fxDrawerEl.querySelectorAll('.eq-slider')).map(s => s.value),
                        
                        aelapseSync: fxDrawerEl.querySelector('.aelapse-sync').value,
                        aelapseFeedback: fxDrawerEl.querySelector('.aelapse-feedback').value,
                        aelapseMix: fxDrawerEl.querySelector('.aelapse-mix').value,
                        aelapseSize: fxDrawerEl.querySelector('.aelapse-size').value,
                        aelapseReverbMix: fxDrawerEl.querySelector('.aelapse-reverb-mix').value,

                        macros: {
                            space: fxMacroState.space ? fxMacroState.space.value : 0,
                            drive: fxMacroState.drive ? fxMacroState.drive.value : 0,
                            tone: fxMacroState.tone ? fxMacroState.tone.value : 50,
                            filter: fxMacroState.filter ? fxMacroState.filter.value : 50,
                            reso: fxMacroState.reso ? fxMacroState.reso.value : 0,
                            delay: fxMacroState.delay ? fxMacroState.delay.value : 0,
                            feedback: fxMacroState.feedback ? fxMacroState.feedback.value : 0,
                            crush: fxMacroState.crush ? fxMacroState.crush.value : 0,
                        }
                    }
                };

                const originalColor = copyTrackBtn.style.color;
                copyTrackBtn.style.color = '#10b981'; // Green accent
                setTimeout(() => { copyTrackBtn.style.color = originalColor; }, 1000);
            });
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
                levelSlider.value = Math.round(settings.level * 100);
                levelValue.textContent = levelSlider.value;
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
                const fx = settings.fxSettings;
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
                track.aelapseEnabled = fx.aelapseEnabled;
                const aeToggleBtn = fxDrawerEl.querySelector('.aelapse-toggle');
                if (aeToggleBtn) {
                    aeToggleBtn.textContent = track.aelapseEnabled ? 'On' : 'Bypass';
                    aeToggleBtn.classList.toggle('is-off', !track.aelapseEnabled);
                }
                const aeSection = fxDrawerEl.querySelector('.aelapse-section');
                if (aeSection) {
                    aeSection.classList.toggle('is-bypassed', !track.aelapseEnabled);
                }
                updateAelapseBypass(track);

                const typeSelect = fxDrawerEl.querySelector('.filtr-type');
                if (typeSelect) {
                    typeSelect.value = fx.filtrType;
                    typeSelect.dispatchEvent(new Event('change'));
                }

                const sliders = {
                    '.filtr-cutoff': fx.filtrCutoff,
                    '.filtr-reso': fx.filtrReso,
                    '.filtr-mix': fx.filtrMix,
                    '.scream-cutoff': fx.screamCutoff,
                    '.scream-amount': fx.screamAmount,
                    '.scream-mix': fx.screamMix,
                    '.aelapse-sync': fx.aelapseSync,
                    '.aelapse-feedback': fx.aelapseFeedback,
                    '.aelapse-mix': fx.aelapseMix,
                    '.aelapse-size': fx.aelapseSize,
                    '.aelapse-reverb-mix': fx.aelapseReverbMix,
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

                const originalColor = pasteTrackBtn.style.color;
                pasteTrackBtn.style.color = '#10b981'; // Green accent
                setTimeout(() => { pasteTrackBtn.style.color = originalColor; }, 1000);
            });
        }

        const regenBtn = mixerEl.querySelector('.regen-btn');
        if (regenBtn) {
            regenBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (track.locked) return;
                
                const unlockedVariants = track.variants.filter(v => !v.locked);
                if (unlockedVariants.length === 0) {
                    showStatus('No variants are unlocked to regenerate!', 'error');
                    return;
                }
                
                const N = unlockedVariants.length;
                showStatus('GENERATING');
                
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
                        duration_padding_sec: 6.0,
                        loop: true
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
                    const result = await pollJob(job_id);
                    if (result.status === 'error') throw new Error(result.error || 'Failed');
                    
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
                    console.error('Regeneration failed:', err);
                    showStatus(`Regeneration failed: ${err.message}`, 'error');
                    unlockedVariants.forEach(v => {
                        v.el.classList.remove('is-loading');
                        const titleEl = v.el.querySelector('.card-title');
                        if (titleEl) titleEl.textContent = v.name;
                    });
                } finally {
                    regenBtn.disabled = false;
                    regenBtn.classList.remove('is-generating');
                }
            });
        }

        levelSlider.addEventListener('input', () => {
            track.level = parseInt(levelSlider.value) / 100;
            levelValue.textContent = levelSlider.value;
            updateMixerState();
        });

        // Pan knob drag interaction
        function updatePanKnob(panVal) {
            track.pan = panVal / 100;
            track.panNode.pan.value = track.pan;
            const deg = (panVal / 100) * 135; // -135 to +135
            panKnob.querySelector('.pan-knob-indicator').style.transform = `rotate(${deg}deg)`;
            panKnob.title = `Pan: ${panVal === 0 ? 'C' : panVal < 0 ? 'L' + Math.abs(panVal) : 'R' + panVal}`;
            panValue.textContent = panVal === 0 ? 'C' : panVal < 0 ? `L${Math.abs(panVal)}` : `R${panVal}`;
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
            document.body.style.cursor = 'ns-resize';
        });

        document.addEventListener('mousemove', (e) => {
            if (!panDragging) return;
            const delta = panStartY - e.clientY; // up = right
            const newVal = Math.max(-100, Math.min(100, panStartVal + delta));
            updatePanKnob(newVal);
        });

        document.addEventListener('mouseup', () => {
            if (panDragging) {
                panDragging = false;
                document.body.style.cursor = '';
            }
        });

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
            const indicator = knobEl.querySelector('.macro-knob-indicator');
            const ctx = ensureAudioCtx();

            if (param === 'filter') {
                // Bipolar: -100 to +100. Left = LP (cutoff sweeps down), Right = HP (cutoff sweeps up)
                const deg = (value / 100) * 135;
                indicator.style.transform = `rotate(${deg}deg)`;
                if (value === 0) {
                    knobEl.title = 'Filter: Off';
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
                        knobEl.title = `LP: ${cutoff >= 1000 ? (cutoff/1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
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
                        knobEl.title = `HP: ${cutoff >= 1000 ? (cutoff/1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    }
                }
            } else {
                // Unipolar 0-100
                const deg = -135 + (value / 100) * 270;
                indicator.style.transform = `rotate(${deg}deg)`;

                if (param === 'reso') {
                    const q = 0.707 + (value / 100) * 24.293;
                    track.filtrResonance = q;
                    track.filtrFilterNode.Q.setTargetAtTime(q, ctx.currentTime, 0.02);
                    knobEl.title = `Reso: ${value}%`;
                } else if (param === 'tone') {
                    if (value === 50) {
                        knobEl.title = 'Tone: Flat';
                    } else if (value < 50) {
                        knobEl.title = 'Tone: Dark';
                    } else {
                        knobEl.title = 'Tone: Bright';
                    }
                    // Push to EQ sliders
                    const eqSlidersList = track.wrapper.querySelectorAll('.eq-slider');
                    if (eqSlidersList.length === 6) {
                        let bandGains = [0, 0, 0, 0, 0, 0];
                        if (value < 50) {
                            const factor = (50 - value) / 50;
                            bandGains = [6.0 * factor, 6.0 * factor, 4.0 * factor, 0, -6.0 * factor, -6.0 * factor];
                        } else if (value > 50) {
                            const factor = (value - 50) / 50;
                            bandGains = [-6.0 * factor, -6.0 * factor, -3.0 * factor, 0, 6.0 * factor, 8.0 * factor];
                        }
                        eqSlidersList.forEach((slider, b) => {
                            slider.value = bandGains[b];
                            slider.dispatchEvent(new Event('input'));
                        });
                    }
                } else if (param === 'dlyMix') {
                    const mix = value / 100;
                    track.aelapseDelayMix = mix;
                    if (!track.aelapseEnabled && value > 0) {
                        const toggle = track.wrapper.querySelector('.aelapse-toggle');
                        if (toggle) toggle.click();
                    }
                    track.aelapseDelayGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
                    knobEl.title = `Delay Mix: ${value}%`;
                } else if (param === 'revSize') {
                    const size = 0.5 + (value / 100) * 4.5; // 0.5s to 5.0s
                    track.aelapseReverbSize = size;
                    try {
                        track.aelapseReverbNode.buffer = createSpringImpulseResponse(ctx, size, 2.5);
                    } catch(e) {}
                    knobEl.title = `Rev Size: ${size.toFixed(1)}s`;
                } else if (param === 'revMix') {
                    const mix = value / 100;
                    track.aelapseReverbMix = mix;
                    if (!track.aelapseEnabled && value > 0) {
                        const toggle = track.wrapper.querySelector('.aelapse-toggle');
                        if (toggle) toggle.click();
                    }
                    track.aelapseReverbGainNode.gain.setTargetAtTime(mix, ctx.currentTime, 0.01);
                    knobEl.title = `Rev Mix: ${value}%`;
                }
            }
        }

        macroKnobs.forEach(knobEl => {
            const param = knobEl.dataset.param;
            const isBipolar = param === 'filter';
            const defaultVal = param === 'tone' ? 50 : 0;
            macroKnobState[param] = { value: defaultVal, dragging: false, startY: 0, startVal: 0 };

            knobEl.addEventListener('mousedown', (e) => {
                if (track.locked) return;
                e.preventDefault();
                e.stopPropagation();
                const st = macroKnobState[param];
                st.dragging = true;
                st.startY = e.clientY;
                st.startVal = st.value;
                document.body.style.cursor = 'ns-resize';
            });

            document.addEventListener('mousemove', (e) => {
                const st = macroKnobState[param];
                if (!st.dragging) return;
                const delta = st.startY - e.clientY;
                const min = isBipolar ? -100 : 0;
                const max = 100;
                const newVal = Math.max(min, Math.min(max, st.startVal + delta));
                st.value = newVal;
                applyMacroKnob(param, newVal);
            });

            document.addEventListener('mouseup', () => {
                const st = macroKnobState[param];
                if (st.dragging) {
                    st.dragging = false;
                    document.body.style.cursor = '';
                }
            });

            knobEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (track.locked) return;
                macroKnobState[param].value = defaultVal;
                applyMacroKnob(param, defaultVal);
            });

            // Init indicator position
            if (isBipolar) {
                knobEl.querySelector('.macro-knob-indicator').style.transform = 'rotate(0deg)';
            } else {
                const initDeg = -135 + (defaultVal / 100) * 270;
                knobEl.querySelector('.macro-knob-indicator').style.transform = `rotate(${initDeg}deg)`;
            }
        });

        // Stash feedback node ref for macro knob access
        track.__aelapseFbNode = aelapseFeedbackNode;

        // 10. Wire FX drawer slider event listeners
        const eqSliders = fxDrawerEl.querySelectorAll('.eq-slider');
        const eqVals = fxDrawerEl.querySelectorAll('.eq-val');
        eqSliders.forEach((slider, b) => {
            slider.addEventListener('input', () => {
                const val = parseFloat(slider.value);
                eqVals[b].textContent = (val >= 0 ? '+' : '') + val.toFixed(1) + 'dB';
                track.eqGains[b] = val;
                eqFilters[b].gain.value = val;
            });
        });

        // Wire Filtr controls
        const filtrTypeSelect = fxDrawerEl.querySelector('.filtr-type');
        filtrTypeSelect.addEventListener('change', () => {
            track.filtrType = filtrTypeSelect.value;
            filtrFilter.type = filtrTypeSelect.value;
        });

        const filtrCutoffSlider = fxDrawerEl.querySelector('.filtr-cutoff');
        const filtrCutoffVal = fxDrawerEl.querySelector('.filtr-cutoff-val');
        filtrCutoffSlider.addEventListener('input', () => {
            const val = parseFloat(filtrCutoffSlider.value);
            filtrCutoffVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.filtrCutoff = val;
            filtrFilter.frequency.value = val;
        });

        const filtrResoSlider = fxDrawerEl.querySelector('.filtr-reso');
        const filtrResoVal = fxDrawerEl.querySelector('.filtr-reso-val');
        filtrResoSlider.addEventListener('input', () => {
            const val = parseFloat(filtrResoSlider.value) / 10;
            filtrResoVal.textContent = val.toFixed(1);
            track.filtrResonance = val;
            filtrFilter.Q.value = val;
        });

        const filtrMixSlider = fxDrawerEl.querySelector('.filtr-mix');
        const filtrMixVal = fxDrawerEl.querySelector('.filtr-mix-val');
        filtrMixSlider.addEventListener('input', () => {
            const pct = parseFloat(filtrMixSlider.value) / 100;
            filtrMixVal.textContent = filtrMixSlider.value + '%';
            track.filtrMix = pct;
            updateFiltrBypass(track);
        });

        // Wire Scream controls
        const screamCutoffSlider = fxDrawerEl.querySelector('.scream-cutoff');
        const screamCutoffVal = fxDrawerEl.querySelector('.scream-cutoff-val');
        screamCutoffSlider.addEventListener('input', () => {
            const val = parseFloat(screamCutoffSlider.value);
            screamCutoffVal.textContent = val >= 1000 ? (val / 1000).toFixed(1) + 'kHz' : val + 'Hz';
            track.screamCutoff = val;
            screamFilter.frequency.value = val;
        });

        const screamAmountSlider = fxDrawerEl.querySelector('.scream-amount');
        const screamAmountVal = fxDrawerEl.querySelector('.scream-amount-val');
        screamAmountSlider.addEventListener('input', () => {
            const pct = parseFloat(screamAmountSlider.value);
            screamAmountVal.textContent = pct + '%';
            // Map 0-100% to Q 0.707-25 and drive 5-80
            const q = 0.707 + (24.293 * pct / 100);
            const drive = 5 + (75 * pct / 100);
            track.screamAmount = q;
            track.screamDriveAmount = drive;
            screamFilter.Q.value = q;
            screamShaper.curve = makeDistortionCurve(drive);
        });

        const screamMixSlider = fxDrawerEl.querySelector('.scream-mix');
        const screamMixVal = fxDrawerEl.querySelector('.scream-mix-val');
        screamMixSlider.addEventListener('input', () => {
            const pct = parseFloat(screamMixSlider.value) / 100;
            screamMixVal.textContent = screamMixSlider.value + '%';
            track.screamMix = pct;
            updateScreamBypass(track);
        });



        const aeFeedback = fxDrawerEl.querySelector('.aelapse-feedback');
        const aeFbVal = fxDrawerEl.querySelector('.aelapse-fb-val');
        aeFeedback.addEventListener('input', () => {
            const pct = parseFloat(aeFeedback.value) / 100;
            aeFbVal.textContent = aeFeedback.value + '%';
            track.aelapseFeedback = pct;
            aelapseFeedbackNode.gain.value = pct;
        });

        const aeMix = fxDrawerEl.querySelector('.aelapse-mix');
        const aeMixVal = fxDrawerEl.querySelector('.aelapse-mix-val');
        aeMix.addEventListener('input', () => {
            const pct = parseFloat(aeMix.value) / 100;
            aeMixVal.textContent = aeMix.value + '%';
            track.aelapseDelayMix = pct;
            updateAelapseBypass(track);
        });

        const aeSize = fxDrawerEl.querySelector('.aelapse-size');
        const aeSizeVal = fxDrawerEl.querySelector('.aelapse-size-val');
        aeSize.addEventListener('input', () => {
            const val = parseFloat(aeSize.value) / 10;
            aeSizeVal.textContent = val.toFixed(1) + 's';
            track.aelapseReverbSize = val;
            try {
                track.aelapseReverbNode.buffer = createSpringImpulseResponse(ctx, val, 2.5);
            } catch (err) {
                console.error('Failed to update convolver buffer:', err);
            }
        });

        const aeReverbMix = fxDrawerEl.querySelector('.aelapse-reverb-mix');
        const aeReverbVal = fxDrawerEl.querySelector('.aelapse-reverb-val');
        aeReverbMix.addEventListener('input', () => {
            const pct = parseFloat(aeReverbMix.value) / 100;
            aeReverbVal.textContent = aeReverbMix.value + '%';
            track.aelapseReverbMix = pct;
            updateAelapseBypass(track);
        });

        const aeSync = fxDrawerEl.querySelector('.aelapse-sync');
        const aeSyncVal = fxDrawerEl.querySelector('.aelapse-sync-val');
        const syncLabels = ['1/16', '1/8T', '1/8', 'd8th', '1/4', 'd1/4', '1/2', 'd1/2', '1/1'];
        const syncBeats = [0.25, 0.333, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
        aeSync.addEventListener('input', () => {
            const idx = parseInt(aeSync.value);
            track.delaySyncIndex = idx;
            aeSyncVal.textContent = syncLabels[idx];
            const bpm = parseInt(bpmInput.value) || 120;
            const delayTimeSec = (60.0 / bpm) * syncBeats[idx];
            track.aelapseDelayTime = delayTimeSec;
            track.aelapseDelayNode.delayTime.setValueAtTime(delayTimeSec, audioCtx.currentTime);
        });

        // 12. Wire FX Drawer Macro Knobs (Space, Drive, Tone)
        const fxMacroKnobs = fxDrawerEl.querySelectorAll('.fx-macro-knob');
        // fxMacroState is declared at the top of createTrackRow

        function applyFxMacro(macroName, value) {
            const knobEl = fxDrawerEl.querySelector(`.fx-macro-knob[data-macro="${macroName}"]`);
            const indicator = knobEl.querySelector('.macro-knob-indicator');

            if (macroName === 'tone') {
                // Tone is bipolar (0-100, 50 = center)
                const deg = -135 + (value / 100) * 270;
                indicator.style.transform = `rotate(${deg}deg)`;
                if (value === 50) {
                    knobEl.title = 'Tone: Flat';
                } else if (value < 50) {
                    knobEl.title = 'Tone: Dark';
                } else {
                    knobEl.title = 'Tone: Bright';
                }
                // Push to EQ sliders
                const eqSlidersList = fxDrawerEl.querySelectorAll('.eq-slider');
                if (eqSlidersList.length === 6) {
                    let bandGains = [0, 0, 0, 0, 0, 0];
                    if (value < 50) {
                        const factor = (50 - value) / 50;
                        bandGains = [6.0 * factor, 6.0 * factor, 4.0 * factor, 0, -6.0 * factor, -6.0 * factor];
                    } else if (value > 50) {
                        const factor = (value - 50) / 50;
                        bandGains = [-6.0 * factor, -6.0 * factor, -3.0 * factor, 0, 6.0 * factor, 8.0 * factor];
                    }
                    eqSlidersList.forEach((slider, b) => {
                        slider.value = bandGains[b];
                        slider.dispatchEvent(new Event('input'));
                    });
                }
            } else if (macroName === 'filter') {
                // Filter macro is bipolar: 0=off, <50=LP sweep, >50=HP sweep
                const bipolarVal = (value / 100) * 200 - 100; // map 0-100 → -100..+100
                const deg = -135 + (value / 100) * 270;
                indicator.style.transform = `rotate(${deg}deg)`;
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
                        knobEl.title = `LP: ${cutoff >= 1000 ? (cutoff/1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    } else {
                        const norm = (value - 50) / 50;
                        const cutoff = 20 * Math.pow(12000 / 20, norm);
                        track.filtrFilterNode.type = 'highpass';
                        track.filtrFilterNode.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.02);
                        track.filtrDryGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
                        track.filtrWetGainNode.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
                        knobEl.title = `HP: ${cutoff >= 1000 ? (cutoff/1000).toFixed(1) + 'kHz' : Math.round(cutoff) + 'Hz'}`;
                    }
                }
            } else {
                // Unipolar 0-100 macros
                const deg = -135 + (value / 100) * 270;
                indicator.style.transform = `rotate(${deg}deg)`;
                knobEl.title = `${macroName.charAt(0).toUpperCase() + macroName.slice(1)}: ${value}%`;

                if (macroName === 'space') {
                    const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
                    const reverbMixSlider = fxDrawerEl.querySelector('.aelapse-reverb-mix');
                    const reverbSizeSlider = fxDrawerEl.querySelector('.aelapse-size');
                    if (delayMixSlider) { delayMixSlider.value = value; delayMixSlider.dispatchEvent(new Event('input')); }
                    if (reverbMixSlider) { reverbMixSlider.value = value; reverbMixSlider.dispatchEvent(new Event('input')); }
                    const sizeVal = Math.round(5 + (45 * value / 100));
                    if (reverbSizeSlider) { reverbSizeSlider.value = sizeVal; reverbSizeSlider.dispatchEvent(new Event('input')); }
                } else if (macroName === 'drive') {
                    const screamVal = Math.round(value * 0.6);
                    const screamAmtSlider = fxDrawerEl.querySelector('.scream-amount');
                    const screamMxSlider = fxDrawerEl.querySelector('.scream-mix');
                    if (screamAmtSlider) { screamAmtSlider.value = screamVal; screamAmtSlider.dispatchEvent(new Event('input')); }
                    if (screamMxSlider) { screamMxSlider.value = Math.max(screamVal, 100); screamMxSlider.dispatchEvent(new Event('input')); }
                    if (value > 0 && !track.screamEnabled) {
                        const screamToggle = fxDrawerEl.querySelector('.scream-toggle');
                        if (screamToggle) screamToggle.click();
                    }
                } else if (macroName === 'reso') {
                    const resoSlider = fxDrawerEl.querySelector('.filtr-reso');
                    if (resoSlider) { resoSlider.value = Math.round(1 + (249 * value / 100)); resoSlider.dispatchEvent(new Event('input')); }
                } else if (macroName === 'delay') {
                    const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
                    if (!track.aelapseEnabled && value > 0) {
                        const toggle = fxDrawerEl.querySelector('.aelapse-toggle');
                        if (toggle) toggle.click();
                    }
                    if (delayMixSlider) { delayMixSlider.value = value; delayMixSlider.dispatchEvent(new Event('input')); }
                } else if (macroName === 'feedback') {
                    const fbSlider = fxDrawerEl.querySelector('.aelapse-feedback');
                    if (fbSlider) { fbSlider.value = Math.round(value * 0.95); fbSlider.dispatchEvent(new Event('input')); }
                } else if (macroName === 'crush') {
                    // Crush: drives scream distortion cutoff down + amount up
                    const screamCutoffSlider = fxDrawerEl.querySelector('.scream-cutoff');
                    const screamAmtSlider = fxDrawerEl.querySelector('.scream-amount');
                    if (!track.screamEnabled && value > 0) {
                        const toggle = fxDrawerEl.querySelector('.scream-toggle');
                        if (toggle) toggle.click();
                    }
                    if (screamCutoffSlider) {
                        const cutoff = Math.round(16000 - (15800 * value / 100));
                        screamCutoffSlider.value = cutoff;
                        screamCutoffSlider.dispatchEvent(new Event('input'));
                    }
                    if (screamAmtSlider) { screamAmtSlider.value = value; screamAmtSlider.dispatchEvent(new Event('input')); }
                }
            }
        }

        fxMacroKnobs.forEach(knobEl => {
            const macroName = knobEl.dataset.macro;
            const defaultVal = (macroName === 'tone' || macroName === 'filter') ? 50 : 0;
            fxMacroState[macroName] = { value: defaultVal, dragging: false, startY: 0, startVal: 0 };

            // Init indicator
            const initDeg = -135 + (defaultVal / 100) * 270;
            knobEl.querySelector('.macro-knob-indicator').style.transform = `rotate(${initDeg}deg)`;

            knobEl.addEventListener('mousedown', (e) => {
                if (track.locked) return;
                e.preventDefault();
                e.stopPropagation();
                const st = fxMacroState[macroName];
                st.dragging = true;
                st.startY = e.clientY;
                st.startVal = st.value;
                document.body.style.cursor = 'ns-resize';
            });

            document.addEventListener('mousemove', (e) => {
                const st = fxMacroState[macroName];
                if (!st.dragging) return;
                const delta = st.startY - e.clientY;
                const newVal = Math.max(0, Math.min(100, st.startVal + delta));
                st.value = newVal;
                applyFxMacro(macroName, newVal);
            });

            document.addEventListener('mouseup', () => {
                const st = fxMacroState[macroName];
                if (st.dragging) {
                    st.dragging = false;
                    document.body.style.cursor = '';
                }
            });

            knobEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (track.locked) return;
                fxMacroState[macroName].value = defaultVal;
                applyFxMacro(macroName, defaultVal);
            });
        });

        // 13. Wire Bypass Switches
        const filtrToggleBtn = fxDrawerEl.querySelector('.filtr-toggle');
        const filtrSection = fxDrawerEl.querySelector('.filtr-section');
        filtrToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.filtrEnabled = !track.filtrEnabled;
            filtrToggleBtn.textContent = track.filtrEnabled ? 'On' : 'Off';
            filtrToggleBtn.classList.toggle('is-off', !track.filtrEnabled);
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
            screamSection.classList.toggle('is-bypassed', !track.screamEnabled);
            updateScreamBypass(track);
        });

        const aeToggleBtn = fxDrawerEl.querySelector('.aelapse-toggle');
        const aeSection = fxDrawerEl.querySelector('.aelapse-section');
        aeToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.aelapseEnabled = !track.aelapseEnabled;
            aeToggleBtn.textContent = track.aelapseEnabled ? 'On' : 'Bypass';
            aeToggleBtn.classList.toggle('is-off', !track.aelapseEnabled);
            aeSection.classList.toggle('is-bypassed', !track.aelapseEnabled);
            updateAelapseBypass(track);
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
                    aelapseEnabled: track.aelapseEnabled,
                    
                    filtrType: fxDrawerEl.querySelector('.filtr-type').value,
                    filtrCutoff: fxDrawerEl.querySelector('.filtr-cutoff').value,
                    filtrReso: fxDrawerEl.querySelector('.filtr-reso').value,
                    filtrMix: fxDrawerEl.querySelector('.filtr-mix').value,
                    
                    screamCutoff: fxDrawerEl.querySelector('.scream-cutoff').value,
                    screamAmount: fxDrawerEl.querySelector('.scream-amount').value,
                    screamMix: fxDrawerEl.querySelector('.scream-mix').value,
                    
                    eqGains: Array.from(fxDrawerEl.querySelectorAll('.eq-slider')).map(s => s.value),
                    
                    aelapseSync: fxDrawerEl.querySelector('.aelapse-sync').value,
                    aelapseFeedback: fxDrawerEl.querySelector('.aelapse-feedback').value,
                    aelapseMix: fxDrawerEl.querySelector('.aelapse-mix').value,
                    aelapseSize: fxDrawerEl.querySelector('.aelapse-size').value,
                    aelapseReverbMix: fxDrawerEl.querySelector('.aelapse-reverb-mix').value,

                    macros: {
                        space: fxMacroState.space ? fxMacroState.space.value : 0,
                        drive: fxMacroState.drive ? fxMacroState.drive.value : 0,
                        tone: fxMacroState.tone ? fxMacroState.tone.value : 50,
                        filter: fxMacroState.filter ? fxMacroState.filter.value : 50,
                        reso: fxMacroState.reso ? fxMacroState.reso.value : 0,
                        delay: fxMacroState.delay ? fxMacroState.delay.value : 0,
                        feedback: fxMacroState.feedback ? fxMacroState.feedback.value : 0,
                        crush: fxMacroState.crush ? fxMacroState.crush.value : 0,
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
                const settings = copiedFxSettings;

                track.filtrEnabled = settings.filtrEnabled;
                filtrToggleBtn.textContent = track.filtrEnabled ? 'On' : 'Off';
                filtrToggleBtn.classList.toggle('is-off', !track.filtrEnabled);
                filtrSection.classList.toggle('is-bypassed', !track.filtrEnabled);
                updateFiltrBypass(track);

                track.eqEnabled = settings.eqEnabled;
                eqToggleBtn.textContent = track.eqEnabled ? 'On' : 'Bypass';
                eqToggleBtn.classList.toggle('is-off', !track.eqEnabled);
                eqSection.classList.toggle('is-bypassed', !track.eqEnabled);
                updateEqBypass(track);

                track.screamEnabled = settings.screamEnabled;
                screamToggleBtn.textContent = track.screamEnabled ? 'On' : 'Off';
                screamToggleBtn.classList.toggle('is-off', !track.screamEnabled);
                screamSection.classList.toggle('is-bypassed', !track.screamEnabled);
                updateScreamBypass(track);

                track.aelapseEnabled = settings.aelapseEnabled;
                aeToggleBtn.textContent = track.aelapseEnabled ? 'On' : 'Bypass';
                aeToggleBtn.classList.toggle('is-off', !track.aelapseEnabled);
                aeSection.classList.toggle('is-bypassed', !track.aelapseEnabled);
                updateAelapseBypass(track);

                const typeSelect = fxDrawerEl.querySelector('.filtr-type');
                if (typeSelect) {
                    typeSelect.value = settings.filtrType;
                    typeSelect.dispatchEvent(new Event('change'));
                }

                const sliders = {
                    '.filtr-cutoff': settings.filtrCutoff,
                    '.filtr-reso': settings.filtrReso,
                    '.filtr-mix': settings.filtrMix,
                    '.scream-cutoff': settings.screamCutoff,
                    '.scream-amount': settings.screamAmount,
                    '.scream-mix': settings.screamMix,
                    '.aelapse-sync': settings.aelapseSync,
                    '.aelapse-feedback': settings.aelapseFeedback,
                    '.aelapse-mix': settings.aelapseMix,
                    '.aelapse-size': settings.aelapseSize,
                    '.aelapse-reverb-mix': settings.aelapseReverbMix,
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
                    if (settings.eqGains[b] !== undefined) {
                        slider.value = settings.eqGains[b];
                        slider.dispatchEvent(new Event('input'));
                    }
                });

                if (settings.macros) {
                    for (const key in settings.macros) {
                        if (fxMacroState[key]) {
                            fxMacroState[key].value = settings.macros[key];
                            applyFxMacro(key, settings.macros[key]);
                        }
                    }
                }

                const originalText = pasteBtn.textContent;
                pasteBtn.textContent = 'Pasted!';
                setTimeout(() => { pasteBtn.textContent = originalText; }, 1000);
            });
        }

        // 11. Build variants card selection UI
        const variantsEl = document.createElement('div');
        variantsEl.className = 'variants-container';

        batchFiles.forEach((filePath, i) => {
            const name = filePath.split('/').pop() || `v${i + 1}`;
            const cardEl = document.createElement('div');
            cardEl.className = 'audio-card is-loading';
            if (i === 0) cardEl.classList.add('is-selected');

            cardEl.innerHTML = `
                <div class="card-header">
                    <span class="card-title" title="${name}">${name}</span>
                    <div style="display: flex; align-items: center; gap: 2px;">
                        <button class="btn-use-init" title="Use as Remix Audio" type="button">Remix</button>
                        <button class="btn-reverse" title="Reverse" type="button">⇄</button>
                        <button class="btn-lock-variant" title="Lock Variant" type="button">
                            <svg class="btn-icon icon-unlock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                        </button>
                        <span class="card-variant-num">#${i + 1}</span>
                    </div>
                </div>
                <div class="card-seek-bar">
                    <canvas class="card-waveform"></canvas>
                    <div class="card-progress-fill"></div>
                    <div class="card-playhead"></div>
                    <div class="card-split-line"></div>
                </div>
            `;

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
                if (track.locked) return;
                const cardRect = cardEl.getBoundingClientRect();
                const clickX = e.clientX - cardRect.left;
                const isLeftHalf = clickX < cardRect.width / 2;

                const seekBar = cardEl.querySelector('.card-seek-bar');
                const seekRect = seekBar.getBoundingClientRect();
                const inSeekBar = e.clientX >= seekRect.left && e.clientX <= seekRect.right
                               && e.clientY >= seekRect.top  && e.clientY <= seekRect.bottom;

                const splitToggle = document.getElementById('toggle-split');
                const splitEnabled = splitToggle ? splitToggle.checked : false;

                if (splitEnabled && isLeftHalf && isPlaying && i !== track.selectedVariant) {
                    // Split ON + left half = queue at next loop boundary
                    track._pendingVariant = i;
                    track.variants.forEach((v, vi) => v.el.classList.toggle('is-queued', vi === i));
                } else {
                    // Default or right half = instant switch
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
                    drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, track.selectedVariant === i, track.originalParams?.bpm);
                    // If this is the playing variant, restart just this track source (not all playback)
                    if (isPlaying && track.selectedVariant === i) {
                        if (audioCtx) {
                            const elapsed = audioCtx.currentTime - playStartCtxTime;
                            playOffset = elapsed % globalDuration;
                        }
                        stopTrackSource(track);
                        startTrackSource(track);
                    }
                });
            }

            const lockVariantBtn = cardEl.querySelector('.btn-lock-variant');
            if (lockVariantBtn) {
                lockVariantBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (track.locked) return;
                    variant.locked = !variant.locked;
                    cardEl.classList.toggle('card-is-locked', variant.locked);
                    
                    if (variant.locked) {
                        lockVariantBtn.innerHTML = `<svg class="btn-icon icon-lock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
                    } else {
                        lockVariantBtn.innerHTML = `<svg class="btn-icon icon-unlock" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
                    }
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

        return track;
    }

    async function loadVariantAudio(variant, url, isSelected, track) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            const ctx = ensureAudioCtx();
            variant.buffer = await ctx.decodeAudioData(buf);
            variant.el.classList.remove('is-loading');
            drawWaveform(variant.el.querySelector('.card-waveform'), variant.buffer, isSelected, track ? track.originalParams?.bpm : null);

            // Auto-play: if this is variant 0 and it just loaded, start it
            if (track && track.selectedVariant === 0 && variant === track.variants[0]) {
                if (isPlaying && audioCtx) {
                    const elapsed = audioCtx.currentTime - playStartCtxTime;
                    playOffset = elapsed % globalDuration;
                    startTrackSource(track);
                } else if (!isPlaying && track._autoPlay) {
                    playAll();
                }
            }
        } catch (err) {
            console.error(`Failed to load ${variant.name}:`, err);
            variant.el.classList.remove('is-loading');
            variant.el.querySelector('.card-title').textContent += ' (err)';
        }
    }

    // --- Random Prompt Generator ---
    const instruments = [
        'acoustic guitar', 'electric guitar', 'classical guitar', 'nylon string guitar',
        'grand piano', 'upright piano', 'fender rhodes piano', 'wurlitzer piano',
        'synth lead', 'analog synthesizer', 'modular synthesizer', 'moog synthesizer',
        'funky bass guitar', 'fretless bass', 'acoustic double bass', 'slap bass',
        'saxophone', 'alto saxophone', 'tenor saxophone', 'trumpet', 'trombone',
        'flute', 'clarinet', 'oboe', 'violin', 'viola', 'cello', 'string ensemble',
        'drum kit', 'percussion', 'congas', 'bongos',
        'hammond organ', 'church organ', 'accordion',
        'marimba', 'vibraphone', 'xylophone', 'kalimba', 'steel drums',
        'classical harp', 'sitar', 'erhu', 'koto', 'tabla',
        'music box', 'celesta', 'glockenspiel', 'glockenspeil', 'harmonica', 'banjo', 'mandolin',
        'theremin', 'mellotron', 'vocoder'
    ];
    
    const styles = [
        'bluesy licks', 'funky riffs', 'jazz improvisation', 'ambient soundscapes',
        'classical melody runs', 'chillhop beat elements', 'hyperpop sequence loops',
        'lofi chords', 'synthwave arpeggios', 'psychedelic rock runs',
        'soulful themes', 'melancholic motifs', 'groovy patterns', 'moody hooks',
        'cinematic phrases', 'epic crescendo', 'minimal techno patterns',
        'afrobeat rhythms', 'bossa nova groove', 'reggae skank',
        'country licks', 'folk fingerpicking', 'R&B progressions',
        'trap melodies', 'drill patterns', 'vaporwave textures',
        'IDM glitch sequences', 'breakbeat chops', 'dub delays',
        'new age atmospheres', 'world music fusion', 'tribal rhythms',
        'neo-soul harmonies', 'gospel chords', 'progressive rock phrases'
    ];

    const moods = [
        'euphoric', 'melancholic', 'dreamy', 'dark', 'uplifting', 'peaceful',
        'aggressive', 'mysterious', 'nostalgic', 'ethereal', 'energetic', 'hypnotic',
        'spacious', 'intimate', 'epic', 'playful', 'haunting', 'cinematic',
        'warm', 'cold', 'bright', 'lush', 'gritty', 'smooth'
    ];

    const productionStyles = [
        'studio quality', 'lo-fi', 'vintage analog', 'pristine digital',
        'lush reverb', 'dry close-mic', 'tape saturated', 'modern polished',
        'textured', '1980s production', 'ambient washed', 'crisp'
    ];
    
    const keys = [
        'C major', 'C minor', 'C# minor', 'D major', 'D minor', 'Eb major',
        'E major', 'E minor', 'F major', 'F minor', 'F# minor', 'G major',
        'G minor', 'Ab major', 'A major', 'A minor', 'Bb major', 'Bb minor',
        'B major', 'B minor', 'D dorian', 'A phrygian', 'F lydian', 'G mixolydian'
    ];
    
    const chords = [
        'Cmaj7 to Fmaj7 chord progression', 'Am9 to Dm9 chord sequence',
        'G7 to Cmaj7 jazz turnaround', 'Fmaj7 chord changes',
        'Emin7 to A7 pattern', 'Bbmaj7 to Ebmaj7 progression',
        'minor 7th arpeggios', 'major 7th voicings',
        'ii-V-I jazz progression', 'I-vi-IV-V pop progression',
        'I-V-vi-IV anthem progression', 'vi-IV-I-V emotional progression',
        'dim7 chromatic passing chords', 'sus4 resolution patterns',
        'minor 9th chord stabs', 'major 6/9 voicings'
    ];

    function generateRandomPrompt(keepKey = false) {
        const inst = instruments[Math.floor(Math.random() * instruments.length)];
        const style = styles[Math.floor(Math.random() * styles.length)];
        const mood = moods[Math.floor(Math.random() * moods.length)];
        
        if (!keepKey || !currentKeyOrChord) {
            if (Math.random() < 0.5) {
                const key = keys[Math.floor(Math.random() * keys.length)];
                currentKeyOrChord = { type: 'key', value: key };
            } else {
                const chord = chords[Math.floor(Math.random() * chords.length)];
                currentKeyOrChord = { type: 'chord', value: chord };
            }
        }
        
        let generated = "";
        if (currentKeyOrChord.type === 'key') {
            generated = `${mood} solo ${inst} ${style} in ${currentKeyOrChord.value}`;
        } else {
            generated = `${mood} solo ${inst} ${style} playing ${currentKeyOrChord.value}`;
        }
        
        // Occasionally add production style
        if (Math.random() < 0.3) {
            const prod = productionStyles[Math.floor(Math.random() * productionStyles.length)];
            generated += `, ${prod}`;
        }
        
        if (btnRandomInKey) {
            btnRandomInKey.title = `Generate Random Prompt in ${currentKeyOrChord.value}`;
            btnRandomInKey.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3M15.5 7.5L14 9"/></svg>${currentKeyOrChord.value}`;
        }
        
        promptInput.value = generated;
        promptInput.focus();
    }

    if (btnRandomPrompt) {
        btnRandomPrompt.addEventListener('click', () => {
            generateRandomPrompt(false);
        });
    }

    if (btnRandomInKey) {
        btnRandomInKey.addEventListener('click', () => {
            generateRandomPrompt(true);
        });
    }

    function changeChordOnly() {
        if (Math.random() < 0.5) {
            const key = keys[Math.floor(Math.random() * keys.length)];
            currentKeyOrChord = { type: 'key', value: key };
        } else {
            const chord = chords[Math.floor(Math.random() * chords.length)];
            currentKeyOrChord = { type: 'chord', value: chord };
        }
        
        const currentPrompt = promptInput.value.trim();
        if (btnRandomInKey) {
            btnRandomInKey.title = `Generate Random Prompt in ${currentKeyOrChord.value}`;
            btnRandomInKey.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3M15.5 7.5L14 9"/></svg>${currentKeyOrChord.value}`;
        }
        
        let newPrompt = currentPrompt;
        const inRegex = /\bin\s+([A-Ga-g][#b]?(?:\s+[a-zA-Z0-9#\/\-\+]+)*)/i;
        const playingRegex = /\bplaying\s+([^,]+)/i;
        
        const newVal = currentKeyOrChord.value;
        const transitionWord = currentKeyOrChord.type === 'key' ? 'in' : 'playing';
        
        if (inRegex.test(currentPrompt)) {
            newPrompt = currentPrompt.replace(inRegex, `${transitionWord} ${newVal}`);
        } else if (playingRegex.test(currentPrompt)) {
            newPrompt = currentPrompt.replace(playingRegex, `${transitionWord} ${newVal}`);
        } else {
            generateRandomPrompt(true);
            return;
        }
        
        promptInput.value = newPrompt;
        promptInput.focus();
    }

    function changeStyleOnly() {
        const currentPrompt = promptInput.value.trim();
        const newStyle = styles[Math.floor(Math.random() * styles.length)];
        
        let matchedInstrument = null;
        for (const inst of instruments) {
            if (currentPrompt.toLowerCase().includes(inst.toLowerCase())) {
                matchedInstrument = inst;
                break;
            }
        }
        
        const inMatch = currentPrompt.match(/\bin\s+/i);
        const playingMatch = currentPrompt.match(/\bplaying\s+/i);
        const markerMatch = inMatch || playingMatch;
        
        if (matchedInstrument && markerMatch) {
            const instEscaped = matchedInstrument.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`(${instEscaped}\\s+)(.*?\\s+)(in|playing\\b)`, 'i');
            
            if (regex.test(currentPrompt)) {
                const newPrompt = currentPrompt.replace(regex, `$1${newStyle} $3`);
                promptInput.value = newPrompt;
                promptInput.focus();
                return;
            }
        }
        
        const inst = matchedInstrument || instruments[Math.floor(Math.random() * instruments.length)];
        const mood = moods[Math.floor(Math.random() * moods.length)];
        if (!currentKeyOrChord) {
            const key = keys[Math.floor(Math.random() * keys.length)];
            currentKeyOrChord = { type: 'key', value: key };
        }
        
        const transitionWord = currentKeyOrChord.type === 'key' ? 'in' : 'playing';
        let generated = `${mood} solo ${inst} ${newStyle} ${transitionWord} ${currentKeyOrChord.value}`;
        
        promptInput.value = generated;
        promptInput.focus();
    }

    function changeInstrumentOnly() {
        const currentPrompt = promptInput.value.trim();
        
        const sortedInstruments = [...instruments].sort((a, b) => b.length - a.length);
        let matchedInstrument = null;
        for (const inst of sortedInstruments) {
            const index = currentPrompt.toLowerCase().indexOf(inst.toLowerCase());
            if (index !== -1) {
                matchedInstrument = inst;
                break;
            }
        }
        
        // Exclude the matched instrument (and its variant/misspelling if it's glockenspiel)
        let excluded = [];
        if (matchedInstrument) {
            excluded.push(matchedInstrument.toLowerCase());
            if (matchedInstrument.toLowerCase() === 'glockenspiel' || matchedInstrument.toLowerCase() === 'glockenspeil') {
                excluded.push('glockenspiel', 'glockenspeil');
            }
        }
        
        const filteredInstruments = instruments.filter(inst => !excluded.includes(inst.toLowerCase()));
        const newInstrument = filteredInstruments[Math.floor(Math.random() * filteredInstruments.length)];
        
        if (matchedInstrument) {
            const regex = new RegExp(matchedInstrument.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
            const newPrompt = currentPrompt.replace(regex, newInstrument);
            promptInput.value = newPrompt;
            promptInput.focus();
            return;
        }
        
        // Fallback if no known instrument is found
        const mood = moods[Math.floor(Math.random() * moods.length)];
        const style = styles[Math.floor(Math.random() * styles.length)];
        if (!currentKeyOrChord) {
            const key = keys[Math.floor(Math.random() * keys.length)];
            currentKeyOrChord = { type: 'key', value: key };
        }
        const transitionWord = currentKeyOrChord.type === 'key' ? 'in' : 'playing';
        const generated = `${mood} solo ${newInstrument} ${style} ${transitionWord} ${currentKeyOrChord.value}`;
        
        promptInput.value = generated;
        promptInput.focus();
    }

    if (btnChangeChord) {
        btnChangeChord.addEventListener('click', changeChordOnly);
    }

    if (btnChangeStyle) {
        btnChangeStyle.addEventListener('click', changeStyleOnly);
    }

    if (btnChangeInstrument) {
        btnChangeInstrument.addEventListener('click', changeInstrumentOnly);
    }

    // --- Random Drum Loop Generator ---
    const drumGenres = [
        'trap', 'boom bap', 'lo-fi hip hop', 'drill', 'jungle', 'breakbeat',
        'house', 'deep house', 'tech house', 'techno', 'minimal techno',
        'drum and bass', 'liquid drum and bass', 'UK garage', 'afrobeat',
        'reggaeton', 'jazz', 'funk', 'rock', 'metal', 'pop', 'R&B', 'disco',
        'footwork', 'juke', 'dancehall', 'amapiano', 'baile funk',
        'industrial', 'electro', 'IDM', 'grime'
    ];

    const drumDescriptors = [
        'hard-hitting', 'crispy', 'punchy', 'tight', 'bouncy', 'swinging',
        'aggressive', 'laid-back', 'groovy', 'minimal', 'complex', 'syncopated',
        'live acoustic', 'processed 808', 'vintage drum machine', 'sampled breaks',
        'shuffled', 'polyrhythmic', 'rolling', 'glitchy',
        'lo-fi dusty', 'compressed', 'thundering', 'hypnotic'
    ];

    const drumElements = [
        '', ', heavy kick', ', crispy snare', ', shaker groove',
        ', hi-hat rolls', ', open hat patterns', ', tom fills',
        ', clap layers', ', rim shots', ', cowbell accents'
    ];

    function generateRandomDrumPrompt() {
        const genre = drumGenres[Math.floor(Math.random() * drumGenres.length)];
        const desc = drumDescriptors[Math.floor(Math.random() * drumDescriptors.length)];
        const elem = drumElements[Math.floor(Math.random() * drumElements.length)];
        const bpm = parseInt(bpmInput.value) || 120;
        promptInput.value = `${desc} ${genre} drum loop at ${bpm} bpm${elem}`;
        promptInput.focus();
    }

    if (btnRandomDrums) {
        btnRandomDrums.addEventListener('click', () => {
            generateRandomDrumPrompt();
        });
    }

    // --- Random Bass Prompt Generator ---
    const bassStyles = [
        'bass line', 'bass sequence', 'live bass', 'slap bass', 'synth bass',
        'funky bass', 'choppy bass', 'dubstep wobble bass', 'wobble bass',
        'sub bass', 'acid bass', 'fingerstyle bass', 'picked bass',
        'fretless bass', 'moog bass', 'reese bass', 'plucky bass',
        'distorted bass', '808 bass', 'deep house bass', 'walking bass',
        'funk bass riff', 'dub bass', 'neuro bass', 'rubber bass',
        'thumping bass', 'groovy bass', 'minimal bass', 'pulsing bass',
        'staccato bass', 'legato bass', 'gliding bass', 'portamento bass',
        'FM bass', 'wavetable bass', 'detuned bass', 'growling bass',
        'garage bass', 'liquid bass', 'electro bass', 'trance bass',
        'midrange bass', 'rolling bass', 'square bass', 'filtered bass',
        'sidechain bass', 'tape bass', 'analog bass', 'digital bass'
    ];

    const bassDescriptors = [
        'deep', 'punchy', 'warm', 'aggressive', 'smooth', 'gritty',
        'fat', 'tight', 'bouncy', 'heavy', 'mellow', 'driving',
        'hypnotic', 'rolling', 'dirty', 'clean', 'saturated', 'crispy',
        'dark', 'rumbling', 'throbbing', 'squelchy', 'wobbly', 'massive',
        'round', 'buzzing', 'distorted', 'compressed'
    ];

    function generateRandomBassPrompt() {
        const style = bassStyles[Math.floor(Math.random() * bassStyles.length)];
        const desc = bassDescriptors[Math.floor(Math.random() * bassDescriptors.length)];
        const bpm = parseInt(bpmInput.value) || 120;

        // Use current key if available
        let keyPart = '';
        if (currentKeyOrChord) {
            if (currentKeyOrChord.type === 'key') {
                keyPart = ` in ${currentKeyOrChord.value}`;
            } else {
                keyPart = ` playing ${currentKeyOrChord.value}`;
            }
        } else {
            const key = keys[Math.floor(Math.random() * keys.length)];
            currentKeyOrChord = { type: 'key', value: key };
            keyPart = ` in ${key}`;
        }

        promptInput.value = `${desc} ${style}${keyPart} at ${bpm} bpm`;
        promptInput.focus();
    }

    if (btnRandomBass) {
        btnRandomBass.addEventListener('click', () => {
            generateRandomBassPrompt();
        });
    }

    // --- Random Lead Prompt Generator ---
    const leadStyles = [
        'synth lead', 'lead melody', 'lead riff', 'arpeggio lead', 'pluck lead',
        'pad lead', 'supersaw lead', 'square wave lead', 'sawtooth lead',
        'FM synth lead', 'bell lead', 'brass lead', 'string lead',
        'vocal chop lead', 'glitch lead', 'chip tune lead', 'theremin lead',
        'whistle melody', 'flute lead', 'electric guitar lead',
        'organ lead', 'marimba lead', 'kalimba melody', 'steel drum lead',
        'sitar lead', 'erhu melody', 'pizzicato lead', 'harp arpeggio',
        'music box melody', 'glass lead', 'crystal lead', 'ethereal lead',
        'acid lead', 'hoover lead', 'trance lead', 'progressive lead',
        'formant lead', 'vocoder melody', 'granular lead', 'wavetable lead',
        'PWM lead', 'unison lead', 'portamento lead', 'stab lead',
        'ambient lead', 'tape loop melody', 'processed piano melody', 'delay-soaked lead'
    ];

    const leadDescriptors = [
        'soaring', 'bright', 'dreamy', 'euphoric', 'melancholic', 'energetic',
        'ambient', 'sharp', 'shimmering', 'lush', 'epic', 'catchy',
        'hypnotic', 'playful', 'dark', 'ethereal', 'punchy', 'airy',
        'nostalgic', 'cinematic', 'pulsing', 'gliding',
        'haunting', 'mystical', 'crystalline', 'warm', 'icy', 'psychedelic',
        'distorted', 'clean', 'reverb-drenched', 'intimate'
    ];

    function generateRandomLeadPrompt() {
        const style = leadStyles[Math.floor(Math.random() * leadStyles.length)];
        const desc = leadDescriptors[Math.floor(Math.random() * leadDescriptors.length)];
        const bpm = parseInt(bpmInput.value) || 120;

        let keyPart = '';
        if (currentKeyOrChord) {
            if (currentKeyOrChord.type === 'key') {
                keyPart = ` in ${currentKeyOrChord.value}`;
            } else {
                keyPart = ` playing ${currentKeyOrChord.value}`;
            }
        } else {
            const key = keys[Math.floor(Math.random() * keys.length)];
            currentKeyOrChord = { type: 'key', value: key };
            keyPart = ` in ${key}`;
        }

        promptInput.value = `${desc} ${style}${keyPart} at ${bpm} bpm`;
        promptInput.focus();
    }

    if (btnRandomLead) {
        btnRandomLead.addEventListener('click', () => {
            generateRandomLeadPrompt();
        });
    }

    // --- Generation ---
    btnGenerate.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) { promptInput.focus(); return; }
        runGeneration(prompt);
    });

    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); btnGenerate.click(); }
    });

    async function runGeneration(prompt) {
        const bpm = parseInt(bpmInput.value) || 120;
        const numVariants = 4;
        const loop = true;
        const seedInput = document.getElementById('seed-input');
        const cfgInput = document.getElementById('cfg-input');
        const stepsInput = document.getElementById('steps-input');
        const seed = seedInput ? parseInt(seedInput.value) : -1;
        const cfgScale = cfgInput ? parseFloat(cfgInput.value) : 1.0;
        const steps = stepsInput ? parseInt(stepsInput.value) : 8;

        btnGenerate.disabled = true;
        btnGenerate.classList.add('is-generating');
        btnGenerate.textContent = 'Generating…';
        showStatus('Submitting…');

        try {
            const bodyPayload = {
                prompt,
                bpm,
                num_variants: numVariants,
                loop,
                duration_padding_sec: 6.0,
                seed,
                cfg_scale: cfgScale,
                steps
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
            showStatus('GENERATING');

            const result = await pollJob(job_id);
            if (result.status === 'error') throw new Error(result.error || 'Failed');

            showStatus(`Done in ${result.elapsed?.toFixed(1) || '?'}s`, 'done');
            const originalParams = {
                prompt,
                bpm,
                seed,
                cfgScale,
                steps
            };
            addTrackRow(result.files, prompt, result.track_num, true, parentTrackId, originalParams);
            clearInitAudio();

        } catch (err) {
            console.error('Generation error:', err);
            showStatus(`Error: ${err.message}`, 'error');
        } finally {
            btnGenerate.disabled = false;
            btnGenerate.classList.remove('is-generating');
            btnGenerate.textContent = 'Generate';
        }
    }

    async function pollJob(jobId) {
        for (let i = 0; i < 300; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const res = await fetch(`/api/status/${jobId}`);
            if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
            const data = await res.json();
            if (data.status === 'done' || data.status === 'error') return data;
            if (data.progress) showStatus(data.progress);
        }
        throw new Error('Timed out');
    }

    function addTrackRow(files, prompt, trackNum, autoPlay = false, parentTrackId = null, originalParams = null) {
        tracksContainer.classList.remove('empty');
        const empty = tracksContainer.querySelector('.grid-empty-state');
        if (empty) empty.remove();

        const track = createTrackRow(prompt, files, trackNum);
        track._autoPlay = autoPlay;
        if (originalParams) {
            track.originalParams = originalParams;
        } else {
            track.originalParams = {
                prompt,
                bpm: parseInt(bpmInput.value) || 120,
                seed: -1,
                cfgScale: 1.0,
                steps: 8
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
        if (btnRenderMix) btnRenderMix.disabled = false;
        if (btnExportLoops) btnExportLoops.disabled = false;
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
            statusBar.querySelector('.status-spinner').style.display = 'none';
            setTimeout(() => {
                statusBar.classList.remove('visible');
                statusBar.querySelector('.status-spinner').style.display = '';
            }, 3000);
        } else if (type === 'error') {
            statusText.classList.add('error');
            statusBar.querySelector('.status-spinner').style.display = 'none';
            setTimeout(() => {
                statusBar.classList.remove('visible');
                statusBar.querySelector('.status-spinner').style.display = '';
            }, 5000);
        } else {
            statusBar.querySelector('.status-spinner').style.display = '';
        }
    }

    // --- Resize observer ---
    const ro = new ResizeObserver(() => {
        tracks.forEach(t => {
            t.variants.forEach((v, i) => {
                drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, i === t.selectedVariant, t.originalParams?.bpm);
            });
        });
    });
    ro.observe(tracksContainer);

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
        const dataArray = new Float32Array(bufferLength);
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
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const expectedW = Math.round(rect.width * dpr);
        const expectedH = Math.round(rect.height * dpr);

        if (canvas.width !== expectedW || canvas.height !== expectedH) {
            canvas.width = expectedW;
            canvas.height = expectedH;
        }

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (w === 0 || h === 0) return;

        // Create gradient
        const gradient = ctx.createLinearGradient(0, 0, w, 0);
        gradient.addColorStop(0, '#10b981');   // green
        gradient.addColorStop(0.7, '#10b981'); // -18dB
        gradient.addColorStop(0.71, '#fbbf24'); // yellow
        gradient.addColorStop(0.9, '#fbbf24');  // -6dB
        gradient.addColorStop(0.91, '#ef4444');  // red
        gradient.addColorStop(1, '#ef4444');

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

    function startMeterLoop() {
        if (meterLoopRunning) return;
        meterLoopRunning = true;
        let lastTime = performance.now();
        function tick() {
            const now = performance.now();
            const dT = Math.min(0.1, (now - lastTime) / 1000);
            lastTime = now;

            // Update master meter
            if (masterAnalyser) {
                updateMeterState(masterAnalyser, masterMeterState, dT);
                const masterCanvas = document.getElementById('master-meter-canvas');
                if (masterCanvas) {
                    drawMeter(masterCanvas, masterMeterState);
                }
            }

            // Update track meters
            tracks.forEach(t => {
                if (t.analyserNode && t.meterState && t.meterCanvas) {
                    updateMeterState(t.analyserNode, t.meterState, dT);
                    drawMeter(t.meterCanvas, t.meterState);
                }
            });

            meterRafId = requestAnimationFrame(tick);
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
        const duration = (v && v.buffer) ? v.buffer.duration : globalDuration;
        updateRemixSlidersRange(duration);

        // Show top controls badge
        const badge = document.getElementById('init-audio-badge');
        const nameEl = document.getElementById('init-audio-name');
        if (badge && nameEl) {
            nameEl.textContent = name;
            badge.style.display = 'flex';
        }

        // Restore the original prompt from the track that generated this audio
        if (track.prompt) {
            promptInput.value = track.prompt;
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
            panel.style.display = panel.id === 'remix-params-variation' ? 'block' : 'none';
        });

        const badge = document.getElementById('init-audio-badge');
        if (badge) {
            badge.style.display = 'none';
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
                panel.style.display = 'none';
            });
            const selectedPanel = document.getElementById(`remix-params-${remixMode}`);
            if (selectedPanel) {
                selectedPanel.style.display = remixMode === 'inpaint' ? 'flex' : 'block';
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
    function bufferToWav(buffer) {
        const numOfChan = buffer.numberOfChannels;
        const length = buffer.length * numOfChan * 2 + 44;
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
        // "data" chunk identifier
        setUint32(0x61746164);
        // chunk length
        setUint32(buffer.length * numOfChan * 2);

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
                view.setInt16(44 + offset, sample, true);
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

    function openExportModal(type) {
        exportActionType = type;
        if (type === 'render') {
            if (exportModalTitle) exportModalTitle.textContent = 'Render Mixdown';
            if (exportFilenameInput) exportFilenameInput.value = 'loopmastersa_mix';
            if (exportLoopsGroup) exportLoopsGroup.style.display = 'flex';
            if (exportFormatGroup) exportFormatGroup.style.display = 'flex';
            if (btnExportConfirm) btnExportConfirm.textContent = 'Render';
        } else {
            if (exportModalTitle) exportModalTitle.textContent = 'Export Loops (ZIP)';
            if (exportFilenameInput) exportFilenameInput.value = 'loopmastersa_loops';
            if (exportLoopsGroup) exportLoopsGroup.style.display = 'none';
            if (exportFormatGroup) exportFormatGroup.style.display = 'none';
            if (btnExportConfirm) btnExportConfirm.textContent = 'Export';
        }
        if (exportModal) exportModal.classList.add('is-visible');
        if (exportFilenameInput) {
            exportFilenameInput.focus();
            exportFilenameInput.select();
        }
    }

    function closeExportModal() {
        if (exportModal) exportModal.classList.remove('is-visible');
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
        if (e.key === 'Escape' && exportModal && exportModal.classList.contains('is-visible')) {
            closeExportModal();
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
            const singleLoopDuration = arrangerModeActive ? (arrangerLengthLoops * globalDuration) : globalDuration;
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
            offlineLimiter.knee.setValueAtTime(0.0, 0);
            offlineLimiter.ratio.setValueAtTime(20.0, 0);
            offlineLimiter.attack.setValueAtTime(0.003, 0);
            offlineLimiter.release.setValueAtTime(0.1, 0);

            const offlineMakeup = offlineCtx.createGain();
            offlineMakeup.gain.setValueAtTime(1.0, 0);

            const offlineVolumeNode = offlineCtx.createGain();
            offlineVolumeNode.gain.value = params.volumeGain;

            // Connect offline master chain
            offlineMasterGain.connect(offlineLimiter);
            offlineLimiter.connect(offlineMakeup);
            offlineMakeup.connect(offlineVolumeNode);
            offlineVolumeNode.connect(offlineCtx.destination);

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

                const source = offlineCtx.createBufferSource();
                source.buffer = v.buffer;
                source.loop = t.looping;
                if (t.looping) {
                    source.loopStart = 0;
                    source.loopEnd = singleLoopDuration;
                }

                // --- REPLICATE DSP EFFECTS ---
                // 0. Filtr Filter
                let lastNode = source;
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
                // 3. Aelapse Delay & Reverb (SEND EFFECT — dry stays at 1.0)
                let offlineAelapseDelayGain = null;
                let offlineAelapseReverbGain = null;
                if (t.aelapseEnabled) {
                    const aelapseSum = offlineCtx.createGain();
                    
                    // Dry path — always 1.0 (send effect, not insert)
                    const aelapseDry = offlineCtx.createGain();
                    aelapseDry.gain.value = 1.0;
                    lastNode.connect(aelapseDry);
                    aelapseDry.connect(aelapseSum);
                    
                    // Delay send path
                    const aelapseDelay = offlineCtx.createDelay(5.0);
                    aelapseDelay.delayTime.setValueAtTime(t.aelapseDelayTime, 0);
                    
                    const aelapseFb = offlineCtx.createGain();
                    aelapseFb.gain.value = t.aelapseFeedback;
                    
                    const aelapseDelayGain = offlineCtx.createGain();
                    aelapseDelayGain.gain.value = t.aelapseDelayMix;
                    offlineAelapseDelayGain = aelapseDelayGain;
                    
                    lastNode.connect(aelapseDelay);
                    aelapseDelay.connect(aelapseFb);
                    aelapseFb.connect(aelapseDelay); // feedback loop
                    aelapseDelay.connect(aelapseDelayGain);
                    aelapseDelayGain.connect(aelapseSum);
                    
                    // Reverb send path
                    const aelapseReverb = offlineCtx.createConvolver();
                    aelapseReverb.buffer = createSpringImpulseResponse(offlineCtx, t.aelapseReverbSize || 2.0, 2.5);
                    
                    const aelapseReverbGain = offlineCtx.createGain();
                    aelapseReverbGain.gain.value = t.aelapseReverbMix;
                    offlineAelapseReverbGain = aelapseReverbGain;
                    
                    lastNode.connect(aelapseReverb);
                    aelapseReverb.connect(aelapseReverbGain);
                    aelapseReverbGain.connect(aelapseSum);
                    
                    lastNode = aelapseSum;
                }

                // --- PAN & LEVEL ---
                const panner = offlineCtx.createStereoPanner();
                panner.pan.value = t.pan;

                const gain = offlineCtx.createGain();
                gain.gain.value = t.level;

                lastNode.connect(panner);
                panner.connect(gain);
                gain.connect(offlineMasterGain);

                source.start(0);
                if (t.looping) {
                    source.stop(contentDuration);
                }

                // Record references for offline parameter automation
                offlineTrackData[t.id] = {
                    gain: gain,
                    panner: panner,
                    filtrBiquad: offlineFiltrBiquad,
                    aelapseDelayGain: offlineAelapseDelayGain,
                    aelapseReverbGain: offlineAelapseReverbGain
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
                                modOffsets[tid] = { level: 0, pan: 0, filter: 0, space: 0 };
                            }
                            modOffsets[tid][slot.param] += offset;
                        }
                    });
                }

                // Apply automations to offline track parameters
                tracks.forEach(track => {
                    const offlineT = offlineTrackData[track.id];
                    if (!offlineT) return;

                    const offsets = modOffsets[track.id] || { level: 0, pan: 0, filter: 0, space: 0 };

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
            const wavBlob = bufferToWav(renderedBuffer);

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
                    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                    s.onload = resolve;
                    s.onerror = reject;
                    document.head.appendChild(s);
                });
            }

            const zip = new JSZip();
            const bpm = parseInt(bpmInput.value) || 120;

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
                zip.file(outFilename, blob);
            }

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
        docsToggle.addEventListener('click', () => {
            docsModule.classList.toggle('is-open');
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
            btnMidiLearn.addEventListener('click', () => {
                requestMIDIAccessLazy();
                midiLearnActive = !midiLearnActive;
                btnMidiLearn.classList.toggle('active', midiLearnActive);
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

            const el = e.target.closest('.level-slider, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .macro-knob, .fx-macro-knob, #master-volume-slider');
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
                localStorage.setItem('loopmaster_midi_mappings', JSON.stringify(midiMappings));
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
            const slider = track.wrapper.querySelector('.level-slider');
            if (slider) slider.value = Math.round(normVal * 100);
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
                panKnob.querySelector('.pan-knob-indicator').style.transform = `rotate(${deg}deg)`;
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

        if (el.classList.contains('level-slider')) return `track-${trackId}-level`;
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

        if (param === 'level') return wrapper.querySelector('.level-slider');
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
            '.level-slider, .filtr-cutoff, .aelapse-delay-mix, .aelapse-reverb-mix, .pan-knob, .macro-knob, .fx-macro-knob, #master-volume-slider'
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

        // Toggle Modulators drawer panel visibility
        const btnToggleModulators = document.getElementById('btn-toggle-modulators');
        if (btnToggleModulators && modulatorsPanel) {
            btnToggleModulators.addEventListener('click', () => {
                const isHidden = modulatorsPanel.style.display === 'none';
                modulatorsPanel.style.display = isHidden ? 'block' : 'none';
                btnToggleModulators.classList.toggle('active', !isHidden);
            });
        }

        // Toggle Song Mode and Arranger visibility
        const toggleArranger = document.getElementById('toggle-arranger');
        const arrangerPanel = document.getElementById('arranger-panel');
            toggleArranger.addEventListener('change', () => {
                arrangerModeActive = toggleArranger.checked;
                arrangerPanel.style.display = arrangerModeActive ? 'flex' : 'none';
                
                const playheadLine = document.getElementById('arranger-playhead-line');
                if (playheadLine) {
                    playheadLine.style.display = arrangerModeActive ? 'block' : 'none';
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
            if (rateSyncRow) rateSyncRow.style.display = isSync ? 'flex' : 'none';
            if (rateFreeRow) rateFreeRow.style.display = isSync ? 'none' : 'flex';

            // On/Off button init
            if (toggleBtn) {
                const enabled = lfoState.enabled !== false;
                lfoState.enabled = enabled;
                toggleBtn.textContent = enabled ? 'On' : 'Off';
                toggleBtn.classList.toggle('is-off', !enabled);
                if (section) {
                    section.classList.toggle('is-bypassed', !enabled);
                }
            }

            if (shapeSelect) {
                shapeSelect.addEventListener('change', () => {
                    globalModulators[`lfo${num}`].shape = shapeSelect.value;
                });
            }
            if (syncToggle) {
                syncToggle.addEventListener('change', () => {
                    const activeSync = syncToggle.checked;
                    globalModulators[`lfo${num}`].mode = activeSync ? 'sync' : 'free';
                    if (rateSyncRow) rateSyncRow.style.display = activeSync ? 'flex' : 'none';
                    if (rateFreeRow) rateFreeRow.style.display = activeSync ? 'none' : 'flex';
                });
            }
            if (rateSyncSelect) {
                rateSyncSelect.addEventListener('change', () => {
                    globalModulators[`lfo${num}`].syncRate = rateSyncSelect.value;
                });
            }
            if (rateFreeSlider) {
                rateFreeSlider.addEventListener('input', () => {
                    const hz = rateFreeSlider.value / 10.0;
                    globalModulators[`lfo${num}`].freeRate = hz;
                    if (rateFreeVal) rateFreeVal.textContent = hz.toFixed(1) + 'Hz';
                });
            }
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const active = globalModulators[`lfo${num}`].enabled;
                    const newActive = !active;
                    globalModulators[`lfo${num}`].enabled = newActive;
                    toggleBtn.textContent = newActive ? 'On' : 'Off';
                    toggleBtn.classList.toggle('is-off', !newActive);
                    if (section) {
                        section.classList.toggle('is-bypassed', !newActive);
                    }
                });
            }
        };

        setupLfoControls(1);
        setupLfoControls(2);
        setupLfoControls(3);
        setupLfoControls(4);

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
        container.style.position = 'relative';

        container.innerHTML = '';
        const numLoops = arrangerLengthLoops;

        const gridEl = document.createElement('div');
        gridEl.className = 'arranger-grid';

        const headerRow = document.createElement('div');
        headerRow.className = 'arranger-row arranger-header-row';
        
        const spacer = document.createElement('div');
        spacer.className = 'arranger-track-label';
        spacer.style.border = 'none';
        spacer.style.background = 'transparent';
        headerRow.appendChild(spacer);

        const cellsHeader = document.createElement('div');
        cellsHeader.className = 'arranger-cells';
        for (let l = 0; l < numLoops; l++) {
            const cell = document.createElement('div');
            cell.className = 'arranger-cell';
            cell.style.border = 'none';
            cell.style.background = 'transparent';
            cell.style.fontSize = '0.6rem';
            cell.style.color = 'var(--text-secondary)';
            cell.style.textAlign = 'center';
            cell.style.lineHeight = '28px';
            cell.textContent = (l + 1).toString();
            cellsHeader.appendChild(cell);
        }

        // Add visual time bar progress div inside header row (cellsHeader)
        const progressEl = document.createElement('div');
        progressEl.className = 'arranger-time-bar-progress';
        progressEl.id = 'arranger-time-bar-progress';
        
        const activeDuration = arrangerModeActive ? (arrangerLengthLoops * globalDuration) : globalDuration;
        const currentProgress = activeDuration > 0 ? (isPlaying ? ((audioCtx.currentTime - playStartCtxTime) % activeDuration) : playOffset) / activeDuration : 0;
        progressEl.style.width = `${currentProgress * 100}%`;
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
        playheadWrapper.style.position = 'absolute';
        playheadWrapper.style.left = '128px';
        playheadWrapper.style.right = '4px';
        playheadWrapper.style.top = '0';
        playheadWrapper.style.bottom = '0';
        playheadWrapper.style.pointerEvents = 'none';

        const playhead = document.createElement('div');
        playhead.className = 'arranger-playhead';
        playhead.id = 'arranger-playhead-line';
        playhead.style.left = `${currentProgress * 100}%`;
        playhead.style.display = arrangerModeActive ? 'block' : 'none';
        
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
        const slider = wrapper.querySelector(sliderSelector);
        if (!slider) return;

        let dot = slider.parentNode.querySelector('.lfo-dot');
        
        let paramName = '';
        if (sliderSelector === '.level-slider') paramName = 'level';
        else if (sliderSelector === '.filtr-cutoff') paramName = 'filter';
        else if (sliderSelector === '.aelapse-delay-mix') paramName = 'space';
        else if (sliderSelector === '.aelapse-reverb-mix') paramName = 'space';

        const isMod = isSliderModulated(track.id, paramName);

        if (!isMod) {
            if (dot) dot.style.display = 'none';
            return;
        }

        if (!dot) {
            dot = document.createElement('div');
            dot.className = 'lfo-dot';
            slider.parentNode.appendChild(dot);
            slider.parentNode.style.position = 'relative';
        }

        dot.style.display = 'block';
        
        const sliderWidth = slider.offsetWidth;
        const sliderHeight = slider.offsetHeight;
        const sliderLeft = slider.offsetLeft;
        const sliderTop = slider.offsetTop;

        const pct = Math.max(0, Math.min(1, normalizedVal));
        const dotLeft = sliderLeft + 6 + pct * (sliderWidth - 12);
        const dotTop = sliderTop + sliderHeight / 2;

        dot.style.left = `${dotLeft}px`;
        dot.style.top = `${dotTop}px`;
    }

    function isSliderModulated(trackId, paramName) {
        const modBypassEl = document.getElementById('toggle-modulators-bypass');
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

    // --- Initialize MIDI and Modulators ---
    initMIDI();
    setupGlobalModulatorsListeners();

})();

