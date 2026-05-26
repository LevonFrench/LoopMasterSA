import { describe, expect, it } from "vitest";
import { parseDisplayAudioGridInit } from "./display-audio-init";

describe("parseDisplayAudioGridInit", () => {
    it("returns null when structuredContent.tracks is missing or not an array", () => {
        expect(parseDisplayAudioGridInit({})).toBeNull();
        expect(parseDisplayAudioGridInit({ structuredContent: {} })).toBeNull();
        expect(parseDisplayAudioGridInit({ structuredContent: { tracks: "not-an-array" } })).toBeNull();
    });

    it("parses valid tracks and filters out invalid ones", () => {
        const init = parseDisplayAudioGridInit({
            structuredContent: {
                tracks: [
                    { path: "/a.wav", name: "a.wav", sizeBytes: 1000, mtimeMs: 12345 },
                    { path: "/b.wav", name: "b.wav" }, // missing fields, invalid
                    { path: "/c.wav", name: "c.wav", sizeBytes: 2000, mtimeMs: 67890 }
                ]
            }
        });
        expect(init).toEqual({
            tracks: [
                { path: "/a.wav", name: "a.wav", sizeBytes: 1000, mtimeMs: 12345 },
                { path: "/c.wav", name: "c.wav", sizeBytes: 2000, mtimeMs: 67890 }
            ]
        });
    });

    it("parses playheadSeconds when valid", () => {
        const init = parseDisplayAudioGridInit({
            structuredContent: {
                tracks: [
                    { path: "/a.wav", name: "a.wav", sizeBytes: 1000, mtimeMs: 12345 }
                ],
                playheadSeconds: 2.5
            }
        });
        expect(init?.playheadSeconds).toBe(2.5);
    });

    it("drops negative or non-finite playheadSeconds", () => {
        const init1 = parseDisplayAudioGridInit({
            structuredContent: {
                tracks: [{ path: "/a.wav", name: "a.wav", sizeBytes: 1000, mtimeMs: 12345 }],
                playheadSeconds: -1
            }
        });
        expect(init1?.playheadSeconds).toBeUndefined();

        const init2 = parseDisplayAudioGridInit({
            structuredContent: {
                tracks: [{ path: "/a.wav", name: "a.wav", sizeBytes: 1000, mtimeMs: 12345 }],
                playheadSeconds: Number.NaN
            }
        });
        expect(init2?.playheadSeconds).toBeUndefined();
    });
});
