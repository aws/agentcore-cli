#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start-tui-harness.sh
#
# Convenience wrapper to build (if needed) and start the TUI harness MCP
# server over HTTP transport.
#
# Usage:
#   ./scripts/start-tui-harness.sh              # default port 24100
#   ./scripts/start-tui-harness.sh --port 8080  # custom port
#
# The server runs in the foreground so it can be stopped with Ctrl-C.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve project root (parent directory of this script's directory)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Parse optional --port argument (default: 24100)
# ---------------------------------------------------------------------------
PORT=24100

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --port requires a value" >&2
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--port PORT]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Build the harness bundle if it doesn't exist yet
# ---------------------------------------------------------------------------
HARNESS_BUNDLE="$PROJECT_DIR/dist/mcp-harness/index.mjs"

if [[ ! -f "$HARNESS_BUNDLE" ]]; then
  echo "Harness bundle not found at $HARNESS_BUNDLE"
  echo "Building with: npm run build:harness ..."
  (cd "$PROJECT_DIR" && npm run build:harness)
  echo ""
fi

# ---------------------------------------------------------------------------
# Start the HTTP MCP server
# ---------------------------------------------------------------------------
echo "=========================================="
echo "  TUI Harness MCP Server (HTTP transport)"
echo "=========================================="
echo ""
echo "  URL:  http://127.0.0.1:${PORT}/mcp"
echo ""
echo "  Add this to your .mcp.json:"
echo ""
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"tui-harness\": {"
echo "        \"type\": \"http\","
echo "        \"url\": \"http://127.0.0.1:${PORT}/mcp\""
echo "      }"
echo "    }"
echo "  }"
echo ""
echo "  Press Ctrl-C to stop the server."
echo "=========================================="
echo ""

# Export the port so the harness process can read it from the environment
export MCP_HTTP_PORT="$PORT"

# Run the harness bundle as a foreground process
exec node "$HARNESS_BUNDLE"
