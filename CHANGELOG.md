# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0-preview.2] - 2026-04-23

### Added
- feat: upgrade agent inspector to 0.2.1 (#937) (b49a06f)
- feat: remove deployed/local from status legend (#936) (c0d5b7b)
- feat: add GovCloud multi-partition support (#908) (098b104)

### Fixed
- fix: update asset snapshots after version revert (c8ea8b4)
- fix: use dnsSuffix() for multi-partition endpoint support (07b7430)
- fix: preserve harness deployed state on early deploy errors (#933) (c1c92f6)
- fix: build and push Dockerfile for harnesses on deploy (#927) (#929) (3cec11c)

### Other Changes
- Revert "chore: bump version to 1.0.0-preview.2 (#939)" (4a90975)
- chore: bump version to 1.0.0-preview.2 (#939) (502e089)
- Merge remote-tracking branch 'origin/main' into preview (69dbc79)
- fix(deploy): honor aws-targets.json region for all SDK and CDK calls (#925) (1903f7d)

## [1.0.0-preview.1] - 2026-04-22

### Added
- feat: upgrade @aws/agentinspector to 0.2.0 (#919) (35ec0c1)
- feat: support preview releases from feature branches (#905) (1a93f92)
- feat: add AG-UI (AGUI) as fourth first-class protocol mode (#858) (52144dc)
- feat: remove inline_function tool approval — all tools execute automatically (#119) (06deb79)
- feat: make update command aware of preview dist-tag (#118) (b8691c3)
- feat: add Custom JWT inbound auth support for harnesses (#109) (54b3f4e)
- feat: skip deploy when project config unchanged (#111) (fc764a6)
- feat: add --with-invoke-script and tools in TUI wizard (#105) (25466d3)
- feat: auto-deploy resources before dev server starts (#101) (202b7e9)
- feat: add session storage support for harnesses (#102) (c1d97f8)
- feat: add tool management commands for harnesses (#100) (26ea7b1)
- feat: add --harness support to traces and logs commands (#98) (765f9d5)
- feat: display harnesses in status screen (#96) (7a5305c)
- feat: add session filesystem storage support (#893) (b97e337)
- feat: add container support to harness create/add (#93) (10d8dd8)
- feat: add harness validation to validate command (#91) (08e4f2f)
- feat: add harness invoke support to CLI and TUI (#89) (c87c8af)
- feat: harness create/add with deploy and bug fixes (#90) (e77dc2d)
- feat: harness deploy support (#87) (cf762bd)
- feat: add shared SigV4 API client and Harness HTTP operations (#84) (89fed85)
- feat: add sync workflow (d15ce2e)

### Fixed
- fix: update asset snapshots and fix useDevDeploy skip test (#921) (1bde086)
- fix: use nullish coalescing operator in CreateScreen (#918) (e850c9e)
- fix: revert vended CDK dep to ^0.1.0-alpha.19 (#910) (34b41e7)
- fix: show tools in harness review screen and wire up invoke --tools (#127) (7889e84)
- fix: align harness networkConfiguration with Smithy model (#126) (5f6f98c)
- fix: align harness model config with Smithy API and add invoke overrides (#122) (34b7639)
- fix: harness bug bash fixes — status duplicate, provider names, session storage, fetch access (#123) (3115e02)
- fix: avoid double JSON parse in harness invocation, extract parseToolResponseRequest (#125) (969cfe6)
- fix: add deploy hash check to CLI deploy path (#120) (4fe3ab7)
- fix: harness add bugs - no deploy, project name prefix, interactive mode (#116) (1c74d43)
- fix: auto-populate aws-targets.json on dev deploy (#117) (df03fe5)
- fix: harness TUI copy and usability improvements (#113) (ddfbfdb)
- fix: add harness to TUI remove flow and CLI status output (#112) (5d625a5)
- fix: TUI deploy not persisting deployed state (#110) (c2e206e)
- fix: add default memory strategies to harness memory creation (#108) (d9d1f81)
- fix: agentcore add component opens component wizard directly (#896) (74a35cb)
- fix: harness deploy bugfixes and model update (#99) (47882d0)
- fix: propagate sessionId as A2A contextId in Inspector proxy (#892) (08d452e)
- fix: make harnesses field optional in AgentCoreProjectSpec (#86) (62c432c)
- fix: codeql permissions (05258f3)
- fix: only sync to main branch (2acb841)
- fix: formatting (7d35986)

### Documentation
- docs: add harness documentation and fix inline_function help text (#124) (1a1de9b)
- docs: update vended AGENTS.md, README.md, and llm-context references (#898) (84a6dde)

### Other Changes
- Revert "chore: bump version to 1.0.0-preview.1.0 (#922)" (454967a)
- chore: merge main into feat/harness-implementation (b28a542)
- chore: bump version to 1.0.0-preview.1.0 (#922) (05570b9)
- fix(invoke): show full session ID and print resume command on exit (#904) (ce683c0)
- chore: bump version to 1.0.0-preview.0 and pin agentcore-cdk to alpha.20 (#128) (2c42299)
- Move Memory out of Advanced settings in harness wizard (#121) (5917220)
- removing bad files (971004c)
- fix(tui): polish harness wizard ordering, help text, and summary (#115) (dd2c8b1)
- avi harness progress (#114) (aa4e8b9)
- chore: remove preview bump type from release workflow (#847) (13f16d3)
- chore: remove single-commit-must-match-PR-title validation (#897) (4d7da2f)
- Merge origin/feat/harness-implementation and fix eslint errors (2ea3b6b)
- Merge remote-tracking branch 'origin/main' into feat/harness-implementation (5046f61)
- chore: sync main with public/main (7e836e4)
- fix(invoke): pass session ID to local invoke log files (#894) (e966cb6)
- chore(schema): regenerate JSON schema with harnesses registry (902c95c)
- feat(schema): add harnesses[] registry to AgentCoreProjectSpec (9eab540)
- chore: sync main with public/main (49932f2)
- feat(schema): add Harness primitive schema definitions (#85) (9151a14)
- chore: sync main with public/main (c5e80ca)
- chore: sync main with public/main (d3ad7f8)
- chore: sync main with public/main (874814a)
- chore: sync main with public/main (7877ead)
- chore: sync main with public/main (eeb444c)
- chore: sync main with public/main (ff86dc1)
- chore: sync main with public/main (50b389a)
- chore: sync main with public/main (b1f9711)
- chore: sync main with public/main (5d4bd38)
- chore: sync main with public/main (e9ab06e)
- chore: sync main with public/main (08872f5)
- chore: sync main with public/main v0.8.0 (63e05fd)
- chore: sync main with public/main (493e1f9)
- chore: sync main with public/main (5af06f5)
- chore: sync main with public/main (832a5c3)
- chore: sync main with public/main (584fd0e)
- fix(ci): exclude .github/workflows/ from public repo sync (#54) (37a0ff8)
- Merge remote-tracking branch 'public/main' (d3f6c81)
- chore: sync main with public/main (c2121ec)
- chore: sync main with public/main (d0c495f)
- chore: sync main with public/main (93d7bbc)
- chore: sync main with public/main (cfd1cdb)
- Merge remote-tracking branch 'origin/main' (ee71ff3)
- chore: sync main with public/main (4c2c674)
- chore: sync main with public/main (1d64fd8)
- chore: sync main with public/main (11ec86e)
- chore: sync main with public/main (6054e95)
- chore: sync main with public/main (cc83d81)
- chore: sync main with public/main (1a361af)
- Merge remote-tracking branch 'public/main' (c2bef91)
- chore: sync main with public/main (c6099d4)
- Merge pull request #1 from aws/aalpert/workflow (216140f)

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
