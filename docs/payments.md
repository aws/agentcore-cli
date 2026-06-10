# Payments

Payments enable agents to process microtransactions using the [x402 protocol](https://www.x402.org/). When an agent's
HTTP tool call receives a `402 Payment Required` response, the payments system automatically signs and submits payment,
then retries the original request. This lets agents access paid APIs and services without manual intervention.

For a full overview of the payment architecture, see
[AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) in the AWS developer
guide.

## Quick Start

```bash
# 1. Create a project with payments capability
agentcore create --name MyProject --defaults
cd MyProject

# 2. Add a payment manager
agentcore add payment-manager --name MyManager

# 3. Add a payment connector with CoinbaseCDP credentials
agentcore add payment-connector \
  --manager MyManager \
  --name MyCDPConnector \
  --provider CoinbaseCDP \
  --api-key-id your-api-key-id \
  --api-key-secret your-api-key-secret \
  --wallet-secret your-wallet-secret

# 4. Deploy (creates payment infrastructure on AWS)
agentcore deploy -y

# 5. Create + fund an instrument out-of-band (SDK), then invoke with auto-session
agentcore invoke --auto-session --payment-user-id alice --prompt "Use a paid tool"
```

> **Note**: `--auto-session` requires a successful deploy first because it reads from deployed state to locate the
> payment manager ARN and create a session. The CLI does not create payment instruments — create and fund one with the
> SDK (scoped to the same `--payment-user-id`) and grant WalletHub delegated signing before invoking. See
> [Invoking with Payment Context](#invoking-with-payment-context).

## How It Works

When an agent makes an HTTP request to a paid endpoint, the server returns a `402 Payment Required` response containing
payment requirements (amount, recipient, network). The AgentCore payments plugin intercepts this response, calls
`ProcessPayment` to sign a USDC transaction, and retries the original request with payment proof headers attached.

For the full runtime flow, see
[How AgentCore payments works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-how-it-works.html).

### Payment Handling

Payments are handled by an **interceptor**: the payments plugin transparently catches a tool's `402 Payment Required`,
settles the x402 payment, and retries — no explicit agent decision. (Payment settlement is never exposed as an agent
tool.)

## Adding a Payment Manager

A payment manager is the top-level resource that orchestrates payment operations. It defines authorization and
auto-payment behavior. (Spending budgets are enforced per payment session, not on the manager — see
[Auto-Session Mode](#auto-session-mode).)

### CLI Command

```bash
# Minimal (defaults: AWS_IAM auth, auto-payment enabled)
agentcore add payment-manager --name MyManager

# With all advanced options
agentcore add payment-manager \
  --name MyManager \
  --authorizer-type AWS_IAM \
  --auto-payment true \
  --default-spend-limit 25.00 \
  --tool-allowlist "web_search,fetch_url" \
  --network-preferences "eip155:84532,eip155:8453" \
  --description "Production payment manager"
```

| Flag                               | Description                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--name <name>`                    | Manager name (required in non-interactive mode)                                                           |
| `--authorizer-type <type>`         | `AWS_IAM` (default) or `CUSTOM_JWT`                                                                       |
| `--discovery-url <url>`            | OIDC discovery URL (required for CUSTOM_JWT)                                                              |
| `--allowed-clients <clients>`      | Comma-separated client IDs (CUSTOM_JWT only)                                                              |
| `--allowed-audience <audience>`    | Comma-separated allowed audiences (CUSTOM_JWT only)                                                       |
| `--allowed-scopes <scopes>`        | Comma-separated allowed scopes (CUSTOM_JWT only)                                                          |
| `--auto-payment [value]`           | Enable automatic payment: `true` (default) or `false`                                                     |
| `--default-spend-limit <amount>`   | Spend cap (USD) for `invoke --auto-session` sessions ONLY; not a deployed-agent budget (default: `10.00`) |
| `--tool-allowlist <tools>`         | Comma-separated tool names eligible for payment                                                           |
| `--network-preferences <networks>` | Comma-separated network IDs (e.g., `eip155:84532` for Base Sepolia)                                       |
| `--description <desc>`             | Human-readable description                                                                                |
| `--json`                           | Output result as JSON                                                                                     |

Name constraints: must start with a letter, contain only alphanumeric characters and underscores, max 48 characters.

When you add a payment manager, the CLI automatically patches your agent code to include the payments plugin. The
generated code is at `capabilities/payments/payments.py` in each agent's directory.

### Authorization Types

**AWS_IAM** (default): Uses AWS IAM SigV4 signing for payment authorization. No additional configuration needed.

```bash
agentcore add payment-manager --name MyManager --authorizer-type AWS_IAM
```

**CUSTOM_JWT**: Uses a custom JWT authorizer via OIDC discovery. Useful when end users authenticate via an external
identity provider (e.g., Cognito).

```bash
agentcore add payment-manager \
  --name MyManager \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX/.well-known/openid-configuration \
  --allowed-clients "client-id-1,client-id-2" \
  --allowed-audience "https://api.example.com" \
  --allowed-scopes "payments:read,payments:write"
```

For details on IAM role separation (ManagementRole vs ProcessPaymentRole), see
[IAM roles for AgentCore payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-iam-roles.html).

## Adding a Payment Connector

A payment connector links a credential provider (wallet credentials) to a payment manager. Each manager needs at least
one connector before it can process payments.

### CoinbaseCDP Provider

```bash
agentcore add payment-connector \
  --manager MyManager \
  --name MyCDPConnector \
  --provider CoinbaseCDP \
  --api-key-id your-api-key-id \
  --api-key-secret your-api-key-secret \
  --wallet-secret your-wallet-secret
```

| Flag                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `--manager <name>`          | Parent payment manager (required)        |
| `--name <name>`             | Connector name (required)                |
| `--provider <provider>`     | `CoinbaseCDP` (default) or `StripePrivy` |
| `--api-key-id <id>`         | Coinbase CDP API Key ID                  |
| `--api-key-secret <secret>` | Coinbase CDP API Key Secret              |
| `--wallet-secret <secret>`  | Coinbase CDP Wallet Secret (ECDSA P-256) |
| `--json`                    | Output result as JSON                    |

### StripePrivy Provider

```bash
agentcore add payment-connector \
  --manager MyManager \
  --name MyStripeConnector \
  --provider StripePrivy \
  --app-id your-privy-app-id \
  --app-secret your-privy-app-secret \
  --authorization-private-key your-ecdsa-private-key \
  --authorization-id your-authorization-key-id
```

| Flag                                | Description                         |
| ----------------------------------- | ----------------------------------- |
| `--manager <name>`                  | Parent payment manager (required)   |
| `--name <name>`                     | Connector name (required)           |
| `--provider <provider>`             | Must be `StripePrivy`               |
| `--app-id <id>`                     | Privy App ID                        |
| `--app-secret <secret>`             | Privy App Secret                    |
| `--authorization-private-key <key>` | ECDSA P-256 private key for signing |
| `--authorization-id <id>`           | Authorization key identifier        |
| `--json`                            | Output result as JSON               |

### Credential Storage

Connector credentials are stored in `agentcore/.env.local` and never committed to source control. The env var naming
convention is:

**CoinbaseCDP** (3 variables):

```
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_API_KEY_ID=...
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_API_KEY_SECRET=...
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_WALLET_SECRET=...
```

**StripePrivy** (4 variables):

```
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_APP_ID=...
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_APP_SECRET=...
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_AUTHORIZATION_PRIVATE_KEY=...
AGENTCORE_CREDENTIAL_{CREDENTIAL_NAME}_AUTHORIZATION_ID=...
```

`{CREDENTIAL_NAME}` is the connector's credential name uppercased with hyphens replaced by underscores. For example, a
credential named `my-cdp-creds` becomes `AGENTCORE_CREDENTIAL_MY_CDP_CREDS_API_KEY_ID`.

### Credential Rotation

To rotate credentials:

1. Update the values in `agentcore/.env.local`
2. Run `agentcore deploy -y`

Deploy automatically updates the PaymentCredentialProvider on AWS with the new secret values.

## Deploying with Payments

When you run `agentcore deploy`, the CLI creates payment infrastructure via direct API calls (not CloudFormation). The
deploy sequence for each payment manager:

1. Reads credentials from `.env.local`
2. Creates or updates a **PaymentCredentialProvider** with the connector secrets
3. Creates **IAM roles** (ProcessPaymentRole and ResourceRetrievalRole) if they don't exist
4. Creates the **PaymentManager** (skipped if it already exists)
5. Creates or updates the **PaymentConnector** linking credentials to the manager

### Prerequisites

- `agentcore/.env.local` must exist with all required credential variables
- Each manager must have at least one connector configured
- AWS credentials with sufficient permissions (see
  [IAM roles](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-iam-roles.html))

> **Note**: First-time deployment takes extra time for IAM role creation and propagation. Subsequent deploys are faster.

## Invoking with Payment Context

After deploying, use `agentcore invoke` to test agents with payment capabilities.

### Payment Flags

| Flag                           | Description                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `--payment-instrument-id <id>` | Payment instrument ID (a funded wallet) for x402 payments                                    |
| `--payment-session-id <id>`    | Payment session ID for budget tracking                                                       |
| `--auto-session`               | Auto-create or reuse a payment session for testing                                           |
| `--payment-user-id <id>`       | End-user identity (wallet owner) to scope the instrument, session, and budget to. See below. |

### Payment identity: `--payment-user-id`

Payment instruments and sessions are **scoped to an end user** (the wallet owner). `--payment-user-id` sets that
identity; the agent uses it to look up the right wallet and budget when settling a payment. It is written into the
invocation body as `user_id`.

When `--payment-user-id` is omitted it falls back to `--user-id`. When neither is set, the agent scopes payments to
`default-user` — fine for single-user local testing, but **production should pass `--payment-user-id` per end user** so
that wallets and budgets are never shared across users. Invoking a payments-enabled project without an identity prints a
warning to that effect.

> **Two different "user id"s.** `--payment-user-id` (the wallet owner, sent in the invocation body) is distinct from
> `--user-id` (the AgentCore Runtime/Identity header used for OAuth token scoping). They are independent: under
> CUSTOM_JWT auth the payment user is derived from the JWT `sub` claim and `--payment-user-id` is ignored. Set
> `--payment-user-id` for SigV4 (IAM) agents that pay on behalf of a specific end user.

The instrument created out-of-band (below) and the `--payment-user-id` passed at invoke time **must be the same user** —
otherwise the agent looks up the wallet under the wrong identity and the payment fails with `Instrument not found`.

### Auto-Session Mode

`--auto-session` creates a temporary payment session with the default spend limit, or reuses an existing one from the
current testing context. This is the simplest way to test payment flows without manually creating a session via the AWS
API. The session is scoped to the resolved payment identity (`--payment-user-id`, else `--user-id`, else
`default-user`), so it aligns with the instrument and the body `user_id`.

```bash
agentcore invoke --auto-session --payment-user-id alice --prompt "Search for paid research papers"
```

### Explicit Payment Context

For testing with a specific instrument and session:

```bash
agentcore invoke \
  --payment-user-id alice \
  --payment-instrument-id payment-instrument-abc123 \
  --payment-session-id payment-session-xyz789 \
  --prompt "Process a payment for the weather API"
```

### Interactive mode

Passing payment flags **without** a prompt launches the interactive chat with the payment context held for the whole
session — every turn pays as that identity, against that instrument and session:

```bash
agentcore invoke --payment-user-id alice --payment-instrument-id payment-instrument-abc123
```

The interactive header shows `Payments: active (wallet owner: <id>)` while a payment context is in effect.
(`--auto-session` is a non-interactive convenience and always runs in command mode.)

### Creating an instrument (out-of-band)

The CLI does not create payment instruments; create them with the AgentCore SDK or your application backend, scoped to
the end user you will invoke as:

```python
from bedrock_agentcore.payments.manager import PaymentManager

manager = PaymentManager(payment_manager_arn=MANAGER_ARN, region_name="us-east-1")
instrument = manager.create_payment_instrument(
    payment_connector_id=CONNECTOR_ID,
    payment_instrument_type="EMBEDDED_CRYPTO_WALLET",
    payment_instrument_details={
        "embeddedCryptoWallet": {
            "network": "ETHEREUM",
            "linkedAccounts": [{"email": {"emailAddress": "alice@example.com"}}],
        }
    },
    user_id="alice",  # MUST match the --payment-user-id you invoke with
)
# instrument["paymentInstrumentId"]                                        -> pass as --payment-instrument-id
# instrument["paymentInstrumentDetails"]["embeddedCryptoWallet"]["walletAddress"]  -> fund this address
# instrument["paymentInstrumentDetails"]["embeddedCryptoWallet"]["redirectUrl"]    -> WalletHub consent (below)
```

Fund the returned `walletAddress` with testnet USDC ([Circle faucet](https://faucet.circle.com/), Base Sepolia) before
invoking.

### Grant delegated signing (one-time, per end-user wallet)

Before `ProcessPayment` can settle, the **end user who owns the wallet must grant Coinbase delegated signing** for it.
There are two layers, and **both** are required:

**1. Project-level toggle (developer, once per CDP project).** In the Coinbase CDP dashboard, enable **Non-custodial
Wallets → Security → Delegated Signing** ("enable users to give your app permission to transact on their behalf"). This
authorizes your app to _request_ delegation at all. It's normally already enabled on the CDP project behind your
connector credentials; if you bring your own CDP credentials, turn it on or the per-wallet grant below will fail.

**2. Per-wallet grant (end user, once per wallet).** Completed in the Coinbase **WalletHub** consent page that AgentCore
returns as the instrument's `redirectUrl`:

1. Send the end user the `redirectUrl` from the `create_payment_instrument` response.
2. The end user opens it and **signs in as the exact email passed in `linkedAccounts`** — _not_ the developer's
   Coinbase/CDP account. Coinbase verifies the identity (typically with a one-time code emailed to that address, valid
   ~10 minutes).
3. The end user clicks **Grant**. WalletHub shows the granted permission and an expiry date (delegation is time-bound;
   it persists until it expires or is revoked).

Under the hood, WalletHub performs Coinbase CDP's `createDelegation` for the wallet — AgentCore hosts it as a redirect
page so you don't have to build the consent frontend. There is **no API to grant delegated signing**; the end-user
WalletHub consent is the only activation path (by Coinbase design), and the only way to detect it is to attempt a
payment.

Until the grant is active, `ProcessPayment` fails with:
`Delegated signing grant is not active for the end user wallet. Please redirect end user to the WalletHub to grant the permissions.`

> **Common pitfall — "no accounts found":** opening the WalletHub link while signed into your own (developer) Coinbase
> account shows **"no accounts found"**, because the wallet is bound to the `linkedAccounts` email identity, not your
> developer account. Always authenticate as the linked end-user email. Open the link in a **fresh/incognito browser
> window** so an existing Coinbase session isn't silently used. For local testing, use a `linkedAccounts` email you
> control — a plus-addressed alias such as `you+testuser@example.com` works because the OTP is delivered to your real
> inbox, letting you complete the end-user grant yourself.

For details on the underlying primitive, see
[CDP delegated signing](https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing) and
[Create a payment instrument](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-create-instrument.html).

### End-to-end: get a transaction through

The complete path from a fresh project to a settled on-chain payment. Steps 1–2 and 6 are CLI; steps 3–5 are out-of-band
(SDK + Coinbase) because instrument creation, funding, and the wallet grant are end-user actions.

```bash
# 1. Create a project and add the payment manager + connector
agentcore create --name MyProject --defaults && cd MyProject
agentcore add payment-manager --name MyManager
agentcore add payment-connector --manager MyManager --name MyCDPConnector --provider CoinbaseCDP \
  --api-key-id "$CDP_API_KEY_ID" --api-key-secret "$CDP_API_KEY_SECRET" --wallet-secret "$CDP_WALLET_SECRET"

# 2. Deploy (creates the payment manager, connector, credential provider, and IAM roles)
agentcore deploy -y
```

```python
# 3. Create a payment instrument for the end user you'll invoke as (SDK / app backend).
#    Use the manager ARN + connector id from `agentcore status --type payment`.
from bedrock_agentcore.payments.manager import PaymentManager
manager = PaymentManager(payment_manager_arn=MANAGER_ARN, region_name="us-east-1")
inst = manager.create_payment_instrument(
    payment_connector_id=CONNECTOR_ID,
    payment_instrument_type="EMBEDDED_CRYPTO_WALLET",
    payment_instrument_details={"embeddedCryptoWallet": {
        "network": "ETHEREUM",
        "linkedAccounts": [{"email": {"emailAddress": "alice@example.com"}}],
    }},
    user_id="alice",
)
print(inst["paymentInstrumentId"])                                                  # -> --payment-instrument-id
print(inst["paymentInstrumentDetails"]["embeddedCryptoWallet"]["walletAddress"])    # -> fund this
print(inst["paymentInstrumentDetails"]["embeddedCryptoWallet"]["redirectUrl"])      # -> WalletHub grant
```

```text
# 4. Fund the walletAddress with Base Sepolia testnet USDC: https://faucet.circle.com/
# 5. Grant delegated signing: open the redirectUrl (incognito), sign in as alice@example.com, click Grant.
#    (See "Grant delegated signing" above. Until this is done, payments fail with
#     "Delegated signing grant is not active".)
```

```bash
# 6. Invoke — the agent makes the paid request, the plugin settles the 402, and retries:
agentcore invoke --payment-user-id alice --payment-instrument-id <id> --auto-session \
  --prompt "Fetch <a paid x402 URL> and return the result"
#   On success the agent returns the paid content; the wallet's USDC balance drops by the charge.
```

Interactive equivalent (payment context held across the whole chat session; needs an explicit `--payment-session-id`
since `--auto-session` is command-only):

```bash
agentcore invoke --payment-user-id alice \
  --payment-instrument-id <id> --payment-session-id <id>   # no prompt -> interactive chat
```

> **Transient settlement failures.** x402 settlement is an on-chain operation; an individual attempt can fail with
> `invalid_exact_evm_transaction_failed` / "Settlement failed" (e.g. two payments fired from the same wallet
> back-to-back collide on transaction timing). This is not a configuration error — **retry the request** and it
> typically settles. The funds are not debited on a failed attempt.

## Status and Removal

### Checking Status

```bash
agentcore status --type payment
```

Shows each payment manager's deployment state, connector count, and live health from the AWS API. The status command
queries the deployed payment manager to verify it's reachable.

### Removing a Connector

```bash
agentcore remove payment-connector --name MyCDPConnector --manager MyManager -y
```

The `--manager` flag is required when a connector name exists under multiple managers.

### Removing a Manager

```bash
agentcore remove payment-manager --name MyManager -y
```

Removing a payment manager cascades: it deletes all associated connectors and credential providers from the local
configuration.

## Validation

`agentcore validate` checks payment configuration for common issues:

- Credential cross-references: verifies each connector's `credentialName` maps to a valid credential entry
- `.env.local` existence: confirms the secrets file exists when payment connectors are configured
- Missing environment variables: checks that all required `AGENTCORE_CREDENTIAL_*` variables are present

```bash
agentcore validate
```

## Troubleshooting

| Error                                                        | Cause                                                                   | Fix                                                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.env.local not found`                                       | No secrets file in project                                              | Create `agentcore/.env.local` with credential vars                                        |
| `Missing credentials for connector`                          | Env vars not set for a connector                                        | Add the required `AGENTCORE_CREDENTIAL_*` vars to `.env.local`                            |
| `ServiceQuotaExceededException`                              | Account limit on payment managers                                       | Request a quota increase via AWS Support                                                  |
| `No connectors for payment manager`                          | Manager has zero connectors                                             | Add at least one connector before deploying                                               |
| `PaymentCredentialProvider not found`                        | Orphaned reference after manual deletion                                | Re-run `agentcore deploy` to recreate                                                     |
| `Request timeout`                                            | Network or service availability                                         | Retry deploy; check internet connectivity                                                 |
| `Invalid authorizer type`                                    | Typo in `--authorizer-type` flag                                        | Use `AWS_IAM` or `CUSTOM_JWT` (case-sensitive)                                            |
| `Instrument not found` at invoke                             | `--payment-user-id` differs from the instrument's owner                 | Invoke with the same user the instrument was created under                                |
| `Delegated signing grant is not active`                      | End user hasn't granted WalletHub consent for the wallet                | Open the instrument's `redirectUrl`, sign in as the linked email, click Grant (see above) |
| WalletHub shows `no accounts found`                          | Opened the consent link as the developer, not the wallet's linked email | Sign in as the `linkedAccounts` email (incognito); OTP goes to that inbox                 |
| `invalid_exact_evm_transaction_failed` / `Settlement failed` | Transient on-chain failure (e.g. back-to-back payments from one wallet) | Retry the request; funds are not debited on a failed attempt                              |

For additional troubleshooting, see
[Troubleshooting AgentCore payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-troubleshooting.html).

## Further Reading

**AWS Documentation:**

- [AgentCore Payments overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html)
- [Core concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-concepts.html)
- [How it works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-how-it-works.html)
- [Getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-getting-started.html)
- [Prerequisites](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-prerequisites.html)
- [IAM roles](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-iam-roles.html)
- [Create manager and connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-create-manager.html)
- [Create instrument](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-create-instrument.html)
- [Process a payment](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-process-payment.html)
- [Coinbase Bazaar via Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-connect-bazaar.html)
- [Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-observability.html)
- [Troubleshooting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-troubleshooting.html)

**Blog:**

- [Agents that transact: Introducing Amazon Bedrock AgentCore Payments](https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/)

**Samples:**

- [x402 Payments with CloudFront](https://github.com/aws-samples/sample-agentcore-cloudfront-x402-payments)
