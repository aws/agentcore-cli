# Identity CLI Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the exact toolchain, TypeScript diagnostic gate, invocation-wide output safety, recursive Commander policy, and mutation execution/presentation supervisors required by every Identity workflow.

**Architecture:** Shared process and router behavior lives outside the Identity feature so every command receives the same safe output and parser policy. Identity-specific mutation correlation is expressed through consumer-owned ports under `src/runtime/mutation`; only the private coordinator can mint scope writers, settled tokens, presentation epochs, evidence, and receipts.

**Tech Stack:** Bun, TypeScript, Commander, Ink, Node streams, Zod, Bun test.

---

## Task 1: Pin The Reviewed Toolchain And Package Contract

**Files:**

- Create: `.node-version`
- Create: `.bun-version`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Modify: `bun.lock`
- Test: `src/testing/packageContract.test.ts`

- [ ] **Step 1: Write the failing package-contract test**

Create `src/testing/packageContract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";

describe("reviewed package contract", () => {
  test("pins the release runtime and direct dependencies", async () => {
    expect(await Bun.file(".node-version").text()).toBe("22.22.1\n");
    expect(await Bun.file(".bun-version").text()).toBe("1.3.14\n");
    expect(packageJson.engines).toEqual({ node: ">=22.22.1" });
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.files).toEqual(["dist", "THIRD_PARTY_NOTICES.md"]);
    expect(packageJson.dependencies["@inkui-cli/data-table"]).toBeUndefined();
    expect(packageJson.dependencies["@aws-sdk/client-bedrock-agentcore-control"]).toBe("3.1079.0");
    expect(packageJson.dependencies["@aws-sdk/client-bedrock-agentcore"]).toBe("3.1079.0");
    expect(packageJson.dependencies["commander"]).toBe("15.0.0");
    expect(packageJson.dependencies["ink"]).toBe("7.1.0");
    expect(packageJson.dependencies["react"]).toBe("19.2.7");
    expect(packageJson.dependencies["@tanstack/react-query"]).toBe("5.101.2");
    expect(packageJson.dependencies["zod"]).toBe("4.4.3");
    expect(packageJson.dependencies["jsonc-parser"]).toBe("3.3.1");
    expect(packageJson.dependencies["@smithy/core"]).toBe("3.29.1");
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
bun test src/testing/packageContract.test.ts
```

Expected: failure because version files, exact pins, notice entry, and direct dependencies are absent.

- [ ] **Step 3: Update package metadata**

Set the exact versions from the design, add:

```json
{
  "files": ["dist", "THIRD_PARTY_NOTICES.md"],
  "engines": { "node": ">=22.22.1" },
  "packageManager": "bun@1.3.14",
  "scripts": {
    "verify:tsc": "bun scripts/verify-ts-diagnostics.ts",
    "test:package": "bun test src/testing/packageContract.test.ts"
  }
}
```

Add `.node-version` and `.bun-version` with one exact version line each. Remove
`@inkui-cli/data-table`, retain its MIT attribution in `THIRD_PARTY_NOTICES.md`, add the reviewed
direct/test/build dependencies from the design, and run:

```bash
bun install
```

- [ ] **Step 4: Verify package metadata**

Run:

```bash
bun test src/testing/packageContract.test.ts
bun install --frozen-lockfile
```

Expected: pass with no lockfile change on the frozen install.

- [ ] **Step 5: Commit**

```bash
git add .node-version .bun-version THIRD_PARTY_NOTICES.md package.json bun.lock src/testing/packageContract.test.ts
git commit -m "build: pin identity release toolchain"
```

## Task 2: Capture And Enforce The TypeScript Diagnostic Baseline

**Files:**

- Create: `test/fixtures/typescript-diagnostics.json`
- Create: `src/testing/typescriptDiagnostics.ts`
- Create: `scripts/verify-ts-diagnostics.ts`
- Create: `src/testing/typescriptDiagnostics.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write parser and comparison tests**

Create `src/testing/typescriptDiagnostics.test.ts` with fixtures proving exact path, line, column,
code, and message multiset comparison:

```ts
import { describe, expect, test } from "bun:test";
import { compareDiagnostics, parseDiagnostics } from "./typescriptDiagnostics";

