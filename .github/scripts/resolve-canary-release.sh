#!/usr/bin/env bash
# Resolve a stable version within one major, independently of npm's latest tag.
set -euo pipefail

MAJOR="${1:?usage: resolve-canary-release.sh <0|1>}"
case "$MAJOR" in
  0|1) ;;
  *) echo "Unsupported canary major: $MAJOR" >&2; exit 1 ;;
esac

# Template strings below are evaluated by Node, not the shell.
# shellcheck disable=SC2016
npm view "@aws/agentcore@$MAJOR" version --json | node -e '
  const fs = require("node:fs");
  const major = process.argv[1];
  const result = JSON.parse(fs.readFileSync(0, "utf8"));
  const versions = (Array.isArray(result) ? result : [result])
    .filter(version => typeof version === "string" && new RegExp(`^${major}\\.[0-9]+\\.[0-9]+$`).test(version))
    .sort((a, b) => {
      const left = a.split(".").map(Number);
      const right = b.split(".").map(Number);
      return left[1] - right[1] || left[2] - right[2];
    });
  if (!versions.length) throw new Error(`No stable v${major} release found`);
  console.log(versions.at(-1));
' "$MAJOR"
