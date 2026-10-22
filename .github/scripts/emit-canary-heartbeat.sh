#!/usr/bin/env bash
# Emits a per-run heartbeat metric for the canary workflow. A CloudWatch
# alarm in the AWS account the canary deploys to watches this metric and
# alerts the team when the canary fails or stops reporting.
#
# Called from canary-release.yml with `if: always()`: each major reports
# Success=1 or Success=0 on every run. The alarm treats missing data as
# breaching, so silence (dead runner, broken credentials, disabled cron)
# trips it just like an explicit failure does — which is why this step
# must never be made conditional on failure only.
#
# Usage: emit-canary-heartbeat.sh <job-result> <v0.x|v1.x>
#   job-result: GitHub's needs.canary.result, including skipped or cancelled
set -euo pipefail

# The alarm lives in us-east-1. Always emit there — even when the canary is
# manually dispatched against another region — so an off-region run can't
# starve the alarm into a false missing-data breach.
readonly MONITOR_REGION=us-east-1
readonly NAMESPACE=AgentCoreCLI/Canary
readonly METRIC_NAME=Success

STATUS="${1:?usage: emit-canary-heartbeat.sh <job-result> <v0.x|v1.x>}"
BRANCH="${2:?usage: emit-canary-heartbeat.sh <job-result> <v0.x|v1.x>}"
case "$BRANCH" in
  v0.x|v1.x) ;;
  *) echo "Unsupported canary branch: $BRANCH" >&2; exit 1 ;;
esac

# Anything other than success (failure, cancelled/timeout) counts as a failed
# canary run.
if [[ "$STATUS" == "success" ]]; then
  VALUE=1
else
  VALUE=0
fi

aws cloudwatch put-metric-data \
  --region "$MONITOR_REGION" \
  --namespace "$NAMESPACE" \
  --metric-name "$METRIC_NAME" \
  --dimensions "Branch=$BRANCH" \
  --value "$VALUE"

echo "Emitted ${NAMESPACE}/${METRIC_NAME}=${VALUE} (branch: ${BRANCH}, result: ${STATUS}) to ${MONITOR_REGION}"
