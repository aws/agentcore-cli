# Identity CLI Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete `agentcore identity` Commander and Ink experience, its hardened transport and secret boundaries, deterministic fixtures, recoverable live tests, and release packaging defined by the approved design.

**Architecture:** Work proceeds inward-out: shared invocation safety first, then pure Identity domain contracts, adapters, actions, and both presentations. Test-only fixture/live systems and release infrastructure are separate plans because they have different trust boundaries, but they consume the same operation registry, schemas, normalizers, and native adapter rather than creating parallel behavior.

**Tech Stack:** TypeScript 5.9.3, Bun 1.3.14, Node 22.22.1, Commander 15.0.0, Ink 7.1.0, React 19.2.7, Zod 4.4.3, AWS SDK v3.1079.0, Smithy Core 3.29.1, jsonc-parser 3.3.1, C++17 N-API v8.

---

## Authority And Scope

The implementation authority is
`docs/superpowers/specs/2026-07-14-identity-cli-design.md` at the planning commit named by the
review-evidence index. The workspace-root `IDENTITY_IMPLEMENTATION_PLAN.md`,
`IDENTITY_TESTING_PLAN.md`, and `IDENTITY_API_SURFACE_AND_BUILD_PLAN.md` are historical investigation
artifacts. Their CLI-only phase, deferred TUI, generic SDK response rendering, broad `CoreIdentityClient`,
and old fixture model are explicitly superseded.

No production Identity code is complete until all ten implementation plans below are complete. In
particular:

- TUI is part of the feature, not a later phase.
- Tags are part of all four taggable resource families.
- OAuth and payment updates reconstruct complete replacement requests.
- Literal secret flags remain supported with a warning, while action intents remain markerized.
- Fixture capture and live cleanup are implementation scope because the design makes them release gates.
- Release packaging includes the native addon, all six prebuilds, notices, provenance verification,
  and installed-tarball smoke tests.

## Locked File Structure

Files may be split further only when a review demonstrates one responsibility has become unreasonably
large. Public module boundaries and ownership remain as follows:

