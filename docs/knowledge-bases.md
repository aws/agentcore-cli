# Knowledge Bases

A Knowledge Base (KB) ingests documents from one or more data sources and exposes a managed `retrieve` tool to your
agent through a gateway. The CLI provisions the underlying Bedrock fully-managed Knowledge Base, its data sources, and
its IAM service role; you only describe the corpus and the gateway you want it wired to.

## Quick Start

The simplest path mirrors the gateway flow: set up the KB and gateway before adding the agent so the generated agent
code is wired to call `retrieve` against the KB through the gateway.

```bash
# 1. Create a project
agentcore create --name MyProject --defaults
cd MyProject

# 2. Add a gateway
agentcore add gateway --name docs-gw

# 3. Add a knowledge base, wired to the gateway
agentcore add knowledge-base \
  --name docs \
  --source s3://my-corpus-bucket/manuals/ \
  --gateway docs-gw

# 4. Create an agent (automatically wired to the gateway)
agentcore add agent --name MyAgent --framework Strands --model-provider Bedrock

# 5. Deploy
agentcore deploy -y
```

The deploy creates the KB and its data sources, kicks off an initial ingestion job, and exposes a `retrieve` tool on
`docs-gw` that your agent can call.

## Adding a Knowledge Base

Three forms work, and they compose:

```bash
# Interactive — drops into the TUI wizard
agentcore add knowledge-base

# Non-interactive — required flags only
agentcore add knowledge-base --name docs --source s3://bucket/prefix/

# Append a second source to an existing KB (idempotent)
agentcore add knowledge-base --name docs --source s3://bucket/another/
```

Re-invoking `add knowledge-base` with an existing `--name` appends data sources rather than creating a duplicate KB.

### Wiring to a gateway

Pass `--gateway <name>` to attach the KB to a gateway. The CLI creates two connector targets on that gateway:

- a per-KB `bedrock-knowledge-bases` target named after the KB (single-KB Retrieve), and
- a shared `bedrock-agentic-retrieve` target named `<gateway>-agentic` that fans out across every KB on the gateway.

```bash
agentcore add knowledge-base --name docs --source s3://bucket/ --gateway docs-gw
```

If `docs-gw` doesn't exist yet, run `agentcore add gateway --name docs-gw` first. The KB add fails fast if the gateway
is missing.

### Multiple data sources per KB

Repeat `--source` (S3) or `--connector-config` (non-S3) on the same `--name` invocation, or call `add knowledge-base`
multiple times with the same name:

```bash
agentcore add knowledge-base --name docs \
  --source s3://bucket/manuals/ \
  --source s3://bucket/changelog.md
```

Each source becomes its own data source under the KB and gets its own ingestion job.

## Data Source Types

`--data-source-type` selects the kind of data source. Defaults to `s3`. Supported values:

| Type         | Flag value     | Required input              | Notes                                                      |
| ------------ | -------------- | --------------------------- | ---------------------------------------------------------- |
| Amazon S3    | `s3` (default) | `--source <s3-uri>`         | Bucket must be in the same account; `s3://bucket[/prefix]` |
| Web Crawler  | `web-crawler`  | `--connector-config <path>` | Crawls one or more seed URLs                               |
| Confluence   | `confluence`   | `--connector-config <path>` | Requires Secrets Manager credentials                       |
| SharePoint   | `sharepoint`   | `--connector-config <path>` | Requires Secrets Manager credentials                       |
| OneDrive     | `onedrive`     | `--connector-config <path>` | Requires Secrets Manager credentials                       |
| Google Drive | `google-drive` | `--connector-config <path>` | Requires Secrets Manager credentials                       |

### S3 sources

Pass an S3 URI. The bucket must live in the same AWS account where you're deploying; cross-account buckets are not
supported by this connector.

```bash
agentcore add knowledge-base --name docs \
  --source s3://corpus-bucket-123456789012/manuals/
```

The KB service role is granted `s3:GetObject` and `s3:ListBucket` on every bucket referenced by an S3 data source,
scoped to the deploying account via an `aws:ResourceAccount` condition. Permissions are bucket-scoped, not prefix-scoped
— a KB pointed at `s3://bucket/foo/` can read all of `bucket`. Split into separate buckets if you need prefix-level
isolation.

### Non-S3 connector sources

For Web Crawler, Confluence, SharePoint, OneDrive, and Google Drive, you supply a JSON connector-config file. Templates
live at [`docs/connector-config-templates/`](connector-config-templates/) — copy the matching one, fill in the real
host/tenant/secret values, then:

```bash
agentcore add knowledge-base --name web-docs \
  --data-source-type web-crawler \
  --connector-config ./web-crawler.json
```

The CLI copies the file under `app/<kb-name>/` and stores the relative path in `agentcore.json`. The JSON contents are
passed verbatim to the Bedrock DataSource's `connectorParameters`.

Auth-bearing connectors (Confluence, SharePoint, OneDrive, Google Drive) require a Secrets Manager `secretArn` in the
config. The KB service role is granted `secretsmanager:GetSecretValue` on that secret at deploy.

You can mix data source types on a single KB by repeating `add knowledge-base` with the same `--name`:

```bash
agentcore add knowledge-base --name docs --source s3://corpus/manuals/
agentcore add knowledge-base --name docs --data-source-type web-crawler --connector-config ./crawler.json
```

## Wiring an External Knowledge Base

