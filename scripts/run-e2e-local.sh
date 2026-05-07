#!/usr/bin/env bash
# Run E2E tests locally, replicating the GitHub Actions e2e-tests.yml workflow.
#
# Required env vars:
#   E2E_ROLE_ARN    — IAM role ARN to assume (grants access to the test account)
#   E2E_SECRET_ARN  — Secrets Manager ARN containing ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
#
# Optional env vars:
#   AWS_REGION      — defaults to us-east-1
#
# Usage:
#   export E2E_ROLE_ARN=arn:aws:iam::<account>:role/<role>
#   export E2E_SECRET_ARN=arn:aws:secretsmanager:<region>:<account>:secret:<name>
#   ./scripts/run-e2e-local.sh                          # runs strands-bedrock.test.ts (CI default)
#   ./scripts/run-e2e-local.sh --all                    # runs the full e2e suite
#   ./scripts/run-e2e-local.sh e2e-tests/foo.test.ts    # runs a specific test file
#
# Prerequisites: aws CLI, node >=20.19, npm, git, uv, jq

set -euo pipefail

ROLE_ARN="${E2E_ROLE_ARN:-}"
SECRET_ARN="${E2E_SECRET_ARN:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"

if [[ -z "$ROLE_ARN" ]]; then
  echo "❌ E2E_ROLE_ARN is not set. Export it before running this script:"
  echo "   export E2E_ROLE_ARN=arn:aws:iam::<account>:role/<role-name>"
  exit 1
fi

if [[ -z "$SECRET_ARN" ]]; then
  echo "❌ E2E_SECRET_ARN is not set. Export it before running this script:"
  echo "   export E2E_SECRET_ARN=arn:aws:secretsmanager:<region>:<account>:secret:<name>"
  exit 1
fi
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

echo "=== Assuming IAM role ==="
CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "local-e2e-$(date +%s)" \
  --duration-seconds 3600 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text)

export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | awk '{print $1}')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | awk '{print $2}')
export AWS_SESSION_TOKEN=$(echo "$CREDS" | awk '{print $3}')
export AWS_REGION

echo "✅ Assumed role successfully"

echo "=== Fetching API keys from Secrets Manager ==="
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" \
  --region "$AWS_REGION" \
  --query SecretString \
  --output text)

# Mirror the GitHub workflow: parse-json-secrets maps keys to E2E_<KEY> then
# the workflow maps them to the bare names the tests expect.
export ANTHROPIC_API_KEY=$(echo "$SECRET_JSON" | jq -r '.ANTHROPIC_API_KEY // empty')
export OPENAI_API_KEY=$(echo "$SECRET_JSON"    | jq -r '.OPENAI_API_KEY // empty')
export GEMINI_API_KEY=$(echo "$SECRET_JSON"    | jq -r '.GEMINI_API_KEY // empty')

echo "✅ Secrets loaded (keys present: $(echo "$SECRET_JSON" | jq -r 'keys | join(", ")')"

echo "=== Setting AWS account env var ==="
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "✅ AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID  AWS_REGION=$AWS_REGION"

echo "=== Configuring git (required for agentcore create) ==="
git config --global user.email "ci@local" 2>/dev/null || true
git config --global user.name "Local E2E"  2>/dev/null || true

cd "$REPO_ROOT"

echo "=== Installing dependencies ==="
npm ci

echo "=== Building CLI ==="
npm run build

echo "=== Installing CLI globally ==="
TARBALL=$(npm pack | tail -1)
npm install -g "$TARBALL"
echo "✅ Installed: $(agentcore --version)"

echo "=== Running E2E tests ==="
if [[ "$RUN_ALL" == "true" ]]; then
  echo "Running full e2e suite"
  npx vitest run --project e2e
elif [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  echo "Running: ${TEST_FILES[*]}"
  npx vitest run --project e2e "${TEST_FILES[@]}"
else
  echo "Running default: e2e-tests/strands-bedrock.test.ts"
  npx vitest run --project e2e e2e-tests/strands-bedrock.test.ts
fi
