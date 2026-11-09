// Framework-free HTTP layers: bearer auth, rate limits, client IP and the guard chain.
import { test, expect } from "bun:test";
import { bearerAuth, parseBearerClients } from "../src/http/auth.ts";
import { RateLimiter, parseRate, rateLimit } from "../src/http/rate-limit.ts";
import { clientIp } from "../src/http/client-ip.ts";
import { chain, type RequestContext } from "../src/http/guard.ts";
import { hostGuard } from "../src/http/host.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);
const req = (headers: Record<string, string> = {}) => new Request("http://docs.example.test/mcp", { method: "POST", headers });

test("bearer clients parse from name:token pairs and reject anything ambiguous", () => {
  expect(parseBearerClients(`openclaw-1:${A}, claude:${B}`)).toEqual([
    { name: "openclaw-1", token: A },
    { name: "claude", token: B },
  ]);
  expect(parseBearerClients(undefined)).toEqual([]);
  expect(parseBearerClients("")).toEqual([]);
  expect(() => parseBearerClients(A)).toThrow(/name:token/);
  expect(() => parseBearerClients(`:${A}`)).toThrow(/name:token/);
  expect(() => parseBearerClients("x:short")).toThrow(/16 characters/);
  expect(() => parseBearerClients(`x:${A},x:${B}`)).toThrow(/unique/);
  expect(() => parseBearerClients(`x:${A},y:${A}`)).toThrow(/own token/);
});

test("bearer auth names the client and rejects missing, wrong and partial tokens", async () => {
  const guard = bearerAuth([{ name: "openclaw-1", token: A }, { name: "claude", token: B }]);
  const ctx: RequestContext = { ip: "1.2.3.4" };
  expect(await guard(req({ authorization: `Bearer ${B}` }), ctx)).toBeNull();
  expect(ctx.client).toBe("claude");

  for (const authorization of [undefined, "", `Basic ${A}`, `Bearer ${A.slice(0, -1)}`, `Bearer ${A}x`, `Bearer ${A} ${B}`]) {
    const c: RequestContext = { ip: "1.2.3.4" };
    const r = await guard(req(authorization === undefined ? {} : { authorization }), c);
    expect(r?.status).toBe(401);
    expect(r?.headers.get("www-authenticate")).toBe('Bearer realm="docify"');
    expect(c.client).toBeUndefined();
  }
});

test("rates parse from count/unit and refuse zero or unknown units", () => {
  expect(parseRate("60/min")).toEqual({ limit: 60, windowMs: 60_000 });
  expect(parseRate(" 5 / s ")).toEqual({ limit: 5, windowMs: 1000 });
  expect(parseRate("1000/h")).toEqual({ limit: 1000, windowMs: 3_600_000 });
  for (const bad of ["0/min", "60", "60/day", "-1/s", "abc"]) expect(() => parseRate(bad, "X")).toThrow(/X: expected a rate/);
});

test("the limiter allows a burst, refuses with Retry-After, then refills with time", () => {
  let t = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 }, () => t);
  expect(limiter.take("k").ok).toBe(true);
  expect(limiter.take("k").ok).toBe(true);
  const refused = limiter.take("k");
  expect(refused).toEqual({ ok: false, retryAfterSec: 30 });
  // Another key has its own bucket.
  expect(limiter.take("other").ok).toBe(true);
  t = 29_000;
  expect(limiter.take("k").ok).toBe(false);
  t = 30_000;
  expect(limiter.take("k").ok).toBe(true);
  expect(limiter.take("k").ok).toBe(false);
});

test("the limiter drops only full buckets when it holds too many keys", () => {
  let t = 0;
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 }, () => t, 2);
  limiter.take("a");
  limiter.take("b");
  t = 1000;
  limiter.take("c"); // a and b are full again, so the sweep removes them
  expect(limiter.size).toBe(1);
  // c is still limited after the sweep.
  expect(limiter.take("c").ok).toBe(false);
});

test("the rate limit guard answers 429 and skips requests without a key", async () => {
  const guard = rateLimit(new RateLimiter({ limit: 1, windowMs: 60_000 }, () => 0), (ctx) => ctx.client);
  expect(await guard(req(), { ip: "x", client: "c" })).toBeNull();
  const r = await guard(req(), { ip: "x", client: "c" });
  expect(r?.status).toBe(429);
  expect(r?.headers.get("retry-after")).toBe("60");
  expect(await r?.json()).toMatchObject({ code: "rate_limited" });
  expect(await guard(req(), { ip: "x" })).toBeNull();
});

test("client IP uses the last X-Forwarded-For entry only behind a trusted proxy", () => {
  const forwarded = req({ "x-forwarded-for": "6.6.6.6, 9.9.9.9" });
  expect(clientIp(forwarded, "10.0.0.2", true)).toBe("9.9.9.9");
  expect(clientIp(forwarded, "10.0.0.2", false)).toBe("10.0.0.2");
  expect(clientIp(req(), "10.0.0.2", true)).toBe("10.0.0.2");
  expect(clientIp(req(), undefined, false)).toBe("unknown");
});

test("the chain stops at the first guard that answers and runs the handler otherwise", async () => {
  const seen: string[] = [];
  const pass = (name: string) => () => (seen.push(name), null);
  const block = () => (seen.push("block"), new Response("no", { status: 418 }));
  const handler = () => (seen.push("handler"), new Response("ok"));
  expect((await chain([pass("a"), block, pass("b")], handler)(req(), { ip: "x" })).status).toBe(418);
  expect(seen).toEqual(["a", "block"]);
  seen.length = 0;
  expect((await chain([pass("a"), pass("b")], handler)(req(), { ip: "x" })).status).toBe(200);
  expect(seen).toEqual(["a", "b", "handler"]);
});

test("the host guard checks Host and a browser Origin", async () => {
  const guard = hostGuard(["docs.example.test"], false);
  const ctx = { ip: "x" };
  expect(await guard(new Request("http://x/mcp", { headers: { host: "docs.example.test" } }), ctx)).toBeNull();
  expect((await guard(new Request("http://x/mcp", { headers: { host: "evil.test" } }), ctx))?.status).toBe(403);
  const cross = new Request("http://x/mcp", { headers: { host: "docs.example.test", origin: "https://evil.test" } });
  expect((await guard(cross, ctx))?.status).toBe(403);
  expect(await hostGuard([], true)(new Request("http://x/mcp", { headers: { host: "anything.test" } }), ctx)).toBeNull();
});
