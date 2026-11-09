import pkg from "../package.json" with { type: "json" };

// package.json is the only place the version is written; scripts/release.ts bumps it with the plugins.
export const VERSION: string = pkg.version;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value: string): [number, number, number] {
  const m = SEMVER.exec(value.trim());
  if (!m) throw new Error(`not a version: ${JSON.stringify(value)} (expected X.Y.Z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// Plugins start `docify mcp --require <their version>`. The docify on PATH may come from an older
// checkout, so refuse to start rather than serve tools the plugin's skill does not match.
export function requireVersion(min: string, current = VERSION): void {
  if (compareVersions(current, min) < 0) {
    throw new Error(`this plugin needs docify ${min} or newer, but the docify on PATH is ${current}; update it (bun link in a current checkout)`);
  }
}
