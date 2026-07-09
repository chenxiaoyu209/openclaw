/**
 * End-to-end runtime proof for issue #102323.
 *
 * Drives the real shared image sanitizer into the real Anthropic Messages
 * transport and captures the outgoing request body, proving that an
 * unsupported-but-decodable image mime (e.g. image/heic) no longer reaches the
 * Anthropic API as a verbatim media_type that the API rejects with a 400.
 */
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createImageProcessor } from "../media/image-ops.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { sanitizeImageBlocks } from "./tool-images.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicMessagesModel = Model<"anthropic-messages">;

const SUPPORTED_INLINE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function createSseResponse(): Response {
  return new Response(
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function makeImageModel(): AnthropicMessagesModel {
  return attachModelProviderRequestTransport(
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies AnthropicMessagesModel,
    { proxy: { mode: "env-proxy" } },
  );
}

function outgoingImageMediaTypes(): string[] {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  const payload = typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const mediaTypes: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const source = (block as { type?: unknown; source?: unknown }).source;
      if ((block as { type?: unknown }).type === "image" && source && typeof source === "object") {
        const mediaType = (source as { media_type?: unknown }).media_type;
        if (typeof mediaType === "string") {
          mediaTypes.push(mediaType);
        }
      }
    }
  }
  return mediaTypes;
}

describe("anthropic image media_type end-to-end (issue #102323)", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } = await import(
      "./anthropic-transport-stream.js"
    ));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    guardedFetchMock.mockResolvedValue(createSseResponse());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a supported media_type after sanitizing an image/heic-labeled image", async () => {
    // Real, decodable within-limit bytes. WebP is not covered by the sanitizer's
    // base64 sniff, so the declared (unsupported) mime drives the transcode path.
    const png = createSolidPngBuffer(48, 48, { r: 30, g: 160, b: 210 });
    const webp = (await createImageProcessor().encode(png, { format: "webp" })).data;

    const { images: sanitized, dropped } = await sanitizeImageBlocks(
      [{ type: "image", data: webp.toString("base64"), mimeType: "image/heic" }],
      "issue-102323",
    );
    expect(dropped).toBe(0);
    expect(sanitized).toHaveLength(1);

    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        makeImageModel(),
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "what is this?" }, ...sanitized],
              timestamp: 1,
            },
          ],
        } as Parameters<typeof streamFn>[1],
        { apiKey: "sk-ant-api03-test" } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    const mediaTypes = outgoingImageMediaTypes();
    expect(mediaTypes).toHaveLength(1);
    // The bug: image/heic passed through verbatim and Anthropic 400'd the turn.
    expect(mediaTypes[0]).not.toBe("image/heic");
    expect(SUPPORTED_INLINE_MIME.has(mediaTypes[0] ?? "")).toBe(true);
  }, 20_000);
});
