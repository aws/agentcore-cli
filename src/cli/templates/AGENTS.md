## AgentCore Templates Rendering

This directory contains the **rendering logic** for template processing.

Template **assets** live in the `assets/` directory at the repository root.

The rendering logic is rooted in the `AgentEnvSpec` and must ALWAYS respect the configuration in the Spec.

### Rendering Pipeline

1. `createRenderer()` selects a renderer based on framework/language
2. `BaseRenderer.render()` copies and renders the framework base template
3. If `hasMemory`, capability templates are layered on top
4. If `buildType === 'Container'`, the container templates (`Dockerfile`, `.dockerignore`) from
   `assets/container/<language>/` are copied into the agent directory

### LLM Context Files

`schema-assets.ts` imports llm-compacted TypeScript files that are embedded at build time via the esbuild text-loader
plugin. `CDKRenderer.writeLlmContext()` writes these to `agentcore/.llm-context/` during project initialization.

## Guidance for template changes

- Always make sure the templates are as close to working code as possible
- AVOID as much as possible using any conditionals within the templates

## How to use the code in this directory

- `index.ts` exports a `createRenderer` method that consumes an `AgentEnvSpec`
- This method picks the appropriate renderer; the caller only needs to call the `render` method
- `templateRoot.ts` exports `getTemplatePath` and `TEMPLATE_ROOT` to locate assets
