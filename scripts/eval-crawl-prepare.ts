import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Docify as Core } from '../src/core/docify.ts';

// Pass an existing checkout to run the identical fixture against an older core.
const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
const {Docify}: {Docify: typeof Core} = await import(join(root, 'src/core/docify.ts'));
let active = 0, peak = 0;
const server = Bun.serve({hostname:'127.0.0.1',port:0, async fetch(req) {
  const leaf = new URL(req.url).pathname.split('/').pop();
  peak = Math.max(peak, ++active);
  try {
    await Bun.sleep(20);
    const body = leaf === '' ? Array.from({length:24}, (_,i)=>`<a href="p${i}.html">Page ${i}</a>`).join('\n') : `<article>Page ${leaf}</article>`;
    return new Response(body,{headers:{'content-type':'text/html'}});
  } finally { active--; }
}});
try {
  for(const sources of [1,3]) {
    const times:number[]=[];
    let digest='';
    peak=0;
    for(let run=0;run<5;run++) {
      const home=mkdtempSync(join(tmpdir(),'docify-crawl-bench-'));
      const d=new Docify({home, modelsDir:process.env.DOCIFY_MODELS_DIR ?? join((await import(join(root,'src/core/config.ts'))).docifyHome(),'models')});
      try {
        const ids=Array.from({length:sources},(_,i)=>d.addSource({kind:'url',library:`s${i}`,version:null,locator:new URL(`/s${i}/`,server.url).href}).id);
        const start=performance.now();
        const results=await Promise.all(ids.map(id=>d.prepare(id,{graph:false})));
        times.push(Math.round(performance.now()-start));
        for(const r of results) {
          if(r.status!=='activated') throw new Error(r.status);
          const rows=d.db.query('SELECT path, raw_sha256, normalized_sha256 FROM documents WHERE generation_id=? ORDER BY path').all(r.generationId!);
          if(rows.length!==25) throw new Error(`Expected 25 documents, got ${rows.length}`);
          const hash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
          if(digest && digest!==hash) throw new Error('Inconsistent prepared documents');
          digest=hash;
        }
      } finally { d.close(); if(resolve(home).startsWith(resolve(tmpdir(),'docify-crawl-bench-'))) rmSync(home,{recursive:true,force:true}); }
    }
    console.log(JSON.stringify({sources,times,medianMs:times.toSorted((a,b)=>a-b)[2],peak,digest}));
  }
} finally {server.stop(true);}
