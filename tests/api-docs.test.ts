import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/web/server.ts";
import { openApiSpec } from "../src/web/openapi.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function setup() {
  const d = newDocify(tempDir());
  const server = await startServer(0, { docify: d, quiet: true, allowedHosts: ["docs.example.test"] });
  cleanup.push(() => {
    server.stop(true);
    d.close();
  });
  return `http://127.0.0.1:${server.port}`;
}

test("the docs page and every asset it references load without the token, under the page policy", async () => {
  const base = await setup();
  const page = await fetch(`${base}/api/docs`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  const html = await page.text();
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(refs).toEqual(["/api/docs/swagger-ui.css", "/api/docs/swagger-ui-bundle.js", "/api/docs/init.js"]);
  for (const ref of refs) {
    const res = await fetch(base + ref);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(ref.endsWith(".js") ? /javascript/ : /css/);
    expect((await res.text()).length).toBeGreaterThan(ref.endsWith("init.js") ? 50 : 10_000);
  }
  const spec = await fetch(`${base}/api/docs/openapi.json`);
  expect(spec.status).toBe(200);
  expect((await spec.json()).openapi).toBe("3.1.0");
});

test("the docs refuse an unknown Host like the rest of the server", async () => {
  const base = await setup();
  const res = await fetch(`${base}/api/docs/openapi.json`, { headers: { host: "evil.example.test" } });
  expect(res.status).toBe(403);
});

test("the spec lists every /api route in server.ts, and nothing else", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "web", "server.ts"), "utf8");
  const routes = [...source.matchAll(/^\s+"(\/api\/[^"]+)":/gm)]
    .map((m) => m[1]!)
    .filter((path) => !path.startsWith("/api/docs"))
    .map((path) => path.replace(/:(\w+)/g, "{$1}"));
  expect(routes.length).toBeGreaterThan(5);
  expect(Object.keys(openApiSpec().paths).sort()).toEqual(routes.sort());
});
