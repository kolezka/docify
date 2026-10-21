// Child process used by process tests.
// argv: <home> <source-id> <mode> [docs-dir]
//   hang:      prepare and block forever at the embed phase (parent kills it)
//   alternate: rewrite the source between two versions and re-prepare in a loop
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newDocify, fakeGraph } from "../helpers.ts";

const [home, id, mode, dir] = Bun.argv.slice(2);
const d = newDocify(home!);

if (mode === "hang") {
  await d.prepare(id!, {
    graphRunner: fakeGraph,
    force: true,
    onPhase: async (phase) => {
      if (phase === "embed") {
        console.log("HANGING");
        await new Promise(() => {});
      }
    },
  });
} else if (mode === "alternate") {
  for (let i = 0; i < 6; i++) {
    const marker = i % 2 === 0 ? "AMARKER" : "BMARKER";
    writeFileSync(join(dir!, "a.md"), `# Doc\n\n## Heron section\n\nHeron ${marker} herons wade in shallow water.\n\n## Crane section\n\nCrane ${marker} cranes fly high.\n`);
    await d.prepare(id!, { graphRunner: fakeGraph });
    console.log(`PREPARED ${marker}`);
  }
}
d.close();
