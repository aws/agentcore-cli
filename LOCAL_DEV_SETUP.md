# Local Development Setup

This guide explains how to set up the agentcore-cli for local development when the L3 constructs package is not yet published to npm.

## Prerequisites

- Node.js >= 20
- npm
- Both packages cloned as siblings:
  ```
  workspace/
  ├── agentcore-cli/
  └── agentcore-l3-cdk-constructs/
  ```

## Setup Steps

### 1. Install and Build the L3 Constructs Package

```bash
cd agentcore-l3-cdk-constructs
npm install
npm run build
```

### 2. Create Global npm Link

```bash
npm link
```

This creates a global symlink that makes `@aws/agentcore-l3-cdk-constructs` available to other local projects.

### 3. Build the CLI

```bash
cd ../agentcore-cli
npm install
npm run build
```

### 4. Create a Test Project

```bash
npm run cli create
```

Follow the prompts to create a new project.

### 5. Link the L3 Constructs in the Generated Project

The generated CDK project includes a postinstall script that automatically attempts to link `@aws/agentcore-l3-cdk-constructs`. However, if npm install was run before you created the global link, you may need to manually link it:

```bash
cd <your-project>/agentcore/cdk
npm link @aws/agentcore-l3-cdk-constructs
```

Alternatively, you can re-run npm install to trigger the postinstall script:

```bash
npm install
```

### 6. Build and Test

```bash
npm run build
```

## How npm link Works

1. `npm link` in the L3 package creates a global symlink
2. `npm link @aws/agentcore-l3-cdk-constructs` in the CDK project creates a local symlink to the global one
3. Changes to the L3 package are immediately reflected (after rebuilding)

## Troubleshooting

### "Cannot find module" errors

Make sure you've built the L3 constructs package:
```bash
cd agentcore-l3-cdk-constructs
npm run build
```

### Link not working

Re-create the links:
```bash
# In L3 constructs
npm unlink
npm link

# In generated CDK project
npm unlink @aws/agentcore-l3-cdk-constructs
npm link @aws/agentcore-l3-cdk-constructs
```

### Changes not reflected

Rebuild the L3 constructs package:
```bash
cd agentcore-l3-cdk-constructs
npm run build
```

## Alternative: Using LOCAL_L3_PATH

If you prefer, you can set the `LOCAL_L3_PATH` environment variable before running create:

```bash
# Windows PowerShell
$env:LOCAL_L3_PATH = "C:\path\to\agentcore-l3-cdk-constructs"
npm run cli create

# Windows CMD
set LOCAL_L3_PATH=C:\path\to\agentcore-l3-cdk-constructs
npm run cli create
```

This will automatically use `file:` protocol in package.json instead of requiring npm link.
