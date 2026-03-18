/**
 * Generates pyproject.toml with conditional dependencies based on agent features and framework.
 */
import type { SDKFramework } from '../../../../schema';
import type { ImportedFeatures } from './base-translator';

const BASE_DEPS = ['pydantic>=2.0.0', 'python-dotenv>=1.1.0', 'boto3>=1.38.0', 'bedrock-agentcore>=0.0.8'];

const STRANDS_DEPS = ['strands-agents>=1.13.0', 'strands-agents-tools>=0.2.16'];

const LANGGRAPH_DEPS = [
  'langgraph>=1.0.2',
  'langchain>=1.0.3',
  'langchain_aws>=1.0.0',
  'langchain-mcp-adapters>=0.1.11',
  'tiktoken==0.11.0',
];

const MEMORY_DEPS = ['bedrock-agentcore[memory]>=0.0.8'];

export function generatePyprojectToml(agentName: string, framework: SDKFramework, features: ImportedFeatures): string {
  const deps = [...BASE_DEPS];

  if (framework === 'Strands') {
    deps.push(...STRANDS_DEPS);
  } else {
    deps.push(...LANGGRAPH_DEPS);
  }

  if (features.hasMemory) {
    // Replace base bedrock-agentcore with the [memory] extra variant
    const baseIdx = deps.findIndex(d => d.startsWith('bedrock-agentcore') && !d.includes('['));
    if (baseIdx !== -1) {
      deps[baseIdx] = MEMORY_DEPS[0]!;
    } else {
      deps.push(...MEMORY_DEPS);
    }
  }

  if (framework === 'LangChain_LangGraph' && features.hasKnowledgeBases) {
    // AmazonKnowledgeBasesRetriever is in langchain_aws, already included
  }

  // Deduplicate (keep first occurrence)
  const seen = new Set<string>();
  const uniqueDeps = deps.filter(d => {
    const name = d.split(/[>=<[]/)[0]!;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  const depsStr = uniqueDeps.map(d => `    "${d}",`).join('\n');

  return `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${agentName}"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
${depsStr}
]

[tool.hatch.build.targets.wheel]
packages = ["."]
`;
}
