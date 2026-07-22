#!/usr/bin/env bash
# Emits a per-run heartbeat metric for the canary workflow. A CloudWatch
# alarm in the AWS account the canary deploys to watches this metric and
# alerts the team when the canary fails or stops reporting.
#
# Called from canary.yml with `if: always()`: every matrix cell reports
# Success=1 or Success=0 on every run. The alarm treats missing data as
# breaching, so silence (dead runner, broken credentials, disabled cron)
# trips it just like an explicit failure does — which is why this step
# must never be made conditional on failure only.
#
# Usage: emit-canary-heartbeat.sh <job-status>
#   job-status: GitHub's ${{ job.status }} — "success", "failure", or "cancelled"
set -euo pipefail

# The alarm lives in us-east-1. Always emit there — even when the canary is
# manually dispatched against another region — so an off-region run can't
# starve the alarm into a false missing-data breach.
readonly MONITOR_REGION=us-east-1
readonly NAMESPACE=AgentCoreCLI/Canary
readonly METRIC_NAME=Success

STATUS="${1:?usage: emit-canary-heartbeat.sh <job-status>}"

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
  --value "$VALUE"

echo "Emitted ${NAMESPACE}/${METRIC_NAME}=${VALUE} (job status: ${STATUS}) to ${MONITOR_REGION}"
