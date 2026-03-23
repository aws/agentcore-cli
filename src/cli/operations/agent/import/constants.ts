/**
 * Constants for the Bedrock Agent import feature.
 */

export const BEDROCK_REGIONS = [
  { id: 'us-east-1', title: 'US East (N. Virginia)' },
  { id: 'us-west-2', title: 'US West (Oregon)' },
  { id: 'eu-west-1', title: 'Europe (Ireland)' },
  { id: 'eu-central-1', title: 'Europe (Frankfurt)' },
  { id: 'ap-southeast-1', title: 'Asia Pacific (Singapore)' },
  { id: 'ap-northeast-1', title: 'Asia Pacific (Tokyo)' },
  { id: 'ap-south-1', title: 'Asia Pacific (Mumbai)' },
  { id: 'ca-central-1', title: 'Canada (Central)' },
  { id: 'sa-east-1', title: 'South America (Sao Paulo)' },
] as const;

export const IMPORT_FRAMEWORK_OPTIONS = [
  { id: 'Strands', title: 'Strands Agents SDK', description: 'AWS native agent framework' },
  { id: 'LangChain_LangGraph', title: 'LangChain + LangGraph', description: 'Popular open-source frameworks' },
] as const;
