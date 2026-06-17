import { type GuardrailCategoryType, type GuardrailFormConfig, defaultDataPathForEffect } from './types';

const GUARDRAIL_FUNCTION_MAP: Record<GuardrailCategoryType, string> = {
  contentFilter: 'BedrockGuardrails::ContentFilter',
  promptAttack: 'BedrockGuardrails::PromptAttack',
  sensitiveInformation: 'BedrockGuardrails::SensitiveInformation',
};

// Default thresholds per category type
const DEFAULT_THRESHOLDS: Record<GuardrailCategoryType, number> = {
  contentFilter: 0.2,
  promptAttack: 0.4,
  sensitiveInformation: 0.2,
};

/**
 * Synthesize a Cedar policy from a guardrail form config.
 *
 * Single filter:  ...["FILTER"].confidenceScore.greaterThan(decimal("0.4"))
 * Multiple filters (forbid/suppressOutput): ...maxConfidenceScore().greaterThan(decimal("0.4"))
 * Multiple filters (permit): ...maxConfidenceScore().lessThanOrEqual(decimal("0.4"))
 *
 * `suppressOutput` is an output-phase forbid: it evaluates `context.output.*` and
 * blocks the model response when the score exceeds the threshold (greaterThan),
 * so it shares forbid's comparator but defaults to an output data path.
 */
export interface SynthesizeCedarOptions {
  targetName?: string;
  gatewayArn?: string;
}

export function synthesizeCedar(form: GuardrailFormConfig, options: SynthesizeCedarOptions = {}): string {
  if (!form.category || form.filters.length === 0) {
    return '// No guardrail rules configured';
  }

  const { targetName, gatewayArn } = options;
  const fn = GUARDRAIL_FUNCTION_MAP[form.category];
  const gwRef = gatewayArn ? `resource == AgentCore::Gateway::"${gatewayArn}"` : 'resource is AgentCore::Gateway';
  const actionRef = targetName ? `action == AgentCore::Action::"${targetName}___POST:/invocations"` : 'action';
  const dataPath = form.dataPath || defaultDataPathForEffect(form.effect);
  const threshold = DEFAULT_THRESHOLDS[form.category];
  // permit allows below threshold; forbid and suppressOutput block above it.
  const comparator = form.effect === 'permit' ? 'lessThanOrEqual' : 'greaterThan';
  const filterList = `[${form.filters.map(f => `"${f}"`).join(', ')}]`;

  let scoreExpr: string;
  if (form.filters.length === 1) {
    scoreExpr = `["${form.filters[0]}"].confidenceScore`;
  } else {
    scoreExpr = '.maxConfidenceScore()';
  }

  return (
    `${form.effect} (principal, ${actionRef}, ${gwRef})\n` +
    `when guardrails { ${fn}(${filterList}, [${dataPath}])${scoreExpr}.${comparator}(decimal("${threshold.toFixed(1)}")) };`
  );
}
