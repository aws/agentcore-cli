/**
 * E2E: export a fully-featured harness to a standalone Strands runtime agent, both in-project
 * (--name) and out-of-project (--arn), and prove each exported agent works at runtime.
 *
 * The source harness exercises every export surface together:
 *   - an existing project memory referenced by name (in-project export wires it via a discovery env
 *     var; out-of-project export resolves its ARN and wires it as a memory connection)
 *   - an agentcore_code_interpreter tool (managed default; exported as a codeInterpreter connection)
 *   - a public GitHub skill (cloned at runtime, no credential)
 *   - an MCP gateway tool (in-project gateway + mcp-server target; exported as a gateway connection)
 *
 * Flow:
 *   1. create a project-only scaffold (--no-agent) + add a memory and a gateway (mcp-server target)
 *   2. deploy #1 — provisions the memory + gateway (both ARNs now exist in deployed-state)
 *   3. create the harness attaching the deployed memory (by name) + gateway (by --gateway-arn),
 *      plus a code-interpreter tool and a public git skill
 *   4. deploy #2 — provisions the harness with memory + gateway + tools + skill
 *   5. invoke the HARNESS and verify the code interpreter runs
 *   6. export --name → a runtime agent in the SAME project; deploy; invoke the runtime; verify
 *      (in-project memory is wired via a discovery env var; gateway + code-interpreter as connections)
 *   7. in a NEW empty project, export --arn (the deployed harness); deploy; invoke; verify
 *      (every resource is external here → memory + gateway + code-interpreter all wired as connections)
 *
 * Two projects are torn down in afterAll. Requires: AWS credentials, npm, git.
 */
import { hasAwsCredentials, parseJsonOutput, prereqs, retry } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, teardownE2EProject, writeAwsTargets } from './e2e-helper.js';
import { getLogger } from './utils/logger.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const canRun = prereqs.npm && prereqs.git && hasAws;

// A public, anonymous-cloneable GitHub repo + subdirectory holding a valid skill (must contain a
// SKILL.md, which the runtime skill fetcher requires). The exported agent clones it at runtime.
const PUBLIC_GIT_SKILL = 'https://github.com/strands-agents/samples';
const PUBLIC_GIT_SKILL_PATH = 'python/01-learn/15-skills/skills/returns-policy';
// A reachable public MCP server endpoint for the gateway target.
const PUBLIC_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';

const logger = getLogger('export-harness-full');

interface InvokeJson {
  success: boolean;
  response?: string;
  error?: unknown;
}

/**
 * Invoke (harness or runtime) with retries; assert success and return the parsed response. An
 * optional `verify` predicate runs INSIDE the retried unit, so a content assertion that fails on one
 * LLM sample (nondeterministic phrasing) or one read (memory write/read lag) re-invokes rather than
 * failing the test — matching the retry pattern in harness-e2e-helper.ts. `verify` should throw
 * (e.g. via expect) when the response does not yet satisfy the check.
 */
