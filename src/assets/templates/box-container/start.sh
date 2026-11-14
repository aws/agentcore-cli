#!/bin/bash
# The image's entry point: runs the agent in a box. Written by `agentcore create`; dev, build and
# deploy stage .box-dist/ beside it, and the Dockerfile copies both into the image.
#
# The image (Debian, arm64, user bedrock_agentcore):
#
#   /app/                              the agent and its .venv; box's workspace, which the agent can write
#   /opt/box/                          box, its two helpers, resources/ (its packs), and this script
#   /opt/box/profile.toml              on AgentCore Runtime: rendered from agentcore.json at deploy
#                                      under `agentcore dev`: the project's .box/profile.toml
#   ~/profile.toml                     on AgentCore Runtime: that profile with the deployed values
#
# box run takes the profile by its path. Both copies are outside /app, the workspace, so box accepts
# them, and the agent cannot change either.
#
# On AgentCore Runtime, this script puts the deployed Memories' and Gateways' variables and the
# Box gateway's URL into the profile, and starts box run. Box signs the AWS requests with the
# execution role: a bare aws:// in the profile resolves the AWS default credential chain, which Box
# Core reads and refreshes itself. If box fails, or the agent in it does not answer by 22s, it serves
# the agent without box: the Runtime allows 30s to start. Under `agentcore dev` (LOCAL_DEV=1), dev
# passes your credentials, so it only starts box. box runs only a profile file the agent's user owns
# and only it can write, so both paths run a copy in $HOME, not the root-owned image copy.
set -u

BOX=/opt/box/box
PYTHON=/app/.venv/bin/python
TEMPLATE=/opt/box/profile.toml
PROFILE=$HOME/profile.toml
READY_BY=22

log() { echo "[box] $*"; }

if [ "${LOCAL_DEV:-}" = 1 ]; then
  cp "$TEMPLATE" "$PROFILE" && chmod 0644 "$PROFILE"
  cd /app && exec "$BOX" run "$PROFILE" --no-banner
fi

serve_without_box() {
  log "FALLBACK ($1) after ${SECONDS}s: serving the agent without box"
  cd /app && exec "$PYTHON" -m main
}

# --- The deployed resources ------------------------------------------------------------------------
fill_profile() {
  local agent_env
  # Only the deployed Memories' and Gateways' IDs and URLs reach the agent, never a secret.
  agent_env=$(env | grep -E '^((AGENTCORE_GATEWAY|MEMORY)_[A-Z0-9_]+_(URL|ARN|ID|AUTH_TYPE)|AWS_REGION|AWS_DEFAULT_REGION)=[!-~]*$' \
    | sed -E 's/^([^=]+)=(.*)$/\1 = "\2"/')
  # The Box gateway's URL exists only after deploy; the CDK sets it on the Runtime.
  sed -e "s|@GATEWAY_BOX_URL@|${AGENTCORE_GATEWAY_BOX_URL:-}|g" "$TEMPLATE" \
    | awk -v lines="$agent_env" '$0 == "# @AGENT_ENV@" { if (lines != "") print lines; next } { print }' \
      > "$PROFILE"

}

# --- Start box -------------------------------------------------------------------------------------
# Box opens the ingress port before the agent is up, so an answer from the agent through it is the
# sign of ready. Any HTTP status line counts: the agent answered, whatever its paths are.
agent_ready() (
  exec 3<>"/dev/tcp/127.0.0.1/$1" || exit 1
  printf 'GET /ping HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
  read -r -t 2 status <&3 && [[ "$status" == HTTP/* ]]
) 2>/dev/null

start_box() {
  local port pid code
  port=$(grep -m1 -oE '^listen = "[0-9.]+:[0-9]+"' "$PROFILE" | grep -oE '[0-9]+"$' | tr -d '"')
  log "starting box run (ingress :${port:-8080})"
  cd /app || serve_without_box "no /app"
  # The prefix keeps box's own lines in a "[box]" log query.
  "$BOX" run "$PROFILE" --no-banner > >(sed -u 's/^/[box] box: /') 2>&1 &
  pid=$!
  while [ "$SECONDS" -lt "$READY_BY" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      serve_without_box "box run exited with $?"
    fi
    if agent_ready "${port:-8080}"; then
      log "the agent in box answers after ${SECONDS}s"
      trap 'kill -TERM "$pid"' TERM INT
      wait "$pid"
      code=$?
      log "box run exited with $code"
      exit "$code"
    fi
    sleep 0.5
  done
  kill "$pid" 2>/dev/null
  serve_without_box "the agent in box did not answer by ${READY_BY}s"
}

# --- Main --------------------------------------------------------------------------------------------
[ "${BOX_START_DISABLE:-}" = 1 ] && serve_without_box "BOX_START_DISABLE=1"
log "box: $("$BOX" --version 2>&1 | head -1)  user: $(id)"
log "covers over /proc: $(awk '$5 ~ "^/proc/" {printf "%s ", $5}' /proc/self/mountinfo)"

fill_profile
log "profile:"
sed 's/^/[box]   /' "$PROFILE"
start_box
