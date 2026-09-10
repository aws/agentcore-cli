export const onlineEvalDataSourceConfigHelp = `(JSON: tagged union object)
Which traces are sampled, for sources the --agent convenience flag cannot
express. Only top-level key: cloudWatchLogs.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  {
    "cloudWatchLogs": {
      "serviceNames": ["string", ...],          // [required] e.g. "my_agent.DEFAULT"
      "logGroupNames": ["string", ...],         // exact group names
      "logGroupNamePrefixes": ["string", ...]   // or match by prefix instead
    }                                           // supply one of the two name lists
  }

API reference:
  https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_DataSourceConfig.html

Example:
  --data-source-config '{"cloudWatchLogs":{"logGroupNames":["/aws/bedrock-agentcore/runtimes/my-runtime-DEFAULT"],"serviceNames":["my_agent.DEFAULT"]}}'`;
