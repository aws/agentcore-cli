# Changelog

All notable changes to this project will be documented in this file.

## [0.16.0] - 2026-05-28
* feat: instrument telemetry for status command by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1317
* fix(telemetry): emit dev command telemetry before blocking by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1375
* feat: compile-time feature flag for preview/GA consolidation by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1341
* fix(ci): upload both GA and preview tarballs in prerelease workflow by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1386
* feat(scripts): extend bundle to support injectable output and version suffix by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1389
* fix(ci): use cache for eslint/prettier/typecheck to speed up dev cycle by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1390
* fix(dataset): tui back-navigation bugs + kmsKeyArn support by @jariy17 in https://github.com/aws/agentcore-cli/pull/1379
* fix: create global entrypoint for tui by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1365
* fix: centralize ANSI codes and disable colors in non-TTY output by @Hweinstock in https://github.com/aws/agentcore-cli/pull/1399
* docs: Link to agentcore-samples repository in README by @notgitika in https://github.com/aws/agentcore-cli/pull/1400
* fix: allow skipping optional KMS key ARN in evaluator wizard by @notgitika in https://github.com/aws/agentcore-cli/pull/1402
* fix(status): show harnesses in agentcore status output by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1396
* fix(deploy): add harness teardown to TUI deploy flow by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1394
* feat: check for spans in agent log group by @avi-alpert in https://github.com/aws/agentcore-cli/pull/1404
* fix(dev): skip redundant deploy when TUI deploy already succeeded by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1395
* fix(harness): resolve memorySpec by deployed ARN for arn-only memory refs by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1407
* chore: simplify release-main-and-preview workflow by @jesseturner21 in https://github.com/aws/agentcore-cli/pull/1415

## [0.15.0] - 2026-05-22

## [0.14.2] - 2026-05-21

