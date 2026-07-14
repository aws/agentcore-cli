# Identity Release And Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the complete Identity feature as a documented, reproducible Node package and six Bun standalone artifacts with verified native prebuilds, exact dependencies, provenance policy, exhaustive local/live evidence, and no test or secret-bearing material in distributions.

**Architecture:** Host development builds one addon; release CI builds six target-specific N-API v8 prebuilds from the same source commit and verifies each before assembly. Package and standalone verification runs against produced artifacts, while a repository-specific policy verifier accepts only exact GitHub-hosted SLSA provenance.

**Tech Stack:** Node 22.22.1, Bun 1.3.14, TypeScript 5.9.3, node-gyp 12.4.0, node-addon-api 8.9.0, npm, GitHub Actions, `gh` 2.96.0.

---

## File Structure

```text
scripts/
|-- build-native.ts
|-- verify-package.ts
|-- verify-standalone.ts
`-- release/
    |-- verify-toolchain.ts
    |-- verify-attestation.ts
    |-- verify-native-manifest.ts
    |-- workflows.test.ts
    `-- trust/github-trusted-root.jsonl

test/
|-- fixtures/attestations/gh-2.96.0-verify-valid.json
`-- subprocess/
    |-- package-install.test.ts
    |-- native-addon-smoke.ts
    |-- node20-native-load.cjs
    `-- standalone-smoke.test.ts

.github/workflows/ci.yml
.github/workflows/release.yml
LICENSE
NOTICE
release-policy.json
release-toolchain.json
docs/identity.md
THIRD_PARTY_NOTICES.md
docs/superpowers/reviews/identity-cli/requirements-evidence.md
docs/superpowers/reviews/identity-cli/release-verification.md
```

## Task 1: Finalize User Documentation, Notices, And Package Boundaries

**Files:**

- Create: `docs/identity.md`
- Create: `LICENSE`
- Create: `NOTICE`
- Modify: `README.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `Makefile`
- Modify: `.gitignore`
- Modify: `.prettierignore`
- Modify: `src/testing/packageContract.test.ts`

- [ ] **Step 1: Write documentation and package-contract tests**

Assert:

- exact runtime/build dependency pins from the design;
- `package.json.files` includes only production `dist` content and `THIRD_PARTY_NOTICES.md`;
- the actual npm tarball allowlist is README, LICENSE, NOTICE, `THIRD_PARTY_NOTICES.md`,
  `package.json`, `dist/index.js`, and exactly six native addons;
- Node/Bun version metadata is exact;
- `@inkui-cli/data-table` is absent;
- the upstream DataTable MIT notice remains;
- README links to complete Identity documentation;
- docs list all commands, selectors, provider slugs, secret sources, literal warnings, update semantics,
  pagination, TUI coverage, result behavior, recovery commands, and security boundaries;
- docs do not describe `agentcore.json` or another project config file.
- `npm pack` does not run Husky or another source-tree mutation through `prepare`;
- README does not claim a nonexistent `prepublishOnly` lifecycle.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/packageContract.test.ts
```

- [ ] **Step 3: Write the complete Identity guide**

`docs/identity.md` must include:

- the 34-command tree and examples for both selectors;
- all 25 OAuth and two payment slugs;
- curated versus advanced JSON boundaries;
- managed/external acquisition flags and literal-secret warning;
- replacement updates, managed re-entry, explicit clears, no-change, and reprepare;
- page versus `--all` behavior and opaque continuation tokens;
- TUI workflows and Preview labeling;
- output/error/exit contracts;
- fixture capture/list/publish/discard/reap;
- live/reap/inspect with exact-account safety;
- known residual Get-to-send race and audit-only stale-recovery platforms.

Use no secret literal in examples. Do not expose internal fixture paths, native authority roots, or
security-sensitive debugging text.

- [ ] **Step 4: Update package metadata and notices**

Retain the DataTable derivative notice:

```text
@inkui-cli/data-table
Copyright (c) 2024 Kamlesh Yadav
MIT License
```

