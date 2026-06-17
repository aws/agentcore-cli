# Connector config templates

Sample `--connector-config` JSON files for non-S3 FMKB data sources. Copy the one matching your source, fill in the real
host/tenant/secret values (and replace any `<...>` placeholders), then:

    agentcore add knowledge-base --name my-kb \
      --data-source-type web-crawler \
      --connector-config ./web-crawler.json

The CLI copies the file under `app/<my-kb>/` and stores the relative path in `agentcore.json`. The JSON is passed
through to the Bedrock DataSource's `connectorParameters` verbatim — Bedrock validates field values, not the CLI, so
typos in enum values surface as a `FAILED` DataSource on first deploy.

## `--data-source-type` → wire `type` mapping

| Flag value     | Wire `type`   | Auth required               |
| -------------- | ------------- | --------------------------- |
| `web-crawler`  | `WEB`         | No                          |
| `confluence`   | `CONFLUENCE`  | Secrets Manager `secretArn` |
| `sharepoint`   | `SHAREPOINT`  | Secrets Manager `secretArn` |
| `onedrive`     | `ONEDRIVE`    | Secrets Manager `secretArn` |
| `google-drive` | `GOOGLEDRIVE` | Secrets Manager `secretArn` |

For the auth connectors, set the secret ARN under the connector's `authConfiguration.credentialsSecretArn`. The KB
service role is granted `secretsmanager:GetSecretValue` on it at deploy.

## Field-value gotchas

Bedrock validates connector-config field values when it creates the DataSource. The CLI doesn't pre-validate enum values
— if you typo one, the DataSource lands in `FAILED` state on first deploy and the failure reason cites the exact
constraint. A few that bite customers:

### Web Crawler `syncScope`

Valid values: `PATH_SPECIFIC`, `SUB_DOMAINS`, `ALL_DOMAINS`, `DOMAINS_ONLY`. Any other value (including the
intuitive-sounding `HOST_ONLY`) fails on creation. Pick the scope that matches your seed URLs:

- **`PATH_SPECIFIC`** — crawl only URLs that share the path prefix of each seed URL. Most restrictive.
- **`SUB_DOMAINS`** — crawl seed hosts and their subdomains.
- **`ALL_DOMAINS`** — crawl any URL reachable from the seed; only the seed list bounds the crawl. Broadest.
- **`DOMAINS_ONLY`** — crawl only the exact host(s) of the seed URLs. No subdomains, no offsite.

### Auth connectors require a real `credentialsSecretArn`

The placeholder ARN values in the templates fail validation at deploy. Create the secret first
(`aws secretsmanager create-secret ...`), then paste its ARN into the config file before running
`agentcore add knowledge-base`.

### Web Crawler `seedUrls`

Must be a non-empty array of fully-qualified `https://` URLs. Values without a scheme, or `http://` for hosts that
require TLS, fail at first crawl rather than at create-time.

## Diagnosing a `FAILED` DataSource

```bash
agentcore status --type knowledge-base --name <kb>
```

The drill-down view surfaces the failure reason from Bedrock. For a deeper look:

```bash
aws bedrock-agent get-data-source \
  --knowledge-base-id <kb-id> \
  --data-source-id <ds-id> \
  --region us-west-2 \
  --query 'dataSource.failureReasons'
```

Fix the value in the JSON file under `app/<kb>/<file>.json`, then `agentcore deploy` to update the DataSource and
re-trigger ingestion.
