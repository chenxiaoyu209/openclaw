// Agent Core harness tests cover cacheRetention parameter handling.
import { describe, expect, it, vi } from "vitest";
import type { Model, StreamFn } from "../../llm.js";
import { AgentHarness } from "./agent-harness.js";
import type { Session } from "./types.js";

const mockModel: Model = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

describe("AgentHarness cacheRetention handling", () => {
  it("preserves cacheRetention when requestOptions.cacheRetention is undefined", async () => {
    // This test verifies the fix for issue #106014 where explicit cacheRetention
    // values were being overwritten by undefined in the agent core harness layer.

    let capturedStreamOptions: unknown;

    // Mock stream function that captures the options it receives
    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      capturedStreamOptions = options;
      // Return a minimal async iterable to satisfy the type
      return (async function* () {
        yield {
          type: "content",
          content: { type: "text" as const, text: "" },
        };
      })();
    });

    // Create a minimal mock session
    const mockSession: Partial<Session> = {
      buildContext: vi.fn().mockResolvedValue({
        messages: [{ role: "user" as const, content: "test", timestamp: Date.now() }],
      }),
      getMetadata: vi.fn().mockResolvedValue({ id: "test-session" }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getBranch: vi.fn().mockResolvedValue([]),
      getLeafId: vi.fn().mockResolvedValue("test-leaf"),
      getEntry: vi.fn().mockResolvedValue(undefined),
      appendModelChange: vi.fn().mockResolvedValue(undefined),
      appendThinkingLevelChange: vi.fn().mockResolvedValue(undefined),
      appendCustomEntry: vi.fn().mockResolvedValue(undefined),
      appendCustomMessageEntry: vi.fn().mockResolvedValue(undefined),
      appendLabel: vi.fn().mockResolvedValue(undefined),
      appendSessionName: vi.fn().mockResolvedValue(undefined),
      appendCompaction: vi.fn().mockResolvedValue("compaction-id"),
      moveTo: vi.fn().mockResolvedValue("summary-id"),
      getStorage: vi.fn().mockReturnValue({
        setLeafId: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const harness = new AgentHarness({
      env: { WORKSPACE_DIR: "/test" },
      session: mockSession as Session,
      model: mockModel,
      tools: [],
      streamOptions: {
        cacheRetention: "long", // Explicit long cache retention
      },
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
      runtime: {
        streamSimple: mockStreamFn,
      },
    });

    // Execute a prompt to trigger the stream function
    try {
      await harness.prompt("test message");
    } catch {
      // Ignore errors from the mock - we only care about captured options
    }

    // Verify that cacheRetention was passed through and not overwritten with undefined
    expect(capturedStreamOptions).toEqual(
      expect.objectContaining({
        cacheRetention: "long",
      }),
    );
  });

  it("does not add cacheRetention key when not configured", async () => {
    // When no cacheRetention is configured, the key should not be present
    // in the options object (not even as undefined).

    let capturedStreamOptions: unknown;

    const mockStreamFn: StreamFn = vi.fn((model, context, options) => {
      capturedStreamOptions = options;
      return (async function* () {
        yield {
          type: "content",
          content: { type: "text" as const, text: "" },
        };
      })();
    });

    const mockSession: Partial<Session> = {
      buildContext: vi.fn().mockResolvedValue({
        messages: [{ role: "user" as const, content: "test", timestamp: Date.now() }],
      }),
      getMetadata: vi.fn().mockResolvedValue({ id: "test-session" }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getBranch: vi.fn().mockResolvedValue([]),
      getLeafId: vi.fn().mockResolvedValue("test-leaf"),
      getEntry: vi.fn().mockResolvedValue(undefined),
      appendModelChange: vi.fn().mockResolvedValue(undefined),
      appendThinkingLevelChange: vi.fn().mockResolvedValue(undefined),
      appendCustomEntry: vi.fn().mockResolvedValue(undefined),
      appendCustomMessageEntry: vi.fn().mockResolvedValue(undefined),
      appendLabel: vi.fn().mockResolvedValue(undefined),
      appendSessionName: vi.fn().mockResolvedValue(undefined),
      appendCompaction: vi.fn().mockResolvedValue("compaction-id"),
      moveTo: vi.fn().mockResolvedValue("summary-id"),
      getStorage: vi.fn().mockReturnValue({
        setLeafId: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const harness = new AgentHarness({
      env: { WORKSPACE_DIR: "/test" },
      session: mockSession as Session,
      model: mockModel,
      tools: [],
      streamOptions: {}, // No cacheRetention configured
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
      runtime: {
        streamSimple: mockStreamFn,
      },
    });

    try {
      await harness.prompt("test message");
    } catch {
      // Ignore errors from the mock
    }

    // Verify that cacheRetention is not present in the options
    expect((capturedStreamOptions as Record<string, unknown>).cacheRetention).toBeUndefined();
    // More importantly, verify the key doesn't exist at all
    expect(Object.keys(capturedStreamOptions as object)).not.toContain("cacheRetention");
  });
});
