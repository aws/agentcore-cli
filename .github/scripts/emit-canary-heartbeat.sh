#!/usr/bin/env bash
set -euo pipefail

# This is the existing v0 alarm's metric. Missing data also breaches that alarm.
readonly MONITOR_REGION=us-east-1
readonly NAMESPACE=AgentCoreCLI/Canary
readonly METRIC_NAME=Success

STATUS="${1:?usage: emit-canary-heartbeat.sh <job-status>}"

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
