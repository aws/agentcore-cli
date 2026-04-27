import { Mode } from './common-shapes.js';
import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const MAX_ATTR_LENGTH = 64;

/**
 * Resource attributes attached to every metric datapoint.
 * Set once per session, not per-event.
 *
 * Constraints are intentionally strict to prevent PII leakage:
 * - IDs must be UUID format (no user-chosen strings)
 * - Version strings are pattern-constrained
 * - All free-text fields are length-bounded
 */
export const ResourceAttributesSchema = z.object({
  'service.name': z.literal('agentcore-cli'),
  'service.version': z.string().regex(SEMVER_PATTERN),
  'agentcore-cli.installation_id': z.string().regex(UUID_PATTERN),
  'agentcore-cli.session_id': z.string().regex(UUID_PATTERN),
  'agentcore-cli.mode': Mode,
  'os.type': z.string().min(1).max(MAX_ATTR_LENGTH),
  'os.version': z.string().min(1).max(MAX_ATTR_LENGTH),
  'host.arch': z.string().min(1).max(MAX_ATTR_LENGTH),
  'node.version': z.string().regex(NODE_VERSION_PATTERN),
});

export type ResourceAttributes = z.infer<typeof ResourceAttributesSchema>;
