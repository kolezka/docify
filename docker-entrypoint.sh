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
unset_empty DOCIFY_WEB_TOKEN DOCIFY_ALLOWED_HOSTS DOCIFY_SOURCE_ROOTS LITELLM_BASE_URL LITELLM_API_KEY \
  DOCIFY_GITHUB_CLIENT_ID DOCIFY_GITHUB_CLIENT_SECRET DOCIFY_ADMINS DOCIFY_PUBLIC_URL

# A bind-mounted host directory keeps its host owner. Fail with a clear message instead of
# a sqlite error deep in startup.
data_dir="${DOCIFY_HOME:-/data}"
# DOCIFY_DATA_DIR is the host path, passed in by the compose file so the hint can name it.
if ! [ -w "$data_dir" ]; then
  host_dir="${DOCIFY_DATA_DIR:-<host directory mounted at $data_dir>}"
  echo "docify: $data_dir is not writable by uid $(id -u). On the host run:" >&2
  echo "  sudo mkdir -p $host_dir" >&2
  echo "  sudo chown -R $(id -u):$(id -g) $host_dir" >&2
  echo "  sudo chmod -R u+rwX,g+rX,g-w,o-rwx $host_dir" >&2
  exit 1
fi

if [ "${DOCIFY_SETUP:-false}" = "true" ]; then
  bun /app/src/cli.ts setup
fi

exec bun /app/src/cli.ts serve \
  --port "${DOCIFY_PORT:-4747}" \
  --host "${DOCIFY_HOST:-0.0.0.0}" \
  "$@"