```text
src/
|-- index.ts
|-- runnable/
|   `-- index.tsx
|-- router/
|   |-- executionPolicy.ts
|   `-- ...existing router files
|-- runtime/
|   |-- output/
|   |   |-- types.ts
|   |   |-- streamSupervisor.ts
|   |   |-- awaitedSink.ts
|   |   |-- commanderOutput.ts
|   |   `-- inkOutput.ts
|   `-- mutation/
|       |-- executionSupervisor.ts
|       |-- presentationSupervisor.ts
|       `-- coordinator.ts
|-- native/
|   `-- identity/
|       |-- types.ts
|       |-- loader.ts
|       `-- index.ts
|-- core/
|   |-- identity.tsx
|   `-- identity/
|       |-- operations.ts
|       |-- statusRegistry.ts
|       |-- body.ts
|       |-- credentials.ts
|       |-- endpoints.ts
|       |-- mapWire.ts
|       |-- rawWire.ts
|       |-- paginator.ts
|       |-- bindings.ts
|       `-- factory.ts
|-- handlers/
|   `-- identity/
|       |-- index.tsx
|       |-- screen.tsx
|       |-- routes.tsx
|       |-- types.ts
|       |-- composition.ts
|       |-- options.ts
|       |-- format.ts
|       |-- interaction.ts
|       |-- commander.ts
|       |-- IdentityErrorBoundary.tsx
|       |-- domain/
|       |   |-- workflow.ts
|       |   |-- operations.ts
|       |   |-- intents.ts
|       |   |-- schemas.ts
|       |   |-- json.ts
|       |   |-- maps.ts
|       |   |-- strings.ts
|       |   |-- unicodeSecurityTable.ts
|       |   |-- arn.ts
|       |   |-- providers.ts
|       |   |-- secretSlots.ts
|       |   |-- oauth.ts
|       |   |-- payment.ts
|       |   |-- requests.ts
|       |   |-- updates.ts
|       |   |-- review.ts
|       |   |-- normalize.ts
|       |   |-- guard.ts
|       |   `-- errors.ts
|       |-- secrets/
|       |   |-- types.ts
|       |   |-- extraction.ts
|       |   |-- context.ts
|       |   `-- reader.ts
|       |-- actions/
|       |   |-- types.ts
|       |   |-- query.ts
|       |   |-- picker.ts
|       |   |-- mutation.ts
|       |   |-- apiKey.ts
|       |   |-- oauth2.ts
|       |   |-- payment.ts
|       |   |-- workload.ts
|       |   |-- tokenVault.ts
|       |   `-- tags.ts
|       |-- hooks/
|       |   |-- useIdentityQuery.tsx
|       |   |-- useIdentityPicker.tsx
|       |   |-- useIdentityMutation.tsx
|       |   `-- useHiddenSecretPrompt.tsx
|       |-- components/
|       |   |-- IdentityPicker.tsx
|       |   |-- IdentityResult.tsx
|       |   |-- MutationReview.tsx
|       |   |-- SecretInput.tsx
|       |   |-- StringListEditor.tsx
|       |   `-- IdentityTextInput.tsx
|       |-- oauth2-provider/{create,get,list,update,delete,tag,untag,list-tags}/
|       |-- api-key-provider/{create,get,list,update,delete,tag,untag,list-tags}/
|       |-- payment-provider/{create,get,list,update,delete,tag,untag,list-tags}/
|       |-- workload-identity/{create,get,list,update,delete,tag,untag,list-tags}/
|       `-- token-vault/{get,set-cmk}/
`-- testing/
    |-- typescriptDiagnostics.ts
    |-- TestIdentityRuntime.tsx
    |-- identity-fixtures/
    |   |-- types.ts
    |   |-- canonical.ts
    |   |-- algebra.ts
    |   |-- redaction.ts
    |   |-- recorder.ts
    |   |-- replay.ts
    |   |-- manifest.ts
    |   `-- publication.ts
    `-- identity-live/
        |-- types.ts
        |-- ledger.ts
        |-- audit.ts
        |-- cleanup.ts
        |-- runner.ts
        |-- inspect.ts
        `-- commands.ts

native/identity/
|-- binding.gyp
|-- src/addon.cc
|-- src/common.cc
|-- src/common.h
|-- src/linux.cc
|-- src/darwin.cc
|-- src/windows.cc
`-- test/
    |-- binding.gyp
    |-- addon.cc
    |-- fixture_kill_points.h
    `-- fixture_kill_points.cc

scripts/
|-- build-native.ts
|-- generate-unicode-security-table.ts
|-- verify-ts-diagnostics.ts
|-- verify-package.ts
|-- verify-standalone.ts
|-- identity-fixtures/
|   |-- capture.ts
|   |-- list.ts
|   |-- publish.ts
|   |-- discard.ts
|   `-- reap.ts
`-- release/
    |-- verify-toolchain.ts
    |-- verify-attestation.ts
    |-- verify-native-manifest.ts
    |-- workflows.test.ts
    `-- trust/github-trusted-root.jsonl

test/
|-- compile/
|-- fixtures/
|   |-- typescript-diagnostics.json
|   |-- unicode/
|   |-- attestations/
|   `-- identity-fixture-tree/identity/v1/
|-- subprocess/
|   |-- identity-commander.test.ts
|   |-- identity-fixture-commands.test.ts
|   |-- identity-fixture-publication-kill.test.ts
|   |-- identity-live-commands.test.ts
|   |-- identity-live-killpoints.test.ts
|   |-- package-install.test.ts
|   |-- native-addon-smoke.ts
|   |-- node20-native-load.cjs
|   `-- standalone-smoke.test.ts
`-- tui/
    |-- identity-driver.tsx
    `-- identity-driver.test.tsx

