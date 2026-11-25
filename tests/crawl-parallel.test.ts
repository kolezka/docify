import { expect, test } from 'bun:test';
import { CrawlPool } from '../src/core/crawl-pool.ts';
import { crawl, DEFAULT_LIMITS } from '../src/core/collect.ts';

test('overlaps siblings but accepts the same first pages at the limit', async () => {
  let active = 0, peak = 0;
  const requests: string[] = [];
  const docs = await crawl('https://docs.test/', {...DEFAULT_LIMITS, maxPages: 3}, async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    peak = Math.max(peak, ++active);
    await Bun.sleep(path === '/a.html' ? 15 : 1);
    active--;
    return new Response(path === '/' ? '<a href="a.html">A</a><a href="b.html">B</a><a href="c.html">C</a>' : path, {headers:{'content-type':'text/html'}});
  });
  expect(docs.map(d=>d.path)).toEqual(['index.html','a.html','b.html']);
  expect(requests).not.toContain('/c.html');
  expect(peak).toBe(2);
});

test('different sites share renderer capacity and use the renderer deadline', async () => {
  const pool = new CrawlPool(4, 1);
  const renderer = { hostname: 'render.test', timeoutMs: 1000 };
  let active = 0, peak = 0;
  await Promise.all(['one','two'].map(site => crawl(`https://${site}.test/`, {...DEFAULT_LIMITS, timeoutMs: 1}, async (_url, init) => {
    peak = Math.max(peak, ++active);
    try {
      await Bun.sleep(20);
      init.signal!.throwIfAborted();
      return new Response('Rendered', {headers:{'content-type':'text/html'}});
    } finally { active--; }
  }, {pool, renderer})));
  expect(peak).toBe(1);
});

test('an already accepted alias makes its speculative error irrelevant', async () => {
  let attempts = 0;
  const base = 'https://docs.test/';
  const docs = await crawl(base, DEFAULT_LIMITS, async url => {
    if (url === base) return new Response('<a href="alias.html">A</a><a href="b.html">B</a>', {headers:{'content-type':'text/html'}});
    if (url.endsWith('/alias.html')) return Response.redirect(base + 'b.html');
    if (++attempts === 1) throw new Error('speculative failure');
    return new Response('destination',{headers:{'content-type':'text/html'}});
  });
  expect(docs.map(d => d.path)).toEqual(['index.html','b.html']);
});
