#!/bin/bash
# The image's entry point: runs the agent in a box. Written by `agentcore create`; dev, build and
# deploy stage .box-dist/ beside it, and the Dockerfile copies both into the image.
#
# The image (Debian, arm64, user bedrock_agentcore):
#
#   /app/                              the agent and its .venv; box's workspace, which the agent can write
#   /opt/box/                          box, its two helpers, resources/ (its packs), this script, and
#                                      the Dogwood policy files the profile's `policies` names
#   /opt/box/profile.toml              on AgentCore Runtime: rendered from agentcore.json at deploy
#                                      under `agentcore dev`: the project's .box/profile.toml
#   ~/box-profile/                     profile.toml, that profile with the deployed values on
#                                      AgentCore Runtime, and a copy of each policy file it names
#   ~/.aws/credentials                 on AgentCore Runtime: profile [default], the execution role
#
# box run takes the profile by its path, and reads its policy files from beside it. Both copies are
# outside /app, the workspace, so box accepts them, and the agent cannot change either.
#
# On AgentCore Runtime, this script puts the deployed Memories' and Gateways' variables and the
# Box gateway's URL into the profile, and starts box run. Box signs the AWS requests with the
# execution role, through the AWS profile default that this script writes and refreshes. If box fails, or the agent in it does not answer by 22s, it serves
# the agent without box: the Runtime allows 30s to start. Under `agentcore dev` (LOCAL_DEV=1), dev
# passes your credentials, so it only starts box. box runs only a profile file the agent's user owns
# and only it can write, so both paths run a copy in $HOME, not the root-owned image copy.
set -u

BOX=/opt/box/box
PYTHON=/app/.venv/bin/python
TEMPLATE_DIR=/opt/box
TEMPLATE=$TEMPLATE_DIR/profile.toml
PROFILE_DIR=$HOME/box-profile
PROFILE=$PROFILE_DIR/profile.toml
CREDENTIALS=$HOME/.aws/credentials
READY_BY=22

log() { echo "[box] $*"; }

# The policy files the profile's `policies` names, as TOML reads it.
policy_files() {
  /usr/local/bin/python -c 'import sys, tomllib; print("\n".join(tomllib.load(open(sys.argv[1], "rb")).get("policies", [])))' "$1"
}

# Copies them from beside the image's profile to beside the filled one, where box reads them.
copy_policy_files() {
  local file
  for file in $(policy_files "$1/profile.toml"); do
    mkdir -p "$2/$(dirname "$file")" && cp "$1/$file" "$2/$file" || return 1
  done
}

if [ "${LOCAL_DEV:-}" = 1 ]; then
  rm -rf "$PROFILE_DIR" && mkdir -p "$PROFILE_DIR" && copy_policy_files "$TEMPLATE_DIR" "$PROFILE_DIR" \
    && cp "$TEMPLATE" "$PROFILE" && chmod 0644 "$PROFILE" || exit 1
  cd /app && exec "$BOX" run "$PROFILE" --no-banner
fi

serve_without_box() {
  log "FALLBACK ($1) after ${SECONDS}s: serving the agent without box"
  cd /app && exec "$PYTHON" -m main
}

# --- Credentials (TEMPORARY) -----------------------------------------------------------------------
# The profile signs the AWS routes with aws://default: box refuses a bare aws://, and Box Core reads
# a named profile only from its files, as static keys (a session token is fine). So copy the
# execution role into the [default] profile of box's credentials file, and rewrite it every 15
# minutes before the role's keys expire; Box Core reads the file again when it signs. Remove this,
# and go back to aws:// in the profile, once box accepts the default credential chain again.
write_credentials() {
  "$PYTHON" - "$CREDENTIALS" <<'EOF'
import os, sys
import botocore.session
credentials = botocore.session.get_session().get_credentials()
if credentials is None:
    sys.exit("no execution role credentials")
keys = credentials.get_frozen_credentials()
text = f"[default]\naws_access_key_id = {keys.access_key}\naws_secret_access_key = {keys.secret_key}\n"
if keys.token:
    text += f"aws_session_token = {keys.token}\n"
temporary = sys.argv[1] + ".tmp"
with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
    out.write(text)
os.replace(temporary, sys.argv[1])
print(f"credentials from {credentials.method}")
EOF
}

start_credentials() {
  local result
  mkdir -p "$(dirname "$CREDENTIALS")" && chmod 0700 "$(dirname "$CREDENTIALS")"
  if result=$(write_credentials 2>&1); then
    log "$result"
    ( while sleep 900; do write_credentials >/dev/null 2>&1 || log "credential refresh failed"; done ) &
  else
    log "credentials failed: $result (the AWS routes cannot sign)"
  fi
}

# --- The deployed resources ------------------------------------------------------------------------
fill_profile() {
  local agent_env
  rm -rf "$PROFILE_DIR" && mkdir -p "$PROFILE_DIR" \
    && copy_policy_files "$TEMPLATE_DIR" "$PROFILE_DIR" || return 1
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

start_credentials
fill_profile || serve_without_box "cannot write $PROFILE and its policy files"
log "profile:"
sed 's/^/[box]   /' "$PROFILE"
start_box
