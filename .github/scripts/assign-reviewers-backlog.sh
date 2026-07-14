#!/usr/bin/env bash
# One-time sweep: round-robin a reviewer onto every open, non-draft PR that has
# no reviewer requested yet. Mirrors .github/workflows/pr-assign-reviewer.yml
# (same round-robin `pr.number % pool` rule, same skip rules) so a PR gets the
# SAME reviewer whether it's swept now or assigned on open.
#
# The reviewer pool is the repo's AUTHORIZED_USERS roster (comma-separated
# usernames) — pass it in, since secret VALUES aren't readable via the API:
#   export AUTHORIZED_USERS="alice,bob,carol"   (or pass as $1)
#
# DRY-RUN BY DEFAULT: prints the plan and changes nothing. Pass --apply to act.
#
# Usage:
#   AUTHORIZED_USERS="a,b,c" ./assign-reviewers-backlog.sh            # dry run
#   AUTHORIZED_USERS="a,b,c" ./assign-reviewers-backlog.sh --apply    # act
#   ./assign-reviewers-backlog.sh "a,b,c"                             # list as $1, dry run
#   ./assign-reviewers-backlog.sh "a,b,c" --apply
set -euo pipefail

REPO="${REPO:-aws/agentcore-cli}"

# Roster: first non-flag arg overrides the env var.
LIST="${AUTHORIZED_USERS:-}"
APPLY=false
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    *) LIST="$a" ;;
  esac
done

# Split comma-separated roster into a sorted POOL array (portable; no mapfile/bash4).
POOL=()
OLDIFS="$IFS"; IFS=','
for u in $LIST; do
  u="$(echo "$u" | tr -d '[:space:]')"
  [ -n "$u" ] && POOL+=("$u")
done
IFS="$OLDIFS"
if [ "${#POOL[@]}" -eq 0 ]; then
  echo "error: no reviewers. Pass AUTHORIZED_USERS=\"a,b,c\" (env) or as the first argument." >&2
  exit 1
fi
# Sort for a stable round-robin order (matches the workflow's .sort()).
IFS=$'\n' POOL=($(printf '%s\n' "${POOL[@]}" | sort)); unset IFS
echo "Pool: ${#POOL[@]} reviewers"

# Open, non-draft PRs with no reviewer requested (individual or team).
PRS=$(gh pr list -R "$REPO" --state open --limit 500 \
  --json number,isDraft,author,reviewRequests \
  --jq '.[] | select(.isDraft==false) | select((.reviewRequests|length)==0) | "\(.number) \(.author.login)"')

if [ -z "$PRS" ]; then
  echo "No unreviewed non-draft PRs found. Nothing to do."
  exit 0
fi

planned=0
while read -r num author; do
  [ -z "$num" ] && continue
  # Eligible pool excludes the PR author (can't review own PR).
  ELIG=(); for m in "${POOL[@]}"; do [ "$m" != "$author" ] && ELIG+=("$m"); done
  if [ "${#ELIG[@]}" -eq 0 ]; then
    echo "PR #$num: no eligible reviewer (author-only pool), skip"; continue
  fi
  reviewer="${ELIG[$(( num % ${#ELIG[@]} ))]}"
  planned=$((planned+1))
  if $APPLY; then
    gh api --method POST "repos/$REPO/pulls/$num/requested_reviewers" \
      -f "reviewers[]=$reviewer" >/dev/null \
      && echo "PR #$num (by $author) -> requested $reviewer"
  else
    echo "PR #$num (by $author) -> WOULD request $reviewer"
  fi
done <<< "$PRS"

echo "---"
echo "$planned PR(s) $($APPLY && echo assigned || echo "would be assigned")."
$APPLY || echo "Dry run. Re-run with --apply to request these reviewers."
