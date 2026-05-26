export type GridTrack = {
    path: string;
    name: string;
    sizeBytes: number;
    mtimeMs: number;
};

export type DisplayAudioGridInit = {
    tracks: GridTrack[];
    playheadSeconds?: number;
};

type ToolResultLike = {
    content?: ReadonlyArray<{ type?: string; text?: string }> | undefined;
    structuredContent?: Record<string, unknown> | undefined;
};

export function parseDisplayAudioGridInit(
    result: ToolResultLike,
): DisplayAudioGridInit | null {
    const sc = result.structuredContent;
    if (!sc || typeof sc !== "object" || !Array.isArray(sc.tracks)) {
        return null;
    }

    const tracks: GridTrack[] = [];
    for (const item of sc.tracks) {
        if (
            item &&
            typeof item === "object" &&
            typeof item.path === "string" &&
            typeof item.name === "string" &&
            typeof item.sizeBytes === "number" &&
            typeof item.mtimeMs === "number"
        ) {
            tracks.push({
                path: item.path,
                name: item.name,
                sizeBytes: item.sizeBytes,
                mtimeMs: item.mtimeMs,
            });
        }
    }

    if (tracks.length === 0) return null;

    const init: DisplayAudioGridInit = { tracks };

    const ph = sc.playheadSeconds;
    if (typeof ph === "number" && Number.isFinite(ph) && ph >= 0) {
        init.playheadSeconds = ph;
    }

    return init;
}
