# JSON Schema

This directory contains the JSON Schema for `agentcore.json`, generated from the Zod schemas in `src/schema/`.

## Updating the schema

```bash
npm run build:lib
npm run build:schema
```

This regenerates `schemas/agentcore.schema.v1.json` from the compiled Zod schemas. Commit the updated file.

## Versioning

- `agentcore.schema.v1.json` — backwards-compatible updates only (new optional fields)
- Create `agentcore.schema.v2.json` only for breaking changes (removed/renamed fields)

### Creating a new major version

1. Update `SCHEMA_VERSION` in `scripts/generate-schema.mjs`
2. Run `npm run build:lib && npm run build:schema`
3. Commit the new schema file — keep the old version for existing projects

## Compatibility

Tag patterns use Unicode property escapes (`\p{L}`, `\p{N}`) which require a JS-based regex engine. This works in VS
Code and other JS-powered validators but may fail in Python, Go, or Java < 9.

## Limitations

The JSON Schema is a best-effort projection of the Zod schemas in `src/schema/`. Zod is the source of truth and is more
expressive (e.g. cross-field refinements, custom validators). Passing JSON Schema validation does not guarantee the CLI
will accept the config.
