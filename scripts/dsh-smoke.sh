#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TGZ="${1:-$ROOT/dsh-offpeak-saver-0.2.0.tgz}"
TMP="$(mktemp -d)"
TGZ="$TMP/plugin.tgz"
cp "$SRC_TGZ" "$TGZ"
if command -v cygpath >/dev/null 2>&1; then
  TGZ="$(cygpath -m "$TGZ")"
fi
WEB_PID=""

cleanup() {
  if [ -n "$WEB_PID" ]; then
    kill "$WEB_PID" 2>/dev/null || true
    if command -v taskkill >/dev/null 2>&1; then
      taskkill //F //T //PID "$WEB_PID" >/dev/null 2>&1 || true
    fi
    for _ in $(seq 1 10); do
      if ! kill -0 "$WEB_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

export DSH_HOME="$TMP/dsh-home"

echo "== install packed plugin into a fresh DSH profile =="
pnpm dlx @deepseek-ai/dsh plugin --profile web add "$TGZ"

echo "== verify the plugin row exists in the composed config =="
pnpm dlx @deepseek-ai/dsh --profile web --dump-config | grep -q 'offpeak-saver'
echo "PASS plugin appears in DSH config"

echo "== boot dsh web with the plugin loaded (bounded retry, 30s cap) =="
pnpm dlx @deepseek-ai/dsh web --port 4099 >"$TMP/web.log" 2>&1 &
WEB_PID=$!

ready=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4099 >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "FAIL dsh web did not become ready within 30s"
  cat "$TMP/web.log"
  exit 1
fi

echo "PASS dsh web booted with the plugin loaded (HTTP 200)"
