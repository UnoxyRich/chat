#!/usr/bin/env bash
# Production deployment helper for the local single-host setup.
# - Validates prerequisites (Node, npm, LM Studio, required files)
# - Installs dependencies if missing
# - Initializes the SQLite database (idempotent)
# - Builds the frontend
# - Starts the backend in production mode serving the built frontend

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FILES_DIR="$ROOT_DIR/files-for-uploading"
SYSTEM_PROMPT="$ROOT_DIR/SystemPromt.txt"
LOG_DIR="$ROOT_DIR/logs"
DB_DIR="$ROOT_DIR/db"
BACKEND_LOG="$LOG_DIR/backend.log"

# Safe defaults that align with backend/config.js (overridable via environment).
PORT="${PORT:-3000}"
LM_STUDIO_BASE_URL="${LM_STUDIO_BASE_URL:-http://localhost:1234/v1}"
LM_STUDIO_CHAT_MODEL="${LM_STUDIO_CHAT_MODEL:-qwen/qwen3-vl-8b}"
LM_STUDIO_EMBEDDING_MODEL="${LM_STUDIO_EMBEDDING_MODEL:-text-embedding-3-large}"

status() {
  echo "[deploy] $*"
}

fail() {
  echo "[deploy][ERROR] $*" >&2
  exit 1
}

status "Starting deployment from $ROOT_DIR"

cd "$ROOT_DIR"

# Ensure required commands exist.
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Please install Node.js >=18."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. Please install npm."
command -v curl >/dev/null 2>&1 || fail "curl is required for health checks."

status "Node.js version: $(node -v)"
status "npm version: $(npm -v)"

# Validate required files and directories.
[ -f "$SYSTEM_PROMPT" ] || fail "SystemPromt.txt is missing at $SYSTEM_PROMPT"
[ -d "$FILES_DIR" ] || fail "files-for-uploading/ directory is missing at $FILES_DIR"

mkdir -p "$LOG_DIR" "$DB_DIR"

# Check LM Studio availability at the configured endpoint.
LM_HEALTH_URL="${LM_STUDIO_BASE_URL%/}/models"
status "Verifying LM Studio is reachable at $LM_HEALTH_URL"
if ! curl -fsS --max-time 5 "$LM_HEALTH_URL" >/dev/null; then
  fail "LM Studio is not reachable at $LM_HEALTH_URL. Please start LM Studio with an OpenAI-compatible server."
fi

# Install project dependencies (always) to ensure required modules like pdf-parse are present.
status "Installing project dependencies..."
npm install || fail "npm install failed."

# Install frontend dependencies if missing.
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  status "Installing frontend dependencies..."
  npm install --prefix "$FRONTEND_DIR"
else
  status "Frontend dependencies already installed."
fi

# Initialize the SQLite database without destructive actions.
status "Initializing database (idempotent)..."
node --input-type=module <<'NODE'
import { initDatabase } from './backend/db.js';
import { ensureDirectories, CONFIG } from './backend/config.js';
ensureDirectories();
const db = initDatabase();
db.close();
console.log(`[deploy] Database ready at ${CONFIG.dbFile}`);
NODE

# Build the frontend so the backend can serve the static assets.
status "Building frontend (React + Vite)..."
npm run build --prefix "$FRONTEND_DIR"

# Prevent double-start if a previous deployment is still running.
if [ -f "$ROOT_DIR/.backend.pid" ] && kill -0 "$(cat "$ROOT_DIR/.backend.pid")" >/dev/null 2>&1; then
  fail "Backend already appears to be running (PID $(cat "$ROOT_DIR/.backend.pid")). Stop it before redeploying."
fi

# Start the backend in production mode, serving the built frontend.
status "Starting backend on port ${PORT} (logs: ${BACKEND_LOG})..."
export PORT
export LM_STUDIO_BASE_URL
export LM_STUDIO_CHAT_MODEL
export LM_STUDIO_EMBEDDING_MODEL
export NODE_ENV=production
(
  cd "$ROOT_DIR" || exit 1
  node server.js > "$BACKEND_LOG" 2>&1 &
  echo $! > "$ROOT_DIR/.backend.pid"
)

# Verify the backend process started.
if [ ! -f "$ROOT_DIR/.backend.pid" ] || ! kill -0 "$(cat "$ROOT_DIR/.backend.pid")" >/dev/null 2>&1; then
  fail "Backend failed to start. Check $BACKEND_LOG for details."
fi

# Wait for the backend health check to succeed.
HEALTH_URL="http://localhost:3000/health"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    status "Backend is healthy at $HEALTH_URL (PID $(cat "$ROOT_DIR/.backend.pid"))."
    break
  fi
  sleep 1
  if ! kill -0 "$(cat "$ROOT_DIR/.backend.pid")" >/dev/null 2>&1; then
    fail "Backend process exited before becoming healthy. Check $BACKEND_LOG for details."
  fi
  if [ "$attempt" -eq 20 ]; then
    fail "Backend did not become healthy. Check $BACKEND_LOG for details."
  fi
  status "Waiting for backend to become ready (attempt $attempt)..."
done

status "Deployment complete. Chat UI available via backend on port ${PORT}."
