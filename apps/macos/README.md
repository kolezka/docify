# Docify Admin (macOS)

A small SwiftUI window for managing Docify sources: list, add, prepare, cancel and remove. It runs the `docify` CLI, so it uses the same store (`~/.cache/docify`, or `DOCIFY_HOME`) and the same preparation locks as the CLI and the web UI.

```bash
bun link                  # once, so ~/.bun/bin/docify exists
cd apps/macos
swift run                 # or: swift build -c release && .build/release/DocifyAdmin
```

Set `DOCIFY_BIN` to use a different `docify` executable, for example `src/cli.ts` of a worktree. The list refreshes every 3 seconds, so preparations started from the CLI show up too. Cancel sends SIGINT, the same as Ctrl-C in `docify prepare`, and the previous generation stays active.

## Settings (Cmd-,)

- **LiteLLM**: base URL and API key. The URL is kept in the app's UserDefaults, the key in the macOS Keychain (service `docify-admin`). The app passes them to every `docify` run as `LITELLM_BASE_URL` and `LITELLM_API_KEY` (or the variable names `config.json` sets), because an app opened from the Dock does not see variables from your shell profile. Empty fields fall back to the environment the app started with. A trailing `/v1` is removed, since the graph adds it.
- **Embeddings**: provider (built-in, Ollama, LiteLLM / OpenAI API), model, dimensions, query prefix and the two similarity thresholds, written to `config.json`. Switching the provider fills in the usual model and dimensions. After a change of provider or model, prepare every source again; until then search skips vector mode for it. The Embeddings column shows what each source was prepared with.
- **Graph**: on or off (`"graph": null`), and the model.

Keys the app does not know are kept when it saves `config.json`. A malformed `config.json` is shown as an error and never overwritten.
