#!/usr/bin/env bash
# Does the DAEMON work inside the packaged AppImage?
#
# `make verify-appimage` proves the 0.1.0 claim: the addon loads the module from
# the packaged app. It never touches logosctl, so it would pass just as happily
# with the daemon missing or unable to find its Qt plugins — which is exactly
# the failure bundling a Nix-wrapped binary invites.
#
# This extracts the AppImage and runs the BUNDLED logosctl out of it, with
# LD_LIBRARY_PATH and QT_PLUGIN_PATH unset, so anything it resolves it resolves
# through its own $ORIGIN rpaths and the environment src/daemon.js supplies.
#
#   make verify-appimage-node
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# The CURRENT version's AppImage, not whatever sorts last: a stale 0.1.0 image
# from a previous build sits in dist/ alongside it, and picking that one fails
# with "no logosctl in the bundle" — a confusing way to be told you tested the
# wrong file.
VERSION=$(node -p "require('$ROOT/package.json').version")
APPIMAGE=${APPIMAGE:-$ROOT/dist/liblogos-electron-poc-$VERSION-x86_64.AppImage}
if [ ! -x "$APPIMAGE" ]; then
  echo "no AppImage found; run 'make appimage' first"
  exit 1
fi

say() { printf '\n=== %s ===\n' "$1"; }

workdir=$(mktemp -d)
cleanup() {
  if [ -n "${CONFIG_DIR:-}" ] && [ -n "${DAEMON_PID:-}" ]; then
    kill -TERM "$DAEMON_PID" 2>/dev/null
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

say "extracting $APPIMAGE"
cd "$workdir"
"$APPIMAGE" --appimage-extract >/dev/null 2>&1 || {
  echo "extraction failed"; exit 1;
}
RUNTIME="$workdir/squashfs-root/resources/runtime"
cd "$ROOT"

CTL="$RUNTIME/logosctl/bin/logosctl"
if [ ! -x "$CTL" ]; then
  echo "FAIL: no logosctl in the bundle at $CTL"
  echo "      (bundle-runtime.js skips it when ./logosctl is absent)"
  exit 1
fi
echo "  logosctl:  $CTL"
echo "  packages:  $(ls "$RUNTIME/packages" 2>/dev/null | tr '\n' ' ')"
echo "  plugins:   $(ls "$RUNTIME/qt-plugins" 2>/dev/null | tr '\n' ' ')"

# Everything below runs with a clean environment on purpose: no dev shell, no
# LD_LIBRARY_PATH, no QT_PLUGIN_PATH from the host. That is the whole test.
CONFIG_DIR="$workdir/session"
mkdir -p "$CONFIG_DIR"

say "does the bundled logosctl even run?"
if ! env -u LD_LIBRARY_PATH -u QT_PLUGIN_PATH \
     LOGOSCTL_CONFIG_DIR="$CONFIG_DIR" "$CTL" --version >/dev/null 2>&1; then
  echo "FAIL: the bundled logosctl could not start"
  env -u LD_LIBRARY_PATH -u QT_PLUGIN_PATH \
    LOGOSCTL_CONFIG_DIR="$CONFIG_DIR" "$CTL" --version 2>&1 | head -5
  exit 1
fi
echo "  yes"

say "starting the daemon from the bundle"
cat > "$CONFIG_DIR/daemon.yaml" <<'YAML'
insecure_tcp: true
modules:
  core_service:
    - protocol: tcp
      host: 127.0.0.1
      port: 7001
      codec: json
  capability_module:
    - protocol: tcp
      host: 127.0.0.1
      port: 7002
      codec: json
YAML

run_ctl() {
  env -u LD_LIBRARY_PATH -u QT_PLUGIN_PATH \
    LOGOSCTL_CONFIG_DIR="$CONFIG_DIR" \
    QT_PLUGIN_PATH="$RUNTIME/qt-plugins" \
    LOGOS_HOST_PATH="$RUNTIME/bin/logos_host" \
    "$CTL" "$@"
}

run_ctl daemon config set "$CONFIG_DIR/daemon.yaml" || exit 1
start_out=$(run_ctl daemon start --detach 2>&1)
echo "$start_out"
DAEMON_PID=$(printf '%s' "$start_out" | grep -oE 'pid [0-9]+' | grep -oE '[0-9]+' | head -1)

bound=0
for _ in $(seq 1 60); do
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:7001'; then bound=1; break; fi
  sleep 1
done
if [ "$bound" -ne 1 ]; then
  echo "FAIL: the bundled daemon never bound 127.0.0.1:7001"
  tail -20 "$CONFIG_DIR"/logs/*.log 2>/dev/null
  exit 1
fi
echo "  core_service listening on 127.0.0.1:7001"

say "installing the bundled packages and loading delivery_module"
for dir in "$RUNTIME"/packages/*/; do
  [ -d "$dir" ] || continue
  lgx=$(ls "$dir"*.lgx 2>/dev/null | head -1)
  [ -n "$lgx" ] || continue
  if run_ctl package install --file "$lgx" -y >/dev/null 2>&1; then
    echo "  $(basename "$dir"): installed"
  else
    echo "  $(basename "$dir"): already present or failed"
  fi
done

load_out=$(run_ctl module load delivery_module 2>&1 | tail -c 300)
echo "$load_out"
if printf '%s' "$load_out" | grep -q '"status":"ok"'; then
  echo
  echo "PASS: the daemon in the packaged AppImage loaded delivery_module"
  exit 0
fi

echo
echo "FAIL: the bundled daemon could not load delivery_module"
exit 1
