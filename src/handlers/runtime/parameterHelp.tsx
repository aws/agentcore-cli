// Long-form help for the Runtime write parameters, rendered into the
// "Parameter details" section of `runtime create --help` and
// `runtime update --help` (see router/flags.tsx/formatParameterDetails).
// Modeled on the harness help (harness/parameterHelp.tsx) and the AWS CLI's
// `aws bedrock-agentcore-control create-agent-runtime` help.

export const NOT_PROJECT_MANAGED = `These Runtimes are not part of an AgentCore project:
agentcore deploy, status, and remove do not track them. Manage them with
agentcore runtime update and delete.`;

export const runtimeParameterHelp = {
  name: `(string)
The name of the Runtime. Must start with a letter and contain only
alphanumeric characters and underscores.

${NOT_PROJECT_MANAGED}

Pattern: [a-zA-Z][a-zA-Z0-9_]{0,47}`,

  runtime: `(string)
The Runtime to change: its name, its ID (<name>-<10 characters>), or its ARN.
A name is looked up with ListAgentRuntimes in the selected region; an ARN
selects its own region.

${NOT_PROJECT_MANAGED}

Example:
  --runtime my_agent`,

  containerUri: `(string)
A pre-built Linux ARM64 container image in Amazon ECR: a private repository
(<account>.dkr.ecr.<region>.amazonaws.com/<repository>[:tag][@digest]) or
public.ecr.aws/<repository>[:tag][@digest]. The CLI does not build or push
images.

Example:
  --container-uri 123456789012.dkr.ecr.us-west-2.amazonaws.com/my-agent:v1`,

  executionRoleArn: `(string)
The ARN of the IAM role the Runtime assumes. The role must trust
bedrock-agentcore.amazonaws.com and allow everything the agent calls.

When omitted, the CLI creates (or reuses) a role named AgentCoreRuntime-<name>,
tagged agentcore:created-by=agentcore-cli, that can only pull the image from
its one ECR repository and write the Runtime's CloudWatch logs. Agents that
call models, memory, gateways, or other AWS services need their own role.

Example:
  --execution-role-arn arn:aws:iam::123456789012:role/MyRuntimeRole`,

  protocol: `(string)
The protocol the container serves: HTTP (default; POST /invocations and
GET /ping on port 8080), MCP (port 8000), A2A (port 9000), or AGUI.`,

  environmentVariables: `(JSON: map of string to string)
Environment variables set in the Runtime. On update, the given map replaces
all existing variables.

Example:
  --environment-variables '{"LOG_LEVEL":"debug"}'`,

  networkConfig: `(JSON object)
The VPC to run in, with --network-mode VPC.

JSON syntax:
  {
    "subnets": ["string", ...],         // [required] subnet IDs
    "securityGroups": ["string", ...]   // [required] security group IDs
  }

Example:
  --network-mode VPC --network-config '{"subnets":["subnet-0123456789abcdef0"],"securityGroups":["sg-0123456789abcdef0"]}'`,

  authorizerConfiguration: `(JSON: tagged union object)
Inbound authorization for incoming requests. Only top-level key:
customJWTAuthorizer. When omitted, callers authenticate with AWS IAM.

JSON syntax:
  {
    "customJWTAuthorizer": {
      "discoveryUrl": "string",         // [required] .../.well-known/
                                        // openid-configuration URL
      "allowedAudience": ["string", ...],
      "allowedClients": ["string", ...]
    }
  }`,

  lifecycleConfiguration: `(JSON object)
Session lifetime limits, in seconds.

JSON syntax:
  {
    "idleRuntimeSessionTimeout": integer, // idle time before a session ends
    "maxLifetime": integer                // maximum session lifetime
  }

Example:
  --lifecycle-configuration '{"idleRuntimeSessionTimeout":900,"maxLifetime":28800}'`,
};
