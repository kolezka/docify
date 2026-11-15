import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256 } from "./hash.ts";

// Snapshot files that nothing opens by line number are stored gzipped, with ".gz" added to the name.
// Stores and backups made before that hold plain files, so every reader accepts both.

const GZ = ".gz";
// One document is never larger than the largest total crawl limit (maxTotalMb, 1000 MB).
// A backup is untrusted, so unpacking stops there.
const MAX_CONTENT_BYTES = 1_000_000_000;

// Snapshot file of a document, relative to its generation directory, from the stored absolute path.
export function snapshotRel(snapshotDir: string, file: string): string | null {
  const rel = relative(snapshotDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

// Writes a snapshot file, gzipped when asked, and returns the path it was written to.
export function writeSnapshotFile(file: string, content: Uint8Array | string, gzip: boolean): string {
  if (!gzip) {
    writeFileSync(file, content);
    return file;
  }
  writeFileSync(file + GZ, gzipSync(content));
  return file + GZ;
}

// The content a stored snapshot file holds, or null when it is not what the database recorded.
// The recorded hash is over the content, so it also tells a gzipped file from a plain one named "*.gz".
export function snapshotContent(name: string, stored: Uint8Array<ArrayBuffer>, sha: string): Uint8Array<ArrayBuffer> | null {
  if (name.endsWith(GZ)) {
    let content: Uint8Array<ArrayBuffer> | null = null;
    try {
      content = gunzipSync(stored, { maxOutputLength: MAX_CONTENT_BYTES });
    } catch {
      // Not gzip, or damaged: the plain comparison below decides.
    }
    if (content && sha256(content) === sha) return content;
  }
  return sha256(stored) === sha ? stored : null;
}

export function readSnapshotFile(file: string, sha: string): Uint8Array<ArrayBuffer> | null {
  return snapshotContent(file, readFileSync(file), sha);
}