Add Unicode data-file licensing and every other shipped third-party native/source notice. Exact-pin
reviewed dependencies without caret, tilde, or `latest`. Restore the repository's Apache-2.0 `LICENSE`
and Amazon `NOTICE` from the reviewed `origin/main` bytes; do not synthesize legal text.

- [ ] **Step 5: Verify and commit**

```bash
bun test src/testing/packageContract.test.ts
bun install --frozen-lockfile
bun run format:check
git diff --check
git add docs/identity.md README.md LICENSE NOTICE THIRD_PARTY_NOTICES.md package.json bun.lock Makefile .gitignore .prettierignore src/testing/packageContract.test.ts
git commit -m "build: finalize identity release contract"
```

## Task 2: Build And Verify Six Native Prebuild Targets

**Files:**

- Create: `scripts/build-native.ts`
- Create: `scripts/build-native.test.ts`
- Create: `scripts/release/verify-native-manifest.ts`
- Create: `scripts/release/verify-native-manifest.test.ts`
- Modify: `native/identity/binding.gyp`
- Modify: `src/native/identity/loader.ts`
- Modify: `package.json`

- [ ] **Step 1: Write target-manifest and loader tests**

Use exactly:

```ts
export const IDENTITY_NATIVE_TARGETS = [
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
] as const;
```

Reject an unknown/missing/duplicate target, wrong addon basename, wrong N-API version, malformed digest,
target-manifest mismatch, and artifact bytes whose SHA-256 differs. Loader tests require the exact
platform/architecture mapping and no JS fallback.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test scripts/build-native.test.ts scripts/release/verify-native-manifest.test.ts
```

- [ ] **Step 3: Implement host and release builds**

`build-native.ts` supports only:

```text
--host
--target <one exact target>
--output <absolute protected staging directory>
```

Host mode compiles the current target into its normal development location. Target mode runs only in
the release matrix and writes `agentcore_cli_native.node` plus one canonical manifest containing target,
source commit/tree, N-API 8, toolchain facts, length, and SHA-256. It never downloads a binary or accepts
an arbitrary compiler command.

- [ ] **Step 4: Add package scripts**

```json
{
  "build:native:host": "bun scripts/build-native.ts --host",
  "verify:native:manifest": "bun scripts/release/verify-native-manifest.ts"
}
```

- [ ] **Step 5: Verify and commit**

```bash
bun run build:native:host
bun test scripts/build-native.test.ts scripts/release/verify-native-manifest.test.ts src/native/identity
bun run verify:tsc
git add scripts/build-native.ts scripts/build-native.test.ts scripts/release/verify-native-manifest.ts scripts/release/verify-native-manifest.test.ts native/identity/binding.gyp src/native/identity/loader.ts package.json bun.lock
git commit -m "build(identity): add native prebuild pipeline"
```

## Task 3: Verify Npm Tarball Contents And Installed Execution

**Files:**

- Create: `scripts/verify-package.ts`
- Create: `scripts/verify-package.test.ts`
- Create: `test/subprocess/package-install.test.ts`
- Create: `test/subprocess/native-addon-smoke.ts`
- Create: `test/subprocess/node20-native-load.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write allowlist/denylist package tests**

Require:

- `README.md`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `package.json`, and `dist/index.js`;
- all six `dist/native/<target>/agentcore_cli_native.node` files.

Those 12 paths are the complete allowlist. Standalone binaries are staged outside `dist`, so
`dist/bin` can never enter npm.

Reject:

- `src/`, `test/`, source maps containing source text, fixture command modules, fixtures, capture/run
  roots, design/plans/reviews, credentials, temporary native files, duplicate archive entries,
  path-traversal entries, wrong modes, unexpected `.node` files, and any extra path.

