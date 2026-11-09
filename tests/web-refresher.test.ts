import { expect, test } from "bun:test";
import { Refresher } from "../src/web/lib/refresher.ts";

// A read whose completion the test controls, so an old response can arrive after a newer request.
function controlledReads() {
  const pending: { id: number; resolve: () => void }[] = [];
  let started = 0;
  const read = () =>
    new Promise<void>((resolve) => {
      started += 1;
      pending.push({ id: started, resolve });
    });
  return { read, pending, started: () => started };
}

test("a refresh asked for while a read runs waits for a new read, not the old one", async () => {
  const reads = controlledReads();
  const refresher = new Refresher(reads.read);
  const settled: string[] = [];

  refresher.run().then(() => settled.push("poll"));
  // A mutation succeeded while the poll was still in flight; its refresh must see newer data.
  const afterMutation = refresher.run().then(() => settled.push("after-mutation"));

  expect(reads.started()).toBe(1);
  reads.pending[0]!.resolve();
  await Bun.sleep(0);
  expect(settled).toEqual(["poll"]);
  expect(reads.started()).toBe(2);

  reads.pending[1]!.resolve();
  await afterMutation;
  expect(settled).toEqual(["poll", "after-mutation"]);
});

test("calls during one read share a single follow-up read, and a failed read still lets the next one run", async () => {
  let started = 0;
  let fail = true;
  const resolvers: (() => void)[] = [];
  const refresher = new Refresher(
    () =>
      new Promise<void>((resolve, reject) => {
        started += 1;
        resolvers.push(() => (fail ? ((fail = false), reject(new Error("offline"))) : resolve()));
      }),
  );

  const first = refresher.run().catch(() => "failed");
  const a = refresher.run();
  const b = refresher.run();
  resolvers[0]!();
  expect(await first).toBe("failed");
  await Bun.sleep(0);
  expect(started).toBe(2);
  resolvers[1]!();
  await Promise.all([a, b]);
  expect(started).toBe(2);
});
