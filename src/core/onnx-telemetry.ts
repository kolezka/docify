// Bun's process.env writes do not reach native getenv. Set the opt-out before ONNX loads.
const libcPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "linux" ? "libc.so.6" : null;
if (libcPath) {
  const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = dlopen(libcPath, {
    setenv: { args: ["cstring", "cstring", "i32"], returns: "i32" },
  });
  try {
    const result = libc.symbols.setenv(Buffer.from("ORT_DISABLE_TELEMETRY\0"), Buffer.from("1\0"), 1);
    if (result !== 0) throw new Error("Could not disable native ONNX telemetry");
  } finally {
    libc.close();
  }
}
process.env.ORT_DISABLE_TELEMETRY = "1";