Parse `npm pack --json` structurally and compare exact normalized paths, sizes, package digest, and
unpacked size against policy. Do not infer safety from filename substrings alone.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test scripts/verify-package.test.ts
```

- [ ] **Step 3: Implement package verification**

`verify-package.ts`:

1. requires the reviewed npm version from `release-toolchain.json`;
2. runs pack in a clean staging directory;
3. parses the JSON manifest;
4. opens the tarball without extraction-path traversal;
5. rejects duplicate, noncanonical, or traversal entries and verifies exact file modes;
6. verifies every file against the exact 12-path allowlist;
7. hashes all native prebuilds against their manifests;
8. verifies executable shebang/package metadata and legal notices;
9. scans text/artifact names for fixture sentinels and forbidden roots.

- [ ] **Step 4: Implement empty-project smoke**

Under exact Node 22.22.1:

1. create an empty temporary project;
2. install the exact tarball with scripts enabled;
3. run `agentcore --help`, `agentcore identity --help`, every Identity subtree help command, and
   network-free native/normalization smoke tests;
4. verify no source-tree import or undeclared dependency is used.

`test/subprocess/node20-native-load.cjs` directly loads one N-API v8 `.node` file under Node 20.20.1
and invokes only its closed self-test export. It does not install or import the CLI package.

- [ ] **Step 5: Verify and commit**

```bash
bun test scripts/verify-package.test.ts
bun run build
npm pack --json > /tmp/identity_npm_pack.json 2>&1
bun scripts/verify-package.ts --pack-json /tmp/identity_npm_pack.json
bun test test/subprocess/package-install.test.ts
git add scripts/verify-package.ts scripts/verify-package.test.ts test/subprocess/package-install.test.ts test/subprocess/native-addon-smoke.ts test/subprocess/node20-native-load.cjs package.json bun.lock
git commit -m "test(identity): verify packed package execution"
```

## Task 4: Build And Smoke Six Standalone Artifacts

**Files:**

- Modify: `package.json`
- Create: `scripts/verify-standalone.ts`
- Create: `scripts/verify-standalone.test.ts`
- Create: `test/subprocess/standalone-smoke.test.ts`
- Modify: `src/native/identity/loader.ts`

- [ ] **Step 1: Write embedding and target tests**

For every target, assert the standalone build embeds only its matching addon, loads it from the
documented Bun executable path, rejects a mismatched manifest, and executes network-free help,
normalization, safe/unsafe file, lock, and fixture-publication smoke behavior.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test scripts/verify-standalone.test.ts
```

- [ ] **Step 3: Update standalone build scripts**

Keep the six existing target names, but make each assembly consume the verified matching native matrix
artifact. Stage standalone binaries outside `dist` and the npm package tree. The loader may not probe
another target or fall back to source compilation at runtime.

- [ ] **Step 4: Verify and commit**

```bash
bun test scripts/verify-standalone.test.ts test/subprocess/standalone-smoke.test.ts
bun scripts/verify-standalone.ts --host
bun run verify:tsc
git add package.json bun.lock scripts/verify-standalone.ts scripts/verify-standalone.test.ts test/subprocess/standalone-smoke.test.ts src/native/identity/loader.ts
git commit -m "build(identity): verify standalone native bundles"
```

## Task 5: Add Cross-Platform CI And Native Compatibility Gates

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `scripts/release/verify-toolchain.ts`
- Create: `scripts/release/verify-toolchain.test.ts`
- Create: `scripts/release/workflows.test.ts`
- Create: `release-toolchain.json`

- [ ] **Step 1: Write toolchain-policy tests**

