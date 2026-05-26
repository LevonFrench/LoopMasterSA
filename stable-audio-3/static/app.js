/* ============================================================
   Stable Audio 3 — Multi-Track Grid Generator
   Simultaneous playback with per-row mixer (solo/mute/pan/level)
   ============================================================ */

(function () {
    'use strict';

    // --- DOM ---
    const promptInput   = document.getElementById('prompt-input');
    const bpmInput      = document.getElementById('bpm-input');
    const durationLabel = document.getElementById('duration-label');
    const variantsInput = document.getElementById('variants-input');
    const loopToggle    = document.getElementById('loop-toggle');
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
    const btnRenderMix = document.getElementById('btn-render-mix');

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
    let masterAnalyser = null;
    let masterMeterState = { rms: -60, peak: -60, peakHold: -60, peakHoldTime: 0 };
    let meterLoopRunning = false;
    let meterRafId = null;

    // --- Init Audio & Prompt State ---
    let selectedInitAudio = null; // { trackId, variantIndex, filePath, name }
    let currentKeyOrChord = null; // { type: 'key' | 'chord', value: string }

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
        durationLabel.textContent = `4 bars = ${globalDuration.toFixed(2)}s`;
        tDuration.textContent = formatTime(globalDuration);
        
        // Update delay times for all tracks to keep them tempo-synced!
        const delayTimeSec = 45.0 / bpm; // Dotted eighth note
        tracks.forEach(t => {
            t.aelapseDelayTime = delayTimeSec;
            if (t.aelapseDelayNode) {
                t.aelapseDelayNode.delayTime.setValueAtTime(delayTimeSec, audioCtx.currentTime);
            }
            if (t.wrapper) {
                const syncDisplay = t.wrapper.querySelector('.aelapse-sync-time');
                if (syncDisplay) {
                    syncDisplay.textContent = `${delayTimeSec.toFixed(2)}s (Dotted 8th)`;
                }
            }
        });
    }

    function ensureAudioCtx() {
        if (!audioCtx) {
            audioCtx = new AudioContext();
            
            // Create master nodes
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 1.0;

            masterLimiter = audioCtx.createDynamicsCompressor();
            masterLimiter.threshold.setValueAtTime(-11.0, audioCtx.currentTime);
            masterLimiter.knee.setValueAtTime(0.0, audioCtx.currentTime);
            masterLimiter.ratio.setValueAtTime(20.0, audioCtx.currentTime);
            masterLimiter.attack.setValueAtTime(0.003, audioCtx.currentTime);
            masterLimiter.release.setValueAtTime(0.1, audioCtx.currentTime);

            masterMakeup = audioCtx.createGain();
            masterMakeup.gain.setValueAtTime(Math.pow(10, 11 / 20), audioCtx.currentTime);

            masterAnalyser = audioCtx.createAnalyser();
            masterAnalyser.fftSize = 1024;

            // Connect master chain: masterGain -> masterLimiter -> masterMakeup -> masterAnalyser -> destination
            masterGain.connect(masterLimiter);
            masterLimiter.connect(masterMakeup);
            masterMakeup.connect(masterAnalyser);
            masterAnalyser.connect(audioCtx.destination);

            // Show master meter section
            const masterMeterSection = document.getElementById('master-meter-section');
            if (masterMeterSection) {
                masterMeterSection.style.display = 'flex';
            }

            // Start meter animation loop
            startMeterLoop();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    // --- BPM ---
    bpmInput.addEventListener('input', updateDurationLabel);
    updateDurationLabel();

    // --- Loop toggle ---
    loopToggle.addEventListener('click', () => {
        generateLoop = !generateLoop;
        loopToggle.classList.toggle('is-on', generateLoop);
        loopToggle.querySelector('.toggle-label').textContent = generateLoop ? 'On' : 'Off';
    });
    loopToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loopToggle.click(); }
    });

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

    btnStopAll.addEventListener('click', () => {
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

    function deleteTrackRow(track) {
        // Stop playback of this track immediately
        stopTrackSource(track);

        // Disconnect Web Audio nodes to free resources
        try {
            track.panNode.disconnect();
            track.gainNode.disconnect();
            if (track.analyserNode) {
                track.analyserNode.disconnect();
            }
        } catch (_) {}

        // Remove from DOM
        track.wrapper.remove();

        // Remove from tracks array
        tracks = tracks.filter(t => t.id !== track.id);

        // Update Mixer Mute/Solo state (in case this track was soloed)
        updateMixerState();

        // Call backend API to delete files from disk
        fetch(`/api/delete_track/${track.id}`, { method: 'POST' })
            .then(res => {
                if (!res.ok) console.error(`Failed to delete track ${track.id} from disk`);
            })
            .catch(err => console.error(err));

        // If no tracks left, show empty state
        if (tracks.length === 0) {
            tracksContainer.classList.add('empty');
            tracksContainer.innerHTML = `
                <div class="grid-empty-state">
                    <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>
                    <div>Enter a prompt and hit <strong>Generate</strong> to add a track</div>
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
                drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, false);
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
            drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, i === variantIndex);
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
        playOffset = pct * globalDuration;
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
    function startRAF() {
        cancelRAF();
        function tick() {
            updatePlayheads();
            rafId = requestAnimationFrame(tick);
        }
        rafId = requestAnimationFrame(tick);
    }

    function cancelRAF() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function updatePlayheads() {
        let currentTime;
        if (isPlaying && audioCtx) {
            currentTime = (audioCtx.currentTime - playStartCtxTime) % globalDuration;
        } else {
            currentTime = playOffset;
        }

        const pct = globalDuration > 0 ? currentTime / globalDuration : 0;
        tPosition.textContent = formatTime(currentTime);

        // Update all card playheads
        tracks.forEach(t => {
            t.variants.forEach(v => {
                const seekBar = v.el.querySelector('.card-seek-bar');
                if (seekBar) seekBar.style.setProperty('--progress', pct.toString());
            });
        });
    }

    // --- Waveform ---
    function drawWaveform(canvas, buffer, isSelected) {
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

        const data = buffer.getChannelData(0);
        const samples = data.length;
        const barCount = Math.max(1, Math.floor(w / 2.5));
        const samplesPerBar = Math.floor(samples / barCount);

        ctx.fillStyle = isSelected
            ? 'rgba(59, 130, 246, 0.55)'
            : 'rgba(59, 130, 246, 0.25)';

        for (let i = 0; i < barCount; i++) {
            let max = 0;
            const start = i * samplesPerBar;
            const end = Math.min(start + samplesPerBar, samples);
            for (let j = start; j < end; j++) {
                const abs = Math.abs(data[j]);
                if (abs > max) max = abs;
            }
            const barH = max * h * 0.85;
            const y = (h - barH) / 2;
            ctx.fillRect(i * (w / barCount), y, Math.max(1, w / barCount - 1), barH);
        }
    }

    // --- Create a track row ---
    function createTrackRow(prompt, batchFiles, trackNum) {
        const ctx = ensureAudioCtx();
        const id = trackNum;

        // 1. Core Web Audio Nodes
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;

        const panNode = ctx.createStereoPanner();
        panNode.pan.value = 0;
        panNode.connect(gainNode);

        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 1024;
        gainNode.connect(analyserNode);
        analyserNode.connect(masterGain);

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
        const fxInputNode = eqFilters[0];
        const eqOutputNode = eqFilters[5];

        // 3. DSP Chain Stage B: Valentine Compressor & Saturator (Split dry/wet)
        const valentineDryGain = ctx.createGain();
        valentineDryGain.gain.value = 1.0;
        
        const valentineDrive = ctx.createGain();
        valentineDrive.gain.value = 1.0;
        
        const valentineShaper = ctx.createWaveShaper();
        valentineShaper.curve = makeDistortionCurve(15);
        
        const valentineCompressor = ctx.createDynamicsCompressor();
        valentineCompressor.threshold.value = 0.0; // off by default
        valentineCompressor.knee.value = 0.0;
        valentineCompressor.ratio.value = 4.0;
        valentineCompressor.attack.value = 0.003;
        valentineCompressor.release.value = 0.1;
        
        const valentineWetGain = ctx.createGain();
        valentineWetGain.gain.value = 0.0; // dry by default
        
        const valentineSumGain = ctx.createGain();
        
        eqOutputNode.connect(valentineDryGain);
        valentineDryGain.connect(valentineSumGain);
        
        eqOutputNode.connect(valentineDrive);
        valentineDrive.connect(valentineShaper);
        valentineShaper.connect(valentineCompressor);
        valentineCompressor.connect(valentineWetGain);
        valentineWetGain.connect(valentineSumGain);

        // 4. DSP Chain Stage C: Aelapse Delay & Spring Reverb (Parallel dry, delay, reverb)
        const aelapseDryGain = ctx.createGain();
        aelapseDryGain.gain.value = 1.0;
        
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
        
        const fxOutputNode = ctx.createGain();
        
        valentineSumGain.connect(aelapseDryGain);
        aelapseDryGain.connect(fxOutputNode);
        
        valentineSumGain.connect(aelapseDelay);
        aelapseDelay.connect(aelapseFeedbackNode);
        aelapseFeedbackNode.connect(aelapseDelay);
        aelapseDelay.connect(aelapseDelayGain);
        aelapseDelayGain.connect(fxOutputNode);
        
        valentineSumGain.connect(aelapseReverb);
        aelapseReverb.connect(aelapseReverbGain);
        aelapseReverbGain.connect(fxOutputNode);

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
            level: 1.0,
            pan: 0,
            selectedVariant: 0,
            variants: [],
            
            // FX state values for offline rendering
            eqGains: [0, 0, 0, 0, 0, 0],
            valentineDriveVal: 1.0,
            valentineThresh: 0,
            valentineRatio: 4,
            valentineMix: 0.0,
            aelapseDelayTime: initialDelayTime,
            aelapseFeedback: 0.3,
            aelapseDelayMix: 0.0,
            aelapseReverbMix: 0.0,
            aelapseReverbSize: 2.0
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
                <button class="mixer-btn loop-btn is-on" title="Loop">L</button>
                <button class="mixer-btn fx-btn" title="Toggle FX Drawer">FX</button>
                <button class="mixer-btn delete-btn" title="Delete Track">×</button>
            </div>
            <div class="mixer-level">
                <label>Vol</label>
                <input type="range" class="level-slider" min="0" max="100" value="100" step="1">
                <span class="level-value">100</span>
            </div>
            <div class="mixer-pan">
                <label>Pan</label>
                <input type="range" class="pan-slider" min="-100" max="100" value="0" step="1">
                <span class="pan-value">C</span>
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
                <div class="fx-section-title">Macro Controls</div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Space</label><input type="range" class="macro-space-slider" min="0" max="100" value="0" step="1"><span class="macro-space-val">0%</span></div>
                    <div class="fx-control-row"><label>Drive</label><input type="range" class="macro-drive-slider" min="0" max="100" value="0" step="1"><span class="macro-drive-val">0%</span></div>
                    <div class="fx-control-row"><label>Tone</label><input type="range" class="macro-tone-slider" min="0" max="100" value="50" step="1"><span class="macro-tone-val">Flat</span></div>
                </div>
            </div>
            <div class="fx-section eq-section">
                <div class="fx-section-title">Luftikus Analog EQ</div>
                <div class="fx-controls-grid eq-sliders-grid">
                    <div class="fx-control-row"><label>10 Hz</label><input type="range" class="eq-slider" data-band="0" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>40 Hz</label><input type="range" class="eq-slider" data-band="1" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>160 Hz</label><input type="range" class="eq-slider" data-band="2" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>640 Hz</label><input type="range" class="eq-slider" data-band="3" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>2.5 kHz</label><input type="range" class="eq-slider" data-band="4" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                    <div class="fx-control-row"><label>Air Band</label><input type="range" class="eq-slider" data-band="5" min="-12" max="12" value="0" step="0.5"><span class="eq-val">0.0dB</span></div>
                </div>
            </div>
            <div class="fx-section valentine-section">
                <div class="fx-section-title">Valentine Distortion & Compressor</div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Drive</label><input type="range" class="valentine-drive" min="1" max="10" value="1" step="0.1"><span class="val-drive-val">1.0x</span></div>
                    <div class="fx-control-row"><label>Thresh</label><input type="range" class="valentine-thresh" min="-40" max="0" value="0" step="1"><span class="val-thresh-val">0dB (off)</span></div>
                    <div class="fx-control-row"><label>Ratio</label><input type="range" class="valentine-ratio" min="1" max="20" value="4" step="0.5"><span class="val-ratio-val">4.0:1</span></div>
                    <div class="fx-control-row"><label>Mix</label><input type="range" class="valentine-mix" min="0" max="100" value="0" step="1"><span class="val-mix-val">0%</span></div>
                </div>
            </div>
            <div class="fx-section aelapse-section">
                <div class="fx-section-title">Ælapse Tape Delay & Spring Reverb</div>
                <div class="fx-controls-grid">
                    <div class="fx-control-row"><label>Sync Delay</label><span class="aelapse-sync-time" style="width: auto; flex: 1; text-align: left; padding-left: 6px;">${initialDelayTime.toFixed(2)}s (Dotted 8th)</span></div>
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
        const loopBtn = mixerEl.querySelector('.loop-btn');
        const fxBtn = mixerEl.querySelector('.fx-btn');
        const deleteBtn = mixerEl.querySelector('.delete-btn');
        const levelSlider = mixerEl.querySelector('.level-slider');
        const levelValue = mixerEl.querySelector('.level-value');
        const panSlider = mixerEl.querySelector('.pan-slider');
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

        loopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.looping = !track.looping;
            loopBtn.classList.toggle('is-on', track.looping);
            updateTrackLoopState(track);
        });

        fxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = fxDrawerEl.style.display !== 'none';
            fxDrawerEl.style.display = isOpen ? 'none' : 'flex';
            fxBtn.classList.toggle('is-on', !isOpen);
        });

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete this track ("${prompt}")?`)) {
                deleteTrackRow(track);
            }
        });

        levelSlider.addEventListener('input', () => {
            track.level = parseInt(levelSlider.value) / 100;
            levelValue.textContent = levelSlider.value;
            updateMixerState();
        });

        panSlider.addEventListener('input', () => {
            const v = parseInt(panSlider.value);
            track.pan = v / 100;
            track.panNode.pan.value = track.pan;
            panValue.textContent = v === 0 ? 'C' : v < 0 ? `L${Math.abs(v)}` : `R${v}`;
        });

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

        const valDrive = fxDrawerEl.querySelector('.valentine-drive');
        const valDriveVal = fxDrawerEl.querySelector('.val-drive-val');
        valDrive.addEventListener('input', () => {
            const val = parseFloat(valDrive.value);
            valDriveVal.textContent = val.toFixed(1) + 'x';
            track.valentineDriveVal = val;
            valentineDrive.gain.value = val;
            valentineShaper.curve = makeDistortionCurve(val * 15);
        });

        const valThresh = fxDrawerEl.querySelector('.valentine-thresh');
        const valThreshVal = fxDrawerEl.querySelector('.val-thresh-val');
        valThresh.addEventListener('input', () => {
            const val = parseFloat(valThresh.value);
            valThreshVal.textContent = val === 0 ? '0dB (off)' : val + 'dB';
            track.valentineThresh = val;
            valentineCompressor.threshold.value = val;
        });

        const valRatio = fxDrawerEl.querySelector('.valentine-ratio');
        const valRatioVal = fxDrawerEl.querySelector('.val-ratio-val');
        valRatio.addEventListener('input', () => {
            const val = parseFloat(valRatio.value);
            valRatioVal.textContent = val.toFixed(1) + ':1';
            track.valentineRatio = val;
            valentineCompressor.ratio.value = val;
        });

        const valMix = fxDrawerEl.querySelector('.valentine-mix');
        const valMixVal = fxDrawerEl.querySelector('.val-mix-val');
        valMix.addEventListener('input', () => {
            const pct = parseFloat(valMix.value) / 100;
            valMixVal.textContent = valMix.value + '%';
            track.valentineMix = pct;
            valentineDryGain.gain.value = 1 - pct;
            valentineWetGain.gain.value = pct;
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
            aelapseDelayGain.gain.value = pct;
            aelapseDryGain.gain.value = 1 - Math.max(track.aelapseDelayMix, track.aelapseReverbMix);
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
            aelapseReverbGain.gain.value = pct;
            aelapseDryGain.gain.value = 1 - Math.max(track.aelapseDelayMix, track.aelapseReverbMix);
        });

        // 12. Wire Macro Controls
        const macroSpace = fxDrawerEl.querySelector('.macro-space-slider');
        const macroSpaceVal = fxDrawerEl.querySelector('.macro-space-val');
        const macroDrive = fxDrawerEl.querySelector('.macro-drive-slider');
        const macroDriveVal = fxDrawerEl.querySelector('.macro-drive-val');
        const macroTone = fxDrawerEl.querySelector('.macro-tone-slider');
        const macroToneVal = fxDrawerEl.querySelector('.macro-tone-val');

        macroSpace.addEventListener('input', () => {
            const val = parseInt(macroSpace.value);
            macroSpaceVal.textContent = val + '%';
            
            const delayMixVal = val;
            const reverbMixVal = val;
            const reverbSizeVal = Math.round(5 + (45 * val / 100)); // 0.5s to 5.0s -> 5 to 50
            
            const delayMixSlider = fxDrawerEl.querySelector('.aelapse-mix');
            const reverbMixSlider = fxDrawerEl.querySelector('.aelapse-reverb-mix');
            const reverbSizeSlider = fxDrawerEl.querySelector('.aelapse-size');
            
            if (delayMixSlider) {
                delayMixSlider.value = delayMixVal;
                delayMixSlider.dispatchEvent(new Event('input'));
            }
            if (reverbMixSlider) {
                reverbMixSlider.value = reverbMixVal;
                reverbMixSlider.dispatchEvent(new Event('input'));
            }
            if (reverbSizeSlider) {
                reverbSizeSlider.value = reverbSizeVal;
                reverbSizeSlider.dispatchEvent(new Event('input'));
            }
        });

        macroDrive.addEventListener('input', () => {
            const val = parseInt(macroDrive.value);
            macroDriveVal.textContent = val + '%';
            
            const driveMultiplier = 1.0 + (9.0 * val / 100); // 1.0x to 10.0x
            const thresholdVal = Math.round(-40 * val / 100); // 0dB to -40dB
            const compressorMixVal = val; // 0% to 100%
            
            const driveSlider = fxDrawerEl.querySelector('.valentine-drive');
            const threshSlider = fxDrawerEl.querySelector('.valentine-thresh');
            const mixSlider = fxDrawerEl.querySelector('.valentine-mix');
            
            if (driveSlider) {
                driveSlider.value = driveMultiplier;
                driveSlider.dispatchEvent(new Event('input'));
            }
            if (threshSlider) {
                threshSlider.value = thresholdVal;
                threshSlider.dispatchEvent(new Event('input'));
            }
            if (mixSlider) {
                mixSlider.value = compressorMixVal;
                mixSlider.dispatchEvent(new Event('input'));
            }
        });

        macroTone.addEventListener('input', () => {
            const val = parseInt(macroTone.value);
            if (val === 50) {
                macroToneVal.textContent = 'Flat';
            } else if (val < 50) {
                macroToneVal.textContent = 'Dark';
            } else {
                macroToneVal.textContent = 'Bright';
            }
            
            const eqSlidersList = fxDrawerEl.querySelectorAll('.eq-slider');
            if (eqSlidersList.length === 6) {
                let bandGains = [0, 0, 0, 0, 0, 0];
                if (val < 50) {
                    const factor = (50 - val) / 50;
                    bandGains = [6.0 * factor, 6.0 * factor, 4.0 * factor, 0, -6.0 * factor, -6.0 * factor];
                } else if (val > 50) {
                    const factor = (val - 50) / 50;
                    bandGains = [-6.0 * factor, -6.0 * factor, -3.0 * factor, 0, 6.0 * factor, 8.0 * factor];
                }
                
                eqSlidersList.forEach((slider, b) => {
                    slider.value = bandGains[b];
                    slider.dispatchEvent(new Event('input'));
                });
            }
        });

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
                    <div style="display: flex; align-items: center;">
                        <button class="btn-use-init" title="Use as Init Audio" type="button"><svg class="btn-icon" viewBox="0 0 24 24" width="10" height="10" fill="currentColor" style="margin-right: 3px; display: inline-block; vertical-align: middle;"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg>Init</button>
                        <span class="card-variant-num">#${i + 1}</span>
                    </div>
                </div>
                <div class="card-seek-bar">
                    <canvas class="card-waveform"></canvas>
                    <div class="card-progress-fill"></div>
                    <div class="card-playhead"></div>
                </div>
            `;

            const variant = {
                name,
                buffer: null,
                el: cardEl,
                sourceNode: null,
            };
            track.variants.push(variant);
            variantsEl.appendChild(cardEl);

            cardEl.addEventListener('click', (e) => {
                const seekBar = cardEl.querySelector('.card-seek-bar');
                const seekRect = seekBar.getBoundingClientRect();
                const inSeekBar = e.clientX >= seekRect.left && e.clientX <= seekRect.right
                               && e.clientY >= seekRect.top  && e.clientY <= seekRect.bottom;

                selectVariant(track, i);

                if (inSeekBar) {
                    const pct = Math.max(0, Math.min(1, (e.clientX - seekRect.left) / seekRect.width));
                    seekTo(pct);
                }

                if (!isPlaying) playAll();
            });

            const useInitBtn = cardEl.querySelector('.btn-use-init');
            if (useInitBtn) {
                useInitBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setInitAudio(track, i, filePath, name);
                });
            }

            loadVariantAudio(variant, `/outputs/${filePath}`, i === 0);
        });

        rowEl.appendChild(variantsEl);
        wrapperEl.appendChild(rowEl);
        wrapperEl.appendChild(fxDrawerEl);

        track.el = rowEl;
        track.wrapper = wrapperEl;
        return track;
    }

    async function loadVariantAudio(variant, url, isSelected) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            const ctx = ensureAudioCtx();
            variant.buffer = await ctx.decodeAudioData(buf);
            variant.el.classList.remove('is-loading');
            drawWaveform(variant.el.querySelector('.card-waveform'), variant.buffer, isSelected);
        } catch (err) {
            console.error(`Failed to load ${variant.name}:`, err);
            variant.el.classList.remove('is-loading');
            variant.el.querySelector('.card-title').textContent += ' (err)';
        }
    }

    // --- Random Prompt Generator ---
    const instruments = [
        'acoustic guitar', 'electric guitar', 'grand piano', 'synth lead', 
        'funky bass guitar', 'saxophone', 'trumpet', 'flute', 'violin', 
        'cello', 'drum kit', 'hammond organ', 'fender rhodes piano', 
        'analog synthesizer', 'marimba', 'acoustic double bass', 'classical harp'
    ];
    
    const styles = [
        'bluesy licks', 'funky riffs', 'jazz improvisation', 'ambient soundscapes', 
        'classical melody runs', 'chillhop beat elements', 'hyperpop sequence loops', 
        'lofi chords', 'synthwave arpeggios', 'psychedelic rock runs', 
        'soulful themes', 'melancholic motifs', 'groovy patterns', 'moody hooks'
    ];
    
    const keys = [
        'C major', 'A minor', 'G major', 'E minor', 'F major', 'D minor', 
        'D major', 'B minor', 'A major', 'F# minor', 'Bb major', 'G minor'
    ];
    
    const chords = [
        'Cmaj7 to Fmaj7 chord progression', 'Am9 to Dm9 chord sequence', 
        'G7 to Cmaj7 jazz turnaround', 'Fmaj7 chord changes', 'Emin7 to A7 pattern', 
        'Bbmaj7 to Ebmaj7 progression', 'minor 7th arpeggios', 'major 7th voicings'
    ];

    function generateRandomPrompt(keepKey = false) {
        const inst = instruments[Math.floor(Math.random() * instruments.length)];
        const style = styles[Math.floor(Math.random() * styles.length)];
        
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
            generated = `solo ${inst} ${style} in ${currentKeyOrChord.value}`;
        } else {
            generated = `solo ${inst} ${style} playing ${currentKeyOrChord.value}`;
        }
        
        if (btnRandomInKey) {
            const displayVal = currentKeyOrChord.value.length > 15 
                ? currentKeyOrChord.value.substring(0, 12) + '...'
                : currentKeyOrChord.value;
            btnRandomInKey.innerHTML = `<svg class="btn-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg> ${displayVal}`;
            btnRandomInKey.title = `Generate Random Prompt in ${currentKeyOrChord.value}`;
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
        const numVariants = parseInt(variantsInput.value) || 4;
        const loop = generateLoop;

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
                duration_padding_sec: 6.0
            };
            if (selectedInitAudio) {
                bodyPayload.init_audio_path = selectedInitAudio.filePath;
                const noiseSlider = document.getElementById('init-noise-slider');
                bodyPayload.init_noise_level = noiseSlider ? parseInt(noiseSlider.value) / 100 : 0.60;
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
            showStatus(`Generating ${numVariants} variants…`);

            const result = await pollJob(job_id);
            if (result.status === 'error') throw new Error(result.error || 'Failed');

            showStatus(`Done in ${result.elapsed?.toFixed(1) || '?'}s`, 'done');
            addTrackRow(result.files, prompt, result.track_num);
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

    function addTrackRow(files, prompt, trackNum) {
        tracksContainer.classList.remove('empty');
        const empty = tracksContainer.querySelector('.grid-empty-state');
        if (empty) empty.remove();

        const track = createTrackRow(prompt, files, trackNum);
        tracks.push(track);
        tracksContainer.appendChild(track.wrapper);

        btnPlayPause.disabled = false;
        if (btnRenderMix) btnRenderMix.disabled = false;
        updateDurationLabel();
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
                drawWaveform(v.el.querySelector('.card-waveform'), v.buffer, i === t.selectedVariant);
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

        // Show top controls badge
        const badge = document.getElementById('init-audio-badge');
        const nameEl = document.getElementById('init-audio-name');
        if (badge && nameEl) {
            nameEl.textContent = name;
            badge.style.display = 'flex';
        }
    }

    function clearInitAudio() {
        selectedInitAudio = null;
        document.querySelectorAll('.btn-use-init').forEach(btn => {
            btn.classList.remove('is-active');
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

        // Write PCM audio samples
        while (pos < buffer.length) {
            for (i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][pos]));
                sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(44 + offset, sample, true);
                offset += 2;
            }
            pos++;
        }

        return new Blob([bufferArr], { type: 'audio/wav' });
    }

    if (btnRenderMix) {
        btnRenderMix.addEventListener('click', async () => {
            if (tracks.length === 0) return;
            const originalHTML = btnRenderMix.innerHTML;
            btnRenderMix.innerHTML = 'Rendering...';
            btnRenderMix.disabled = true;

            try {
                const currentCtx = ensureAudioCtx();
                const sampleRate = currentCtx.sampleRate;
                const duration = globalDuration;
                const offlineCtx = new OfflineAudioContext(2, sampleRate * duration, sampleRate);

                // Create master chain on offline context
                const offlineMasterGain = offlineCtx.createGain();
                offlineMasterGain.gain.value = 1.0;

                const offlineLimiter = offlineCtx.createDynamicsCompressor();
                offlineLimiter.threshold.setValueAtTime(-11.0, 0);
                offlineLimiter.knee.setValueAtTime(0.0, 0);
                offlineLimiter.ratio.setValueAtTime(20.0, 0);
                offlineLimiter.attack.setValueAtTime(0.003, 0);
                offlineLimiter.release.setValueAtTime(0.1, 0);

                const offlineMakeup = offlineCtx.createGain();
                offlineMakeup.gain.setValueAtTime(Math.pow(10, 11 / 20), 0);

                // Connect offline master chain
                offlineMasterGain.connect(offlineLimiter);
                offlineLimiter.connect(offlineMakeup);
                offlineMakeup.connect(offlineCtx.destination);

                // Connect all active tracks
                const anySoloed = tracks.some(t => t.soloed);

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
                        source.loopEnd = duration;
                    }

                    // --- REPLICATE DSP EFFECTS ---
                    // 1. Luftikus EQ (6-band)
                    let lastNode = source;
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

                    // 2. Valentine Compressor & Saturator (Split dry/wet)
                    const valentineDry = offlineCtx.createGain();
                    valentineDry.gain.value = 1 - t.valentineMix;
                    
                    const valentineDrive = offlineCtx.createGain();
                    valentineDrive.gain.value = t.valentineDriveVal;
                    
                    const valentineShaper = offlineCtx.createWaveShaper();
                    valentineShaper.curve = makeDistortionCurve(t.valentineDriveVal * 15);
                    
                    const valentineComp = offlineCtx.createDynamicsCompressor();
                    valentineComp.threshold.setValueAtTime(t.valentineThresh, 0);
                    valentineComp.knee.setValueAtTime(0.0, 0);
                    valentineComp.ratio.setValueAtTime(t.valentineRatio, 0);
                    valentineComp.attack.setValueAtTime(0.003, 0);
                    valentineComp.release.setValueAtTime(0.1, 0);
                    
                    const valentineWet = offlineCtx.createGain();
                    valentineWet.gain.value = t.valentineMix;
                    
                    const valentineSum = offlineCtx.createGain();
                    
                    lastNode.connect(valentineDry);
                    valentineDry.connect(valentineSum);
                    
                    lastNode.connect(valentineDrive);
                    valentineDrive.connect(valentineShaper);
                    valentineShaper.connect(valentineComp);
                    valentineComp.connect(valentineWet);
                    valentineWet.connect(valentineSum);
                    
                    lastNode = valentineSum;

                    // 3. Aelapse Delay & Reverb
                    const aelapseSum = offlineCtx.createGain();
                    
                    // Dry path
                    const aelapseDry = offlineCtx.createGain();
                    aelapseDry.gain.value = 1 - Math.max(t.aelapseDelayMix, t.aelapseReverbMix);
                    lastNode.connect(aelapseDry);
                    aelapseDry.connect(aelapseSum);
                    
                    // Delay path
                    const aelapseDelay = offlineCtx.createDelay(5.0);
                    aelapseDelay.delayTime.setValueAtTime(t.aelapseDelayTime, 0);
                    
                    const aelapseFb = offlineCtx.createGain();
                    aelapseFb.gain.value = t.aelapseFeedback;
                    
                    const aelapseDelayGain = offlineCtx.createGain();
                    aelapseDelayGain.gain.value = t.aelapseDelayMix;
                    
                    lastNode.connect(aelapseDelay);
                    aelapseDelay.connect(aelapseFb);
                    aelapseFb.connect(aelapseDelay); // feedback loop
                    aelapseDelay.connect(aelapseDelayGain);
                    aelapseDelayGain.connect(aelapseSum);
                    
                    // Reverb path
                    const aelapseReverb = offlineCtx.createConvolver();
                    aelapseReverb.buffer = createSpringImpulseResponse(offlineCtx, t.aelapseReverbSize || 2.0, 2.5);
                    
                    const aelapseReverbGain = offlineCtx.createGain();
                    aelapseReverbGain.gain.value = t.aelapseReverbMix;
                    
                    lastNode.connect(aelapseReverb);
                    aelapseReverb.connect(aelapseReverbGain);
                    aelapseReverbGain.connect(aelapseSum);
                    
                    lastNode = aelapseSum;

                    // --- PAN & LEVEL ---
                    const panner = offlineCtx.createStereoPanner();
                    panner.pan.value = t.pan;

                    const gain = offlineCtx.createGain();
                    gain.gain.value = t.level;

                    lastNode.connect(panner);
                    panner.connect(gain);
                    gain.connect(offlineMasterGain);

                    source.start(0);
                });

                const renderedBuffer = await offlineCtx.startRendering();
                const wavBlob = bufferToWav(renderedBuffer);

                const bpm = parseInt(bpmInput.value) || 120;
                const blobUrl = URL.createObjectURL(wavBlob);
                const link = document.createElement('a');
                link.href = blobUrl;
                link.download = `loopmastersa_mix_${bpm}bpm.wav`;
                link.click();
                URL.revokeObjectURL(blobUrl);

            } catch (err) {
                console.error('Failed to render mix:', err);
                alert('Failed to render mix: ' + err.message);
            } finally {
                btnRenderMix.innerHTML = originalHTML;
                btnRenderMix.disabled = false;
            }
        });
    }

})();