describe("TypeScript diagnostic baseline", () => {
  const line = "src/a.ts(2,7): error TS2532: Object is possibly 'undefined'.";

  test("normalizes one compiler diagnostic", () => {
    expect(parseDiagnostics(line)).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        column: 7,
        code: "TS2532",
        message: "Object is possibly 'undefined'.",
      },
    ]);
  });

  test("rejects a moved, changed, added, or missing diagnostic", () => {
    const baseline = parseDiagnostics(line);
    expect(compareDiagnostics(baseline, baseline)).toEqual({ kind: "matched" });
    expect(
      compareDiagnostics(baseline, parseDiagnostics(line.replace("(2,7)", "(3,7)"))).kind,
    ).toBe("mismatched");
    expect(compareDiagnostics(baseline, []).kind).toBe("mismatched");
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
bun test src/testing/typescriptDiagnostics.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the closed parser and verifier**

Implement:

```ts
export type TypeScriptDiagnostic = Readonly<{
  path: string;
  line: number;
  column: number;
  code: `TS${number}`;
  message: string;
}>;

export type DiagnosticComparison =
  | Readonly<{ kind: "matched" }>
  | Readonly<{
      kind: "mismatched";
      missing: readonly TypeScriptDiagnostic[];
      unexpected: readonly TypeScriptDiagnostic[];
    }>;

export function parseDiagnostics(stderr: string): readonly TypeScriptDiagnostic[];
export function compareDiagnostics(
  expected: readonly TypeScriptDiagnostic[],
  actual: readonly TypeScriptDiagnostic[],
): DiagnosticComparison;
```

`verify-ts-diagnostics.ts` must:

1. Require TypeScript `5.9.3`.
2. run `bunx tsc --noEmit`;
3. parse the complete output;
4. compare the full sorted multiset to `test/fixtures/typescript-diagnostics.json`;
5. reject any diagnostic in a changed Identity or otherwise touched TypeScript file;
6. print only static mismatch headings plus normalized tuples.

Capture the current 29 diagnostics as the initial fixture before changing their source files.

- [ ] **Step 4: Verify the gate**

Run:

```bash
bun test src/testing/typescriptDiagnostics.test.ts
bun run verify:tsc
```

Expected: parser tests pass and the exact baseline matches.

- [ ] **Step 5: Commit**

```bash
git add package.json test/fixtures/typescript-diagnostics.json scripts/verify-ts-diagnostics.ts src/testing/typescriptDiagnostics.ts src/testing/typescriptDiagnostics.test.ts
git commit -m "test: enforce exact TypeScript diagnostic baseline"
```

## Task 3: Implement Invocation-Wide Stream Supervision

**Files:**

- Create: `src/runtime/output/types.ts`
- Create: `src/runtime/output/streamSupervisor.ts`
- Create: `src/runtime/output/awaitedSink.ts`
- Create: `src/runtime/output/awaitedSink.test.ts`
- Modify: `src/handlers/types.tsx`

- [ ] **Step 1: Write backpressure and failure tests**

The test must use a controllable writable and prove:

```ts
test("settles only after callback and drain when write returns false", async () => {
  const stream = new ControlledWritable({ writeReturn: false });
  const supervisor = createStreamSupervisor(stream, stream);
  const write = supervisor.stdout.writeUtf8('{"ok":true}\n');
  expect(await Promise.race([write, Promise.resolve("pending")])).toBe("pending");
  stream.completeCallback();
  expect(await Promise.race([write, Promise.resolve("pending")])).toBe("pending");
  stream.emitDrain();
  expect(await write).toEqual({ kind: "written" });
});

test("contains synchronous throw, callback failure, error, and early close", async () => {
  for (const failure of ["throw", "callback", "error", "close"] as const) {
    const result = await exerciseWriteFailure(failure);
    expect(result).toEqual({ kind: "outputUnavailable" });
  }
});
```

Also assert one in-flight stdout document, serialized stderr writes, cancellation only before
`write()`, callback-plus-drain ownership after acceptance, quiescence, and listener removal.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
bun test src/runtime/output/awaitedSink.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the closed output API**

Implement the exact public surface:

```ts
export type OutputWriteOutcome = { kind: "written" } | { kind: "outputUnavailable" };

export interface AwaitedOutputSink {
  writeUtf8(
    text: string,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<OutputWriteOutcome>;
}

export interface StreamSupervisor {
  readonly stdout: AwaitedOutputSink;
  readonly stderr: AwaitedOutputSink;
  quiesce(): Promise<void>;
  dispose(): void;
}

export function createStreamSupervisor(
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): StreamSupervisor;
```

The implementation must never throw an underlying stream error, split/retry a document, or detach
listeners while accepted callbacks remain unsettled.

- [ ] **Step 4: Verify focused and existing output tests**

```bash
bun test src/runtime/output/awaitedSink.test.ts src/runnable/index.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/output src/handlers/types.tsx
git commit -m "feat: add awaited invocation output supervision"
```

## Task 4: Apply One Recursive Commander Execution Policy

**Files:**

- Create: `src/router/executionPolicy.ts`
- Create: `src/router/executionPolicy.test.ts`
- Modify: `src/router/router.tsx`
- Modify: `src/router/handler.tsx`
- Modify: `src/handlers/index.tsx`
- Modify: `src/runnable/index.tsx`
- Modify: `src/index.ts`

- [ ] **Step 1: Write recursive-policy tests**

Build a root, nested branch, default host, and leaf; assert every compiled `Command` uses injected
writers, suppressed `outputError`, and a throwing exit override. Cover pinned codes:

```ts
const successfulCodes = new Set(["commander.help", "commander.helpDisplayed", "commander.version"]);
const usageCodes = new Set([
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.missingArgument",
  "commander.excessArguments",
  "commander.invalidArgument",
]);
```

Tests must prove `help <command>` succeeds, malformed dynamic input never reaches Commander's raw
writer, and no compiled node can call `process.exit`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/router/executionPolicy.test.ts
```

- [ ] **Step 3: Implement and inject the policy**

Define:

```ts
export type CommanderExitOutcome =
  | Readonly<{ kind: "success" }>
  | Readonly<{ kind: "usage"; code: string }>
  | Readonly<{ kind: "internal" }>;

export interface CommanderExecutionPolicy {
  configure(command: Command): void;
  classify(error: CommanderError): CommanderExitOutcome;
}
```

`compile()` must call `policy.configure(c)` immediately after every `new Command`, before adding
arguments, options, actions, defaults, or children. Thread the same invocation-owned policy through
the full recursive walk. Update root composition to construct the stream supervisor and policy once.

- [ ] **Step 4: Verify router and subprocess behavior**

```bash
bun test src/router src/runnable
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/router src/runnable src/handlers/index.tsx src/index.ts
git commit -m "refactor: enforce recursive Commander execution policy"
```

## Task 5: Implement Mutation Execution And Presentation Supervisors

**Files:**

- Create: `src/runtime/mutation/executionSupervisor.ts`
- Create: `src/runtime/mutation/presentationSupervisor.ts`
- Create: `src/runtime/mutation/coordinator.ts`
- Create: `src/runtime/mutation/supervisors.test.ts`

- [ ] **Step 1: Write state-machine tests**

Test exact transitions:

```text
idle -> active(none) -> active(outcomeUnknown) -> active(committed) -> settled
settled -> presenting(commander|ink) -> retired
```

Cover synchronous registration, `busy`, repeated `settle`, foreign/stale/cross-kind receipts, one
Commander receipt, finite Ink frame epochs, high-water quiescence, exit fallback, and certainty-derived
guidance. A busy second pair must remain unchanged and must not inherit the active scope's certainty.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/runtime/mutation/supervisors.test.ts
```

- [ ] **Step 3: Implement consumer-owned ports and private coordinator**

Expose only the closed interfaces:

```ts
export type MutationCertainty = "none" | "outcomeUnknown" | "committed";

export type MutationActivationOutcome<W> =
  | Readonly<{ kind: "activated"; execution: ActiveMutationExecution<W> }>
  | Readonly<{ kind: "busy" }>;

export interface MutationExecutionSupervisorPort {
  activate<W extends MutationWorkflowId>(
    workflow: W,
    planToken: MutationPlanToken<W>,
  ): MutationActivationOutcome<W>;
}

export interface MutationPresentationSupervisorPort {
  beginCommander<W>(settled: SettledMutationExecution<W>): MutationPresentationBeginOutcome<W>;
  beginInk<W>(settled: SettledMutationExecution<W>): MutationPresentationBeginOutcome<W>;
  finish(receipt: MutationPresentationReceipt): MutationPresentationFinishOutcome;
}
```

Keep all constructors, certainty views, and mutation writers module-private. The public
`MutationExecutionSupervisorPort` has no `view()` method, and `ActiveMutationExecution` provides no
mark method; only a closure given to the exact binding facade may advance certainty.

- [ ] **Step 4: Verify supervisors**

```bash
bun test src/runtime/mutation/supervisors.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/mutation
git commit -m "feat: add correlated mutation execution supervisors"
```

## Task 6: Foundation Regression Gate

**Files:**

- Test: all files touched by this plan

- [ ] **Step 1: Run the full local gate**

```bash
bun test
bun run build
bun run format:check
bun run verify:tsc
git diff --check
```

Expected: all tests/build/format pass and TypeScript matches the exact allowlist with zero diagnostics
in touched files.

- [ ] **Step 2: Run two independent reviews**

Run `openai.gpt-5.6-sol` spec-compliance and code-quality/security reviews against the plan's base/head
SHAs. Fix and repeat until both pass.

- [ ] **Step 3: Push**

```bash
git push -u origin feat/identity-cli
```
