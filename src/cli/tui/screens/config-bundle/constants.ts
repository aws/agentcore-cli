// ─────────────────────────────────────────────────────────────────────────────
// Config Bundle Wizard Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service/CFN key pattern for a config-bundle component identifier. Mirrors
 * `aws-bedrockagentcore-configurationbundle.json` `Components.patternProperties`.
 * Any ARN qualifies, but an `arn:` prefix is NOT required — the service accepts
 * any pattern-valid string (max 2048 chars). Rejects `{{...}}` placeholders,
 * spaces, and over-length input — exactly what CloudFormation rejects.
 */
export const COMPONENT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_:/.-]{0,2047}$/;

/** Inline error shown when a custom component identifier fails {@link COMPONENT_KEY_PATTERN}. */
export const COMPONENT_KEY_ERROR = 'Must be a valid component identifier (an ARN, max 2048 chars).';
