import { createHash } from 'node:crypto';
import { CrawlPool } from '../src/core/crawl-pool.ts';
import { crawl, DEFAULT_LIMITS } from '../src/core/collect.ts';
const pool = new CrawlPool();

let active = 0, peak = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const leaf = new URL(req.url).pathname.split('/').pop();
  peak = Math.max(peak, ++active);
  try {
    await Bun.sleep(20);
    const body = leaf === '' ? Array.from({length:24}, (_, i) => `<a href="p${i}.html">Page ${i}</a>`).join('\n') : `<article>Page ${leaf}</article>`;
    return new Response(body, {headers:{'content-type':'text/html'}});
  } finally { active--; }
}});
try {
  for (const sources of [1,3]) {
    const times: number[] = [];
    let digest = '';
    peak = 0;
    for(let run=0;run<5;run++) {
      const start = performance.now();
      const results = await Promise.all(Array.from({length:sources}, (_,i)=>crawl(new URL(`/s${i}/`, server.url).href, DEFAULT_LIMITS, fetch, {pool, markdownExports:false})));
      times.push(Math.round(performance.now()-start));
      for (const docs of results) {
        if(docs.length!==25) throw new Error(`Expected 25 documents, got ${docs.length}`);
        const h=createHash('sha256');
        for(const doc of docs) h.update(doc.path).update('\0').update(doc.bytes).update('\0');
        const actual=h.digest('hex');
        if(digest && digest!==actual) throw new Error('Inconsistent document order or content');
        digest=actual;
      }
    }
    console.log(JSON.stringify({sources,times,medianMs:times.toSorted((a,b)=>a-b)[2],peak,digest}));
  }
} finally { server.stop(true); }