.github/workflows/ci.yml
.github/workflows/release.yml
.node-version
.bun-version
LICENSE
NOTICE
release-policy.json
release-toolchain.json
docs/identity.md
THIRD_PARTY_NOTICES.md
docs/superpowers/reviews/identity-cli/requirements-evidence.md
docs/superpowers/reviews/identity-cli/release-verification.md
```

Every resource verb directory contains `index.tsx`, `screen.tsx`, and focused Commander/screen tests
where the verb is interactive. Shared handler factories may remove mechanical duplication, but the
route and test files remain explicit so parity checks can enumerate the surface.

## Plan Order

| Order | Plan                | Produces                                                                                                 | Depends on         |
| ----: | ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------ |
|     1 | `01-foundations`    | exact toolchain, diagnostic baseline, awaited output, recursive Commander policy, mutation supervisors   | current repository |
|     2 | `02-domain`         | closed workflows, catalogs, intents, validation, review, guards, V1 normalization                        | plan 1 types       |
|     3 | `03-secrets-native` | marker extraction, context ownership, secret reader, secure native file/root/lock primitives             | plans 1-2          |
|     4 | `04-transport`      | operation-bound SDK factories, exact status/body handling, endpoint/credential pinning, maps, paginators | plans 1-3          |
|     5 | `05-actions`        | query/picker and prepare/commit/reprepare actions for all 46 workflows                                   | plans 1-4          |
|     6 | `06-commander`      | complete command tree, options, warnings, JSON output, routing                                           | plans 1-5          |
|     7 | `07-tui`            | complete Ink registry, pickers, forms, reviews, confirmations, result/error views                        | plans 1-6          |
|     8 | `08-fixtures`       | secret-safe deterministic record/replay, capture, handoff, and publication commands                      | plans 2-7          |
|     9 | `09-live-recovery`  | live matrix, canonical ledger, audit, inspect, dry-run/mutating reaper, cleanup terminalization          | plans 3-8          |
|    10 | `10-release`        | packaging, native prebuild matrix, provenance policy/verifier, final verification                        | all prior plans    |

Plans are executed in order. A task does not start until its predecessor's focused tests and both
subagent reviews pass. Push the branch after every reviewed task commit.

## Non-Negotiable Cross-Plan Invariants

1. Presentation never imports SDK request unions or builds replacement requests.
2. Domain and action modules never import Commander, Ink, React, process, filesystem, or native code.
3. Every action receives one operation- and workflow-branded binding factory, not a broad client.
4. Every async boundary returns a closed outcome and no raw `Error`, cause, stack, or service text.
5. Every production mutation has one prepared capability, one matching secret context, one operation
   binding, one execution scope, at most one SDK mutation command, and one correlated output receipt.
6. Managed secret values exist only in an extraction bundle or claimed context lease. They never enter
   intents, plans, reviews, guards, errors, fixtures, or V1 documents.
7. Ordinary reads tolerate additive fields after exact status/body validation; OAuth/payment update
   reads fail closed on additive wire shape.
8. Dynamic maps remain duplicate-free entry arrays until a boundary explicitly creates a
   null-prototype record.
9. Raw SDK outputs never cross the action boundary. Commander and Ink consume only branded V1
   documents or closed safe errors.
10. TUI routes and Commander leaves derive from one closed registry and are parity-tested.
11. Fixture replay is an SDK-level adapter, not an action fake. Capture commits only accepted,
    normalized logical calls.
12. `READY` is created only after a quiescent audit and a ledger whose rows are all
    `createNotSent` or `deleted`.
13. Test/live endpoint policy never honors configured endpoint overrides and never mutates outside
    account `603141041947`, region `us-east-1`, profile `deploy`.
14. The npm tarball and standalone artifacts contain production code, notices, and matching native
    prebuilds, but no tests, fixtures, run roots, captures, or review artifacts.
15. Plan 03 owns every production native filesystem/publication mutation. Plans 08-09 consume those
    primitives and may add only a separately built, compile-time-enabled kill-point test addon.
16. Identity Ink screens use static routes and action-only lifecycle hooks. They do not import Core,
    SDK types, transport cursors, continuation tokens, or TanStack Query.
17. Identity fixture capture/replay remains parallel to the legacy Harness recorder and uses the single
    plan 09 recovery runner; it does not modify `src/testing/fixtures.tsx` or duplicate cleanup.

## Requirement Coverage

| Design section                          | Primary plan | Verification evidence                                      |
| --------------------------------------- | ------------ | ---------------------------------------------------------- |
| Command Surface / Output And Invocation | 01, 06       | router, subprocess, and Commander contract tests           |
| Architecture / Ports And Adapters       | 01-05        | compile fixtures plus adapter/action tests                 |
| Provider Catalog / Input Model          | 02           | exhaustive catalog and schema tests                        |
| Secret Handling                         | 03           | marker, lifecycle, file, and native platform tests         |
| Request Flow / Update Semantics         | 02, 05       | prepare/commit/rebase matrices                             |
| Pagination / Unknown Future Providers   | 02, 04, 05   | codec, paginator, picker, and drift tests                  |
| TUI Design / Errors                     | 01, 07       | route parity, screen, async failure, and output tests      |
| Secret-Safe Record And Replay           | 08           | fixture algebra, retry, poison, capture, publication tests |
| Testing Strategy / Live Tests           | 09           | live matrix, ledger, audit, cleanup, inspect/reap tests    |
| Dependencies / Release                  | 01, 03, 10   | lockfile, package, prebuild, smoke, attestation tests      |

## Execution Protocol

For every implementation task:

1. Write the smallest behavioral or compile-time test first.
2. Run the focused test and record the expected failure.
3. Implement only the task's behavior.
4. Run the focused test, affected subsystem tests, `bun run verify:tsc`, and `git diff --check`.
5. Commit with the task's conventional commit message.
6. Run a fresh `openai.gpt-5.6-sol` spec-compliance review.
7. Fix every valid finding and repeat the spec review until it passes.
8. Run a separate `openai.gpt-5.6-sol` code-quality/security review.
9. Fix every valid finding and repeat until it passes.
10. Push the reviewed commit to the feature branch before starting the next task.

Reviewers receive the exact base/head SHAs, complete task text, relevant design sections, and test
evidence. They do not inherit implementation-agent context.

## Task 1: Establish The Baseline

**Files:**

- Read: `docs/superpowers/specs/2026-07-14-identity-cli-design.md`
- Read: all ten companion plans
- Test: current repository

- [ ] **Step 1: Record the immutable starting point**

Run:

```bash
git rev-parse HEAD
git status --short
```

Expected: one committed planning SHA and no production-code changes.

- [ ] **Step 2: Run the pre-implementation baseline**

Run:

```bash
bun test
bun run build
bun run format:check
bunx tsc --noEmit
```

Expected: tests/build/format pass; TypeScript output matches the diagnostic fixture created by plan 01.

- [ ] **Step 3: Execute plans 01 through 10 in order**

Use each plan's checkboxes and commits. Do not combine tasks across plans when that would skip the
required red/green or review boundary.

## Task 2: Final Requirement Audit

**Files:**

- Verify: every file listed under Locked File Structure
- Verify: `docs/superpowers/specs/2026-07-14-identity-cli-design.md`
- Verify: `docs/superpowers/reviews/identity-cli/`

- [ ] **Step 1: Build a requirement-to-evidence table**

For every acceptance criterion in the design, record the exact test, source module, runtime command,
packaged artifact, or review report that proves it. A missing or indirect entry is a failure.

- [ ] **Step 2: Run the complete verification matrix**

Run the commands defined in plan 10, including unit, compile, subprocess, native host, fixture,
package, standalone, and explicit deploy-account live suites.

- [ ] **Step 3: Run four final independent reviews**

Use separate `openai.gpt-5.6-sol` reviewers for architecture, factual/API, security, and
implementation readiness. Repeat correction and review commits until all four reports end in
`VERDICT: PASS`.

- [ ] **Step 4: Push the final branch**

Run:

```bash
git status --short
git push -u origin feat/identity-cli
```

Expected: clean worktree and remote branch at the verified local HEAD.
