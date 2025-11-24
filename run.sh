#!/usr/bin/env bash
set -euo pipefail

# Ensure pnpm is available
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[run.sh] pnpm not found, falling back to npm/yarn if available..."
fi

# Install deps if node_modules missing or empty
if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null || true)" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile || pnpm install
  elif command -v npm >/dev/null 2>&1; then
    npm ci || npm install
  elif command -v yarn >/dev/null 2>&1; then
    yarn install --frozen-lockfile || yarn install
  else
    echo "[run.sh] No package manager found (pnpm/npm/yarn)." >&2
    exit 1
  fi
fi

# Build TypeScript -> dist
if command -v pnpm >/dev/null 2>&1; then
  pnpm build
elif command -v npm >/dev/null 2>&1; then
  npm run build --silent
else
  yarn build --silent
fi

# Start the bot from dist
exec node dist/index.js
