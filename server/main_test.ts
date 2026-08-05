/// <reference lib="deno.ns" />

import assert from "node:assert/strict";
import * as Y from "yjs";
import { createCollabApp, DEFAULT_MARKDOWN } from "./main.ts";

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;

function packet(update: Uint8Array) {
  const result = new Uint8Array(update.length + 1);
  result[0] = DOCUMENT_UPDATE;
  result.set(update, 1);
  return result;
}

class Peer {
  readonly doc = new Y.Doc();
  readonly ready: Promise<void>;
  readonly socket: WebSocket;
  awarenessMessages = 0;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => this.socket.send(packet(Y.encodeStateAsUpdate(this.doc))));
      this.socket.addEventListener("message", (event) => {
        if (event.data === "synced") return resolve();
        const message = new Uint8Array(event.data as ArrayBuffer);
        if (message[0] === DOCUMENT_UPDATE) Y.applyUpdate(this.doc, message.subarray(1), this);
        if (message[0] === AWARENESS_UPDATE) this.awarenessMessages += 1;
      });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });
    this.doc.on("update", (update, origin) => {
      if (origin !== this && this.socket.readyState === WebSocket.OPEN) this.socket.send(packet(update));
    });
  }

  close() {
    this.socket.close();
    this.doc.destroy();
  }
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for collaboration");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("stores canonical Markdown and restores collaborative state after reconnect", async () => {
  const dataDir = await Deno.makeTempDir();
  const staticDir = `${dataDir}/dist`;
  await Deno.mkdir(staticDir);
  await Deno.writeTextFile(`${staticDir}/index.html`, "<!doctype html><title>OKF Hub</title>");
  const app = await createCollabApp({ dataDir, staticDir });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  const base = `http://127.0.0.1:${port}`;
  let first: Peer | undefined;
  let second: Peer | undefined;
  let reconnected: Peer | undefined;

  try {
    assert.equal(await (await fetch(`${base}/api/doc`)).text(), DEFAULT_MARKDOWN);
    assert.match(await (await fetch(`${base}/`)).text(), /OKF Hub/);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: base } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: "https://attacker.example" } })).status, 403);
    const canonical = "# Reopened\n\nCanonical **Markdown**.\n";
    assert.equal((await fetch(`${base}/api/doc`, { method: "PUT", body: canonical })).status, 204);
    assert.equal(await (await fetch(`${base}/api/doc`)).text(), canonical);

    first = new Peer(`ws://127.0.0.1:${port}/collab`);
    second = new Peer(`ws://127.0.0.1:${port}/collab`);
    await Promise.all([first.ready, second.ready]);
    first.doc.getText("proof").insert(0, "two editors");
    await waitFor(() => second?.doc.getText("proof").toString() === "two editors");
    first.socket.send(new Uint8Array([AWARENESS_UPDATE, 1, 2, 3]));
    await waitFor(() => second?.awarenessMessages === 1);

    second.close();
    second = undefined;
    first.doc.getText("proof").insert(11, " reconnect");
    reconnected = new Peer(`ws://127.0.0.1:${port}/collab`);
    await reconnected.ready;
    await waitFor(() => reconnected?.doc.getText("proof").toString() === "two editors reconnect");
  } finally {
    first?.close();
    second?.close();
    reconnected?.close();
    await server.shutdown();
    await app.close();
    await Deno.remove(dataDir, { recursive: true });
  }
});
