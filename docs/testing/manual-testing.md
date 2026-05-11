# Manual Testing

## Building a local tarball

Run `npm run bundle` from the agentcore-cli directory. This bundles the CLI along with the CDK constructs from the
sister repo (`agentcore-l3-cdk-constructs`) into a single installable tarball.

```bash
cd agentcore-cli
npm run bundle
```

## Installing locally (without conflicting with global installs)

Install the tarball into your working directory so it doesn't conflict with other `agentcore` commands on the machine:

```bash
# From the parent workspace directory
npm init -y  # if no package.json exists yet
npm install ./agentcore-cli/aws-agentcore-*.tgz
```

Then run it with:

```bash
npx agentcore
```

Or add `node_modules/.bin` to your PATH for this directory only:

```bash
export PATH="$(pwd)/node_modules/.bin:$PATH"
agentcore
```
