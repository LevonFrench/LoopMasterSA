import "./app.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { wireTheme } from "./theme";
import { sniffAudioFormatBytes, type AudioFormat } from "./audio-formats";
import { createWebAudioPlayer, type WebAudioPlayer } from "./web-audio-player";
import { extractMetadata, METADATA_HEADER_BYTES } from "./metadata";
import { createAudioContextPublisher, type AudioContextPublisher } from "./audio-context-publisher";
import { createInstanceCoordinator } from "./instance-coordinator";
import { parseDisplayAudioGridInit, type DisplayAudioGridInit, type GridTrack } from "./display-audio-init";
import { createChunkStore, type ChunkStore } from "./chunk-store";
import { createChunkBus, type ChunkBus, type ChunkEvent } from "./chunk-bus";
import { createChunkLoader, type ChunkLoader } from "./chunk-loader";
import { createChunkedSource } from "./chunked-source";
import { createWaveformForCanvas, type Waveform } from "./waveform";
import { formatTime } from "./time-display";

const playPauseBtn = document.querySelector("#play-pause") as HTMLButtonElement;
const positionEl = document.querySelector("#position") as HTMLElement;
const durationEl = document.querySelector("#duration") as HTMLElement;
const gridContainer = document.querySelector("#grid-container") as HTMLElement;
const errorBannerEl = document.querySelector("#error-banner") as HTMLElement;
const errorDetailEl = errorBannerEl.querySelector(".error-detail") as HTMLElement;

type DecodeErrorKind =
    | "unsupported"
    | "decode-failed"
    | "playback-unsupported";

function renderErrorDetail(kind: DecodeErrorKind, message?: string): string {
    const base =
        kind === "unsupported"
            ? "The file format is not supported."
            : kind === "playback-unsupported"
              ? "Playback of this file is not supported in this browser."
              : "The file could not be decoded.";
    const msg = message?.replace(/[\r\n\t]+/g, " ").trim();
    return msg ? `${base.slice(0, -1)} (${msg}).` : base;
}

function showError(kind: DecodeErrorKind, message?: string): void {
    playPauseBtn.hidden = true;
    gridContainer.hidden = true;
    errorBannerEl.hidden = false;
    errorDetailEl.textContent = renderErrorDetail(kind, message);
}

function hideError(): void {
    playPauseBtn.hidden = false;
    gridContainer.hidden = false;
    errorBannerEl.hidden = true;
    errorDetailEl.textContent = "";
}

const app = new App({ name: "Audio Grid App", version: "1.0.0" });
const connected = app.connect();
wireTheme(app, connected);
const coordinator = createInstanceCoordinator(app);
window.addEventListener("pagehide", () => coordinator.destroy(), { once: true });

let keyWarned = false;
let sharedCtx: AudioContext | null = null;

function getSharedContext(): AudioContext {
    if (!sharedCtx) {
        sharedCtx = new AudioContext();
    }
    return sharedCtx;
}

type TrackState = {
    path: string;
    name: string;
    sizeBytes: number;
    store: ChunkStore;
    loader: ChunkLoader;
    chunkBus: ChunkBus;
    format: AudioFormat | null;
    duration: number;
    player: WebAudioPlayer;
    cardEl: HTMLElement;
    seekBarEl: HTMLElement;
    playheadEl: HTMLElement;
    waveform: Waveform;
};

let tracks: TrackState[] = [];
let activeTrackIndex = -1;
let currentProgress = 0; // 0 to 1
let loadGen = 0;

let publisher: AudioContextPublisher | null = null;
let currentActivePlayer: WebAudioPlayer | null = null;

const onTimeUpdate = () => {
    if (!currentActivePlayer || activeTrackIndex === -1) return;
    const dur = currentActivePlayer.duration;
    if (Number.isFinite(dur) && dur > 0) {
        const pct = currentActivePlayer.currentTime / dur;
        currentProgress = pct;
        updatePlayheads(pct);
        publisher?.setPosition(currentActivePlayer.currentTime, null);
    }
};

const onPlay = () => {
    updatePlayState(true);
    publisher?.setPlayback("playing");
};

const onPause = () => {
    updatePlayState(false);
    publisher?.setPlayback("paused");
};

const onAudioError = (e: Event) => {
    const player = e.currentTarget as WebAudioPlayer;
    const err = player.error;
    const msg = err ? err.message : "Playback error";
    console.error("Audio playback error:", msg);
};

function setupActivePlayerListeners(player: WebAudioPlayer): void {
    if (currentActivePlayer) {
        currentActivePlayer.removeEventListener("timeupdate", onTimeUpdate);
        currentActivePlayer.removeEventListener("play", onPlay);
        currentActivePlayer.removeEventListener("pause", onPause);
        currentActivePlayer.removeEventListener("error", onAudioError);
    }
    currentActivePlayer = player;
    currentActivePlayer.addEventListener("timeupdate", onTimeUpdate);
    currentActivePlayer.addEventListener("play", onPlay);
    currentActivePlayer.addEventListener("pause", onPause);
    currentActivePlayer.addEventListener("error", onAudioError);
}

