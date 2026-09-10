import type { OutputConfig } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { SourceResolver, type AppIO } from "../../../io";
import { flag } from "../../../router";
import { parseJsonFlag } from "../../utils";

const outputConfigHelp = `(JSON: tagged union object)
Where evaluation results and metrics are written. Omit it and results go to the
service-managed default location. Only top-level key: cloudWatchConfig.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  {
    "cloudWatchConfig": {
      "logGroupName": "string",      // result log group; omit for
                                     // SOURCE_LOG_GROUP, and it cannot sit
                                     // under /aws/bedrock-agentcore/evaluations/
      "logStreamName": "string",     // result log stream
      "metricsNamespace": "string",  // defaults to
                                     // Bedrock-AgentCore/Evaluations; cannot
                                     // begin with "AWS/"
      "resultDestination": "DEDICATED_LOG_GROUP" | "SOURCE_LOG_GROUP"
                                     // DEDICATED_LOG_GROUP (default) writes to
                                     // a dedicated result group;
                                     // SOURCE_LOG_GROUP writes back to the log
                                     // group the traces were read from
    }
  }

API reference:
  https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_OutputConfig.html

Example:
  --output-config '{"cloudWatchConfig":{"logGroupName":"/company/agent-evaluations","metricsNamespace":"Company/AgentEvaluations","resultDestination":"DEDICATED_LOG_GROUP"}}'`;

export class BatchOutputConfig {
  static readonly flags = [
    flag(
      "output-config",
      "where results and metrics are written (JSON OutputConfig)",
      z.string().optional(),
      { group: "Result output:", help: outputConfigHelp },
    ),
  ] as const;

  static async resolve(value: string | undefined, io: AppIO): Promise<OutputConfig | undefined> {
    const resolver = new SourceResolver({ stdin: io.stdin });
    return parseJsonFlag<OutputConfig>(
      "output-config",
      await resolver.resolveText("output-config", value),
    );
  }
}
