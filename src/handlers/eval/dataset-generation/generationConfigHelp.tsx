export const generationConfigHelp = `(JSON: object)
Where traces are read from, which sessions become examples, and what each
example carries. Only sourceConfig is required.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  {
    "sourceConfig": {                       // [required] exactly one key
      "cloudWatchLogs": {
        "logGroupNames": ["string"],        // or "logGroupNamePrefixes", not both
        "serviceNames": ["string"],         // [required] exactly one: the agent's service.name
        "startTime": "ISO 8601 timestamp",  // default 7 days before endTime
        "endTime": "ISO 8601 timestamp"     // default now
      },
      "onlineEvaluation": {
        "onlineEvaluationConfigArn": "string",   // [required]
        "startTime": "ISO 8601 timestamp",
        "endTime": "ISO 8601 timestamp"
      },
      "batchEvaluation": { "batchEvaluationArn": "string" }   // [required]
    },
    "selection": {                          // exactly one key; omit to select every session
      "filters": {
        "attributeFilters": [ { "key": "string", "operator": "string", "value": { ... } } ],
        "turnCount": { "min": 1, "max": 100 },
        "evaluatorFilters": [ { "evaluatorId": "string", "operator": "string",
                                "value": { "doubleValue": 0.9 }, "aggregation": "Min" } ]
      },
      "identifiers": { "sessionIds": ["string"], "traceIds": ["string"] }
    },
    "sampling": { "maxScenarios": 100 },    // default 100, at most 1000
    "groundTruth": {
      "fields": ["expected_response", "expected_trajectory"],   // [required]
      "qualityFilters": [ ... ]             // same shape as evaluatorFilters
    },
    "redactionConfiguration": {             // omit for no redaction
      "identifiers": ["NAME", "EMAIL_ADDRESS"],
      "customDataIdentifiers": [ { "name": "string", "regex": "string" } ]
    }
  }

evaluatorFilters and qualityFilters need an onlineEvaluation or batchEvaluation
source; a cloudWatchLogs source carries no evaluation results to compare.

See https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_TraceGenerationSource.html

Example:
  --generation-config '{"sourceConfig":{"batchEvaluation":{"batchEvaluationArn":"arn:aws:bedrock-agentcore:us-west-2:111122223333:batch-evaluate/nightly-a1b2c3d4e5"}}}'

  --generation-config file://generation.json`;
