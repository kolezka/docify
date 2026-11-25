import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/web/server.ts";
import { fakeGraph, newDocify, tempDir, writeDocs } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

async function setup() {
  const home = tempDir();
  const d = newDocify(home);
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32) });
  cleanup.push(() => { server.stop(true); d.close(); });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (query = "", auth = true) => fetch(`${base}/api/logs${query}`, {
    headers: auth ? { "x-docify-token": server.token! } : {},
  });
  const add = (library: string) => d.addSource({ library, kind: "local", locator: writeDocs(tempDir(), { "a.md": "# A\n\nText." }) });
  return { home, d, get, add };
}

test("missing log history is an empty authenticated response without creating storage", async () => {
  const { home, get } = await setup();
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ lines: [], cursor: 0, capped: false });
  expect(existsSync(join(home, "logs.sqlite"))).toBe(false);
  expect((await get("", false)).status).toBe(401);
});

test("source activity and failed preparation are timestamped, ordered and paginated", async () => {
  const { d, get, add } = await setup();
  add("otter");
  await expect(d.prepare("otter@unknown", { onPhase() { throw new Error("fixture-provider-failure"); } })).rejects.toThrow("fixture-provider-failure");
  const response = await get("?limit=2");
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.lines).toHaveLength(2);
  const second = await (await get(`?after=${first.cursor}`)).json();
  const lines = [...first.lines, ...second.lines];
  expect(lines.every((line: any, i: number) => line.seq > (lines[i - 1]?.seq ?? 0))).toBe(true);
  expect(lines.every((line: any) => Number.isFinite(Date.parse(line.ts)) && line.source === "otter@unknown")).toBe(true);
  expect(lines.some((line: any) => line.text.includes("collect"))).toBe(true);
  expect(lines.some((line: any) => line.level === "error" && line.text.includes("fixture-provider-failure"))).toBe(true);
  expect(await (await get(`?after=${second.cursor}`)).json()).toEqual({ lines: [], cursor: second.cursor, capped: false });
});

test("the tail and older pages are bounded and stable while new logs arrive", async () => {
  const { d, get } = await setup();
  d.logs.append("bulk", Array.from({ length: 2100 }, (_, i) => String(i + 1)).join("\n"));
  const tail = await (await get("?tail=1")).json();
  expect(tail.lines).toHaveLength(1000);
  expect([tail.lines[0].seq, tail.cursor, tail.hasOlder]).toEqual([1101, 2100, true]);
  d.logs.append("bulk", "live");
  const older = await (await get("?before=1101")).json();
  expect([older.lines.length, older.lines[0].seq, older.cursor, older.hasOlder]).toEqual([1000, 101, 1100, true]);
  const oldest = await (await get("?before=101")).json();
  expect([oldest.lines.length, oldest.lines[0].seq, oldest.cursor, oldest.hasOlder]).toEqual([100, 1, 100, false]);
  expect((await get("?tail=1&after=0")).status).toBe(400);
});

test("log API rejects invalid cursors and limits instead of silently resetting them", async () => {
  const { get } = await setup();
  for (const query of ["?after=-1", "?after=abc", "?after=1.5", "?after=9007199254740992", "?limit=0", "?limit=1001", "?limit=no", "?after="]) {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_input");
  }
});

test("history written by another Docify instance is visible and configured credentials are redacted", async () => {
  const { home, d, get } = await setup();
  const keyName = "DOCIFY_TEST_LOG_SECRET";
  const previous = process.env[keyName];
  process.env[keyName] = "fixture-secret-never-store";
  const writer = newDocify(home, { graph: { backend: "openai", model: "fake", apiKeyEnv: keyName } });
  try {
    writer.addSource({ library: "beaver", kind: "local", locator: tempDir() });
    await writer.prepare("beaver@unknown", { onPhase() { throw new Error(`fixture failure ${process.env[keyName]}`); } }).catch(() => {});
    const response = await get();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.lines.some((line: any) => line.source === "beaver@unknown")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-secret-never-store");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    const db = new Database(join(home, "logs.sqlite"), { readonly: true });
    expect(JSON.stringify(db.query("SELECT * FROM logs").all())).not.toContain("fixture-secret-never-store");
    db.close();
  } finally {
    writer.close();
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
  }
});

test("corrupt history returns an explicit read error alongside a valid-history control", async () => {
  const good = await setup();
  good.add("positive");
  const control = await good.get();
  expect(control.status).toBe(200);
  expect((await control.json()).lines[0].source).toBe("positive@unknown");
  const broken = await setup();
  writeFileSync(join(broken.home, "logs.sqlite"), "not a sqlite database");
  const response = await broken.get();
  expect(response.status).toBe(500);
  const data = await response.json();
  expect(data.code).toBe("logs_unavailable");
  expect(data.lines).toBeUndefined();
});

test("retention bounds history and reports gaps without recycling sequence ids", async () => {
  const { d, get } = await setup();
  d.logs.append("bulk", Array.from({ length: 10_005 }, (_, i) => `entry ${i + 1}`).join("\n"));
  const first = await (await get("?limit=1000")).json();
  expect(first.capped).toBe(true);
  expect(first.lines[0].text).toBe("entry 6");
  expect(first.lines).toHaveLength(1000);
  let cursor = first.cursor;
  let count = first.lines.length;
  while (true) {
    const page = await (await get(`?after=${cursor}`)).json();
    expect(page.capped).toBe(false);
    if (!page.lines.length) break;
    expect(page.lines[0].seq).toBe(cursor + 1);
    count += page.lines.length;
    cursor = page.cursor;
  }
  expect(count).toBe(10_000);
  d.logs.append("bulk", "last entry");
  const next = await (await get(`?after=${cursor}`)).json();
  expect(next.lines.map((line: any) => line.text)).toEqual(["last entry"]);
  expect(next.cursor).toBe(cursor + 1);
});

test("malformed stored entries are a read error, not valid empty history", async () => {
  const { home, d, get, add } = await setup();
  add("valid");
  expect((await (await get()).json()).lines[0].source).toBe("valid@unknown");
  const db = new Database(join(home, "logs.sqlite"));
  db.run("UPDATE logs SET stream = 'invalid'");
  db.close();
  const response = await get();
  expect(response.status).toBe(500);
  expect((await response.json()).code).toBe("logs_unavailable");
});

test("logs record activation, unchanged snapshots and cancellation through preparation", async () => {
  const { d, get } = await setup();
  const dir = writeDocs(tempDir(), { "a.md": "# Test\n\n## Otter\n\nOtter floats." });
  d.addSource({ library: "life", kind: "local", locator: dir });
  await d.prepare("life@unknown", { graphRunner: fakeGraph });
  await d.prepare("life@unknown", { graphRunner: fakeGraph });
  const signal = AbortSignal.abort();
  await expect(d.prepare("life@unknown", { signal })).rejects.toThrow("preparation cancelled");
  const { lines } = await (await get()).json();
  expect(lines.some((line: any) => line.text.includes("activated"))).toBe(true);
  expect(lines.some((line: any) => line.text.includes("Unchanged"))).toBe(true);
  expect(lines.some((line: any) => line.level === "warn" && line.text.includes("cancelled"))).toBe(true);
});
