# Changelog

All notable changes to this project will be documented in this file.

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
