export const EXPORT_NOTES_FILENAME = 'EXPORT_NOTES.md';

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export const EXTERNAL_GATEWAY_NOTE_CATEGORY = 'External gateway ARNs hardcoded';
export const MEMORY_ARN_NOTE_CATEGORY = 'Memory ARN requires IAM policy';
export const CONTAINER_URI_NOTE_CATEGORY = 'containerUri: verify Python in base image';
export const CUSTOM_DOCKERFILE_NOTE_CATEGORY = 'Custom harness Dockerfile needs the agent build layer';
export const CONTAINER_URI_ECR_PULL_NOTE_CATEGORY = 'containerUri base image requires ECR pull permission';
export const ALLOWED_TOOLS_NOTE_CATEGORY = 'allowedTools: per-invocation overrides dropped';
export const PATH_SKILLS_NOTE_CATEGORY = 'path skills require container filesystem';
export const MCP_HEADER_CREDS_NOTE_CATEGORY = 'MCP tool header credentials';
export const GIT_SKILLS_CONTAINER_NOTE_CATEGORY = 'git skills require git in container image';
export const GATEWAY_IAM_POLICY_NOTE_CATEGORY = 'Gateway requires InvokeGateway IAM permission';
export const BROWSER_IAM_POLICY_NOTE_CATEGORY = 'Browser tool requires IAM permissions';
export const BROWSER_CODZIP_NOTE_CATEGORY = 'Browser tool requires Container build — excluded from CodeZip export';
export const CODE_INTERPRETER_IAM_POLICY_NOTE_CATEGORY = 'Code interpreter tool requires IAM permissions';
export const AWS_SKILLS_NOTE_CATEGORY = 'AWS skills omitted — not available outside managed harness';
export const S3_SKILLS_IAM_POLICY_NOTE_CATEGORY = 'S3 skills require S3 read IAM permission';
