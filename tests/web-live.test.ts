import { expect, test } from "bun:test";
import { basename } from "node:path";
import { parseAdmins } from "../src/core/accounts.ts";
import { startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

const token = "web-live-test-token";
async function connect(port: number, cookie?: string) {
  const origin = `http://127.0.0.1:${port}`;
  // Bun accepts handshake headers; the DOM WebSocket declaration only lists protocols.
  const BunSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new BunSocket(`${origin.replace("http:", "ws:")}/api/live`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
  const messages: string[] = [];
  let notify: (() => void) | undefined;
  ws.onmessage = e => { messages.push(String(e.data)); notify?.(); };
  const closed = new Promise<CloseEvent>(resolve => { ws.onclose = resolve; });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade failed")); });
  return { ws, closed, subscribe(sources: boolean, logsAfter: number | null, key = token) {
    ws.send(JSON.stringify({ type: "subscribe", token: key, sources, logsAfter }));
  }, async next() {
    if (!messages.length) await new Promise<void>(resolve => { notify = resolve; });
    notify = undefined;
    return JSON.parse(messages.shift()!);
  }, messages };
}

test("live sends an authoritative snapshot, external source diffs, then logs after the replacement cursor", async () => {
  const home = tempDir(), d = newDocify(home), writer = newDocify(home);
  const server = await startServer(0, { host: "127.0.0.1", docify: d, quiet: true, token });
  try {
    const socket = await connect(server.port!);
    socket.subscribe(true, null);
    expect(await socket.next()).toEqual({ type: "sources", reset: true, upserts: [], removed: [] });
    const locator = tempDir();
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { Docify } from './src/core/docify.ts';
      const [home, locator] = process.argv.slice(1);
      const docify = new Docify({ home });
      docify.addSource({ kind: 'local', library: 'sample', version: '1', locator });
      docify.close();
    `, home, locator], { cwd: import.meta.dir + "/.." });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(await socket.next()).toMatchObject({ type: "sources", reset: false, upserts: [{ id: "sample@1", locator }], removed: [] });
    writer.removeSource("sample@1");
    expect(await socket.next()).toEqual({ type: "sources", reset: false, upserts: [], removed: ["sample@1"] });
    writer.logs.append("other-process", "already read");
    const cursor = writer.logs.read().cursor;
    writer.logs.append("other-process", "new");
    socket.subscribe(false, cursor);
    expect(await socket.next()).toMatchObject({ type: "logs", entries: [{ seq: cursor + 1, text: "new" }] });
    await server.stop();
    expect((await socket.closed).code).toBe(1001);
    const restarted = await startServer(0, { host: "127.0.0.1", docify: d, quiet: true, token });
    try {
      const resumed = await connect(restarted.port!);
      writer.logs.append("other-process", "after restart");
      resumed.subscribe(true, cursor + 1);
      expect(await resumed.next()).toEqual({ type: "sources", reset: true, upserts: [], removed: [] });
      expect(await resumed.next()).toMatchObject({ entries: [{ seq: cursor + 2, text: "after restart" }] });
    } finally { await restarted.stop(true); }
  } finally { await server.stop(true); writer.close(); d.close(); }
});

test("live rejects a wrong token without sending data", async () => {
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, token });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    for (const headers of [{}, { origin: "https://outside.invalid" }, { origin: "http://127.0.0.1:1" }, { host: "outside.invalid", origin: "https://outside.invalid" }] as HeadersInit[]) {
      expect((await fetch(`${url}/api/live`, { headers })).status).toBe(403);
    }
    expect((await fetch(`${url}/api/live?token=${token}`, { headers: { origin: url } })).status).toBe(400);
    const socket = await connect(server.port!);
    socket.subscribe(true, 0, "wrong");
    expect((await socket.closed).code).toBe(1008);
    expect(socket.messages).toEqual([]);
    const malformed = await connect(server.port!);
    malformed.ws.send(JSON.stringify({ type: "subscribe", token, sources: true, logsAfter: -1 }));
    expect((await malformed.closed).code).toBe(1008);
    expect(malformed.messages).toEqual([]);
  } finally { await server.stop(true); d.close(); }
});

test("live member snapshots match HTTP, logs require admin, and signed-out connections close", async () => {
  const d = newDocify(tempDir());
  const locator = tempDir();
  d.addSource({ kind: "local", library: "private", version: "1", locator });
  const server = await startServer(0, { docify: d, quiet: true, accounts: { github: { clientId: "test", clientSecret: "test" }, admins: parseAdmins("boss") } });
  try {
    const store = server.accounts!;
    const admin = store.signIn({ id: 1, login: "boss", name: null });
    const member = store.signIn({ id: 2, login: "reader", name: null });
    store.updateUser(member.user.id, { status: "active" }, admin.user.id);
    const cookie = `docify_session=${member.session}`;
    const expected = await (await fetch(`http://127.0.0.1:${server.port}/api/sources`, { headers: { cookie } })).json();
    const reader = await connect(server.port!, cookie);
    reader.subscribe(true, null, "");
    const snapshot = await reader.next();
    expect(snapshot.upserts).toEqual(expected);
    expect(snapshot.upserts[0].locator).toBe(basename(locator));
    reader.subscribe(false, 0, "");
    expect((await reader.closed).code).toBe(1008);
    const revoked = await connect(server.port!, cookie);
    revoked.subscribe(true, null, "");
    expect((await revoked.next()).reset).toBe(true);
    store.signOut(member.session);
    expect((await revoked.closed).code).toBe(1008);
  } finally { await server.stop(true); server.accounts?.close(); d.close(); }
});