function updatePlayState(playing: boolean): void {
    playPauseBtn.classList.toggle("is-playing", playing);
    playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function updatePlayheads(pct: number): void {
    tracks.forEach(tr => {
        tr.seekBarEl.style.setProperty("--progress", pct.toString());
    });
    if (activeTrackIndex !== -1) {
        const activeTrack = tracks[activeTrackIndex];
        const curTime = pct * activeTrack.duration;
        positionEl.textContent = formatTime(curTime);
        durationEl.textContent = formatTime(activeTrack.duration);
    }
}

function seekAll(pct: number): void {
    currentProgress = pct;
    if (activeTrackIndex !== -1) {
        const activeTrack = tracks[activeTrackIndex];
        activeTrack.player.currentTime = pct * activeTrack.duration;
    }
    updatePlayheads(pct);
}

function setActiveTrack(index: number): void {
    if (index === activeTrackIndex || index < 0 || index >= tracks.length) return;
    const wasPlaying = activeTrackIndex !== -1 ? !tracks[activeTrackIndex].player.paused : false;

    if (activeTrackIndex !== -1) {
        tracks[activeTrackIndex].player.pause();
        tracks[activeTrackIndex].cardEl.classList.remove("is-active");
    }

    const prevPct = currentProgress;
    activeTrackIndex = index;
    const activeTrack = tracks[index];
    activeTrack.cardEl.classList.add("is-active");

    setupActivePlayerListeners(activeTrack.player);

    // Sync playhead time to the new track based on last progress pct
    const targetTime = prevPct * activeTrack.duration;
    activeTrack.player.currentTime = targetTime;

    // Update publisher state for the new active file
    publisher?.setFile(activeTrack.path);
    publisher?.setDurationSeconds(activeTrack.duration);
    publisher?.setPosition(targetTime, null);
    publisher?.setPlayback(wasPlaying ? "playing" : "paused");

    if (wasPlaying) {
        void activeTrack.player.play().catch(e => {
            console.error("Playback failed to resume on track change:", e);
        });
    }
}

playPauseBtn.addEventListener("click", () => {
    if (activeTrackIndex === -1) return;
    const player = tracks[activeTrackIndex].player;
    if (player.paused) {
        void player.play().catch(e => {
            console.error("Playback failed to start:", e);
        });
    } else {
        player.pause();
    }
});

app.ontoolresult = async (result) => {
    const init = parseDisplayAudioGridInit(result);
    if (!init) return;

    const sc = result.structuredContent as
        | { createdAt?: unknown; seq?: unknown }
        | undefined;
    if (
        sc &&
        typeof sc.createdAt === "number" &&
        typeof sc.seq === "number"
    ) {
        coordinator.setKey({ createdAt: sc.createdAt, seq: sc.seq });
    } else if (!keyWarned) {
        keyWarned = true;
        console.warn(
            "missing election key on toolresult — multi-instance coordination disabled",
        );
    }

    const myGen = ++loadGen;
    releaseAll();
    hideError();
    playPauseBtn.classList.add("is-loading");

    try {
        const loadedTracks: TrackState[] = [];
        gridContainer.innerHTML = "";

        for (let i = 0; i < init.tracks.length; i++) {
            if (myGen !== loadGen) return;
            const t = init.tracks[i];
            try {
                const store = createChunkStore(t.sizeBytes);
                const chunkBus = createChunkBus();
                const loader = createChunkLoader(store, {
                    path: t.path,
                    totalSize: t.sizeBytes,
                    chunkBytes: 1 << 20,
                    concurrency: 4,
                    fetcher: (start, length) => mcpRangeFetcher(t.path, start, length),
                    onChunk: (start, blob) => {
                        store.add(start, blob);
                        chunkBus.emit({ start, end: start + blob.size, blob });
                    },
                });
                const source = createChunkedSource({
                    store,
                    loader,
                    onChunk: chunkBus.subscribe,
                });

                await waitForFirstChunk(chunkBus, store, () => myGen === loadGen);
                if (myGen !== loadGen) {
                    loader.cancel();
                    return;
                }

                const head = await store.read(0, Math.min(64, t.sizeBytes));
                const format = sniffAudioFormatBytes(head);

                const headerLen = Math.min(METADATA_HEADER_BYTES, t.sizeBytes);
                await waitForRange(chunkBus, store, 0, headerLen, () => myGen === loadGen);
                if (myGen !== loadGen) {
                    loader.cancel();
                    return;
                }
                const headerBytes = await store.read(0, headerLen);
                const metadata = extractMetadata(format, headerBytes, t.sizeBytes);
                const durationSeconds = metadata?.duration ?? 0;
                const durationExact = metadata?.durationExact ?? false;

                // Create Card element in DOM
                const cardEl = document.createElement("div");
                cardEl.className = "audio-card";
                cardEl.dataset.index = i.toString();
                cardEl.innerHTML = `
                    <div class="card-header">
                        <span class="card-title" title="${t.name}">${t.name}</span>
                    </div>
                    <div class="card-seek-bar">
                        <canvas class="card-waveform"></canvas>
                        <div class="card-playhead"></div>
                    </div>
                `;
                gridContainer.appendChild(cardEl);

                const canvas = cardEl.querySelector(".card-waveform") as HTMLCanvasElement;
                const seekBarEl = cardEl.querySelector(".card-seek-bar") as HTMLElement;
                const playheadEl = cardEl.querySelector(".card-playhead") as HTMLElement;

                const waveform = await createWaveformForCanvas(
                    store,
                    chunkBus,
                    loader,
                    format,
                    canvas,
                    durationSeconds,
                    durationExact,
                );

                const player = createWebAudioPlayer(source, {
                    createContext: () => getSharedContext()
                });
                player.loop = true;

                loadedTracks.push({
                    path: t.path,
                    name: t.name,
                    sizeBytes: t.sizeBytes,
                    store,
                    loader,
                    chunkBus,
                    format,
                    duration: durationSeconds,
                    player,
                    cardEl,
                    seekBarEl,
                    playheadEl,
                    waveform,
                });
            } catch (err) {
                console.error(`Failed to load track ${t.name}:`, err);
            }
        }

        if (myGen !== loadGen) {
            loadedTracks.forEach(tr => {
                tr.loader.cancel();
                tr.waveform.destroy();
                tr.player.destroy();
            });
            return;
        }

        if (loadedTracks.length === 0) {
            showError("decode-failed", "No valid tracks could be loaded.");
            return;
        }

        tracks = loadedTracks;

        // Initialize context state publisher
        publisher = createAudioContextPublisher((s) => coordinator.submitLocal(s));

        // Initialize active track to 0
        setActiveTrack(0);

        // Configure seek and click listeners
        tracks.forEach((tr, index) => {
            tr.cardEl.addEventListener("pointerdown", (e) => {
                // Determine if they clicked on the seekbar specifically
                const seekRect = tr.seekBarEl.getBoundingClientRect();
                const isClickInSeekBar =
                    e.clientX >= seekRect.left &&
                    e.clientX <= seekRect.right &&
                    e.clientY >= seekRect.top &&
                    e.clientY <= seekRect.bottom;

                if (isClickInSeekBar) {
                    const pct = Math.max(0, Math.min(1, (e.clientX - seekRect.left) / seekRect.width));
                    setActiveTrack(index);
                    seekAll(pct);
                } else {
                    setActiveTrack(index);
                }
            });
        });

        // Enable Play Button
        playPauseBtn.disabled = false;
        updatePlayState(false);

        // Apply initial playhead position if provided
        if (init.playheadSeconds !== undefined) {
            const activeTrack = tracks[activeTrackIndex];
            const pct = Math.max(0, Math.min(1, init.playheadSeconds / activeTrack.duration));
            seekAll(pct);
        } else {
            seekAll(0);
        }

    } finally {
        if (myGen === loadGen) {
            playPauseBtn.classList.remove("is-loading");
        }
    }
};

function releaseAll(): void {
    if (tracks.length > 0) {
        tracks.forEach(tr => {
            tr.loader.cancel();
            tr.waveform.destroy();
            tr.player.destroy();
        });
        tracks = [];
    }
    if (publisher) {
        publisher.destroy();
        publisher = null;
    }
    if (currentActivePlayer) {
        currentActivePlayer.removeEventListener("timeupdate", onTimeUpdate);
        currentActivePlayer.removeEventListener("play", onPlay);
        currentActivePlayer.removeEventListener("pause", onPause);
        currentActivePlayer.removeEventListener("error", onAudioError);
        currentActivePlayer = null;
    }
    activeTrackIndex = -1;
    currentProgress = 0;
    playPauseBtn.disabled = true;
    updatePlayState(false);
}

async function mcpRangeFetcher(
    path: string,
    start: number,
    length: number,
): Promise<Uint8Array> {
    const uri = `audiofile-range://${encodeURIComponent(path)}/${start}/${length}`;
    const result = await app.readServerResource({ uri });
    const content = result.contents[0];
    const b64 =
        content && "text" in content && typeof content.text === "string"
            ? content.text
            : content && "blob" in content && typeof content.blob === "string"
              ? content.blob
              : null;
    if (b64 === null) {
        throw new Error("expected blob/text content from range resource");
    }
    return Uint8Array.fromBase64(b64);
}

function waitForFirstChunk(
    bus: ChunkBus,
    store: ChunkStore,
    stillCurrent: () => boolean,
): Promise<void> {
    return waitForRange(bus, store, 0, Math.min(1, store.totalSize), stillCurrent);
}

function waitForRange(
    bus: ChunkBus,
    store: ChunkStore,
    start: number,
    end: number,
    stillCurrent: () => boolean,
): Promise<void> {
    return new Promise<void>((resolve) => {
        if (end <= start || store.isLoaded(start, end)) {
            resolve();
            return;
        }
        const off = bus.subscribe(() => {
            if (!stillCurrent() || store.isLoaded(start, end)) {
                off();
                resolve();
            }
        });
    });
}
