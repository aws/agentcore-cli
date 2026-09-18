// Long-form help for the harness write parameters, rendered into the
// "Parameter details" section of `harness create --help` and
// `harness update --help` (see router/flags.tsx/formatParameterDetails).
//
// The content is modeled on the AWS CLI's generated help for
// `aws bedrock-agentcore-control create-harness`: a type annotation (the first
// line, shown next to the flag name), prose, the JSON syntax of the value, and
// a copy-pasteable example. Fields marked [required] are required within their
// enclosing object, not on the command line.

export const parameterHelp = {
  model: `(JSON: tagged union object)
The model configuration for the harness. Supports Amazon Bedrock, OpenAI,
Google Gemini, and LiteLLM providers. Exactly one of the following top-level
keys can be set: bedrockModelConfig, openAiModelConfig, geminiModelConfig,
liteLlmModelConfig. When omitted, the service default model is used.

JSON syntax:
  {
    "bedrockModelConfig": {
      "modelId": "string",              // [required] Bedrock model ID
      "maxTokens": integer,             // per model call, min 1
      "temperature": float,             // 0.0 - 2.0
      "topP": float,                    // 0.0 - 1.0
      "apiFormat": "converse_stream" | "responses" | "chat_completions",
      "additionalParams": {...}         // passed through to the provider
    },
    "openAiModelConfig": {
      "modelId": "string",              // [required]
      "apiKeyArn": "string",            // [required] AgentCore Identity
                                        // API-key credential-provider ARN
      "maxTokens": integer,
      "temperature": float,
      "topP": float,
      "apiFormat": "chat_completions" | "responses",
      "additionalParams": {...}
    },
    "geminiModelConfig": {
      "modelId": "string",              // [required]
      "apiKeyArn": "string",            // [required]
      "maxTokens": integer,
      "temperature": float,
      "topP": float,
      "topK": integer                   // 0 - 500
    },
    "liteLlmModelConfig": {
      "modelId": "string",              // [required] e.g. "anthropic/..."
      "apiKeyArn": "string",
      "apiBase": "string",              // provider API base URL
      "maxTokens": integer,
      "temperature": float,
      "topP": float,
      "additionalParams": {...}
    }
  }

Example:
  --model '{"bedrockModelConfig":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}}'`,

  tools: `(JSON: list of objects)
The tools available to the agent: remote MCP servers, AgentCore Gateway,
AgentCore Browser, Code Interpreter, or inline functions. Each entry's
"config" is a tagged union whose single key matches the entry's "type".

JSON syntax:
  [
    {
      "type": "remote_mcp" | "agentcore_browser" | "agentcore_gateway"
            | "inline_function" | "agentcore_code_interpreter",  // [required]
      "name": "string",                 // unique; inferred when omitted
      "config": {
        "remoteMcp": {
          "url": "string",              // [required] MCP endpoint URL
          "headers": {"string": "string", ...}
        },
        "agentCoreBrowser": {
          "browserArn": "string"        // omit to use the built-in Browser
        },
        "agentCoreGateway": {
          "gatewayArn": "string",       // [required]
          "outboundAuth": {             // defaults to awsIam when omitted
            "awsIam": {},
            "none": {},
            "oauth": {
              "providerArn": "string",  // [required]
              "scopes": ["string", ...],
              "customParameters": {"string": "string", ...},
              "grantType": "CLIENT_CREDENTIALS" | "AUTHORIZATION_CODE"
                         | "TOKEN_EXCHANGE",
              "defaultReturnUrl": "string"
            }
          }
        },
        "inlineFunction": {
          "description": "string",      // [required] shown to the model
          "inputSchema": {...}          // [required] JSON Schema
        },
        "agentCoreCodeInterpreter": {
          "codeInterpreterArn": "string" // omit to use the built-in one
        }
      }
    },
    ...
  ]

Example:
  --tools '[{"type":"agentcore_browser","config":{"agentCoreBrowser":{}}},{"type":"remote_mcp","config":{"remoteMcp":{"url":"https://mcp.example.com/sse"}}}]'`,

  skills: `(JSON: list of tagged union objects)
The skills available to the agent — bundles of files the agent can pull into
its context on demand. Each entry sets exactly one of: path, s3, git,
awsSkills.

JSON syntax:
  [
    {
      "path": "string",                 // filesystem path to the skill
      "s3": {
        "uri": "string"                 // [required] e.g. s3://bucket/skill/
      },
      "git": {
        "url": "string",                // [required] HTTPS repository URL
        "path": "string",               // subdirectory within the repo
        "auth": {
          "credentialArn": "string",    // [required] AgentCore Identity ARN
          "username": "string"          // defaults to "oauth2"
        }
      },
      "awsSkills": {
        "paths": ["string", ...]        // glob filters, e.g. "core-skills/*"
      }
    },
    ...
  ]

Example:
  --skills '[{"s3":{"uri":"s3://my-bucket/skills/reviewer/"}}]'`,

  allowedTools: `(list of strings)
The tools the agent is allowed to use. Supports glob patterns: * for all
tools, @builtin for all built-in tools, or @serverName/toolName for a
specific MCP server tool. Pass one or more space-separated patterns.

Example:
  --allowed-tools '@builtin' '@my-server/search'`,

  memory: `(JSON: tagged union object)
The AgentCore Memory configuration for persisting conversation context
across sessions. Exactly one of the following top-level keys can be set:
managedMemoryConfiguration (the service creates and manages a memory
resource), agentCoreMemoryConfiguration (bring your own), disabled.

JSON syntax:
  {
    "managedMemoryConfiguration": {
      "strategies": ["SEMANTIC" | "SUMMARIZATION" | "USER_PREFERENCE"
                   | "EPISODIC", ...],  // defaults to SEMANTIC+SUMMARIZATION
      "eventExpiryDuration": integer,   // retention in days, 3-365 (30)
      "encryptionKeyArn": "string"      // customer KMS key; not updatable
    },
    "agentCoreMemoryConfiguration": {
      "arn": "string",                  // [required] memory resource ARN
      "actorId": "string",
      "messagesCount": integer,
      "retrievalConfig": {
        "<namespace>": {
          "topK": integer,
          "relevanceScore": float,
          "strategyId": "string"
        }, ...
      }
    },
    "disabled": {}
  }

Example:
  --memory '{"managedMemoryConfiguration":{}}'`,

  truncation: `(JSON object)
The truncation configuration for managing conversation context when it
exceeds model limits. "config" is a tagged union matching the chosen
strategy (none for "none").

JSON syntax:
  {
    "strategy": "sliding_window" | "summarization" | "none",  // [required]
    "config": {
      "slidingWindow": {
        "messagesCount": integer        // recent messages to retain
      },
      "summarization": {
        "summaryRatio": float,
        "preserveRecentMessages": integer,
        "summarizationSystemPrompt": "string"
      }
    }
  }

Example:
  --truncation '{"strategy":"sliding_window","config":{"slidingWindow":{"messagesCount":40}}}'`,

  environment: `(JSON: tagged union object)
The compute environment configuration for the harness: network mode,
session lifecycle, and filesystem mounts. Only top-level key:
agentCoreRuntimeEnvironment.

JSON syntax:
  {
    "agentCoreRuntimeEnvironment": {
      "lifecycleConfiguration": {
        "idleRuntimeSessionTimeout": integer, // seconds, 60-28800 (900)
        "maxLifetime": integer                // seconds, 60-28800 (28800)
      },
      "networkConfiguration": {
        "networkMode": "PUBLIC" | "VPC",      // [required]
        "networkModeConfig": {                // required for VPC mode
          "subnets": ["string", ...],
          "securityGroups": ["string", ...]
        }
      },
      "filesystemConfigurations": [           // up to 5 mounts; each entry
        {                                     // sets exactly one key
          "sessionStorage": {
            "mountPath": "string"             // [required] /mnt/<dir>
          },
          "s3FilesAccessPoint": {
            "accessPointArn": "string",       // [required]
            "mountPath": "string"             // [required]
          },
          "efsAccessPoint": {
            "accessPointArn": "string",       // [required]
            "mountPath": "string"             // [required]
          }
        },
        ...
      ]
    }
  }

Example:
  --environment '{"agentCoreRuntimeEnvironment":{"networkConfiguration":{"networkMode":"PUBLIC"}}}'`,

  environmentArtifact: `(JSON: tagged union object)
The environment artifact for the harness, such as a custom container image
with additional dependencies. Only top-level key: containerConfiguration.

JSON syntax:
  {
    "containerConfiguration": {
      "containerUri": "string"          // [required] ECR image URI
    }
  }

Example:
  --environment-artifact '{"containerConfiguration":{"containerUri":"123456789012.dkr.ecr.us-east-1.amazonaws.com/my-agent:latest"}}'`,

  environmentVariables: `(JSON: map of string to string)
Environment variables to set in the harness runtime environment. Up to 50
entries; keys up to 100 characters, values up to 5000.

Example:
  --environment-variables '{"LOG_LEVEL":"debug","FEATURE_FLAG":"on"}'`,

  authorizerConfiguration: `(JSON: tagged union object)
Inbound authorization for authenticating incoming requests. Only top-level
key: customJWTAuthorizer. When omitted, callers authenticate with AWS IAM.

JSON syntax:
  {
    "customJWTAuthorizer": {
      "discoveryUrl": "string",         // [required] .../.well-known/
                                        // openid-configuration URL
      "allowedAudience": ["string", ...],
      "allowedClients": ["string", ...],
      "allowedScopes": ["string", ...]
    }
  }

Example:
  --authorizer-configuration '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration","allowedAudience":["my-app"]}}'`,

  tags: `(JSON: map of string to string)
Tags to apply to the harness resource. Up to 50 entries; keys up to 128
characters, values up to 256.

Example:
  --tags '{"team":"ml-platform","env":"dev"}'`,
};
