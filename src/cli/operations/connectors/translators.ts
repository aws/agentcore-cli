/**
 * Connector translators: convert validated CLI inputs into the configurations[]
 * array expected by the on-disk schema (which mirrors the CFN wire format).
 *
 * Each connector exposes one or more operations (e.g. "Retrieve", "AgenticRetrieveStream",
 * "WebSearch"). The translator produces a configuration entry per operation.
 */

export interface ConfigurationEntry {
  name: string;
  description: string;
  parameterValues: Record<string, unknown>;
  parameterOverrides: ParameterOverride[];
}

export interface ParameterOverride {
  path: string;
  description?: string;
  visible?: boolean;
}

export interface WebSearchTranslatorInput {
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface KnowledgeBasesTranslatorInput {
  knowledgeBaseId: string;
}

export type ConnectorTranslatorInput =
  | { connectorId: 'web-search'; input: WebSearchTranslatorInput }
  | { connectorId: 'bedrock-knowledge-bases'; input: KnowledgeBasesTranslatorInput };

function translateWebSearch(input: WebSearchTranslatorInput): ConfigurationEntry[] {
  const parameterValues: Record<string, unknown> = {};

  // Both lists go in one domainFilter, since that is how the connector reads them.
  // An empty list is not the same request as an absent one, so empty is left out.
  const domainFilter: { include?: string[]; exclude?: string[] } = {};
  if (input.includeDomains && input.includeDomains.length > 0) {
    domainFilter.include = input.includeDomains;
  }
  if (input.excludeDomains && input.excludeDomains.length > 0) {
    domainFilter.exclude = input.excludeDomains;
  }
  if (Object.keys(domainFilter).length > 0) {
    parameterValues.domainFilter = domainFilter;
  }

  return [{ name: 'WebSearch', description: '', parameterValues, parameterOverrides: [] }];
}

function translateKnowledgeBases(input: KnowledgeBasesTranslatorInput): ConfigurationEntry[] {
  return [
    {
      name: 'AgenticRetrieveStream',
      description:
        'Streaming endpoint for agentic retrieval from knowledge bases. Performs multi-step retrieval with planning and returns results as a stream of events.',
      parameterValues: {
        retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: input.knowledgeBaseId } } }],
        agenticRetrieveConfiguration: { foundationModelType: 'MANAGED', rerankingModelType: 'MANAGED' },
      },
      parameterOverrides: [],
    },
    {
      name: 'Retrieve',
      description: 'Queries a knowledge base and retrieves information from it.',
      parameterValues: { knowledgeBaseId: input.knowledgeBaseId },
      parameterOverrides: [],
    },
  ];
}

export function translateConnector(args: ConnectorTranslatorInput): ConfigurationEntry[] {
  switch (args.connectorId) {
    case 'web-search':
      return translateWebSearch(args.input);
    case 'bedrock-knowledge-bases':
      return translateKnowledgeBases(args.input);
  }
}
