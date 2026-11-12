// Hosting support: bind address, Host/Origin checks, stable token and source roots.
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { parseSourceRoots, startServer, withinSourceRoots } from "../src/web/server.ts";
import { VERSION } from "../src/version.ts";
import { hostAllowed, originAllowed, parseAllowedHosts } from "../src/http/host.ts";
import { newDocify, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
const temp = () => {
  const d = tempDir();
  cleanup.push(d);
  return d;
};
afterAll(() => cleanup.forEach((p) => rmSync(p, { recursive: true, force: true })));

test("host matching accepts exact entries, bare hostnames, loopback and the wildcard", () => {
  expect(hostAllowed(null, [])).toBe(false);
  expect(hostAllowed("127.0.0.1:4747", ["127.0.0.1:4747"])).toBe(true);
  expect(hostAllowed("LOCALHOST:4747", ["localhost:4747"])).toBe(true);
  // A published container port differs from the bound one; loopback still works.
  expect(hostAllowed("127.0.0.1:4799", ["docs.example.test"])).toBe(true);
  expect(hostAllowed("localhost:8080", [])).toBe(true);
  expect(hostAllowed("docs.example.test:443", ["docs.example.test"])).toBe(true);
  expect(hostAllowed("docs.example.test", ["docs.example.test:443"])).toBe(false);
  expect(hostAllowed("docs.example.test.evil", ["docs.example.test"])).toBe(false);
  expect(hostAllowed("anything.test", ["*"])).toBe(true);
  expect(parseAllowedHosts(" Docs.Example.test , localhost:4747 ")).toEqual(["docs.example.test", "localhost:4747"]);
  expect(parseAllowedHosts("")).toEqual([]);
});

test("origin checking accepts https behind a TLS proxy and rejects other hosts and schemes", () => {
  expect(originAllowed(null, "docs.example.test")).toBe(true);
  expect(originAllowed("https://docs.example.test", "docs.example.test:443")).toBe(true);
  expect(originAllowed("http://docs.example.test", "docs.example.test")).toBe(true);
  expect(originAllowed("https://evil.test", "docs.example.test")).toBe(false);
  expect(originAllowed("https://docs.example.test.evil", "docs.example.test")).toBe(false);
  expect(originAllowed("file:///etc/passwd", "docs.example.test")).toBe(false);
});

test("source roots default to home, split on the path delimiter and reject escaping symlinks", () => {
  const root = temp();
  const other = temp();
  const outside = temp();
  mkdirSync(join(root, "sub"));
  mkdirSync(join(other, "sub"));
  writeFileSync(join(root, "a.md"), "# A\n");
  writeFileSync(join(root, "sub", "b.md"), "# B\n");
  writeFileSync(join(other, "sub", "c.md"), "# C\n");
  writeFileSync(join(outside, "secret.md"), "# Secret\n");
  symlinkSync(join(outside, "secret.md"), join(root, "link.md"));

  const real = (p: string) => realpathSync(p);
  expect(withinSourceRoots(real(join(root, "a.md")), [root])).toBe(true);
  expect(withinSourceRoots(real(join(root, "sub", "b.md")), [root])).toBe(true);
  expect(withinSourceRoots(real(join(root, "link.md")), [root])).toBe(false);
  expect(withinSourceRoots(real(join(outside, "secret.md")), [root])).toBe(false);
  expect(withinSourceRoots(real(join(other, "sub", "c.md")), [root])).toBe(false);
  expect(withinSourceRoots(real(join(other, "sub", "c.md")), [root, other])).toBe(true);
  expect(withinSourceRoots(real(join(root, "a.md")), ["/nonexistent", root])).toBe(true);

  expect(parseSourceRoots(`${root}${delimiter}${other}`)).toEqual([root, other]);
  expect(parseSourceRoots("~/docs")).toEqual([join(homedir(), "docs")]);
});

test("a hosted server accepts its configured Host, serves healthz and rejects an unknown Host", async () => {
  const d = newDocify(temp());
  const token = "t".repeat(48);
  const server = await startServer(0, { docify: d, quiet: true, token, allowedHosts: ["docs.example.test"] });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { "x-docify-token": token };
    expect((await fetch(`${base}/api/sources`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/sources`, { headers: { ...auth, host: "docs.example.test" } })).status).toBe(200);
    expect((await fetch(`${base}/api/sources`, { headers: { ...auth, host: "docs.example.test:443" } })).status).toBe(200);
    expect((await fetch(`${base}/api/sources`, { headers: { ...auth, host: "evil.test" } })).status).toBe(403);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, version: VERSION });
  } finally {
    server.stop(true);
    d.close();
  }
});

test("a POST through a TLS proxy passes the Origin check, a cross-site Origin does not", async () => {
  const d = newDocify(temp());
  const token = "u".repeat(48);
  const server = await startServer(0, { docify: d, quiet: true, token, allowedHosts: ["docs.example.test"] });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      "x-docify-token": token,
      host: "docs.example.test",
      "content-type": "application/json",
      origin: "https://docs.example.test",
    };
    const ok = await fetch(`${base}/api/search`, { method: "POST", headers, body: JSON.stringify({}) });
    // Passed the origin check and reached the route, which rejects the empty query; no model is needed.
    expect(ok.status).toBe(400);
    const cross = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.test" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(cross.status).toBe(403);
  } finally {
    server.stop(true);
    d.close();
  }
});

test("without a token or DOCIFY_WEB_TOKEN the API needs no token, but still checks Host and Origin", async () => {
  const d = newDocify(temp());
  const saved = process.env.DOCIFY_WEB_TOKEN;
  // An empty value, as compose passes for a variable unset in .env, also means no token.
  process.env.DOCIFY_WEB_TOKEN = "";
  const server = await startServer(0, { docify: d, quiet: true });
  try {
    expect(server.token).toBeNull();
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/sources`)).status).toBe(200);
    expect((await fetch(`${base}/api/sources`, { headers: { "x-docify-token": "stale" } })).status).toBe(200);
    expect((await fetch(`${base}/api/sources`, { headers: { host: "evil.test" } })).status).toBe(403);
    const cross = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify({ query: "anything" }),
    });
    expect(cross.status).toBe(403);
  } finally {
    server.stop(true);
    if (saved === undefined) delete process.env.DOCIFY_WEB_TOKEN;
    else process.env.DOCIFY_WEB_TOKEN = saved;
    d.close();
  }
});

test("the token must be long enough and DOCIFY_WEB_TOKEN is used when no token is passed", async () => {
  const d = newDocify(temp());
  await expect(startServer(0, { docify: d, quiet: true, token: "short" })).rejects.toThrow(/16 characters/);
  const saved = process.env.DOCIFY_WEB_TOKEN;
  process.env.DOCIFY_WEB_TOKEN = "e".repeat(32);
  try {
    const server = await startServer(0, { docify: d, quiet: true });
    expect(server.token).toBe("e".repeat(32));
    server.stop(true);
  } finally {
    if (saved === undefined) delete process.env.DOCIFY_WEB_TOKEN;
    else process.env.DOCIFY_WEB_TOKEN = saved;
    d.close();
  }
});