Parse workflow YAML structurally with `Bun.YAML.parse`. For each target, require exact hosted-runner
image, architecture, Node, Bun, npm, TypeScript, C/C++ compiler, linker, platform SDK, native
dependency, action full commit SHA, and least-privilege permissions. Reject mutable image drift,
unreported facts, duplicate targets, self-hosted runners, mutable action refs, and tool output that
does not parse exactly.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test scripts/release/verify-toolchain.test.ts
```

- [ ] **Step 3: Implement CI**

CI must:

1. check out by reviewed full action SHA;
2. read `.node-version` and `.bun-version`;
3. run `bun ci`;
4. run unit, compile, router, screen, fixture, native-host, build, format, diagnostic, and diff gates;
5. build/test each native target on its matching GitHub-hosted runner;
6. exercise safe/unsafe file, permanent lock/process death, capture/publication, and mount proof or
   explicit audit-only behavior;
7. smoke each standalone under Bun and each installed npm target under Node 22;
8. upload prebuild plus canonical target manifest and SHA-256;
9. run the isolated Node 20.20.1 N-API load job without package installation.

Use no AWS credentials in ordinary CI.

- [ ] **Step 4: Verify workflow structure and commit**

```bash
bun test scripts/release/verify-toolchain.test.ts scripts/release/workflows.test.ts
bun scripts/release/verify-toolchain.ts --workflow .github/workflows/ci.yml
bun run format:check
git add .github/workflows/ci.yml scripts/release/verify-toolchain.ts scripts/release/verify-toolchain.test.ts scripts/release/workflows.test.ts release-toolchain.json
git commit -m "ci(identity): add cross-platform native verification"
```

## Task 6: Implement Closed Release Provenance Policy

**Files:**

- Create: `release-policy.json`
- Create: `scripts/release/trust/github-trusted-root.jsonl`
- Create: `scripts/release/verify-attestation.ts`
- Create: `scripts/release/verify-attestation.test.ts`
- Create: `test/fixtures/attestations/gh-2.96.0-verify-valid.json`

- [ ] **Step 1: Write hermetic policy vectors**

Using exact `gh 2.96.0` JSON fixtures, reject:

- wrong repository, source commit, source ref, signer workflow/digest, OIDC issuer, predicate type, or
  hosted-runner decision;
- public-good trust or wrong trusted-root digest;
- wrong artifact name/digest;
- zero or multiple accepted attestations;
- zero or multiple subjects or SHA-256 digests;
- empty verified timestamps;
- malformed or extra top-level result structures.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test scripts/release/verify-attestation.test.ts
```

- [ ] **Step 3: Implement exact policy**

`release-policy.json` pins:

```json
{
  "repository": "aws/agentcore-cli",
  "signerWorkflow": "github.com/aws/agentcore-cli/.github/workflows/release.yml",
  "oidcIssuer": "https://token.actions.githubusercontent.com",
  "predicateType": "https://slsa.dev/provenance/v1",
  "denySelfHostedRunners": true,
  "allowPublicGood": false,
  "ghVersion": "2.96.0"
}
```

Also pin the exact `gh` binary and trusted-root SHA-256. The verifier first hashes artifact and trust
root, invokes exactly:

```text
gh attestation verify <artifact> \
  --bundle <artifact>.sigstore.jsonl \
  --repo aws/agentcore-cli \
  --signer-workflow github.com/aws/agentcore-cli/.github/workflows/release.yml \
  --signer-digest <source-commit> \
  --source-digest <source-commit> \
  --source-ref refs/tags/<release-tag> \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners \
  --digest-alg sha256 \
  --custom-trusted-root scripts/release/trust/github-trusted-root.jsonl \
  --no-public-good \
  --format json
```

It parses JSON structurally and enforces exactly one result, subject, SHA-256 digest, and nonempty
verified timestamp.

- [ ] **Step 4: Verify and commit**

```bash
bun test scripts/release/verify-attestation.test.ts
bun scripts/release/verify-attestation.ts --self-test test/fixtures/attestations/gh-2.96.0-verify-valid.json
bun run verify:tsc
git add release-policy.json scripts/release/trust/github-trusted-root.jsonl scripts/release/verify-attestation.ts scripts/release/verify-attestation.test.ts test/fixtures/attestations/gh-2.96.0-verify-valid.json
git commit -m "build(identity): verify release provenance"
```

## Task 7: Assemble And Verify Final Release Artifacts

**Files:**

