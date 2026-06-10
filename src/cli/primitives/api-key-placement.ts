import type { ApiKeyOutboundConfig } from '../../schema';

/** Raw placement inputs (from CLI flags or an imported AWS response). */
export interface ApiKeyPlacementInputs {
  location?: string;
  parameterName?: string;
  prefix?: string;
}

const DEFAULT_LOCATION = 'HEADER';
const DEFAULT_PARAMETER_NAME = 'x-api-key';

/**
 * Build the optional `apiKey` placement block for an API_KEY outbound auth.
 * Returns undefined when the inputs are empty or equal the CDK defaults
 * (HEADER / x-api-key / no prefix), so configs that don't customize placement
 * stay free of an apiKey block.
 */
export function buildApiKeyPlacement(inputs: ApiKeyPlacementInputs): ApiKeyOutboundConfig | undefined {
  const block: ApiKeyOutboundConfig = {};
  if (inputs.location && inputs.location !== DEFAULT_LOCATION) {
    block.location = inputs.location as ApiKeyOutboundConfig['location'];
  }
  if (inputs.parameterName && inputs.parameterName !== DEFAULT_PARAMETER_NAME) {
    block.parameterName = inputs.parameterName;
  }
  if (inputs.prefix) {
    block.prefix = inputs.prefix;
  }
  return Object.keys(block).length > 0 ? block : undefined;
}
