# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0-preview1.1] - 2026-02-11

### Added
- feat: add release workflow for GitHub Packages (#279) (8a4e54e)
- feat: use aws-opentelemetry-distro in Strands and OpenAIAgents templates (#273) (b6f2d83)
- feat: add conversation history to invoke TUI (#268) (e135c50)
- feat: deprecate destroy and introduce remove all + deploy teardown flow (#265) (3008c84)

### Fixed
- fix: exclude CHANGELOG.md from prettier and improve generation (#281) (ca9a031)
- fix: broken test that fails CI launch test for CI environment (#271) (8a1a814)
- fix: include APP_DIR in agent path for TUI add agent venv setup (#272) (1a79c46)
- fix: align command descriptions in TUI help screen (#269) (de051b6)
- fix: remove CUSTOM memory strategy temporarily (#235) (#266) (b2fc32b)
- fix: remove AccessDenied from expired token error codes (#263) (ba1158c)
- fix: add default namespaces to memory strategies (#259) (9aefe95)
- fix: hide help command from TUI command list (#260) (fe64ecc)

### Documentation
- docs: update readme, agents.md and docs folder (#280) (c76fc6c)

### Other Changes
- chore: remove unused static/strands-bedrock directory (#278) (0d54a45)
- update readme structure (#276) (f9a609b)
- Release 0.3.0-preview1.0 (#277) (d179b6d)
- add migration path to readme roadmap (#275) (b6a51ca)
- Remove target mcp jsons (#267) (35a01ea)
- Fix agentcore create launching CLI instead of TUI (#270) (6b77bf7)
- chore: improve documentation (#232) (9e60442)
