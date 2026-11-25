# Keep Docify work records in the existing Outline folder

If your team already stores Docify work records under `<collection>/ai-docify`, keep the project name `docify` and set its `kb_folder` to that existing folder. This avoids starting a second task history under `<collection>/docify`.

For a new local `worklog-persist` project mapping, run the following from the main Docify checkout. Set `WORKLOG_SCRIPTS` to the plugin's scripts directory, `WORLD` to your configured world, and `COLLECTION` to your Outline collection name.

```sh
bash "${WORKLOG_SCRIPTS:?}/config-add.sh" project \
  --world "${WORLD:?}" --name docify \
  --repo "$(git rev-parse --show-toplevel)" \
  --kb-folder "${COLLECTION:?}/ai-docify"
```

Run `bash "$WORKLOG_SCRIPTS/resolve-context.sh"` from the checkout and check that `tasks_path` is `<collection>/ai-docify/Tasks`. This mapping applies to the local plugin configuration. It does not move Outline documents or configure other machines.
