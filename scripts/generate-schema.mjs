/**
 * Generates JSON Schema from the AgentCoreProjectSpec Zod schema.
 * Runs against the compiled dist/ output — must be run after build:lib.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMA_VERSION = 'v1';

const outPath = join(__dirname, '..', 'schemas', `agentcore.schema.${SCHEMA_VERSION}.json`);

const z = await import('zod');
const { AgentCoreProjectSpecSchema } = await import('../dist/schema/schemas/agentcore-project.js');

const schema = z.toJSONSchema(AgentCoreProjectSpecSchema, { target: 'draft-07' });

// Allow $schema field alongside the strict properties
schema.properties.$schema = { type: 'string' };

// Fields with defaults should not be required — Zod's toJSONSchema marks them required anyway
if (schema.required && schema.properties) {
  schema.required = schema.required.filter(field => !('default' in schema.properties[field]));
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n');
console.log(`Schema written to ${outPath}`);
