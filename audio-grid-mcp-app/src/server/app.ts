import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { normalizeIncomingPath } from "./path-utils.js";
import { asScalar, parseNonNegInt } from "./range-params.js";

const server = new McpServer({
  name: "Audio Grid MCP App",
  version: "1.0.0",
});

const resourceUri = "ui://ctpt.co/audio-grid/mcp-app.html";

const regionSchema = z.object({
  startSeconds: z.number().min(0).finite(),
  endSeconds: z.number().min(0).finite(),
});

let callSeq = 0;

registerAppTool(
  server,
  "display_audio_grid",
  {
    title: "Display audio grid",
    description: "Display a UI for a grid of audio files, providing playback and synchronized A/B comparison. Use when the user asks to hear/see a grid, list, or folder of tracks.",
    inputSchema: z.object({
      directory: z
        .string()
        .optional()
        .describe("Optional absolute path to a directory of audio files to scan"),
      paths: z
        .array(z.string())
        .optional()
        .describe("Optional list of absolute paths to specific audio files to play"),
      playheadSeconds: z
        .number()
        .min(0)
        .finite()
        .optional()
        .describe("Optional initial playhead position in seconds"),
    }),
    _meta: { ui: { resourceUri } },
  },
  async ({ directory, paths, playheadSeconds }) => {
    let resolvedPaths: string[] = [];
    if (paths && paths.length > 0) {
      resolvedPaths = paths.map(p => normalizeIncomingPath(p)).filter((p): p is string => !!p);
    }
    if (directory) {
      const normalizedDir = normalizeIncomingPath(directory);
      if (normalizedDir) {
        const entries = await fs.readdir(normalizedDir, { withFileTypes: true });
        const audioExtensions = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".webm", ".wma"]);
        const dirFiles: string[] = [];
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (audioExtensions.has(ext)) {
              dirFiles.push(path.join(normalizedDir, entry.name));
            }
          }
        }
        resolvedPaths = [...resolvedPaths, ...dirFiles];
      }
    }

    if (resolvedPaths.length === 0) {
      throw new Error("Either a directory containing audio files or a non-empty list of paths is required.");
    }

    // De-duplicate paths
    resolvedPaths = Array.from(new Set(resolvedPaths));

    // Get statistics for each file and sort by mtimeMs descending (newest first)
    const tracksWithStats = await Promise.all(
      resolvedPaths.map(async (p) => {
        try {
          const stat = await fs.stat(p);
          return {
            path: p,
            name: path.basename(p),
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        } catch {
          return null;
        }
      })
    );

    const validTracks = tracksWithStats
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // Newest first

    if (validTracks.length === 0) {
      throw new Error("No valid audio files found.");
    }

    const seq = ++callSeq;
    const createdAt = Date.now();
    const structuredContent: Record<string, unknown> = {
      tracks: validTracks,
      createdAt,
      seq,
    };
    if (playheadSeconds !== undefined) {
      structuredContent.playheadSeconds = playheadSeconds;
    }

    return {
      content: [{ type: "text", text: `Displaying grid with ${validTracks.length} tracks.` }],
      structuredContent,
    };
  },
);

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  {
    mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  },
  async () => {
    const html = await fs.readFile(
      path.join(import.meta.dirname, "..", "..", "dist", "mcp-app.html"),
      "utf-8",
    );
    return {
      contents: [
        { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
      ],
    };
  },
);

const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

// Base64 is returned in the `text` field rather than `blob` because Goose's
// MCP-Apps host only forwards `text` resource content to the iframe.
server.registerResource(
    "audiofile-range",
    new ResourceTemplate("audiofile-range://{path}/{start}/{length}", {
        list: undefined,
    }),
    {
        description:
            "Byte range of a local audio file as base64 in `text`; path/start/length are URL-encoded.",
        mimeType: "application/octet-stream;encoding=base64",
    },
    async (uri, { path, start, length }): Promise<ReadResourceResult> => {
        const rawPath = asScalar(path);
        if (!rawPath) throw new Error("Path parameter is required");
        const pathStr = normalizeIncomingPath(decodeURIComponent(rawPath));
        if (!pathStr) throw new Error("Path parameter is required");
        const startNum = parseNonNegInt(asScalar(start));
        const lengthNum = parseNonNegInt(asScalar(length));
        if (startNum === null || lengthNum === null) {
            throw new Error("start and length must be non-negative integers");
        }
        if (lengthNum === 0 || lengthNum > MAX_CHUNK_BYTES) {
            throw new Error(`length must be in (0, ${MAX_CHUNK_BYTES}]`);
        }
        const fh = await fs.open(pathStr, "r");
        try {
            const buf = Buffer.allocUnsafe(lengthNum);
            const { bytesRead } = await fh.read(buf, 0, lengthNum, startNum);
            const slice =
                bytesRead === lengthNum ? buf : buf.subarray(0, bytesRead);
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/octet-stream;encoding=base64",
                        text: slice.toString("base64"),
                    },
                ],
            };
        } finally {
            await fh.close();
        }
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();
