import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

test("artifact downloads are authenticated and limited to active snapshot files", async () => {
  const home = tempDir();
  const d = newDocify(home);
  const source = d.addSource({ id: "docs.v1", library: "docs", kind: "url", locator: "https://example.com" });
  d.db.run("INSERT INTO generations (id, source_id, status, started_at, schema_version) VALUES (1, ?, 'active', '2026-01-01', 1), (2, ?, 'superseded', '2026-01-01', 1)", [source.id, source.id]);
  d.db.run("UPDATE sources SET active_generation = 1 WHERE id = ?", [source.id]);
  const active = join(home, "snapshots", source.id, "1", "artifacts");
  const staging = join(home, "snapshots", source.id, "2", "artifacts");
  mkdirSync(active, { recursive: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(active, "screenshot.png"), "active image");
  writeFileSync(join(staging, "screenshot.png"), "staging image");
  const server = await startServer(0, { docify: d, quiet: true, token: "a".repeat(32) });
  try {
    const url = `http://127.0.0.1:${server.port}/api/sources/${source.id}/artifacts`;
    const get = (suffix: string) => fetch(`${url}/${suffix}`, { headers: { "x-docify-token": server.token! } });
    expect((await fetch(`${url}/screenshot`)).status).toBe(401);
    const image = await get("screenshot");
    expect(image.status).toBe(200);
    expect(await image.text()).toBe("active image");
    expect(image.headers.get("content-disposition")).toBe('attachment; filename="screenshot.png"');
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get("pdf")).status).toBe(404);
    expect((await get("%2e%2e%2fsecret")).status).toBe(404);
    symlinkSync(join(staging, "screenshot.png"), join(active, "page.pdf"));
    expect((await get("pdf")).status).toBe(404);
    d.db.run("UPDATE sources SET active_generation = 2 WHERE id = ?", [source.id]);
    expect(await (await get("screenshot")).text()).toBe("staging image");
  } finally {
    server.stop(true);
    d.close();
  }
});
