import { expect, test } from "bun:test";
import { join } from "node:path";

const posix = process.platform === "darwin" || process.platform === "linux";

test.skipIf(!posix)("local embedding entrypoint disables native telemetry before ONNX loads", async () => {
  const script = `
    import { dlopen } from "bun:ffi";
    const libc = dlopen(${JSON.stringify(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6")}, {
      getenv: { args: ["cstring"], returns: "cstring" },
    });
    const name = Buffer.from("ORT_DISABLE_TELEMETRY\\0");
    const readNative = () => libc.symbols.getenv(name)?.toString() ?? null;
    const initial = readNative();
    const atBindingLoad = [];
    const original = process.dlopen;
    process.dlopen = function(...args) {
      if (String(args[1]).includes("onnxruntime_binding.node")) atBindingLoad.push(readNative());
      return original.apply(this, args);
    };
    await import(${JSON.stringify(join(import.meta.dir, "../src/core/embed.ts"))});
    console.log(JSON.stringify({ initial, atBindingLoad, afterNative: readNative(), afterJs: process.env.ORT_DISABLE_TELEMETRY }));
    libc.close();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ORT_DISABLE_TELEMETRY: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout.trim());
  expect(result.initial).toBe("0");
  // A positive control: the observer must see the real native binding, not just the JS flag.
  expect(result.atBindingLoad.length).toBeGreaterThan(0);
  expect(result.atBindingLoad).toEqual(["1"]);
  expect(result.afterNative).toBe("1");
  expect(result.afterJs).toBe("1");
});
