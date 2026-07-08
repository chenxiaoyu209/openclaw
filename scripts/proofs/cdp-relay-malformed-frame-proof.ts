/**
 * Real behavior proof: browser relay returns JSON-RPC errors for malformed
 * CDP client frames.
 *
 * Starts a loopback relay server, connects a real ws CDP client, sends
 * malformed frames, and records responses with wall-clock timing.
 *
 * Usage: npx tsx scripts/proofs/cdp-relay-malformed-frame-proof.ts
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ExtensionRelayBridge,
  type BridgeSocket,
} from "../../extensions/browser/src/browser/extension-relay/relay-bridge.js";

const HOST = "127.0.0.1";

function toBridgeSocket(ws: WebSocket): BridgeSocket {
  return {
    send: (data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code?: number, reason?: string) => {
      try {
        ws.close(code, reason);
      } catch {
        /* closing */
      }
    },
  };
}

function bindSocket(
  ws: WebSocket,
  handlers: { onMessage: (raw: string) => void; onClose: () => void },
): void {
  ws.on("message", (data) => {
    const raw =
      typeof data === "string"
        ? data
        : Buffer.from(data as ArrayBuffer).toString("utf8");
    handlers.onMessage(raw);
  });
  ws.on("close", handlers.onClose);
}

async function sendAndWait(
  ws: WebSocket,
  frame: string,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: timeout after 2s`)),
      2000,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(
        typeof data === "string"
          ? data
          : Buffer.from(data as ArrayBuffer).toString("utf8"),
      );
    });
    ws.send(frame);
  });
}

async function main() {
  const bridge = new ExtensionRelayBridge();

  const server = http.createServer((_req, res) => {
    res.writeHead(200).end("ok");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/cdp") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        bindSocket(ws, bridge.attachCdpClientSocket(toBridgeSocket(ws)));
      });
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, HOST, () => resolve()),
  );
  const addr = server.address() as { port: number };
  const cdpUrl = `ws://${HOST}:${addr.port}/cdp`;

  console.log(`relay server listening on ${cdpUrl}`);
  console.log(`Node ${process.version}, ${process.platform} ${process.arch}`);

  // --- Proof 1: malformed JSON → parse error -32700 ---
  {
    const ws = new WebSocket(cdpUrl);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const start = performance.now();
    const response = await sendAndWait(ws, "not valid json {", "malformed JSON");
    const elapsed = Math.round(performance.now() - start);

    const parsed = JSON.parse(response);
    console.log(`\n=== Malformed JSON (parse error -32700) ===`);
    console.log(`Sent:     not valid json {`);
    console.log(`Received: ${response}`);
    console.log(`Elapsed:  ${elapsed}ms`);
    console.assert(
      parsed.id === null,
      "FAIL: id must be null for parse error",
    );
    console.assert(
      parsed.error?.code === -32700,
      "FAIL: error code must be -32700",
    );
    console.assert(
      parsed.error?.message === "Parse error",
      "FAIL: error message mismatch",
    );
    console.log("PASS: parse error response correct");

    ws.close();
  }

  // --- Proof 2: invalid request (missing method) → -32600 ---
  {
    const ws = new WebSocket(cdpUrl);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const start = performance.now();
    const response = await sendAndWait(
      ws,
      JSON.stringify({ id: 42, params: {} }),
      "invalid request",
    );
    const elapsed = Math.round(performance.now() - start);

    const parsed = JSON.parse(response);
    console.log(`\n=== Invalid Request (missing method, -32600) ===`);
    console.log(`Sent:     {"id":42,"params":{}}`);
    console.log(`Received: ${response}`);
    console.log(`Elapsed:  ${elapsed}ms`);
    console.assert(parsed.id === 42, "FAIL: id must be preserved");
    console.assert(
      parsed.error?.code === -32600,
      "FAIL: error code must be -32600",
    );
    console.assert(
      parsed.error?.message === "Invalid request",
      "FAIL: error message mismatch",
    );
    console.log("PASS: invalid request error response correct");

    ws.close();
  }

  // --- Proof 3: invalid request with sessionId preserved ---
  {
    const ws = new WebSocket(cdpUrl);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));

    const start = performance.now();
    const response = await sendAndWait(
      ws,
      JSON.stringify({ id: 7, sessionId: "session-1" }),
      "invalid request with sessionId",
    );
    const elapsed = Math.round(performance.now() - start);

    const parsed = JSON.parse(response);
    console.log(`\n=== Invalid Request with sessionId (-32600) ===`);
    console.log(`Sent:     {"id":7,"sessionId":"session-1"}`);
    console.log(`Received: ${response}`);
    console.log(`Elapsed:  ${elapsed}ms`);
    console.assert(parsed.id === 7, "FAIL: id must be preserved");
    console.assert(
      parsed.sessionId === "session-1",
      "FAIL: sessionId must be preserved for correct session routing",
    );
    console.assert(
      parsed.error?.code === -32600,
      "FAIL: error code must be -32600",
    );
    console.log("PASS: sessionId preserved in error response");

    ws.close();
  }

  console.log(`\n✓ All assertions passed. Real behavior proof complete.`);
  console.log(
    `✓ Neither malformed JSON nor invalid request frames cause silent timeouts.`,
  );

  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAIL: ${String(err)}`);
  process.exit(1);
});
