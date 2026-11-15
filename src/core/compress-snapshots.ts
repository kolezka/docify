import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { Docify } from "./docify.ts";
import { sha256 } from "./hash.ts";
import { readSnapshotFile, snapshotContent, snapshotRel } from "./snapshot-file.ts";

// Gzips the snapshot files of generations prepared before prepare did it itself: raw HTML and
// every normalized copy. Raw Markdown stays plain, as in prepare.
// A file is replaced only when it matches its recorded hash, and nothing is overwritten.
// One that cannot be placed stays as it is and is reported.

export interface CompressResult {
  files: number;
  bytesBefore: number;
  bytesAfter: number;
  skipped: { sourceId: string; generationId: number; file: string; reason: string }[];
}

interface DocRow {
  id: number;
  kind: string;
  raw_file: string;
  raw_sha256: string;
  normalized_file: string;
  normalized_sha256: string;
}

const GZ = ".gz";
// Files handled between two pauses that let the lease heartbeat run.
const YIELD_EVERY = 25;

// Size of what is at this path, or null when nothing is.
const sizeOfFile = (file: string): number | null => {
  try {
    return lstatSync(file).size;
  } catch {
    return null;
  }
};

export async function compressSnapshots(docify: Docify): Promise<CompressResult> {
  const home = docify.config.home;
  return docify.withAllLeases(async () => {
    const result: CompressResult = { files: 0, bytesBefore: 0, bytesAfter: 0, skipped: [] };
    let seen = 0;
    const gens = docify.db
      .query<{ id: number; source_id: string; snapshot_dir: string }, []>("SELECT id, source_id, snapshot_dir FROM generations WHERE status IN ('active', 'superseded') AND snapshot_dir IS NOT NULL ORDER BY id")
      .all();
    for (const g of gens) {
      // Built from home, never from the stored snapshot_dir.
      const dir = join(home, "snapshots", g.source_id, String(g.id));
      const docs = docify.db.query<DocRow, [number]>("SELECT id, kind, raw_file, raw_sha256, normalized_file, normalized_sha256 FROM documents WHERE generation_id = ?").all(g.id);
      // Every file a document of this generation points at; none of them is ever removed as a leftover.
      const recorded = new Set<string>();
      for (const d of docs) for (const file of [d.raw_file, d.normalized_file]) recorded.add((snapshotRel(g.snapshot_dir, file) ?? file).toLowerCase());
      const moved: { id: number; column: "raw_file" | "normalized_file"; stored: string; plain: string }[] = [];
      const leftovers: string[] = [];
      for (const d of docs) {
        for (const [column, stored, sha] of [
          ["raw_file", d.raw_file, d.raw_sha256],
          ["normalized_file", d.normalized_file, d.normalized_sha256],
        ] as const) {
          if (column === "raw_file" && d.kind !== "html") continue;
          if (++seen % YIELD_EVERY === 0) await Bun.sleep(0);
          const rel = snapshotRel(g.snapshot_dir, stored);
          const skip = (reason: string) => result.skipped.push({ sourceId: g.source_id, generationId: g.id, file: rel ?? stored, reason });
          if (!rel) {
            skip("points outside its snapshot");
            continue;
          }
          const file = join(dir, rel);
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = readFileSync(file);
          } catch {
            skip("missing");
            continue;
          }
          const content = snapshotContent(rel, bytes, sha);
          if (!content) {
            skip("does not match its recorded hash");
            continue;
          }
          if (content !== bytes) {
            // Already gzipped. A run stopped after the database update left the plain file behind.
            const plain = file.slice(0, -GZ.length);
            const size = sizeOfFile(plain);
            if (size !== null && !recorded.has(rel.slice(0, -GZ.length).toLowerCase()) && sha256(readFileSync(plain)) === sha) {
              leftovers.push(plain);
              result.files++;
              result.bytesBefore += size;
              result.bytesAfter += bytes.length;
            }
            continue;
          }
          const target = file + GZ;
          if (sizeOfFile(target) === null) {
            // Renamed into place, so a run that dies here never leaves half a file under the final name.
            const tmp = `${target}.${process.pid}.tmp`;
            writeFileSync(tmp, gzipSync(content));
            renameSync(tmp, target);
          }
          // Read back from disk. A file that was already there is used only when it holds this content,
          // as one written by an interrupted run does.
          let written: Uint8Array<ArrayBuffer> | null = null;
          try {
            written = readSnapshotFile(target, sha);
          } catch {
            // A directory, or unreadable: reported below.
          }
          if (!written) {
            skip(`the name ${rel}${GZ} is taken`);
            continue;
          }
          moved.push({ id: d.id, column, stored: stored + GZ, plain: file });
          result.files++;
          result.bytesBefore += bytes.length;
          result.bytesAfter += sizeOfFile(target) ?? 0;
        }
      }
      // The paths of one generation change together, and a plain file goes only after that.
      docify.db.transaction(() => {
        for (const m of moved) docify.db.run(`UPDATE documents SET ${m.column} = ? WHERE id = ?`, [m.stored, m.id]);
      })();
      for (const plain of [...moved.map((m) => m.plain), ...leftovers]) unlinkSync(plain);
    }
    return result;
  });
}
