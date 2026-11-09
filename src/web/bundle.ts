import { join } from "node:path";
import { SveltePlugin } from "bun-plugin-svelte";
import tailwind from "bun-plugin-tailwind";

export interface UiAsset {
  body: Blob;
  type: string;
}

let built: Promise<Map<string, UiAsset>> | undefined;

// Built in memory on first use, with the plugins passed here: Bun reads bunfig.toml from the
// current directory, and `docify serve` runs from any directory.
export function uiAssets(): Promise<Map<string, UiAsset>> {
  built ??= buildUi().catch((err) => {
    built = undefined;
    throw err;
  });
  return built;
}

async function buildUi(): Promise<Map<string, UiAsset>> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.html")],
    target: "browser",
    minify: true,
    publicPath: "/",
    plugins: [SveltePlugin({ development: false }), tailwind],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new Error(`web UI build failed:\n${result.logs.map(String).join("\n")}`);
  const assets = new Map<string, UiAsset>();
  for (const out of result.outputs) {
    const path = "/" + out.path.replace(/^\.?\//, "");
    assets.set(path === "/index.html" ? "/" : path, { body: out, type: out.type });
  }
  if (!assets.has("/")) throw new Error("web UI build produced no index.html");
  return assets;
}