### Added
- feat: add support for LTM metadata (#1281) (44b5c2cf)
- feat: instrument telemetry for import command (#1312) (2cc0a4cb)

### Fixed
- fix(import): escape triple-quotes in collaborationInstruction to prevent docstring injection (#1329) (ae1b932e)
- fix(ci): use npm-shrinkwrap.json for node_modules cache key (#1325) (a6872ca5)
- fix: ship npm-shrinkwrap.json to eliminate glob@10 deprecation warning on install (#1315) (4c5077c2)
- fix: scope summaries retrieval to actor, not session, for cross-session memory (#1299) (1402057e)

### Documentation
- docs: sync CLI documentation with actual command surface (#1296) (5ae559ae)

### Other Changes
- Revert "feat: add support for LTM metadata (#1281)" (#1338) (2d8b9d7b)
- ci(security-review): drop pull_request_review trigger (broken on fork PRs) (#1310) (43607fa1)
- chore: replace CDK_REPO_TOKEN PAT with GitHub App token in e2e workflows (#1201) (fc675346)
- chore(deps): bump ws from 8.20.0 to 8.20.1 (#1298) (52d3e847)

## [0.14.1] - 2026-05-19

### Added
- feat(tui): add dedicated Logs screen for streaming runtime logs (#1274) (2f3040a6)
- feat: upgrade agent inspector to 0.4.2 (#1305) (7fac9a35)
- feat: upgrade agent inspector to 0.4.2 (36399dbf)
- feat: expose ability to publish otel metrics to remote endpoint (#1244) (721c2a95)

### Fixed
- fix(templates): pin google-adk < 2.0.0 to prevent runtime init timeout (#1309) (397530ad)
- fix: update PR tarball install instructions to use gh CLI (55f124ee)
- fix: hoist TypeScript session-storage check before early returns, add test (040f4c1f)
- fix: remove session storage option from TypeScript agent advanced config (0c6f0431)
- fix(test): strip ANSI codes from Ink TUI test assertions (#1301) (ab4c19ec)
- fix(templates): make Strands TypeScript template strict-typecheck clean (#1300) (9bada857)
- fix: handle scoped conventional commits in changelog categorization (#1289) (fc135b0a)
- fix: build CLI before running integration tests (#1286) (306c9e84)
- fix: skip schema-check and pr-title validation on release PRs (#1272) (d92fac29)

### Other Changes
- Merge pull request #1307 from aws/fix-pr-tarball-install-instructions (e0c2d5bb)
- Merge pull request #1306 from aws/remove-session-storage-typescript (f1f6719c)
- ci(security-review): add safe-to-review label as alternate trigger (#1297) (4f89e0df)
- ci(security-review): drop sticky comment, post workflow summary, re-enable synchronize (#1293) (fcbdf592)
- ci: add Claude Code /security-review workflow on PRs (#1285) (ac6cf4a9)
- refactor(telemetry): make attributes globally unique (#1246) (574375ba)
- Merge pull request #1273 from notgitika/chore/remove-dead-tag-command (10294f1b)
- refactor: centralize error types for consistent definition shapes (#1238) (5e1a24f3)
- chore: remove dead tag command (1f21ad05)

## [0.14.0] - 2026-05-15

### Added
- feat: upgrade agent inspector to 0.4.1 (f012107c)
- feat: upgrade agent inspector to 0.4.0 (9b494b56)
- feat: instrument telemetry for invoke command (#1227) (b6e44184)
- feat: instrument telemetry for dev command (#1223) (fdf145d0)
- feat: add Node.js OTEL support and fix CJS import.meta.url crash (76e3fffc)
- feat: instrument telemetry for deploy command (CLI + TUI) (#1206) (ce00f570)
- feat: record command attrs on telemetry failure via fallbackAttrs (#1204) (f69e2524)
- feat: instrument telemetry for create command (CLI + TUI) (#1202) (bcedddec)
- feat: wire telemetry into all remove.* commands (#1069) (52a24ce9)

### Fixed
- fix: remove early --version interception, keep only the dep fix (3b667587)
- fix: resolve crash on agentcore --version due to missing transitive dep (ff8ac7bd)
- fix: add workflow_dispatch trigger to sync-preview workflow (#1255) (7836897f)
- fix: replace third-party base image with AWS public ECR image (CVE-2026-31789) (#1250) (530394b1)
- fix: disambiguate sync-from-public branch checkout (d7a7798d)
- fix: hide traces UI for TypeScript agents (9fc7adbf)
- fix: make reserved-name error message language-neutral (1c291bce)
- fix: use Resource class instead of resourceFromAttributes for OTEL v1.x compat (95437e8a)
- fix: TypeScript template and packaging fixes for Node CodeZip (b8dd9e27)
- fix: update otel-register.ts to use OpenTelemetry SDK v2.x API (174e9fcf)
- fix: copy dynamic require deps into _deps dir for Node CodeZip bundles (7da712fb)
- fix: use CJS format with package.json type:commonjs in zip (198b69e7)
- fix: add createRequire banner to ESM bundles for CJS compat (8a7ac68c)
- fix: switch Node CodeZip bundling to ESM format (87b2f661)
- fix: wire up agent templates with PORT option (f140073c)
- fix: update runCLI call to use options object and format frameworks.md (afdc9f16)
- fix: set typescript agent port to 8080 (fddaad1e)
- fix: sync-preview pushes directly on clean merge, PRs only on conflict (#1078) (01536945)
- fix: bump versions to resolve security audit failure (f1788bc5)
- fix: add batch eval, recommendation, and CloudWatch Logs write permissions to docs (#1113) (ce50d524)
- fix: widen TUI panel to prevent text truncation (#1191) (#1193) (6ee1141c)
- fix: resolve target-based AB test target name mismatch (#1188) (eb2e1475)
- fix: handle CloudFormation throttling in import gateway polling (#1185) (df27f122)
- fix: resolve high-severity npm audit vulnerabilities (#1184) (715a5a28)
- fix: use search API with listForRepo fallback for issue dedup (#1180) (e247d995)
- fix: apply prettier formatting to review.md (#1167) (ab82c66d)
- fix: pin a2a-sdk below 1.0 to prevent breaking changes (42487c0c)

### Documentation
- docs: add VercelAI to CLI help text and documentation (590b1369)
- docs: add explanatory comments for container credentials and node path resolution (301e2867)
- docs: update bugbash status — withApiKey fix resolves deployed invoke (ef6f1f36)
- docs: update bugbash status — deploy, invoke, and remove lifecycle tested (9219f894)
- docs: update bugbash status — all Container + non-Bedrock combos tested (1d1cf0c8)
- docs: add telemetry instrumentation guide (#1197) (340878c9)
- docs: split TESTING.md into focused per-type docs (#1192) (be652019)
- docs: add bedrock:CountTokens to IAM policy examples (#1181) (804e0419)

### Other Changes
- Merge pull request #1276 from aws/fix/version-crash-missing-region-config-resolver (7acd86ea)
- chore(deps): bump react from 19.2.5 to 19.2.6 (#1228) (5539677c)
- chore(deps-dev): bump @vitest/coverage-v8 from 4.1.5 to 4.1.6 (#1229) (98720a30)
- chore(deps): bump zod from 4.3.6 to 4.4.3 (#1230) (b5ae6b7a)
- chore(deps): bump yaml from 2.8.3 to 2.9.0 (#1231) (c4b0d930)
- chore(deps-dev): bump @playwright/test from 1.59.1 to 1.60.0 (#1234) (65ab3666)
- chore: update namespace design for data plane (#1114) (28541506)
- chore: update CP semantics to expect redesigned namespaces field (#1115) (a4605ef3)
- Merge pull request #1251 from avi-alpert/aalpert/inspector-0.4.1 (a8e9a1e0)
- Merge pull request #1249 from avi-alpert/aalpert/inspector-0.4.0 (df51f041)
- Merge pull request #981 from aws/fix/strands-ts-stream-events (6d8aed58)
- docs(templates): fix stale README info in TS templates (18e4f89c)
- fix(templates): remove unused deps from Strands TS package.json (904cd703)
- fix(templates): rename handler to callback in Strands TS tool config (402af8e8)
- fix(schema): relax request header allowlist to accept documented header patterns (#1163) (613c9958)
- Merge pull request #1235 from aws/fix/sync-from-public-ambiguous-preview (95032396)
- fix(dev): use dynamic port assignment for TS HTTP agents in web UI (485cbdab)
- fix(templates): remove OTEL, session storage, and gateway from TS templates (580cd10b)
- Reapply "ci(e2e): add cdk_branch input to override CDK source branch" (521e6436)
- Revert "ci(e2e): add cdk_branch input to override CDK source branch" (cd1ee54d)
- ci(e2e): add cdk_branch input to override CDK source branch (1f9b3309)
- fix(tui): remove duplicate project name in create-prompt phase (f6dd69cb)
- fix(templates): bump bedrock-agentcore SDK to ^0.2.4 (16060192)
- test(e2e): skip logs and traces tests for TypeScript agents (8fe40a9c)
- test(e2e): add TypeScript Strands and VercelAI e2e tests (39c1837b)
- fix(dev): allow web UI port fallback for TypeScript HTTP agents (ac5876f8)
- fix(templates): fix withApiKey call syntax in TypeScript non-Bedrock templates (235df8f2)
- fix(templates): fix TypeScript non-Bedrock model provider templates (4fdb5076)
- fix(dev): use fixed port 8080 for TypeScript HTTP agents in web UI (1581f971)
- test: update asset snapshots for otel-register import in main.ts (23e09650)
- refactor: inline otel-register into main.ts for local + deployed tracing (0e81fd54)
- test: fix node-packager tests and update snapshots for CJS bundling (1ed9e14d)
- style: format container-dev-server test with prettier (b7bd53eb)
- fix(test): update container-dev-server test for resolveHostCredentials spawnSync call (5576fbeb)
- chore: remove development tracking docs from PR (aebae2c1)
- fix(dev): detect and skip container runtime shims that masquerade as real runtimes (7fa54adc)
- fix(dev): resolve AWS credentials on host for container dev mode (b632ac2a)
- fix(dev): prefer explicit credentials over AWS_PROFILE in container dev (730e01c5)
- fix(vercelai): fix dependency versions, model ID, and Bedrock credentials (fbdeb95b)
- feat(typescript): add Vercel AI SDK framework for TypeScript agents (b60db2de)
- fix(typescript): disable memory for TypeScript agents and clean up templates (cafed9c1)
- fix(invoke): include text/event-stream in Accept header for HTTP invoke (a21dbfda)
- fix(typescript): use correct Strands SDK stream event types in template (32d006a9)
- fix(dev): detect TS server readiness in terminal TUI mode (fe56048a)
- feat(dev): enable dev mode for TypeScript agents (CodeZip + Container, browser + no-browser) (091ce803)
- fix(typescript): gate MCP and A2A protocols behind Python-only until TS templates land (a927a9a1)
- fix(typescript): enable TypeScript option in interactive create wizard (51261427)
- fix(typescript): reject --protocol MCP + --language TypeScript with a clear error (9472f8e8)
- fix(typescript): move tsx into dependencies so containers boot without re-install (e5ad996d)
- fix(typescript): make container build succeed for scaffolded TS agent (70c79537)
- docs(typescript): add completed test plan results for TS support bug bash (ca77d1d4)
- fix(typescript): surface real npm install error in interactive create TUI (40d0e361)
- fix(typescript): run npm install during non-interactive create for TS projects (89e33231)
- fix(typescript): make scaffolded TS agent installable and bootable (997c1e80)
- docs(typescript): add code pointers to TS test plan for targeted fixes (c14cc782)
- docs(typescript): add manual test plan with progress-tracker checklist (b2eb1fa3)
- docs(typescript): phase 7 user docs + phase 8 verification log (c339f670)
- fix(typescript): replace Python-only guard in create validator with Strands gate (fce50f47)
- docs(typescript): log 7af265e in progress tracker (197e41f8)
- test(typescript): add TUI walkthrough for create TypeScript + Strands (71ee6438)
- docs(typescript): log c22147d in progress tracker (4c73b4e7)
- test(typescript): add TS dev-server spec + create-flow integ block; fix spawn entrypoint rewrite (1e24a985)
- docs(typescript): log f015ce7 + 5c2af7d in progress tracker (e5590cf2)
- feat(typescript): Node setup helper + create-flow wiring (Phase 5) (9d493e3f)
- docs(typescript): log 003f672 + 076a4aa in progress tracker (aca0e694)
- feat(typescript): add container template for TS agents (Phase 4) (ecfbc2a1)
- docs(typescript): log 6f1aeed + f6ed2e9 in progress tracker (fe47baed)
- feat(typescript): author TS/Strands HTTP template assets (Phase 3) (2c1e7fc7)
- docs(typescript): log a487f19 in progress tracker (56429216)
- feat(typescript): unblock dev mode for TS agents (Phase 2) (ca7264b1)
- docs(typescript): log 3417f9a in progress tracker (0a87cdbd)
- docs(typescript): add progress tracker for TS support initiative (b37d4933)
- feat(typescript): scaffold TypeScript language support (WIP checkpoint) (358ed7e2)
- refactor: unify result types with discriminated Result<T, E> union (#1125) (f010c126)
- feat(evaluator): add kmsKeyArn support for custom evaluator (#994) (7d27f47b)
- Merge pull request #1210 from aws/chore/replace-github-token-with-app-token (6dc4b7fd)
- revert: keep pr-title.yml using GITHUB_TOKEN (read-only access sufficient) (0e6d5778)
- Merge pull request #1211 from Hweinstock/fix/old-deps (a15c7565)
- chore: replace all github.token/GITHUB_TOKEN with GitHub App token (5767d93e)
- chore: replace PAT tokens with GitHub App token (#1198) (eba0e40e)
- test: remove unnecessary mocks, use real filesystem (#1156) (9063a776)
- chore(deps-dev): bump hono from 4.12.14 to 4.12.18 (#1152) (7bf41ddd)
- ci: use AUTOMATION_ACCOUNT_PAT_TOKEN for issue creation (#1176) (d8fc802f)
- ci: add workflow to create issues on CI failure (#1174) (714b1785)
- Merge pull request #1137 from aws/dependabot/npm_and_yarn/secretlint-13.0.0 (2c34489e)
- Add labels to Slack issue notification payload (#1162) (6b2be998)
- feat(harness): add verdict prefix to reviewer comments (#1153) (a3f504ae)
- Merge pull request #1145 from aws/fix/pin-a2a-sdk-below-1.0 (2923dea3)
- fix(deploy): pass stack selection to diff and deploy for --target filtering (#980) (#1148) (d9ec423b)
- chore(deps): bump react from 19.2.5 to 19.2.6 (#1136) (ec92d3fe)
- chore(deps): bump @opentelemetry/exporter-metrics-otlp-http (#1141) (9716db05)
- chore(deps-dev): bump secretlint from 12.3.1 to 13.0.0 (4ac28c23)

## [0.13.1] - 2026-05-06

### Added
- feat: add archive command for batch evaluations and recommendations (#1112) (7586092e)

### Fixed
- fix: correct AB test execution role IAM policy and promote stability (#1120) (9f231d00)
- fix: set iamRoleFallback to true for lambda gateway targets (#1086) (639adf1b)
- fix: prefix HTTP gateway names with project name to prevent cross-project collisions (#1105) (e9066ce0)
- fix: use correct resourceType for config bundle in E2E status test (#1094) (7fb8a636)
- fix: align E2E batch eval and recommendation tests with current API (#1093) (f1d046cf)
- fix: sync e2e IAM policy and fix run eval flag (#1092) (78b3bd15)
- fix: address formatting failure in docs (#1080) (162afd45)

### Documentation
- docs: clarify integration vs e2e test boundaries and add e2e README (#1111) (bb69aa53)
- docs: remove CrewAI from supported frameworks (#1059) (a91d8882)

### Other Changes
- test: collapse schema enumeration tests and remove duplicates (#1087) (4f464d77)
- test: remove http-gateway-targets e2e test (#1090) (5ce18744)
- chore(deps): override glob to ^13 to silence install deprecation warning (#1008) (3b7a0a5b)

## [0.13.0] - 2026-05-01

### Added
- feat: evo preview features — config bundles, batch evaluation, recommendations, AB testing (#1068) (9ccf802)
- feat: wire telemetry into all add.* commands (#1050) (e9dfc16)
- feat: make parsing resilient to individual failures (#1062) (a4c37a2)
- feat: update @aws/agent-inspector to 0.3.0 (90f17b4)
- feat: update @aws/agent-inspector to 0.3.0 (278783a)

### Fixed
- fix: remove unnecessary non-null assertions after .default([]) revert (#1075) (eab8c87)
- fix: revert .optional() to .default([]) and strip empty evo arrays on write (#1074) (8c5cdfe)
- fix: remove dead preflight patch, proper teardown, optional evo schema fields (#1073) (839b32b)
- fix: remove dead preflight patch and use proper teardown for evo resources (#1072) (0e38e9e)
- fix: resolve e2e import test concurrency races (#1067) (bd6f841)
- fix: forward custom headers in bearer token invoke paths (#1065) (3dccd97)

### Other Changes
- refactor: consolidate cli-config into global-config (#802) (3aec000)
- ci: cut full e2e time in half via vitest sharding (#1016) (4daca83)

## [0.11.0] - 2026-04-24

### Added
- feat: add telemetry schemas and client (#941) (7c37fa6)
- feat: add GitHub Action for automated PR review via AgentCore Harness (#934) (a365bf5)

### Fixed
- fix: display session ID after CLI invoke completes (#957) (51e4a8e)
- fix: lower eventExpiryDuration minimum from 7 to 3 days (closes #744) (#956) (8613657)
- fix: use pull_request_target for fork PR support (#958) (933bac8)
- fix: agentcore dev not working in windows (#951) (5271f55)
- fix: add TTY detection before TUI fallbacks to prevent agent/CI hangs (#949) (c30ed54)
- fix: allow code-based evaluators in online eval configs (#947) (3d2d671)
- fix: buffer streaming text to avoid per-token log lines in GitHub Actions (#946) (cb1e81a)

### Other Changes
- test: add browser tests for agent inspector (#938) (7a4104d)

## [0.10.0] - 2026-04-23

### Added
- feat: upgrade agent inspector to 0.2.1 (#937) (b49a06f)
- feat: remove deployed/local from status legend (#936) (c0d5b7b)
- feat: add GovCloud multi-partition support (#908) (098b104)
- feat: support preview releases from feature branches (#905) (1a93f92)
- feat: add AG-UI (AGUI) as fourth first-class protocol mode (#858) (52144dc)
- feat: add session filesystem storage support (#893) (b97e337)

### Fixed
- fix: agentcore add component opens component wizard directly (#896) (74a35cb)
- fix: propagate sessionId as A2A contextId in Inspector proxy (#892) (08d452e)

### Documentation
- docs: update vended AGENTS.md, README.md, and llm-context references (#898) (84a6dde)

### Other Changes
- fix(deploy): honor aws-targets.json region for all SDK and CDK calls (#925) (1903f7d)
- fix(invoke): show full session ID and print resume command on exit (#904) (ce683c0)
- chore: remove preview bump type from release workflow (#847) (13f16d3)
- chore: remove single-commit-must-match-PR-title validation (#897) (4d7da2f)
- fix(invoke): pass session ID to local invoke log files (#894) (e966cb6)

## [0.9.1] - 2026-04-17

## [0.9.0] - 2026-04-17

### Fixed
- fix: revert version to 0.8.2 (#885) (321ea06)
- fix: agent-inspector frontend assets missing from build (#883) (08f826c)
- fix: use caret range for @aws/agentcore-cdk in CDK template (#882) (e01f6f9)
- fix: defer policy engine write and harden policy flow UX (#856) (c576d02)
  
### Added
- feat: add agent inspector web UI for `agentcore dev` (#871) (6cc575c)

### Documentation
- docs: document executionRoleArn in runtime spec (#872) (abfd33b)

## [0.8.2] - 2026-04-16

### Added
- feat: upgrade default Python runtime to PYTHON_3_14 (#837) (b139c05)

### Other Changes
- revert: roll back version bump to 0.8.1 (#877) (ef14108)
- test: update asset snapshot for @aws/agentcore-cdk 0.1.0-alpha.19 (#875) (f781c60)
- chore: bump version to 0.8.2 (#874) (865b5d5)

## [0.8.1] - 2026-04-14

### Added
- feat: add auto-instrumentation to langchain agent template (#835) (31fb7d1)
- feat: add e2e tests for import command (#828) (bb9de25)
- feat: add --request-header-allowlist CLI flag for agentcore add agent (#825) (#830) (b433faf)

### Fixed
- fix: pin @aws/agentcore-cdk to exact version in CDK template (#852) (aff1097)
- fix: only exclude root-level agentcore/ directory from packaging artifacts (#844) (c3921ec)
- fix: add AWS_IAM as a valid authorizer type for gateway commands (#820) (f2964e3)
- fix: add missing langchain instrumentor dependency to import flow (#836) (921a05f)
- fix: unhide import command from TUI main menu (#834) (ee6b630)
- fix: add missing AgentCore regions to match AWS documentation (#833) (3b60dbe)
- fix: remove docker info check from container runtime detection (#829) (6729eb2)
- fix: update E2E test regex to match new CUSTOM_JWT client-side error (#832) (4f178a5)
- fix: fail fast when CUSTOM_JWT agent has no bearer token available (#817) (96de3d2)
- fix: respect aws-targets.json region instead of overriding with AWS_REGION env var (#818) (bdcc954)
- fix: use caret range for aws-cdk-lib in project template (#805) (6e19463)

### Other Changes
- fix(ci): bump @aws/agentcore-cdk to 0.1.0-alpha.18 and remove snapshot step from release (#850) (e885843)
- fix(ci): move snapshot update after build step in release workflow (#849) (37665a3)
- fix(ci): update snapshots after CDK version sync in release workflow (#848) (6f87f04)
- fix(e2e): use uv run for import test Python scripts (#845) (5962711)
- fix(ci): unpin boto3 in e2e workflow (#841) (e64e8e2)
- chore: pin @aws/agentcore-cdk version and auto-sync on release (#811) (1e5c631)
- chore: bump aws-cdk-lib peer dep to ^2.248.0 (#812) (16b3c8c)

## [0.8.0] - 2026-04-09

### Added
- feat: enable memory in `agentcore dev` (#801) (04c3785)
- feat: add telemetry notice and preference management (#797) (fb34507)
- feat: add TUI wizard streaming steps for memory record streaming (#534) (05becd7)
- feat: add streamDeliveryResources schema, CLI flags, and validation for memory record streaming (#531) (a8a1f79)

### Fixed
- fix: bump aws-cdk-lib to 2.248.0 in project template (#804) (374fe31)
- fix: format docs/commands.md to pass prettier check (#798) (bbe5452)
- fix: add bearer-token support to MCP invoke path (#749) (6b6c0a5)

### Documentation
- docs: add build, npm, and license badges to README (#787) (3124b6d)
- docs: fix 30 documentation inaccuracies found by source code audit (#697) (767fd4c)

### Other Changes
- fix(e2e): use --runtime flag instead of non-existent --agent in byo-custom-jwt tests (#795) (321177c)
- ci: bump the github-actions group across 1 directory with 2 updates (#649) (4a3d91d)
- chore(deps-dev): bump @secretlint/secretlint-rule-preset-recommend (#756) (6b1bda6)
- chore(deps-dev): bump @modelcontextprotocol/sdk from 1.28.0 to 1.29.0 (#758) (793300c)
- chore(deps): bump dotenv from 17.3.1 to 17.4.0 (#759) (9af4f29)
- chore(deps-dev): bump secretlint from 11.4.0 to 11.4.1 (#760) (9d1bc4d)
- chore(deps): bump lodash from 4.17.23 to 4.18.1 (#766) (c104059)
- chore(deps-dev): bump hono from 4.12.9 to 4.12.12 (#788) (2b904ac)
- chore(deps-dev): bump @hono/node-server from 1.19.11 to 1.19.13 (#789) (f6c8279)
- chore(deps): bump the aws-cdk group across 1 directory with 2 updates (#791) (7560634)
- chore(deps): bump the aws-sdk group across 1 directory with 15 updates (#793) (ecc3e4b)

## [0.7.1] - 2026-04-07

### Added
- feat: add custom dockerfile support for Container agent builds (#783) (cdd5a15)

### Fixed
- fix: make add command description consistent with remove (#773) (2eb9edb)

### Other Changes
- fix(ci): pin npm version to avoid self-upgrade corruption (#785) (9c10f2c)
- chore: bump version to 0.7.0 (#784) (a4f9948)
- feat(invoke,dev): add exec mode for running shell commands in runtimes (#750) (27ce2d0)
- feat(import): add evaluator and online eval config import subcommands (#780) (e266576)
- feat(create): add --skip-install flag to skip dependency installation (#782) (380ac6e)
- feat(status): display runtime invocation URL for deployed agents (#775) (0aa9d55)
- fix(fetch): add --identity-name option for custom credential lookup (#715) (#774) (a6bf024)
- chore(deps): bump vite from 8.0.3 to 8.0.5 (#777) (c9e5cfe)

## [0.7.0] - 2026-04-07

### Added
- feat: add custom dockerfile support for Container agent builds (#783) (cdd5a15)

### Fixed
- fix: make add command description consistent with remove (#773) (2eb9edb)

### Other Changes
- feat(invoke,dev): add exec mode for running shell commands in runtimes (#750) (27ce2d0)
- feat(import): add evaluator and online eval config import subcommands (#780) (e266576)
- feat(create): add --skip-install flag to skip dependency installation (#782) (380ac6e)
- feat(status): display runtime invocation URL for deployed agents (#775) (0aa9d55)
- fix(fetch): add --identity-name option for custom credential lookup (#715) (#774) (a6bf024)
- chore(deps): bump vite from 8.0.3 to 8.0.5 (#777) (c9e5cfe)

## [0.6.0] - 2026-04-02

### Added
- feat: add code-based evaluator support (#739) (11ca658)

### Other Changes
- ci: block schema changes in PRs (#712) (8119910)
- fix(ci): regenerate lockfile for npm 11 compatibility (#770) (ee7aea2)
- feat(import): add runtime and memory import subcommands with TUI wizard (#763) (cb79649)
- ci: use draft releases for PR tarballs to avoid notifying watchers (#745) (1a45c28)

## [0.5.1] - 2026-03-31

### Added
- feat: add e2e tests for dev server lifecycle (#734) (d3a3c23)

### Other Changes
- fix(eval): filter scopeless spans in CloudWatch query (#738) (7f4c1bb)

## [0.5.0] - 2026-03-30

### Added
- feat: add ground truth reference inputs for on-demand evaluation (#732) (01623ff)
- feat: bundle @aws/agentcore-cdk inside CLI tarball for testing (#731) (c9cc1f2)

### Other Changes
- chore: remove dead AutoGenRenderer code (#735) (cb09603)
- fix(tui): prevent screen flicker in policy creation flow (#730) (dbb9c00)
- fix(e2e): limit PR tests to Bedrock-only and improve credential cleanup (#728) (a5c2da9)
- feat(import): extract and pass through executionRoleArn from starter toolkit YAML (#729) (60b5946)

## @aws/agentcore v0.4.0

The AgentCore CLI is now generally available.

`npm i @aws/agentcore`

### What's included

- Agent lifecycle: `create`, `dev`, `deploy`, `invoke`, `status`, `logs`, `traces`
- Frameworks: Strands Agents, LangChain/LangGraph, Google ADK, OpenAI Agents, bring your own
- Gateway: Managed MCP servers with API Gateway, Lambda, and OpenAPI targets. OAuth, API key, and Custom JWT auth.
- Policy: Cedar-based access control for gateway tools
- Memory: Semantic, summarization, user preference, and episodic strategies
- Evaluations: LLM-as-a-Judge evaluators, on-demand and continuous online evaluation
- Local development: Hot-reload dev server supporting HTTP, MCP, and A2A protocols
- Infrastructure: CDK-managed deployments with VPC support, container builds, resource tagging, and `--dry-run` previews
- Migration: `agentcore import` migrates existing Starter Toolkit projects with zero downtime. See the [Migration Guide](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/MIGRATION.md).

### Breaking changes from preview

This release includes breaking changes that affect existing projects created during preview. See [aws/agentcore-cli#719](https://github.com/aws/agentcore-cli/issues/719) for a step-by-step guide on making the schema compatible.

### Summary of what changed:

- `agents` renamed to `runtimes` in `agentcore.json` and all CLI flags (`--agent` → `--runtime`, `-a` → `-r`)
- `mcp.json` merged into `agentcore.json`
- type field removed from agent, memory, and evaluator schemas. Credential type renamed to authorizerType
- `agentcore add identity` → `agentcore add credential`
- `agentcore run evals` → `agentcore run eval`
- `--force` → `--yes` for the remove command, `--plan` → `--dry-run`
- `agentcore dev --invoke "prompt"` → `agentcore dev "prompt"`
- Default Python runtime upgraded to 3.13

### Documentation

- [Commands reference](https://github.com/aws/agentcore-cli/blob/main/docs/commands.md)
- [Frameworks](https://github.com/aws/agentcore-cli/blob/main/docs/frameworks.md)
- [Configuration](https://github.com/aws/agentcore-cli/blob/main/docs/configuration.md)
- [Local development](https://github.com/aws/agentcore-cli/blob/main/docs/local-development.md)
- [Memory](https://github.com/aws/agentcore-cli/blob/main/docs/memory.md)
- [Gateway](https://github.com/aws/agentcore-cli/blob/main/docs/gateway.md)
- [Evaluations](https://github.com/aws/agentcore-cli/blob/main/docs/evals.md)
- [IAM permissions](https://github.com/aws/agentcore-cli/blob/main/docs/PERMISSIONS.md)
- [Migration from Starter Toolkit](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/MIGRATION.md)

## [0.4.0] - 2026-03-28

### Added
- feat: upgrade default Python runtime to PYTHON_3_13 (#658) (dfdc2cb)
- feat: show all CLI commands in TUI with / toggle (#635) (df80f90)
- feat: add semanticOverride support for SEMANTIC memory strategies (#678) (#696) (5e0f584)
- feat: inject $schema URL into generated agentcore.json (#692) (915125d)
- feat: add managedBy enum field to AgentCoreProjectSpec schema (#700) (c123d2f)
- feat: add JSON schema generation from Zod (#661) (2d02eeb)

### Fixed
- fix: standardize remove flags to -y/--yes and fix UX copy (#720) (1a3bddc)
- fix: remove dead --agents flag from agentcore add gateway (#711) (c1c41ca)
- fix: deprecate crewAI support (#704) (ac32563)
- fix: align name constraints with API docs (#701) (956c248)
- fix: support non-default runtime endpoint in on-demand evals (#634) (ec38020)
- fix: improve CLI UX — memory docs, standardize flags, fix deploy alias (#703) (9c7f143)
- fix: prevent region override for post-deploy commands (#595) (6b1cf79)

### Documentation
- docs: add IAM permissions guide and policy files (#689) (7a70cf4)

### Other Changes
- ci: format schemas after generation in release workflow (#721) (02de9f1)
- refactor: rename agents to runtimes (schema, CLI flags, MCP bindings) (#706) (d41e14b)
- feat(dev): positional prompt arg for invoking dev server (#707) (8898535)
- ci: regenerate JSON schema during release (#710) (e75e8a0)
- revert: remove CUSTOM strategy and semanticOverride support (#713) (6ff721e)
- refactor(schema): remove type fields from resource schemas and rename credential discriminator (#709) (48dadfd)
- feat(memory): add CUSTOM strategy type to agentcore-cli (#677) (#694) (beac707)
- ci: use AUTHORIZED_USERS for pr-tarball authorization (#642) (f5e1579)
- refactor(cli)!: unify naming without backward-compat aliases (#705) (5e55ea5)
- fix(cli): correct inaccurate --help text across all commands (#695) (9783cf7)
- fix(e2e): clean up stale credential providers before test runs (#698) (2f1d59f)
- chore(deps): bump handlebars from 4.7.8 to 4.7.9 (#691) (cb26199)

## [0.3.0-preview.9.0] - 2026-03-26

### Added
- feat: add runtime lifecycle configuration (idle timeout and max lifetime) (#653) (1ca0750)
- feat: add EPISODIC memory strategy support (#651) (247de18)
- feat: add agentcore import command for starter toolkit migration (#620) (2142c77)
- feat: runtime inbound auth (Custom JWT) for agents (#657) (0b743db)

### Fixed
- fix: use aws-opentelemetry-distro and add input/output logging for LangGraph agent (#552) (f24609f)
- fix: resolve picomatch high severity vulnerability (#663) (49e3d7c)

## [0.3.0-preview.8.0] - 2026-03-25

### Added
- feat: rename `run evals` command to `run eval` (#636) (408801a)
- feat: config-driven resource tagging (#625) (79a6a53)
- feat: add requestHeaderAllowlist support to CLI (#614) (55acc9b)

### Fixed
- fix: custom header support for invoke and dev commands (#652) (1066276)
- fix: pass requestHeaderAllowlist through create flow and fix tag command types (#643) (8a1af21)
- fix: move conflict check to postinstall and downgrade to warning (#640) (30b781f)
- fix: handle dot-prefixed directories in PATH fallback detection (#621) (73fdf72)
- fix: fix import from Bedrock Agents code generation bugs (#622) (32a543a)
- fix: add missing MCP fields to vended CDK test spec (#619) (8758f9b)

### Other Changes
- fix(gateway): add missing validation for custom JWT claim values (#644) (acd300d)
- ci: add global CLI install and CDK matrix to full e2e workflow (#639) (e1e2bbf)
- feat(gateway): add agentcore fetch access command (#627) (eda0f5d)
- test: add e2e test for evaluations lifecycle (#628) (ec3d007)
- test: add integ tests for evaluator and online-eval resource lifecycle (#626) (afaec4f)
- test: add post-deploy e2e tests for status, logs, and traces (#623) (87de38a)
- fix(gateway): write both CLIENT_ID and CLIENT_SECRET env vars for managed OAuth credentials (#617) (7c69105)
- ci: use packaged CLI tarball for e2e tests (#616) (6952584)
- feat(gateway): add custom claims validation and TUI wizard for JWT auth (#599) (b1c8a50)
- feat!: merge mcp.json into agentcore.json (#605) (23df9fe)
- ci: add cross-package e2e matrix testing against CDK constructs main (#610) (b941fbc)

## [0.3.0-preview.7.0] - 2026-03-23

**Note:** Policy currently has issues with asscoiating a policy engine with a gateway that has No Auth or IAM Auth.

### Added
- feat: add resource tagging support (#564) (dd9716c)
- feat: add import from Bedrock Agents to add agent and create flows (#563) (f0e1af7)
- feat: add policy engine and policy support (#579) (4da709b)
- feat: add advanced settings gate to agent creation wizard (#593) (0023284)

### Fixed
- fix: improve old CLI conflict detection in preinstall hook (#588) (a5cbc03)
- fix: add @aws-sdk/xml-builder override to resolve entity expansion limit (#601) (36f1ca2)

### Documentation
- docs: update CLI command reference with missing commands, options, and aliases (#581) (41b6c74)

### Other Changes
- Revert "feat: add resource tagging support (#564)" (#612) (b62ca3a)
- fix(tui): remove dead PlaceholderScreen and fix gateway wizard UX (#597) (8f44713)
- fix(gateway): harden inbound auth schema and rename credential flags (#598) (bf1406c)
- ci: run full e2e suite on every push to main (#585) (aec6102)
- ci: add package install sanity check to build-and-test (#590) (06fb886)
- ci: fix pr-tarball for fork PRs using pull_request_target (#586) (686dbee)

## [0.3.0-preview.6.1] - 2026-03-19

### Added
- feat: add PR tarball workflow with direct download link (#576) (c0aeaae)

### Fixed
- fix: align aws-cdk-lib peer dependency with @aws/agentcore-cdk ^2.243.0 (#582) (9dc4507)
- fix: bump fast-xml-parser override to 5.5.7 (CVE-2026-33036, CVE-2026-33349) (#577) (41570f0)

### Documentation
- docs: add evals documentation, update commands reference and configuration guide (#572) (df58b41)

### Other Changes
- feat(tui-harness): tui_action tool, bug fixes, SVG rendering (#575) (06ca9dd)
- feat(tui-harness): add SVG screenshots and HTTP transport (#571) (9d964d5)

## [0.3.0-preview.6.0] - 2026-03-19

### Added
- feat: introduce evaluation feature (#518) (d970e26)
- feat: add TUI agent harness with MCP server (#548) (c51b1e2)
- feat: dev and invoke support for MCP and A2A protocols (#554) (c2c646c)
- feat: unhide gateway and gateway-target CLI commands (#562) (5c8d1b4)
- feat: add protocol mode support (HTTP, MCP, A2A) (#550) (3aaa062)
- feat: add VPC network mode support (#545) (a61ebdd)

### Fixed
- fix: correct managed OAuth credential name lookup for gateway MCP clients (#543) (30e6a74)

### Other Changes
- Revert "chore: bump version to 0.3.0-preview.7.0 (#569)" (#573) (e1db6a5)
- chore: bump version to 0.3.0-preview.7.0 (#569) (3ef8c07)

## [0.3.0-preview.5.1] - 2026-03-12

### Added
- feat: add semantic search toggle for gateways (#533) (8d35d7f)

### Fixed
- fix: default srcDir to project root instead of non-existent src/ subdirectory (#530) (e954287)

### Documentation
- docs: add transaction search documentation and post-deploy note (#526) (3b6212a)

### Other Changes
- chore(deps-dev): bump lint-staged from 16.3.2 to 16.3.3 (#539) (5e64ea3)
- chore(deps): bump the aws-sdk group with 10 updates (#536) (e4a3bbe)
- chore(deps): bump the aws-cdk group with 2 updates (#537) (1dd60f6)
- chore(deps-dev): bump the dev-dependencies group with 6 updates (#538) (5bca680)
- ci: bump the github-actions group with 2 updates (#535) (50bff14)
- Add daily Slack notification for open PRs (#527) (f0dc82e)

## [0.3.0-preview.5.0] - 2026-03-09

### Added
- feat: add lambdaFunctionArn target type (#519) (fb6a4f7)
- feat: add OpenAPI and Smithy model gateway target types (#516) (0d1021d)
- feat: add API Key and No Auth support for API Gateway targets (#514) (763b937)
- feat: configurable transaction search index percentage (#513) (c5edfeb)
- feat: add API Gateway target TUI wizard and address review feedback (#511) (9ecf0fa)
- feat: enable CloudWatch Transaction Search on deploy (#506) (315df61)
- feat: add API Gateway REST API as new gateway target type (#509) (3b1df62)
- feat: revamp agentcore status command to show all resources status (#504) (96e6691)
- feat: add target type picker to gateway target wizard (#496) (#505) (b8bb758)
- feat: make container dev mode language-agnostic (#500) (a158ffb)

### Fixed
- fix: wire identity OAuth and gateway auth CLI options through to primitives (#522) (32064ee)
- fix: resolve schema paths relative to project root instead of agentcore/ (#523) (d4995cb)
- fix: centralize auth rules, consolidate TUI flows, and clarify schema paths (#521) (2059bd1)
- fix: conditionally show invoke in deploy next steps only when agents exist (#508) (baae06b)

### Documentation
- docs: update help text and docs for all gateway target types (#524) (a282d65)

## [0.3.0-preview.4.0] - 2026-03-05

## [0.3.0-preview.3.1] - 2026-03-05
Known Issue
For memory-only deployments, the agentcore status command printing out an error is a known bug for this release. We will follow up with a fix for the next release.
### Added
- feat: support individual memory deployment without agents (#483) (a75112e)
- feat: add `agentcore traces` command and trace link in invoke TUI (#493) (b10b2c7)
- feat: modular primitive architecture (#481) (0214f86)
- feat: add `logs` command for streaming and searching agent runtime logs (#486) (7302109)
- feat: add --diff flag to deploy command (#75) (#485) (3b4ee19)

### Fixed
- fix: hide logs and traces commands from TUI (#499) (125f83c)
- fix: prevent CI runs from cancelling each other on main (#492) (0d6fc31)
- fix: wire gateway-target CLI flags and default source to existing-endpoint (#488) (8c8b179)
- fix: resolve CI failures for security audit, PR title validation, and dependabot noise (#470) (5bf2192)
- fix: clear mcp.json gateways during remove-all to prevent orphaned AWS resources (#484) (d4aa281)
- fix: make CLI flag values case-insensitive (#413) (c1144e0)

### Documentation
- docs: show default time ranges in traces and logs --help (#497) (b852179)
- docs: add gateway documentation for commands, configuration, and local development (#474) (ec41be7)

### Other Changes
- ci: auto-run E2E tests for authorized team members (#495) (0eb359d)
- test: enable gateway test coverage (#487) (41365e4)
- ci: bump the github-actions group with 5 updates (#491) (48ebf23)

## [0.3.0-preview.3.0] - 2026-03-02

### Added
- feat: add npm cache ownership preflight check (#462) (f2942dd)
- feat: implement gateway integration (#472) (3cf1342)
- feat: add version-aware AWS CLI guidance to credential error messages (#452) (0e036a8)
- feat: support custom package index (UV_DEFAULT_INDEX) for Container builds (#453) (478fde8)
- feat: add VPC CLI flags to create and add commands [2/3] (#425) (c75f4cd)
- feat: add VPC info messages to dev and invoke commands [3/3] (#426) (7a81b02)
- feat: add VPC network mode to schema (#424) (4180646)
- feat: show version update notification on CLI startup (#380) (dd17167)

### Fixed
- fix: revert version to 0.3.0-preview.2.1 (accidentally bumped in #472) (#479) (f5cf41c)
- fix: drop wip and statuses write from PR title workflow (#476) (d5a7a3b)
- fix: add statuses write permission to PR title workflow (#475) (6d88468)
- fix: add .venv/bin to PATH in container Dockerfile (#471) (571a610)
- fix: prevent spurious agent startup in dev mode and remove tiktoken dep (#454) (ac62c4e)
- fix: resolve all npm audit vulnerabilities (#422) (33523a6)
- fix: container dev mode no longer assumes uv or bedrock_agentcore user (#433) (7c5b2f3)
- fix: disallow underscores in deployment target names and sanitize stack names (#412) (5f2fbda)
- fix: replace dead CDK test and update stale READMEs; enable strict tsconfig flags in vended CDK project (#379) (47da675)
- fix: handle unhandled promise rejection in vended CDK main() (#409) (ecaedf8)
- fix: surface Python errors during agentcore dev (#359) (c7eead8)
- fix: avoid DEP0190 warning when spawning subprocesses with shell mode (#360) (e1d1e9b)
- fix: e2e testing workflow with orphaned e2e deployments (#381) (c41b738)

### Other Changes
- chore: remove VPC feature from CLI (#466) (3e8a72f)
- chore: remove web-harness and update rollup to fix vulnerability (#463) (10272d2)
- chore: disable npm caching in release workflow (#460) (ca5644f)
- chore(deps): bump @aws-sdk/client-bedrock-agentcore from 3.993.0 to 3.995.0 (#398) (0b39e45)
- chore(deps-dev): bump dev-dependencies group with 4 updates (#386) (515785d)
- chore(deps): bump @aws-cdk/toolkit-lib from 1.15.1 to 1.16.0 (#388) (122bc65)
- chore(deps): bump @aws-sdk/credential-providers from 3.993.0 to 3.995.0 (#387) (f44e250)
- chore(deps): bump @smithy/shared-ini-file-loader from 4.4.3 to 4.4.4 (#393) (7806cd8)
- chore(deps): bump @aws-sdk/client-resource-groups-tagging-api from 3.993.0 to 3.995.0 (#397) (15b33b6)
- chore(deps): bump @aws-sdk/client-cloudformation from 3.993.0 to 3.995.0 (#399) (60f52d8)
- chore(deps): bump @aws-sdk/client-bedrock-runtime from 3.993.0 to 3.995.0 (#400) (0aa8a30)
- chore(deps-dev): bump typescript-eslint from 8.56.0 to 8.56.1 (#401) (d683b29)
- chore(deps): bump @aws-sdk/client-sts from 3.993.0 to 3.995.0 (#402) (21953a1)
- chore(deps-dev): bump @typescript-eslint/parser from 8.56.0 to 8.56.1 (#404) (7dad5d3)
- chore(deps): bump @aws-sdk/client-bedrock-agentcore-control from 3.993.0 to 3.995.0 (#403) (7741d44)
- ci: bump slackapi/slack-github-action from 2.0.0 to 2.1.1 (#394) (a267244)
- ci: bump actions/checkout from 4 to 6 (#391) (99d3f29)
- ci: bump actions/setup-node from 4 to 6 (#396) (81d1626)
- ci: bump actions/download-artifact from 4 to 7 (#392) (bce7bc6)
- ci: bump actions/cache from 4 to 5 (#389) (5424f89)
- chore: add Dependabot configuration (#372) (fd5c9a9)
- ci: add Slack notification workflow for new issues (#383) (53159e3)
- ci: add feat/gateway-integration branch to workflow triggers (#376) (bbfcdc4)
- chore: split e2e workflow into PR-focused and weekly full suite (#367) (fe1283a)

## [0.3.0-preview.2.1] - 2026-02-20

### Added
- feat: add docker container deployment e2e test for Strands/Bedrock (#362) (5de204a)

### Fixed
- fix: remove stale fast-xml-parser override, upgrade aws-cdk-lib (#368) (4a02d94)
- fix: correct path references and env var names in agent README templates (#364) (592af45)
- fix: use lockfile for reproducible builds and correct Dockerfile port comments (#365) (4da0591)
- fix: add package marker comment to __init__.py template files (#363) (993e695)
- fix: add mcp as explicit dependency in strands template (#366) (c6d0735)
- fix: add .env and .git exclusions to dockerignore template (#361) (df4eebc)
- fix: add --chown to Dockerfile COPY so app files are owned by bedrock_agentcore (#358) (be9b99b)
- fix: handle pre-release versions in compareVersions (#357) (6bf7a92)

### Other Changes
- Add pull_request_target trigger to CodeQL workflow (#355) (3d1231d)

## [0.3.0-preview.2.0] - 2026-02-19

### Added
- feat: add preview-major bump type (#353) (1824817)
- feat: strands review command (#326) (93ed835)
- feat: display model provider and default model throughout CLI (#324) (d97fa83)
- feat: add integration tests for CLI commands (#319) (2703683)

### Fixed
- fix: upgrade npm for OIDC trusted publishing (#350) (ec44120)
- fix: temporarily Disable security audit in pre-commit hook (#349) (cf1d564)
- fix: container dev now has a starting container status (#346) (3fc5d1f)
- fix: resolve lint warnings (#338) (8579540)
- fix: add missing __init__.py to Python template subpackages (#336) (ddb2a3a)
- fix: remove unused dependencies from Python template pyproject.toml files (#328) (7becb0c)
- fix: add .venv/ to gitignore templates and remove duplicate .env entry (#333) (f1c2f46)
- fix: override fast-xml-parser to 5.3.6 for CVE-2026-26278 (#330) (567fdef)
- fix: correct action path in agent-restricted workflow (#323) (73edf93)
- fix: remove mcp.ts from generated .llm-context folder (#310) (ffe6110)
- fix: add fallback URL for docs/memory.md link in unsupported terminals (#307) (#312) (5a1e0b4)
- fix: add explicit permissions to CI workflows (#309) (0c03dc4)
- fix: use npm Trusted Publishing (OIDC) in release workflow (#306) (56e8219)

### Documentation
- docs: update AGENTS.md and llm-context for container support (#348) (6d7572d)
- docs: add container build documentation (#340) (6ed4411)

### Other Changes
- all framework and models (#347) (166221e)
- ci: add PR size check and label workflow (#343) (43f5b27)
- ci: add PR title conventional commit validation (#344) (3be40ee)
- Add container deployment support for AgentCore Runtime (#334) (0a1574a)
- add check for kms key in token vault before create one (#339) (5a54555)
- test: add unit tests for TUI (#320) (aae1a9d)
- set pull request to use the main env, with the git commit of the incomming commit (#331) (3b925ed)
- chore: update supported frameworks to Strands Agents from Strands (#314) (66f3f91)
- ci: add CodeQL workflow for code scanning (#316) (ccad289)
- ci: add PR trigger with environment gate for e2e tests (#325) (772e0d3)
- add end to end tests (#322) (7c51a20)
- test: add unit tests across schema, lib, and cli modules (#318) (81cb70e)
- chore: add npm package metadata for search discoverability (#313) (5708c3f)

## [0.3.0-preview.1.0] - 2026-02-12

### Fixed
- fix: Reset package.json version (#303) (befa844)
- fix: Version Downgrade for release (#300) (f362f78)

### Other Changes
- Update npm publish command to include public access (#302) (c7a8263)
- chore: bump version to 0.3.0-preview.1.0 (#301) (4c5285e)
- correct package name (#297) (e8aba75)
- update readme (#296) (9718ad5)
- Switch from GitHub Packages to npm for publishing (#295) (cd0f976)
