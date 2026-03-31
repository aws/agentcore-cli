# TODO

## Import Command

- [ ] **Entrypoint detection: fail instead of silent fallback**
  - Currently `extractEntrypoint()` in `import-runtime.ts` silently falls back to `main.py` if it can't determine the
    entrypoint from the API's modified `entryPoint` array.
  - Change: fail with a clear error message if auto-detection fails and `--entrypoint` was not provided.
  - Add `--entrypoint <file>` flag to `import runtime` subcommand so users can specify it manually.
  - Error message:
    `Could not determine entrypoint from runtime configuration. Please re-run with --entrypoint <file> to specify it manually.`

- [ ] **Investigate CFN Phase 2 HandlerInternalFailure for runtime import**
  - Phase 2 IMPORT change set fails with `HandlerInternalFailure` for `AWS::BedrockAgentCore::Runtime`.
  - Note: the execution role ARN is already being passed through correctly (`import-runtime.ts:61-62` sets
    `executionRoleArn` from the API's `roleArn`), so the failure is likely not a role mismatch.
  - The handler may not fully support the IMPORT operation, or there are other property mismatches beyond the role.
  - Needs further investigation with the service team to understand what properties the handler is failing to reconcile.
  - Workaround: `agentcore deploy` after import reconciles everything via UPDATE.
