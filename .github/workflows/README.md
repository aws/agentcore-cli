# GitHub Workflows

## Hierarchy

Workflows are organized into two roles:

```
Orchestrators (e.g. ci.yml, release.yml)
Jobs          (e.g. build.yml, unit-test.yml, publish-npm.yml)
```

**Orchestrators** respond to events and coordinate work. They define _when_ and
_in what order_ things happen, but contain minimal logic themselves. An orchestrator
is a composition of jobs.

**Jobs** are self-contained, reusable units of work. They accept inputs (like a
`ref` to check out), do one thing, and report pass/fail. A job doesn't know or
care what triggered it.

An orchestrator calls jobs via `workflow_call`.

### Current example

```
ci.yml
  ├── build.yml      (lint, format, typecheck, audit, bundle, compile)
  └── unit-test.yml  (tests on Linux, Windows, macOS)
```

### Future examples

```
release.yml
  ├── unit-test.yml
  ├── build.yml
  └── publish-npm.yml
```

Jobs like `unit-test.yml` and `build.yml` appear in multiple orchestrators. This
is the point — write once, compose freely.

## Naming Convention

- **Orchestrators** are named for their purpose (e.g. `ci`, `release`).
- **Jobs** are named as verbs or noun-verb pairs describing the work
  (e.g. `build`, `unit-test`, `publish-npm`).

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
