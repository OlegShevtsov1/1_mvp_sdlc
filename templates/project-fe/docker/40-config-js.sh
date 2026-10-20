#!/bin/sh
# Runs from the nginx image entrypoint (/docker-entrypoint.d) before nginx starts:
# writes the runtime config the app reads from /config.js, so one image serves every
# environment. Values are restricted to URL-safe characters because they are placed
# inside JS string literals; a bad value stops the container instead of serving it.
set -eu

out=${CONFIG_JS_PATH:-/usr/share/nginx/html/config.js}

fail() {
  echo "config.js: $1" >&2
  exit 1
}

for name in API_URL ENV_NAME; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is required"
done

SENTRY_DSN=${SENTRY_DSN:-}
APP_VERSION=${KAMAL_VERSION:-local}

for name in API_URL SENTRY_DSN ENV_NAME APP_VERSION; do
  eval "value=\$$name"
  case $value in
    *[!A-Za-z0-9._~:/?#@\&=%+-]*) fail "$name has invalid characters" ;;
  esac
done

tmp="$out.tmp"
cat > "$tmp" <<JS
window.APP_CONFIG = {
  API_URL: "$API_URL",
  SENTRY_DSN: "$SENTRY_DSN",
  ENV_NAME: "$ENV_NAME",
  APP_VERSION: "$APP_VERSION",
};
JS
mv "$tmp" "$out"
