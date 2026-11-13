import { afterAll, expect, test } from "bun:test";
import { summarizeSource, getSourceSummary, buildSummaryInput, SUMMARY_INPUT_MAX_TOKENS } from "../src/core/summary.ts";
import { discoverSources, renderSources, sources } from "../src/core/search.ts";
import { countTokens } from "../src/core/tokens.ts";
import { newDocify, tempDir } from "./helpers.ts";

let requests = 0;
let content = "Apple documentation covering interface design, accessibility and navigation for app developers.";
let status = 200;
let finish = "stop";
let duringRequest: (() => void) | undefined;
const server = Bun.serve({ port: 0, fetch: async req => {
  expect(new URL(req.url).pathname).toBe("/v1/chat/completions");
  const body = await req.json() as any;
  expect(body.messages[1].content).toContain("Untrusted documentation sample");
  requests++;
  duringRequest?.();
  return Response.json({ choices: [{ message: { content }, finish_reason: finish }] }, { status });
} });
process.env.DOCIFY_SUMMARY_TEST_URL = server.url.origin;
process.env.DOCIFY_SUMMARY_TEST_KEY = "test-only-key";
const d = newDocify(tempDir(), { graph: { backend: "openai", model: "summary-test", baseUrlEnv: "DOCIFY_SUMMARY_TEST_URL", baseUrlSuffix: "/v1", apiKeyEnv: "DOCIFY_SUMMARY_TEST_KEY" } });
afterAll(() => { d.close(); server.stop(true); delete process.env.DOCIFY_SUMMARY_TEST_URL; delete process.env.DOCIFY_SUMMARY_TEST_KEY; });
const source = d.addSource({ library: "reference", kind: "url", locator: "https://example.test/reference" });
d.db.run("INSERT INTO generations(id, source_id, status, started_at, schema_version) VALUES (1, ?, 'active', 'now', 1)", [source.id]);
d.db.run("UPDATE sources SET active_generation = 1, options = ? WHERE id = ?", [JSON.stringify({ maxPages: 100 }), source.id]);
for (let i = 0; i < 60; i++) {
  const result = d.db.run("INSERT INTO documents(generation_id,path,title,kind,raw_file,raw_sha256,normalized_file,normalized_sha256,lines_match_raw) VALUES (1, ?, ?, 'markdown', '', '', '', '', 1)", [`doc-${String(i).padStart(2, "0")}`, `Topic ${i}`]);
  d.db.run("INSERT INTO passages(id,generation_id,document_id,ord,heading_path,start_line,end_line,text,content_sha256,tokens,has_code,has_warning) VALUES (?,1,?,0,'[\"Design\"]',1,2,?,'',10,0,0)", [`p${i}`, Number(result.lastInsertRowid), `marker-${i} ${"Documentation content. ".repeat(200)}`]);
}

test("generation summary is saved, reused and discovers topics absent from identity", async () => {
  expect(discoverSources(d, "accessibility")).toEqual([]);
  const saved = await summarizeSource(d, source.id);
  expect(saved.generation).toBe(1);
  expect(requests).toBe(1);
  expect(JSON.parse(d.getSource(source.id)!.options).maxPages).toBe(100);
  expect(await summarizeSource(d, source.id)).toEqual(saved);
  expect(requests).toBe(1);
  expect(discoverSources(d, "docs for Apple").map(s => s.id)).toEqual([source.id]);
  expect(renderSources(sources(d))).toContain("untrusted");
  await summarizeSource(d, source.id, { force: true });
  expect(requests).toBe(2);
});

test("sample is bounded and spans the collection", () => {
  const sample = buildSummaryInput(d, 1);
  expect(countTokens(sample)).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_TOKENS);
  expect(sample).toContain("marker-0");
  expect(sample).toContain("marker-30");
  expect(sample).toContain("marker-59");
});

test("invalid output and provider failures never replace a valid summary", async () => {
  const before = d.getSource(source.id)!.options;
  for (const invalid of ["", "x".repeat(1501)]) {
    content = invalid;
    await expect(summarizeSource(d, source.id, { force: true })).rejects.toThrow("invalid summary");
    expect(d.getSource(source.id)!.options).toBe(before);
  }
  content = "valid text";
  finish = "length";
  await expect(summarizeSource(d, source.id, { force: true })).rejects.toThrow("invalid summary");
  finish = "stop";
  status = 500;
  content = "test-only-key secret response";
  const failure = await summarizeSource(d, source.id, { force: true }).catch(err => err);
  expect(failure.message).toContain("HTTP 500");
  expect(failure.message).not.toContain("test-only-key");
  expect(failure.message).not.toContain("secret response");
  expect(d.getSource(source.id)!.options).toBe(before);
  status = 200;
  content = "Apple accessibility documentation.";
});

test("concurrent option edits survive and generation changes reject stale writes", async () => {
  duringRequest = () => d.db.run("UPDATE sources SET options = json_set(options, '$.maxPages', 200) WHERE id = ?", [source.id]);
  await summarizeSource(d, source.id, { force: true });
  expect(JSON.parse(d.getSource(source.id)!.options).maxPages).toBe(200);
  duringRequest = () => {
    d.db.run("INSERT INTO generations(id, source_id, status, started_at, schema_version) VALUES (2, ?, 'active', 'later', 1)", [source.id]);
    d.db.run("UPDATE sources SET active_generation = 2 WHERE id = ?", [source.id]);
  };
  await expect(summarizeSource(d, source.id, { force: true })).rejects.toThrow("source changed");
  duringRequest = undefined;
  expect(getSourceSummary(d.getSource(source.id)!)).toBeNull();
  expect(discoverSources(d, "accessibility")).toEqual([]);
  expect(d.getSource(source.id)!.active_generation).toBe(2);
});

test("cancelled requests never write", async () => {
  const before = d.getSource(source.id)!.options;
  const controller = new AbortController();
  d.db.run("UPDATE sources SET active_generation = 1 WHERE id = ?", [source.id]);
  duringRequest = () => controller.abort();
  const failure = await summarizeSource(d, source.id, { force: true, signal: controller.signal }).catch(err => err);
  duringRequest = undefined;
  expect(failure.code).toBe("cancelled");
  expect(d.getSource(source.id)!.options).toBe(before);
});
