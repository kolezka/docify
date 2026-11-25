import { expect, test } from 'bun:test';
import { CrawlPool } from '../src/core/crawl-pool.ts';
import { crawl, DEFAULT_LIMITS } from '../src/core/collect.ts';

test('rotates waiting sources, skips saturated hosts, and removes cancelled work', async () => {
  const pool = new CrawlPool(2, 1);
  const a = Symbol(), b = Symbol();
  const controller = new AbortController();
  const started:string[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const submit = (source:symbol, host:string, name:string, signal = new AbortController().signal) => {
    const gate = Promise.withResolvers<void>();
    gates.set(name,gate);
    return pool.run(source,host,signal, async () => {started.push(name); await gate.promise;});
  };
  const first = submit(a,'x','a1');
  const second = submit(a,'x','a2');
  const third = submit(a,'x','a3');
  const other = submit(b,'x','b1');
  const cancelled = submit(Symbol(),'x','cancelled',controller.signal);
  const independent = submit(Symbol(),'y','y');
  controller.abort(new Error('cancel fixture'));
  await expect(cancelled).rejects.toThrow('cancel fixture');
  expect(started).toEqual(['a1','y']);
  for (const [name, done, next] of [['a1',first,'a2'],['a2',second,'b1'],['b1',other,'a3']] as const) {
    gates.get(name)!.resolve(); await done; await Bun.sleep(0);
    expect(started.at(-1)).toBe(next);
  }
  gates.get('a3')!.resolve(); gates.get('y')!.resolve(); await Promise.all([third, independent]);
});

test('holds the global slot through streamed body consumption; abort frees it for another source', async () => {
  const pool = new CrawlPool(1,1);
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const starts:string[]=[];
  const stalled = crawl('https://first.test/',DEFAULT_LIMITS,async (url,init)=>{
    starts.push(url);
    return new Response(new ReadableStream({start(stream){entered.resolve(); init.signal!.addEventListener('abort',()=>stream.error(init.signal!.reason),{once:true});}}),{headers:{'content-type':'text/html'}});
  },{pool,signal:controller.signal});
  await entered.promise;
  const second = crawl('https://other.test/',DEFAULT_LIMITS,async(url)=>{starts.push(url);return new Response('<article>Other</article>',{headers:{'content-type':'text/html'}});},{pool});
  await Bun.sleep(0); expect(starts).toEqual(['https://first.test/']);
  controller.abort(new Error('cancel first')); await expect(stalled).rejects.toThrow('cancel first');
  expect((await second).map(d=>d.url)).toEqual(['https://other.test/']);
});
