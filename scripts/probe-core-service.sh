#!/usr/bin/env bash
# Drives the whole core_service experiment: daemon up, modules in, probe, daemon
# down. Called by `make probe-core-service`.
#
# A shell script rather than a make recipe because the sequence needs real
# control flow — a loop whose failures are tolerated, a probe whose exit status
# must survive the cleanup that follows it — and make's line-per-shell recipes
# turn that into unreadable backslash soup that silently stopped executing
# halfway.
set -uo pipefail

cd "$(dirname "$0")/.."

LOGOSCTL=${LOGOSCTL:-./logosctl/bin/logosctl}
MODULE=${MODULE:-delivery_module}
# capability_module is built into the daemon, so cap-lgx is not in this list.
LGX_DIRS=${DAEMON_LGX_DIRS:-"lez-core-lgx lez-rln-lgx rln-lgx delivery-lgx"}

say() { printf '\n=== %s ===\n' "$1"; }

say "stopping any daemon from a previous run"
# `daemon start` refuses a second daemon in the same config dir, and a stale one
# holds the old config and an already-rotated token.
"$LOGOSCTL" daemon stop >/dev/null 2>&1 || true

say "installing config"
"$LOGOSCTL" daemon config set scripts/daemon-node.yaml || exit 1

say "starting daemon"
# Backgrounded, then polled. `daemon start` does not detach when stdout is not a
# terminal — it keeps writing the daemon's log to the foreground and never
# returns, so calling it directly from a script or a make recipe hangs forever.
# Run it detached and wait for the thing that actually matters: the port.
start_log=$(mktemp)
"$LOGOSCTL" daemon start >"$start_log" 2>&1 &
for _ in $(seq 1 60); do
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:7001'; then break; fi
  sleep 1
done
if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:7001'; then
  echo "daemon never bound 127.0.0.1:7001; last of its log:"
  tail -20 "$start_log"
  exit 1
fi
echo "  core_service listening on 127.0.0.1:7001"

cleanup() { "$LOGOSCTL" daemon stop >/dev/null 2>&1 || true; }
trap cleanup EXIT

say "installing module packages into the daemon's store"
for d in $LGX_DIRS; do
  # Failures are tolerated: a package already installed at the same version is
  # reported as an error, and re-running this script is normal.
  if "$LOGOSCTL" package install --file "$d"/*.lgx -y >/dev/null 2>&1; then
    echo "  $d: installed"
  else
    echo "  $d: already present or failed (continuing)"
  fi
done

say "loading $MODULE"
"$LOGOSCTL" module load "$MODULE" 2>&1 | tail -c 300
echo

say "driving it from Node through core_service"
nix develop --no-write-lock-file "${LIBLOGOS_FLAKE:-$HOME/src/logos-co/logos-liblogos}" \
  -c node scripts/probe-core-service.js