- Create: `.github/workflows/release.yml`
- Modify: `scripts/release/workflows.test.ts`
- Modify: `scripts/release/verify-native-manifest.ts`
- Modify: `scripts/verify-package.ts`
- Modify: `scripts/verify-standalone.ts`

- [ ] **Step 1: Write release-workflow contract tests**

Prove:

- release runs only for `refs/tags/<release-tag>`;
- source commit/tree and workflow commit are fixed before build;
- six matrix inputs are independently attested and verified before assembly;
- final npm and six standalone artifacts are each independently attested and verified;
- no artifact is assembled from an unverified/mismatched matrix input;
- final artifact names and SHA-256 digests match policy.

- [ ] **Step 2: Implement release assembly**

The workflow:

1. resolves the protected tag and source commit;
2. runs the exact toolchain check;
3. builds six prebuilds on exact hosted runners;
4. produces and downloads one attestation bundle per prebuild;
5. verifies every bundle offline under the pinned GitHub-only root;
6. assembles npm and matching standalone artifacts in separate staging trees;
7. runs tarball/install/standalone smoke tests;
8. attests every final artifact;
9. downloads and independently verifies each final bundle;
10. publishes only after all verification passes.

All action references are full commit SHAs. No release job accepts a self-reported artifact digest
without freshly hashing bytes.

- [ ] **Step 3: Verify and commit**

```bash
bun test scripts/release scripts/verify-package.test.ts scripts/verify-standalone.test.ts test/subprocess/package-install.test.ts test/subprocess/standalone-smoke.test.ts
bun scripts/release/verify-toolchain.ts --workflow .github/workflows/release.yml
bun run format:check
git diff --check
git add .github/workflows/release.yml scripts/release/workflows.test.ts scripts/release/verify-native-manifest.ts scripts/verify-package.ts scripts/verify-standalone.ts
git commit -m "ci(identity): add verified release assembly"
```

## Task 8: Run The Complete Local, Package, Native, Fixture, And Live Matrix

**Files:**

- Test: complete repository and produced artifacts

- [ ] **Step 1: Run local verification with captured output**

Under exact Node `22.22.1`:

```bash
bun ci > /tmp/identity_bun_ci.txt 2>&1; echo "EXIT: $?"
bun run verify:toolchain > /tmp/identity_toolchain.txt 2>&1; echo "EXIT: $?"
bun run build:native:host > /tmp/identity_native_host.txt 2>&1; echo "EXIT: $?"
bun test > /tmp/identity_all_tests.txt 2>&1; echo "EXIT: $?"
bun run verify:tsc > /tmp/identity_tsc.txt 2>&1; echo "EXIT: $?"
bun scripts/generate-unicode-security-table.ts --check > /tmp/identity_unicode.txt 2>&1; echo "EXIT: $?"
env -u RECORD bun test > /tmp/identity_no_record_tests.txt 2>&1; echo "EXIT: $?"
bun run build > /tmp/identity_build.txt 2>&1; echo "EXIT: $?"
bun run test:release > /tmp/identity_release_tests.txt 2>&1; echo "EXIT: $?"
bun run format:check > /tmp/identity_format.txt 2>&1; echo "EXIT: $?"
bun audit --audit-level=high > /tmp/identity_audit.txt 2>&1; echo "EXIT: $?"
git diff --check
```

Record every exit code and inspect only relevant tails/failures. All commands must pass; the exact
TypeScript baseline remains unchanged outside intentional reviewed updates and every touched file has
zero diagnostics.

- [ ] **Step 2: Run native, fixture, package, and artifact gates**

```bash
bun run build:native:host > /tmp/identity_native_host.txt 2>&1
bun test src/native/identity src/testing/identity-fixtures src/testing/identity-live > /tmp/identity_native_fixture_live_tests.txt 2>&1
npm pack --json > /tmp/identity_npm_pack.json 2>&1
bun scripts/verify-package.ts --pack-json /tmp/identity_npm_pack.json > /tmp/identity_package_verify.txt 2>&1
bun test test/subprocess/package-install.test.ts > /tmp/identity_installed_smoke.txt 2>&1
bun scripts/verify-standalone.ts --host > /tmp/identity_standalone_smoke.txt 2>&1
```