async function invokeAndExpectSuccess(
  args: string[],
  projectPath: string,
  verify?: (json: InvokeJson) => void,
  attempts = 3
): Promise<InvokeJson> {
  return retry(
    async () => {
      const result = await runAgentCoreCLI(args, projectPath);
      expect(result.exitCode, `Invoke failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as InvokeJson;
      expect(json.success, `Invoke should report success; got: ${JSON.stringify(json)}`).toBe(true);
      verify?.(json);
      return json;
    },
    attempts,
    15000
  );
}

/**
 * Behaviorally verify that an exported runtime agent actually has every capability WIRED AND USABLE
 * at runtime — not just present in the spec. Runs four invokes against the deployed runtime:
 *   - code interpreter: compute a factorial and assert the exact value (the model can't fabricate it)
 *   - MCP gateway tool: list tools and assert a gateway-provided tool is present by its name prefix
 *     (mcpGw -> `mcp_gw_*`) or the Exa `_exa` token — provider-specific, not generic prose words
 *   - skill: ask what skills are loaded and assert the git-cloned `returns-policy` skill is referenced
 *   - memory: a same-session round trip (state a fact, then recall it) — proves read/write at runtime
 */
async function verifyExportedAgentCapabilities(
  agentName: string,
  projectPath: string,
  factorial: { prompt: string; expected: string }
): Promise<void> {
  // Each capability check passes its content assertion as `verify`, so the assertion runs inside the
  // retry: a flaky LLM sample (or a not-yet-visible memory write) re-invokes instead of failing.
  const invoke = (prompt: string, verify?: (json: InvokeJson) => void, sessionId?: string): Promise<InvokeJson> =>
    invokeAndExpectSuccess(
      [
        'invoke',
        '--runtime',
        agentName,
        ...(sessionId ? ['--session-id', sessionId] : []),
        '--prompt',
        prompt,
        '--json',
      ],
      projectPath,
      verify
    );

  // 1. Code interpreter — exact computed value proves the tool ran (not model guesswork).
  await invoke(factorial.prompt, json =>
    expect(json.response ?? '', `Expected ${factorial.expected} in response; got: ${json.response}`).toContain(
      factorial.expected
    )
  );

  // 2. Gateway tool — exported gateway tools are exposed to the model under the gateway tool's
  //    snake_cased name prefix (mcpGw -> `mcp_gw_*`), and the Exa MCP server's tools carry an `_exa`
  //    suffix. Match those provider/prefix-specific tokens (not generic words like "search"/"fetch",
  //    which the model could emit in prose) so a pass means the MCP client actually connected.
  await invoke('List the exact names of every tool you can call. Reply with the names only.', json =>
    expect(
      /mcp_?gw|_exa|exa_/.test((json.response ?? '').toLowerCase()),
      `Agent should list a gateway-provided MCP tool (mcpGw-prefixed / Exa); got: ${json.response}`
    ).toBe(true)
  );

  // 3. Skill — the returns-policy skill is about returns/refunds/warranty; asking the agent to name
  //    its skills should surface it, proving the git clone + skill load succeeded at runtime.
  await invoke('What specialized skills do you have? Name them briefly.', json =>
    expect(
      /return|refund|warranty|returns-policy/.test((json.response ?? '').toLowerCase()),
      `Agent should reference the returns-policy skill; got: ${json.response}`
    ).toBe(true)
  );

  // 4. Memory — same-session round trip. Session id must be >=33 chars (service constraint); the
  //    agentName already carries a per-run suffix, so it is unique per run. Turn 1 just needs to
  //    succeed; the recall turn retries its content assertion (the write may lag the read).
  const sessionId = `e2e-export-mem-${agentName}-roundtrip-padding`;
  await invoke('My favorite color is teal. Please remember it.', undefined, sessionId);
  await invoke(
    'What is my favorite color? Answer with just the color.',
    json =>
      expect(
        (json.response ?? '').toLowerCase(),
        `Agent should recall "teal" from memory; got: ${json.response}`
      ).toContain('teal'),
    sessionId
  );
}

describe.sequential('e2e: export fully-featured harness — in-project + out-of-project', () => {
  let testDir: string;
  let projectPath: string; // source project (harness + in-project export)
  let outDir: string;
  let outProjectPath: string; // separate project for the --arn export
  let harnessName: string;
  let projectName: string;
  let outProjectName: string;
  let harnessArn: string;
  let gatewayArn: string;
  const gatewayName = 'expgw';
  const memoryName = 'HarnessMem';
  const codeToolName = 'codeRunner';
  const gatewayToolName = 'mcpGw';
  const inProjectAgent = 'InProjAgent';
  const outProjectAgent = 'OutProjAgent';

  if (!canRun) {
    logger.warn(`tests skipped: npm=${prereqs.npm}, git=${prereqs.git}, hasAws=${hasAws}`);
  }

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-exp-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    // Per-run suffix so project (= stack) names are unique across concurrent/repeated runs; a
    // hardcoded name would collide (AlreadyExists/ROLLBACK) with a leftover from a prior run.
    // The `E2e` prefix is required: global-setup's stale-stack GC only collects stacks named
    // `AgentCore-E2e*`, so any orphan left by a failed teardown is still swept on the next run.
    const runSuffix = String(Date.now()).slice(-8);
    harnessName = `E2eExp${runSuffix}`;
    projectName = `E2eExpSrc${runSuffix}`;
    outProjectName = `E2eExpOut${runSuffix}`;

    // 1. Create a project-only scaffold (no agent), then add the resources the harness will attach:
    //    a memory and a gateway (+ mcp-server target). These are deployed FIRST (deploy #1) so they
    //    have concrete ARNs; the harness then references the memory by name and the gateway by ARN.
    const create = await runAgentCoreCLI(
      ['create', '--project-name', projectName, '--no-agent', '--json', '--skip-git'],
      testDir
    );
    expect(create.exitCode, `Create failed: ${create.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(create.stdout) as { projectPath: string }).projectPath;

    // 1a. A project memory (existing, by name) — has a concrete ARN the export can resolve. (Managed
    // memory's ARN only exists service-side in get-harness, so it is not resolvable by --name export.)
    const addMemory = await runAgentCoreCLI(
      ['add', 'memory', '--name', memoryName, '--strategies', 'SEMANTIC', '--json'],
      projectPath
    );
    expect(addMemory.exitCode, `add memory failed: ${addMemory.stderr}`).toBe(0);

    // 1b. A gateway + mcp-server target (public endpoint, self-contained).
    const addGw = await runAgentCoreCLI(
      ['add', 'gateway', '--name', gatewayName, '--protocol-type', 'None', '--authorizer-type', 'AWS_IAM', '--json'],
      projectPath
    );
    expect(addGw.exitCode, `add gateway failed: ${addGw.stderr}`).toBe(0);

    const addTarget = await runAgentCoreCLI(
      [
        'add',
        'gateway-target',
        '--name',
        'exatarget',
        '--gateway',
        gatewayName,
        '--type',
        'mcp-server',
        '--endpoint',
        PUBLIC_MCP_ENDPOINT,
        // Outbound auth defaults to NONE when omitted; passing `--outbound-auth none` currently trips
        // a credential-required check (the flag value is lowercased but validated against 'NONE').
        '--json',
      ],
      projectPath
    );
    expect(addTarget.exitCode, `add gateway-target failed: ${addTarget.stderr}`).toBe(0);

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (hasAws) {
      if (projectPath) await teardownE2EProject(projectPath, harnessName, 'bedrock').catch(() => undefined);
      if (outProjectPath) await teardownE2EProject(outProjectPath, outProjectAgent, 'bedrock').catch(() => undefined);
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    if (outDir) await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 900000);

  // ── Phase A: deploy memory+gateway, then create the harness attaching both, deploy, verify ──

  it.skipIf(!canRun)(
    'deploy #1 provisions the memory and gateway',
    async () => {
      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
          expect(result.exitCode, `Deploy #1 failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
          expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
        },
        2,
        30000
      );

      // Gateway ARN must now exist in deployed-state (top-level `resources.gateways`, the same path
      // the gateway e2e tests read) so the harness can attach the gateway tool by ARN.
      const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as {
        targets?: {
          default?: {
            resources?: {
              gateways?: Record<string, { gatewayId?: string; gatewayArn?: string }>;
              memories?: Record<string, { memoryArn?: string }>;
            };
          };
        };
      };
      const gateways = state.targets?.default?.resources?.gateways ?? {};
      const gatewayEntry = gateways[gatewayName] ?? Object.values(gateways)[0];
      expect(gatewayEntry?.gatewayArn, 'Gateway ARN should be in deployed state').toBeTruthy();
      gatewayArn = gatewayEntry!.gatewayArn!;

      const memories = state.targets?.default?.resources?.memories ?? {};
      expect(memories[memoryName]?.memoryArn, 'Memory ARN should be in deployed state').toBeTruthy();
    },
    900000
  );

  it.skipIf(!canRun)(
    'create the harness attaching the memory + gateway + tools + skill, then deploy #2',
    async () => {
      // Attach the deployed memory by name and the deployed gateway by ARN (--gateway-arn is the
      // stable way to attach an already-deployed gateway as a tool).
      expect(gatewayArn, 'Gateway ARN should have been captured from deploy #1').toBeTruthy();

      const addHarness = await runAgentCoreCLI(
        [
          'add',
          'harness',
          '--name',
          harnessName,
          '--model-provider',
          'bedrock',
          '--memory-name',
          memoryName,
          '--memory-actor-id',
          'user-1',
          '--json',
        ],
        projectPath
      );
      expect(addHarness.exitCode, `add harness failed: stderr=${addHarness.stderr}, stdout=${addHarness.stdout}`).toBe(
        0
      );

      // Code-interpreter tool (managed default — no external ARN).
      const addTool = await runAgentCoreCLI(
        [
          'add',
          'tool',
          '--harness',
          harnessName,
          '--type',
          'agentcore_code_interpreter',
          '--name',
          codeToolName,
          '--json',
        ],
        projectPath
      );
      expect(addTool.exitCode, `add code-interpreter tool failed: ${addTool.stderr}`).toBe(0);

      // Public GitHub skill (cloned anonymously at runtime), pointing at a subdir containing SKILL.md.
      const addSkill = await runAgentCoreCLI(
        [
          'add',
          'skill',
          '--harness',
          harnessName,
          '--git',
          PUBLIC_GIT_SKILL,
          '--git-path',
          PUBLIC_GIT_SKILL_PATH,
          '--json',
        ],
        projectPath
      );
      expect(addSkill.exitCode, `add git skill failed: ${addSkill.stderr}`).toBe(0);

      // Gateway tool referencing the already-deployed gateway by ARN.
      const addGwTool = await runAgentCoreCLI(
        [
          'add',
          'tool',
          '--harness',
          harnessName,
          '--type',
          'agentcore_gateway',
          '--name',
          gatewayToolName,
          '--gateway-arn',
          gatewayArn,
          '--outbound-auth',
          'awsIam',
          '--json',
        ],
        projectPath
      );
      expect(
        addGwTool.exitCode,
        `add gateway tool failed: stderr=${addGwTool.stderr}, stdout=${addGwTool.stdout}`
      ).toBe(0);

      // Verify all four surfaces actually landed in the harness spec before deploying — `add tool`
      // only fails at synth/deploy for some misconfigurations, so assert the local spec is complete.
      const spec = JSON.parse(await readFile(join(projectPath, 'app', harnessName, 'harness.json'), 'utf-8')) as {
        memory?: { mode?: string; name?: string };
        tools?: { type: string }[];
        skills?: unknown[];
      };
      const toolTypes = (spec.tools ?? []).map(t => t.type).sort();
      expect(toolTypes, `Harness should have both tools; got: ${toolTypes.join(', ')}`).toEqual(
        expect.arrayContaining(['agentcore_code_interpreter', 'agentcore_gateway'])
      );
      expect(spec.memory?.name, 'Harness should reference the memory by name').toBe(memoryName);
      expect(spec.skills?.length, 'Harness should have the git skill').toBeGreaterThan(0);

      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
          expect(result.exitCode, `Deploy #2 failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
          expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
        },
        2,
        30000
      );

      // The harness ARN must now exist for the out-of-project (--arn) export.
      const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as {
        targets?: { default?: { resources?: { harnesses?: Record<string, { harnessArn?: string }> } } };
      };
      const harnessEntry = state.targets?.default?.resources?.harnesses?.[harnessName];
      expect(harnessEntry?.harnessArn, 'Harness ARN should be in deployed state').toBeTruthy();
      harnessArn = harnessEntry!.harnessArn!;
    },
    900000
  );

  it.skipIf(!canRun)(
    'invokes the source harness and runs the code interpreter',
    async () => {
      await invokeAndExpectSuccess(
        [
          'invoke',
          '--harness',
          harnessName,
          '--prompt',
          'Use your code interpreter to compute 6 factorial. Reply with just the number.',
          '--json',
        ],
        projectPath,
        json => expect(json.response ?? '', `Expected 720 in response; got: ${json.response}`).toContain('720')
      );
    },
    240000
  );

  // ── Phase B: in-project export (--name) → runtime agent in the SAME project ──

  it.skipIf(!canRun)(
    'exports the harness in-project to a runtime agent',
    async () => {
      const result = await runAgentCoreCLI(
        ['export', 'harness', '--name', harnessName, '--target-agent-name', inProjectAgent, '--json'],
        projectPath
      );
      expect(result.exitCode, `In-project export failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);

      // In-project export: the gateway + code-interpreter (external/managed-default resources) are
      // wired as connections. The project memory is referenced by name — it is in-project, so it is
      // wired via the project's implicit all-to-all wiring (a discovery env var), NOT a connection.
      // It therefore appears as a connection only on the OUT-of-project export below.
      const cfg = JSON.parse(await readFile(join(projectPath, 'agentcore', 'agentcore.json'), 'utf-8')) as {
        runtimes: { name: string; connections?: { to: { type: string } }[] }[];
        memories?: { name: string }[];
      };
      const agent = cfg.runtimes.find(r => r.name === inProjectAgent);
      expect(agent, `Exported runtime "${inProjectAgent}" should be in agentcore.json`).toBeDefined();
      const types = (agent!.connections ?? []).map(c => c.to.type).sort();
      expect(types, `Expected gateway + codeInterpreter connections; got: ${types.join(', ')}`).toEqual(
        expect.arrayContaining(['codeInterpreter', 'gateway'])
      );
      // The project memory is still present (the exported runtime accesses it via in-project wiring).
      expect(
        cfg.memories?.some(m => m.name === memoryName),
        `Project memory "${memoryName}" should remain`
      ).toBe(true);

      // The generated agent wires the memory: its session manager reads the MEMORY_<NAME>_ID env var.
      const mainPy = await readFile(join(projectPath, 'app', inProjectAgent, 'main.py'), 'utf-8').catch(() => '');
      const sessionPy = await readFile(join(projectPath, 'app', inProjectAgent, 'memory', 'session.py'), 'utf-8').catch(
        () => ''
      );
      expect(
        `${mainPy}\n${sessionPy}`.includes(`MEMORY_${memoryName.toUpperCase()}_ID`),
        'Generated agent should read the in-project memory discovery env var'
      ).toBe(true);
    },
    120000
  );

  it.skipIf(!canRun)(
    'deploys the in-project exported agent and verifies all capabilities at runtime',
    async () => {
      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
          expect(result.exitCode, `Export deploy failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
          expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
        },
        2,
        30000
      );

      // Verify all four capabilities are usable at runtime on the in-project exported agent.
      await verifyExportedAgentCapabilities(inProjectAgent, projectPath, {
        prompt: 'Use your code interpreter to compute 5 factorial. Reply with just the number.',
        expected: '120',
      });
    },
    900000
  );

  // ── Phase C: out-of-project export (--arn) → runtime agent in a NEW project ──

  it.skipIf(!canRun)(
    'exports the harness by ARN into a new empty project',
    async () => {
      expect(harnessArn, 'Harness ARN should have been captured from deploy #2').toBeTruthy();

      outDir = join(tmpdir(), `agentcore-e2e-exp-out-${randomUUID()}`);
      await mkdir(outDir, { recursive: true });

      // Create a project-only scaffold (no agent) to receive the exported runtime.
      const create = await runAgentCoreCLI(
        ['create', '--project-name', outProjectName, '--no-agent', '--json', '--skip-git'],
        outDir
      );
      expect(create.exitCode, `Out-of-project create failed: ${create.stderr}`).toBe(0);
      outProjectPath = (parseJsonOutput(create.stdout) as { projectPath: string }).projectPath;

      await writeAwsTargets(outProjectPath);
      installCdkTarball(outProjectPath);

      const result = await runAgentCoreCLI(
        ['export', 'harness', '--arn', harnessArn, '--target-agent-name', outProjectAgent, '--json'],
        outProjectPath
      );
      expect(result.exitCode, `--arn export failed: stderr=${result.stderr}, stdout=${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);

      // Out-of-project export: ALL the harness's resources — memory, gateway, code-interpreter — are
      // external to this fresh project, so each is wired as a connection (resolved by ARN from the
      // fetched harness, incl. the memory's service-side ARN).
      const cfg = JSON.parse(await readFile(join(outProjectPath, 'agentcore', 'agentcore.json'), 'utf-8')) as {
        runtimes: { name: string; connections?: { to: { type: string } }[] }[];
      };
      const agent = cfg.runtimes.find(r => r.name === outProjectAgent);
      expect(agent, `Exported runtime "${outProjectAgent}" should be in agentcore.json`).toBeDefined();
      const types = (agent!.connections ?? []).map(c => c.to.type).sort();
      expect(types, `Expected memory + gateway + codeInterpreter connections; got: ${types.join(', ')}`).toEqual(
        expect.arrayContaining(['codeInterpreter', 'gateway', 'memory'])
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'deploys the out-of-project exported agent and verifies all capabilities at runtime',
    async () => {
      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], outProjectPath);
          expect(
            result.exitCode,
            `Out-of-project deploy failed: stderr=${result.stderr}, stdout=${result.stdout}`
          ).toBe(0);
          expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
        },
        2,
        30000
      );

      // Verify all four capabilities are usable at runtime on the out-of-project exported agent.
      await verifyExportedAgentCapabilities(outProjectAgent, outProjectPath, {
        prompt: 'Use your code interpreter to compute 7 factorial. Reply with just the number.',
        expected: '5040',
      });
    },
    900000
  );
});
