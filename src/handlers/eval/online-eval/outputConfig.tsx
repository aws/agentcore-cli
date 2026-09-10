import z from "zod";
import { SourceResolver, type AppIO } from "../../../io";
import { flag } from "../../../router";
import { parseJsonFlag } from "../../utils";
import type { OnlineEvalOutputConfig } from "../types";

const outputConfigHelp = `(JSON object)
Where evaluation results and metrics are written. Omit it and results go to the
service-managed default location. Only top-level key: cloudWatchConfig.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  {
    "cloudWatchConfig": {
      "logGroupName": "string",      // result log group; omit for
                                     // SOURCE_LOG_GROUP, and it cannot sit
                                     // under /aws/bedrock-agentcore/evaluations/
      "metricsNamespace": "string",  // CloudWatch metrics namespace
      "resultDestination": "DEDICATED_LOG_GROUP" | "SOURCE_LOG_GROUP"
                                     // DEDICATED_LOG_GROUP writes to a
                                     // dedicated result group, creating it if
                                     // needed; SOURCE_LOG_GROUP writes back to
                                     // the groups the traces were sampled from
    }
  }

A role you supply with --role-arn is never edited by the CLI, so it must already
grant logs:PutLogEvents on the destination — plus logs:CreateLogGroup when the
group does not exist yet.

API reference:
  https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_OutputConfig.html

Example:
  --output-config '{"cloudWatchConfig":{"logGroupName":"/company/agent-evaluations","metricsNamespace":"Company/AgentEvaluations","resultDestination":"DEDICATED_LOG_GROUP"}}'`;

export class OnlineEvalOutputConfigFlag {
  static readonly flags = [
    flag(
      "output-config",
      "where results and metrics are written (JSON OutputConfig)",
      z.string().optional(),
      { group: "Result output:", help: outputConfigHelp },
    ),
  ] as const;

  static async resolve(
    value: string | undefined,
    io: AppIO,
  ): Promise<OnlineEvalOutputConfig | undefined> {
    const resolver = new SourceResolver({ stdin: io.stdin });
    return parseJsonFlag<OnlineEvalOutputConfig>(
      "output-config",
      await resolver.resolveText("output-config", value),
    );
  }
}
