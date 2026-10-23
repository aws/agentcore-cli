#!/usr/bin/env bash
set -euo pipefail

# The v1 canary uses the default namespace; the v0 canary supplies its own.
readonly MONITOR_REGION=us-east-1
readonly NAMESPACE="${2:-AgentCoreCLI/Canary}"
readonly METRIC_NAME=Success

STATUS="${1:?usage: emit-canary-heartbeat.sh <job-status> [namespace]}"

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