All gates must pass with no secret sentinel, fixture/test source, run root, capture root, or review
artifact in a distribution.

- [ ] **Step 3: Run deterministic capture/replay twice**

Record the same logical suite with different worker schedules, physical resource names, service
timestamps, and page tokens. Require byte-identical objects, manifests, `READY`, and proposed suite
index. Replay both through the real client/action/router/TUI boundaries.

- [ ] **Step 4: Run deploy-account live and capture gates**

Refresh deploy credentials in the background, wait for success, then run only with:

```text
AWS_PROFILE=deploy
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=603141041947
```

Run the full live matrix and one complete golden capture. Require final quiescent zero-finding audits,
all terminal rows, no remaining AgentCore/Secrets Manager resources, a sealed capture, successful
native publication, and replay of the published generation. Routine automation must not mutate token
vault CMK.

The live command uses `--yes`, owner `agentcore-cli-identity-live-v1`, partition `aws`, and exactly
`api-key-provider`, `oauth2-provider`, `payment-provider`, `workload-identity`, and
`secrets-manager-secret` families. Record the exact command, account, region, result document, audit,
ledger digest, and final resource checks in `release-verification.md`.

- [ ] **Step 5: Inspect all retained evidence**

If any live/capture stdout write is intentionally failed, use `fixtures:list` and
`test:identity:inspect` to recover exact IDs/digests, complete cleanup/publication, and prove no
ambiguous retained authority remains.

## Task 9: Produce Requirement Evidence And Final Reviewed Branch

**Files:**

- Create: `docs/superpowers/reviews/identity-cli/requirements-evidence.md`
- Create: `docs/superpowers/reviews/identity-cli/release-verification.md`
- Modify: `docs/superpowers/reviews/identity-cli/README.md`
- Verify: `docs/superpowers/specs/2026-07-14-identity-cli-design.md`
- Verify: all implementation plans and commits

- [ ] **Step 1: Build an acceptance-criterion evidence table**

For every design acceptance criterion, record:

- exact source module;
- exact unit/compile/subprocess/native/live test;
- artifact or command output;
- reviewed commit SHA;
- any accepted residual risk.

No row may say “covered elsewhere”, “manual”, or “not applicable” without concrete design evidence.

- [ ] **Step 2: Run four independent final Codex reviews**

Dispatch separate `openai.gpt-5.6-sol` reviewers for:

1. architecture and maintainability;
2. factual SDK/service/release correctness;
3. security, secrets, native filesystem, recovery, and supply chain;
4. implementation readiness and requirement coverage.

Each receives exact base/head SHAs, design, all plans, test output paths, package manifests, live
results, and prior adjudications. Fix every valid finding in a new conventional commit, rerun all
affected verification, and repeat the same review domain until its report ends in `VERDICT: PASS`.

- [ ] **Step 3: Record reproducible review evidence**

Store each exact prompt, model/session ID, reviewed SHA, full report, finding adjudication, correction
SHA, and verification rerun under `docs/superpowers/reviews/identity-cli/`. Review reports evaluate an
immutable prior commit; never modify a reviewed commit or amend.

`release-verification.md` records every required command and exit, implementation SHA, native target
manifest and digest, npm listing, installed-package result, standalone result, provenance result,
fixture digest, and live cleanup result. `requirements-evidence.md` maps every design acceptance
criterion to direct source, test, artifact, or runtime evidence.

- [ ] **Step 4: Verify the final tree and push**

```bash
git status --short
git log --oneline --decorate -20
git diff --check
git push -u origin feat/identity-cli
```

Expected: clean worktree, all four final reviews pass, requirement evidence has no gap, and remote
`feat/identity-cli` equals the verified local HEAD.
