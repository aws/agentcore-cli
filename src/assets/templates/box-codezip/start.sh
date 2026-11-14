#!/bin/bash
# Runs the agent in a box on AgentCore Runtime (CodeZip). start.py runs this script. Written by
# `agentcore create`; `agentcore deploy` stages .box-dist/ beside it.
#
# The microVM (Amazon Linux 2023, arm64, an ordinary user, HOME unset):
#
#   /var/task/                         the zip, read-only                                 $CODE
#   ├── start.py  start.sh  main.py    main.py is the agent
#   ├── <dependencies>                 installed at the zip root
#   └── .box-dist/                     staged by agentcore deploy
#       ├── box  strands-box-sock-alias  strands-box-contain-trampoline
#       ├── resources/                 box's packs
#       ├── ffi/                       _ctypes and a libffi that Box Core's W^X filter allows
#       ├── profile.toml               rendered from agentcore.json, with @CODE@, @PYTHON@,
#       │                              @PYTHON_PREFIX@ and @GATEWAY_BOX_URL@ for this script
#       └── <policy files>             the Dogwood files of .box/profile.toml, unchanged, which
#                                      the profile's `policies` names
#
#   /tmp/box/                          written here; gone with the microVM
#   ├── profile/                       the filled profile, which box run takes by path, and a
#   │                                  copy of each policy file it names                  $PROFILE_DIR
#   ├── workspace/                     where box run starts; the agent reads and writes   $WORKSPACE
#   └── home/                          HOME for box; the agent cannot read it             $HOME_DIR
#
# Box signs the AWS requests with the execution role: a bare aws:// in the profile resolves the AWS
# default credential chain, which Box Core reads and refreshes itself.
#
# If box fails, or the agent in it does not answer by 22s, this serves main.py without box: the
# Runtime allows 30s to start. Set BOX_START_DISABLE=1 on the Runtime to skip box.
set -u

CODE=$(cd "$(dirname "$0")" && pwd)
PYTHON=${BOX_START_PYTHON:-$(command -v python3)}
DIST=$CODE/.box-dist
BOX=$DIST/box
WORKSPACE=/tmp/box/workspace
HOME_DIR=/tmp/box/home
# Outside the workspace, so box accepts the profile and its policy files.
PROFILE_DIR=/tmp/box/profile
PROFILE=$PROFILE_DIR/profile.toml
READY_BY=22

log() { echo "[box] $*"; }

# A Python for helper scripts. Setting PYTHONPATH drops the OpenTelemetry startup hooks that
# opentelemetry-instrument adds: they cost about 3s and start threads.
pyq() { env PYTHONPATH="$CODE" "$PYTHON" "$@"; }

serve_without_box() {
  log "FALLBACK ($1) after ${SECONDS}s: serving the agent without box"
  cd "$CODE" && exec "$PYTHON" main.py
}

# --- The profile -----------------------------------------------------------------------------------
# The policy files the profile's `policies` names. Deploy renders that line on one line, and names
# each file with letters, digits, `.`, `_`, `-`, and `/` only.
policy_files() { sed -n 's/^policies = \[\(.*\)\]$/\1/p' "$1" | tr -d '"' | tr ',' ' '; }

# Copies them from beside the staged profile to beside the filled one, where box reads them.
copy_policy_files() {
  local file
  for file in $(policy_files "$1/profile.toml"); do
    mkdir -p "$2/$(dirname "$file")" && cp "$1/$file" "$2/$file" || return 1
  done
}

write_profile() {
  local python_prefix agent_env
  rm -rf "$PROFILE_DIR" && mkdir -p "$PROFILE_DIR" && copy_policy_files "$DIST" "$PROFILE_DIR" \
    || return 1
  python_prefix=$(pyq -c 'import sys; print(sys.base_prefix)')

  # Only the deployed Memories' and Gateways' IDs and URLs reach the agent, never a secret.
  agent_env=$(env | grep -E '^((AGENTCORE_GATEWAY|MEMORY)_[A-Z0-9_]+_(URL|ARN|ID|AUTH_TYPE)|AWS_REGION|AWS_DEFAULT_REGION)=[!-~]*$' \
    | sed -E 's/^([^=]+)=(.*)$/\1 = "\2"/')

  # The Box gateway's URL exists only after deploy; the CDK sets it on the Runtime.
  sed -e "s|@CODE@|$CODE|g" -e "s|@PYTHON_PREFIX@|$python_prefix|g" -e "s|@PYTHON@|$PYTHON|g" \
    -e "s|@GATEWAY_BOX_URL@|${AGENTCORE_GATEWAY_BOX_URL:-}|g" \
    "$DIST/profile.toml" \
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
  cd "$WORKSPACE" || serve_without_box "no workspace"
  log "starting box run (ingress :${port:-8080})"
  # The prefix keeps box's own lines in a "[box]" log query.
  env HOME="$HOME_DIR" "$BOX" run "$PROFILE" --no-banner > >(sed -u 's/^/[box] box: /') 2>&1 &
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
[ -x "$BOX" ] && [ -f "$DIST/profile.toml" ] || serve_without_box "no $DIST; deploy stages it"
log "box: $("$BOX" --version 2>&1 | head -1)  python: $PYTHON  user: $(id -u)"

mkdir -p "$WORKSPACE" "$HOME_DIR"
chmod 0700 "$HOME_DIR"

write_profile || serve_without_box "cannot write $PROFILE and its policy files"
log "profile:"
sed 's/^/[box]   /' "$PROFILE"
start_box
