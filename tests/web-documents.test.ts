import { expect, test } from "bun:test";
import { startServer } from "../src/web/server.ts";
import { newDocify, tempDir } from "./helpers.ts";

test("document paths are authenticated, complete, and restricted to the active generation", async () => {
  const docify = newDocify(tempDir());
  const server = await startServer(0, { docify, quiet: true, token: "d".repeat(32) });
  try {
    const source = docify.addSource({ library: "docs", version: "1", kind: "local", locator: tempDir() });
    const base = `http://127.0.0.1:${server.port}/api/sources`;
    const get = (id: string, token = server.token!) => fetch(`${base}/${encodeURIComponent(id)}/documents`, { headers: { "x-docify-token": token } });
    expect((await get(source.id, "wrong")).status).toBe(401);
    const missing = await get("missing");
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("source_unknown");
    expect(await (await get(source.id)).json()).toEqual({ source: source.id, generation: null, paths: [] });

    const insertGeneration = docify.db.query<{ id: number }, [string, string]>(
      "INSERT INTO generations (source_id, status, started_at, schema_version) VALUES (?, ?, '2026-01-01', 1) RETURNING id",
    );
    const old = insertGeneration.get(source.id, "superseded")!.id;
    const active = insertGeneration.get(source.id, "active")!.id;
    const staging = insertGeneration.get(source.id, "staging")!.id;
    const insertDocument = docify.db.query(
      "INSERT INTO documents (generation_id, path, kind, raw_file, raw_sha256, normalized_file, normalized_sha256, lines_match_raw) VALUES (?, ?, 'md', '', '', '', '', 1)",
    );
    const paths = Array.from({ length: 1500 }, (_, i) => `guide/${String(i).padStart(4, "0")}.md`);
    docify.db.transaction(() => {
      insertDocument.run(old, "old.md");
      insertDocument.run(staging, "staging.md");
      for (const path of paths.toReversed()) insertDocument.run(active, path);
      docify.db.run("UPDATE sources SET active_generation = ? WHERE id = ?", [active, source.id]);
    })();
    const changes = docify.db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
    const response = await get(source.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: source.id, generation: active, paths });
    expect(docify.db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count).toBe(changes);
  } finally {
    server.stop(true);
    docify.close();
  }
});
