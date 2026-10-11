# Vendored v0 project schemas

Frozen copy of `src/schema` from [aws/agentcore-cli@v0.31.1](https://github.com/aws/agentcore-cli/tree/v0.31.1/src/schema)
(tests and `llm-compacted/` omitted; `index.ts` replaced with a narrow, renamed export surface).

These schemas read unmigrated v0 projects (`agentcore.json` with `version: 1`) for
compatibility mode and `agentcore migrate`. Do not edit or reformat them: the contract is
"anything v0 0.31.1 accepted is accepted here", and keeping the files byte-identical keeps
them diffable against upstream. Lint and Prettier ignore this directory.