To wire an existing Bedrock KB that this project does not own (created elsewhere, owned by another team), use the
gateway-target primitive directly — there is no `agentcore add knowledge-base` path for external KBs:

```bash
agentcore add gateway-target \
  --type connector \
  --connector bedrock-knowledge-bases \
  --knowledge-base-id <10-CHAR-KB-ID> \
  --gateway docs-gw \
  --name external-docs
```

This writes only to `agentCoreGateways[].targets[]` — no `knowledgeBases[]` entry, no IAM role, no managed ingestion.
The KB lives wherever it lives; the project just adds a Retrieve target on top of it.

## Ingestion

`agentcore deploy` automatically kicks off an ingestion job on every data source after the CFN stack finishes. To
re-trigger a manual ingestion later (after updating corpus contents, fixing permissions, etc.):

```bash
# Ingest all data sources on a KB
agentcore run ingest --name docs

# Ingest a specific data source on the KB
agentcore run ingest --name docs --data-source s3://corpus/manuals/

# JSON output for scripting
agentcore run ingest --name docs --json
```

Bedrock allows only one concurrent ingestion job per KB; the CLI retries with backoff if a job is already running.

## Status

```bash
# All KBs in the project
agentcore status --type knowledge-base

# Drill into one KB
agentcore status --type knowledge-base --name docs

# JSON output
agentcore status --type knowledge-base --json
```

The drill-down view shows per-data-source ingestion state, document counts (scanned, indexed, failed), and any
troubleshooting hints if ingestion failed (most early failures are bucket permissions, file format, or an expired
secret).

## Removing a Knowledge Base

```bash
agentcore remove knowledge-base --name docs
```

The remove preview shows everything that will be cleaned up:

- the KB and its data sources from `knowledgeBases[]`,
- the per-KB Retrieve target on the wired gateway, and
- the entry from the gateway's shared `agentic-retrieve` target — and the agentic target itself if this was the last KB
  on the gateway.

`agentcore deploy` after the remove cleanly tears down the CFN resources.

## Configuration Reference

In `agentcore.json`:

```json
{
  "knowledgeBases": [
    {
      "name": "docs",
      "description": "Product manuals",
      "gateway": "docs-gw",
      "dataSources": [
        { "type": "S3", "uri": "s3://corpus-bucket/manuals/" },
        { "type": "WEB", "connectorConfigFile": "app/docs/web-crawler.json" }
      ]
    }
  ],
  "agentCoreGateways": [
    {
      "name": "docs-gw",
      "targets": [
        {
          "name": "docs",
          "targetType": "connector",
          "connectorId": "bedrock-knowledge-bases",
          "knowledgeBaseId": "docs"
        },
        {
          "name": "docs-gw-agentic",
          "targetType": "connector",
          "connectorId": "bedrock-agentic-retrieve",
          "knowledgeBaseIds": ["docs"]
        }
      ]
    }
  ]
}
```

`knowledgeBaseId` on a connector target accepts either a project KB name (an entry in `knowledgeBases[]`) or a literal
10-character external KB ID. The two formats can never collide because real Bedrock KB IDs are 10 uppercase alphanumeric
chars and project names start with a letter and may include dashes/underscores.

After deploy, `agentcore/.cli/deployed-state.json` carries the resolved Bedrock KB ID and per-data-source IDs:

```json
{
  "targets": {
    "default": {
      "resources": {
        "knowledgeBases": {
          "docs": {
            "knowledgeBaseId": "ABCDEFGHIJ",
            "knowledgeBaseArn": "arn:aws:bedrock:us-west-2:111122223333:knowledge-base/ABCDEFGHIJ",
            "dataSources": {
              "s3://corpus-bucket/manuals/": "ABC1234567"
            }
          }
        }
      }
    }
  }
}
```

## Common Issues

**"Gateway 'X' not found in agentcore.json"** — add the gateway first with `agentcore add gateway --name X` before
attaching the KB to it. The CLI never auto-creates a gateway from `add knowledge-base` non-interactively.

**Ingestion shows `FAILED` immediately after deploy** — for S3 sources, most early failures are: the bucket doesn't
exist, the bucket is in a different AWS account, the file format is unsupported, or the file size exceeds 50 MB.
`agentcore status --type knowledge-base --name <kb>` shows the troubleshooting hints inline.

**DataSource itself in `FAILED` state right after deploy (non-S3 connectors)** — Bedrock validates the
`connectorParameters` you wrote in the JSON file and rejects bad enum values, missing fields, or unreachable seed URLs.
Surface the exact reason with:

```bash
aws bedrock-agent get-data-source \
  --knowledge-base-id <kb-id> \
  --data-source-id <ds-id> \
  --region us-west-2 \
  --query 'dataSource.failureReasons'
```

The most common Web Crawler trip-up is `crawlConfiguration.syncScope` — only `PATH_SPECIFIC`, `SUB_DOMAINS`,
`ALL_DOMAINS`, and `DOMAINS_ONLY` are accepted. See
[`docs/connector-config-templates/README.md`](connector-config-templates/README.md) for the full list of value gotchas.
Edit `app/<kb>/<file>.json`, then `agentcore deploy` to update the DataSource and re-trigger ingestion.

**"Duplicate data source in this invocation"** — you passed the same `--source` URI twice on one call. Drop the
duplicate.

**"Connector config files X and Y would both be stored as 'app/<kb>/<basename>'"** — two of your connector configs share
a filename. Rename one before passing both.
