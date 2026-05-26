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

    // --- Init Audio State ---
    let selectedInitAudio = null; // { trackId, variantIndex, filePath, name }

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
        track.el.remove();

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
        source.connect(track.panNode);
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

        // Audio graph: source → panNode → gainNode → analyserNode → masterGain
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;

        const panNode = ctx.createStereoPanner();
        panNode.pan.value = 0;
        panNode.connect(gainNode);

        const analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 1024;
        gainNode.connect(analyserNode);
        analyserNode.connect(masterGain);

        const track = {
            id,
            prompt,
            el: null,
            gainNode,
            panNode,
            analyserNode,
            meterCanvas: null,
            meterState: { rms: -60, peak: -60, peakHold: -60, peakHoldTime: 0 },
            muted: false,
            soloed: false,
            looping: true,
            level: 1.0,
            pan: 0,
            selectedVariant: 0,
            variants: [],
        };

        // Build DOM
        const rowEl = document.createElement('div');
        rowEl.className = 'track-row';

        // --- Mixer strip ---
        const mixerEl = document.createElement('div');
        mixerEl.className = 'mixer-strip';
        mixerEl.innerHTML = `
            <div class="mixer-label" title="${prompt}">${prompt}</div>
            <div class="mixer-buttons">
                <button class="mixer-btn solo-btn" title="Solo">S</button>
                <button class="mixer-btn mute-btn" title="Mute">M</button>
                <button class="mixer-btn loop-btn is-on" title="Loop">L</button>
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

        // Wire mixer controls
        const soloBtn = mixerEl.querySelector('.solo-btn');
        const muteBtn = mixerEl.querySelector('.mute-btn');
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

        const loopBtn = mixerEl.querySelector('.loop-btn');
        loopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            track.looping = !track.looping;
            loopBtn.classList.toggle('is-on', track.looping);
            updateTrackLoopState(track);
        });

        const deleteBtn = mixerEl.querySelector('.delete-btn');
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

        // --- Variants container ---
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
                        <button class="btn-use-init" title="Use as Init Audio" type="button">✨ Init</button>
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

            // Click → select this variant for the row
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

            // Load audio
            loadVariantAudio(variant, `/outputs/${filePath}`, i === 0);
        });

        rowEl.appendChild(variantsEl);
        track.el = rowEl;
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

    if (btnRandomPrompt) {
        btnRandomPrompt.addEventListener('click', () => {
            const inst = instruments[Math.floor(Math.random() * instruments.length)];
            const style = styles[Math.floor(Math.random() * styles.length)];
            let generated = "";
            if (Math.random() < 0.5) {
                const key = keys[Math.floor(Math.random() * keys.length)];
                generated = `solo ${inst} ${style} in ${key}`;
            } else {
                const chord = chords[Math.floor(Math.random() * chords.length)];
                generated = `solo ${inst} ${style} playing ${chord}`;
            }
            promptInput.value = generated;
            promptInput.focus();
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
        tracksContainer.appendChild(track.el);

        btnPlayPause.disabled = false;
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

})();
