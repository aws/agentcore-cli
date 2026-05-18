#!/usr/bin/env bash
# Run E2E tests against your dev account using local credentials.
#
# Usage:
#   ./scripts/run-e2e-dev.sh                          # runs strands-bedrock.test.ts
#   ./scripts/run-e2e-dev.sh --all                    # runs the full e2e suite
#   ./scripts/run-e2e-dev.sh e2e-tests/foo.test.ts    # runs a specific test file

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse arguments ────────────────────────────────────────────────────────────
RUN_ALL=false
TEST_FILES=()
for arg in "$@"; do
  if [[ "$arg" == "--all" ]]; then
    RUN_ALL=true
  else
    TEST_FILES+=("$arg")
  fi
done

# ── Build & install CLI from source ────────────────────────────────────────────
cd "$REPO_ROOT"
npm run build
TARBALL=$(npm pack | tail -1)
npm install -g "$TARBALL"
echo "=== Installed: $(agentcore --version) ==="

# ── Set env vars for tests ─────────────────────────────────────────────────────
export AWS_REGION="$REGION"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# ── Run tests ──────────────────────────────────────────────────────────────────
cd "$REPO_ROOT"

EXCLUDE_API_KEY_TESTS=(
  --exclude 'e2e-tests/*-anthropic*'
  --exclude 'e2e-tests/*-openai*'
  --exclude 'e2e-tests/*-gemini*'
)

if [[ "$RUN_ALL" == "true" ]]; then
  echo "=== Running full e2e suite ==="
  npx vitest run --project e2e
elif [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  echo "=== Running: ${TEST_FILES[*]} ==="
  npx vitest run --project e2e "${TEST_FILES[@]}"
else
  echo "=== Running all Bedrock/IAM tests (excluding API-key-dependent tests) ==="
  npx vitest run --project e2e "${EXCLUDE_API_KEY_TESTS[@]}"
fi
