#!/bin/bash
set -e

# Resolve paths relative to this file, including folders containing spaces.
cd "$(dirname "$0")"

fail() {
  printf '%s\n' "$1"
  if [ -t 0 ]; then
    read -r -p "Press Enter to close. " _
  fi
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required. Install it, then reopen Terminal."
command -v npm >/dev/null 2>&1 || fail "npm was not found. Check your Node.js installation."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
  || fail "Node.js 24 or newer is required."

if [ ! -d node_modules ]; then
  fail "Run 'npm ci' in this project folder first, then run this launcher again."
fi

printf '%s\n' "Moa: http://127.0.0.1:4173" "Press Ctrl+C to stop."
exec npm run dev
