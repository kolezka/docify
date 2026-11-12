#!/bin/sh
# Serve the web UI; DOCIFY_SETUP=true runs the one-time setup first.
set -eu

# Compose passes variables that are unset in .env as empty strings, which would shadow
# defaults in config.json (for example an empty LITELLM_BASE_URL).
unset_empty() {
  for name in "$@"; do
    eval "value=\${$name-}"
    if [ -z "$value" ]; then unset "$name"; fi
  done
}
unset_empty DOCIFY_WEB_TOKEN DOCIFY_ALLOWED_HOSTS DOCIFY_SOURCE_ROOTS LITELLM_BASE_URL LITELLM_API_KEY

if [ "${DOCIFY_SETUP:-false}" = "true" ]; then
  bun /app/src/cli.ts setup
fi

exec bun /app/src/cli.ts serve \
  --port "${DOCIFY_PORT:-4747}" \
  --host "${DOCIFY_HOST:-0.0.0.0}" \
  "$@"
