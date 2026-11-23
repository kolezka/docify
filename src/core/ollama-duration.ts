// Ollama's keep_alive format: seconds, a Go duration such as 5m or 1h30m, or -1 to keep the model loaded.
// No imports, so the web UI can share it without bundling node:fs.
export const OLLAMA_DURATION = /^(?=.)(-1|\d+|(\d+h)?(\d+m)?(\d+s)?)$/;
