# GitHub Workflows

## Hierarchy

Workflows are organized into two roles:

```
Orchestrators (ci.yml, release-prepare.yml, release-publish.yml)
Jobs          (verify.yml)
```

**Orchestrators** respond to events and coordinate work. They define _when_ and
_in what order_ things happen, but contain minimal logic themselves. An orchestrator
is a composition of jobs.

**Jobs** are self-contained, reusable units of work. They accept inputs (like a
`ref` to check out), do one thing, and report pass/fail. A job doesn't know or
care what triggered it.

An orchestrator calls jobs via `workflow_call`.

### Current examples

```
ci.yml
  `-- verify.yml     (one job per platform: static checks on Linux, then bundle,
                      package, compile, smoke test and unit tests)

release-prepare.yml (version bump, vended CDK pin, release PR)

release-publish.yml (npm publish and GitHub release when a release PR merges)
  `-- verify.yml
```

`verify.yml` appears in both orchestrators. This is the point — write once,
compose freely.

## Naming Convention

- **Orchestrators** are named for their purpose (e.g. `ci`, `release-publish`).
- **Jobs** are named as verbs or noun-verb pairs describing the work
  (e.g. `verify`).

## Releasing

Dispatch `release-prepare` with a bump and a channel, review the release PR it opens, merge it.
`release-publish` then publishes the merged package.json version.

Publishing listens for pushes to `refactor`, not PR events. It looks up the pushed commit's
associated PRs and proceeds only when that exact commit
is the merge of a `release/v*` PR opened by `agentcore-devx-automation[bot]` (account ID
`282717993`) from this repository into the target branch. Manually opened release PRs,
ordinary merges, fork PRs, and pushes without a matching release PR skip verification and
publishing. Every job uses the pushed SHA, so later commits cannot change what is released.

npm publish authenticates with trusted publishing: the package's npm settings list this repository
and `release-publish.yml` as a trusted publisher, and the publish job exchanges its GitHub OIDC token
for a short-lived npm token. There is no npm secret in the repository. npm checks the filename of the
top-level workflow, so the publish step must stay in `release-publish.yml` rather than move into a
reusable workflow.

The prepare, check-release, and publish jobs use `aws-release-4-core`. The `release-publish.yml`
allowlist currently covers `refactor` only. After the workflow lands on `main`, have a
runner-group administrator add its `main` entry before switching the publish branch filter.
The allowlist is scoped to workflow paths and branches; renaming a workflow also requires an
update. Keep PR-triggered workflows and the verification matrix off this release-only pool.

The npm package includes `dist` except `dist/bin`, plus standard package metadata. This keeps
additional bundle chunks and runtime assets included as the build evolves. Native binaries in
`dist/bin` are separate GitHub release assets, never npm package contents, even when packing a
workspace that has already compiled them.

If publish fails after the merge, rerun the failed `release-publish` jobs. Both the npm publish
and the GitHub release steps skip work that already succeeded. Do not re-dispatch
`release-prepare`, package.json already holds the new version and it would bump again.

## Key Choices

### Explicit ref passing

Every job accepts a `ref` input and passes it to `actions/checkout`. The
orchestrator resolves the correct commit once and threads it to each job. This
ensures all jobs check out the exact same commit — important for PRs where the
default `github.sha` points to a merge commit that may shift mid-workflow.

### persist-credentials: false

All checkout steps disable credential persistence. Jobs only need read access to
clone; dropping the token from the local git config avoids accidental credential
leakage in downstream steps.

### Minimal permissions

Every job declares the least privilege it needs. Most only require
`permissions: { contents: read }`.

### Bun throughout

All jobs use `oven-sh/setup-bun@v2` and `bun install --frozen-lockfile`. The
lockfile is enforced to keep CI deterministic.
