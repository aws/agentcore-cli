# Changelog

All notable changes to this project will be documented in this file.

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
