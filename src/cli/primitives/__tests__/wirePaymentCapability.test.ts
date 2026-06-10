import type { AgentCoreProjectSpec } from '../../../schema';
import { PaymentManagerPrimitive } from '../PaymentManagerPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports are processed
// ---------------------------------------------------------------------------
const {
  mockFindConfigRoot,
  mockReadProjectSpec,
  mockWriteProjectSpec,
  mockExistsSync,
  mockMkdirSync,
  mockCopyFileSync,
  mockWriteFileSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockFindConfigRoot: vi.fn().mockReturnValue('/project/agentcore'),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = vi.fn().mockReturnValue(true);
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: mockFindConfigRoot,
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    removeEnvVars: vi.fn().mockResolvedValue(undefined),
    toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    serializeResult: (r: unknown) => r,
    ResourceNotFoundError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ResourceNotFoundError';
      }
    },
  };
});

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
}));

vi.mock('../../templates/templateRoot', () => ({
  getTemplatePath: (...segments: string[]) => `/cli-templates/${segments.join('/')}`,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid AgentCoreProjectSpec with one runtime at the given codeLocation.
 * Defaults to a Python HTTP runtime so the payment-eligibility gate accepts it.
 * Tests that need to exercise the gate's reject path can pass overrides.
 */
function makeProject(codeLocation: string, runtimeOverrides: Record<string, unknown> = {}): AgentCoreProjectSpec {
  return {
    name: 'test-project',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [
      {
        name: 'my-agent',
        build: 'CodeZip' as const,
        entrypoint: 'main.py:handler' as any,
        codeLocation: codeLocation as any,
        ...runtimeOverrides,
      },
    ],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
    abTests: [],
    httpGateways: [],
    harnesses: [],
    payments: [],
  };
}

/** Absolute agent directory derived from project root + codeLocation */
const PROJECT_ROOT = '/project';
const CODE_LOCATION = 'agents/my-agent';
const AGENT_DIR = `${PROJECT_ROOT}/${CODE_LOCATION}`;
const CAP_DIR = `${AGENT_DIR}/capabilities/payments`;
const PAYMENTS_PY_DEST = `${CAP_DIR}/payments.py`;
const PAYMENTS_PY_SRC = `/cli-templates/python/http/strands/capabilities/payments/payments.py`;
const TEMPLATE_DIR = `/cli-templates/python/http/strands/capabilities/payments`;
const MAIN_PY = `${AGENT_DIR}/main.py`;
const CAP_INIT = `${CAP_DIR}/__init__.py`;
const PARENT_INIT = `${AGENT_DIR}/capabilities/__init__.py`;

/** Default add options that skip duplicate/CUSTOM_JWT guards */
const ADD_OPTIONS = {
  name: 'payments-mgr',
  authorizerType: 'AWS_IAM' as const,
};

/** Call primitive.add() which internally calls wirePaymentCapability() for every runtime */
async function callAdd(primitive: PaymentManagerPrimitive, project: AgentCoreProjectSpec) {
  mockReadProjectSpec.mockResolvedValue(project);
  return primitive.add(ADD_OPTIONS);
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------
describe('wirePaymentCapability (via PaymentManagerPrimitive.add)', () => {
  let primitive: PaymentManagerPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    primitive = new PaymentManagerPrimitive();

    // Default: template directory exists, cap dir does NOT yet exist (so we proceed)
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEMPLATE_DIR) return true;
      if (p === PAYMENTS_PY_DEST) return false; // not yet copied — trigger wiring
      return false; // everything else absent by default
    });

    // readFileSync returns a minimal main.py by default (overridden per test)
    mockReadFileSync.mockReturnValue('');
  });

  // =========================================================================
  // Test 1 – Template agent: get_or_create_agent() pattern
  // =========================================================================
  describe('template agent with get_or_create_agent() pattern', () => {
    const templateMain = [
      'import os',
      'from strands import Agent, tool',
      '',
      '_agent = None',
      '',
      'def get_or_create_agent():',
      '    global _agent',
      '    if _agent is None:',
      '        _agent = Agent(',
      '            model=load_model(),',
      '            system_prompt="You are helpful.",',
      '            tools=tools,',
      '        )',
      '    return _agent',
      '',
      '@app.entrypoint',
      'async def invoke(payload, context):',
      '    agent = get_or_create_agent()',
      '    stream = agent.stream_async(payload.get("prompt"))',
      '    async for event in stream:',
      '        yield event',
    ].join('\n');

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(templateMain);
    });

    it('replaces "agent = get_or_create_agent()" with per-invocation plugin block', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      expect(mockWriteFileSync).toHaveBeenCalledWith(MAIN_PY, expect.any(String));
      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // Original call is gone
      expect(written).not.toContain('agent = get_or_create_agent()');

      // Per-invocation plugin block inserted
      expect(written).toContain('user_id = payload.get("user_id")');
      expect(written).toContain('instrument_id = payload.get("payment_instrument_id")');
      expect(written).toContain('session_id = payload.get("payment_session_id")');
      expect(written).toContain('payments_plugin = create_payments_plugin(user_id, instrument_id, session_id)');
      expect(written).toContain('plugins = [payments_plugin] if payments_plugin else []');

      // Replacement spawns a new Agent() constructor
      expect(written).toContain('agent = Agent(');
      expect(written).toContain('plugins=plugins,');

      // Import line inserted
      expect(written).toContain('from capabilities.payments.payments import create_payments_plugin');
    });

    it('inserts the import near the top of the file (before any function or class definition)', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // The payment import is inserted at the top after any docstring /
      // `from __future__` block. It must land BEFORE the first function /
      // entrypoint definition. (Note the cached `_agent = None` line is
      // removed by the singleton-removal pass, so we anchor on @app.entrypoint.)
      const pluginImportPos = written.indexOf('from capabilities.payments.payments import create_payments_plugin');
      const entrypointPos = written.indexOf('@app.entrypoint');
      expect(pluginImportPos).toBeGreaterThanOrEqual(0);
      expect(entrypointPos).toBeGreaterThan(pluginImportPos);
    });
  });

  // =========================================================================
  // Test 2 – BYO agent: Agent() constructor present but no get_or_create_agent
  // =========================================================================
  describe('BYO agent with existing Agent() constructor', () => {
    const byoMain = [
      'import os',
      'from strands import Agent, tool',
      '',
      '@app.entrypoint',
      'async def invoke(payload, context):',
      '    agent = Agent(',
      '        model="anthropic.claude-3-5-sonnet-20241022-v2:0",',
      '        system_prompt="You are a payment assistant.",',
      '        tools=my_tools,',
      '    )',
      '    stream = agent.stream_async(payload.get("prompt"))',
      '    async for event in stream:',
      '        yield event',
    ].join('\n');

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(byoMain);
    });

    it('inserts plugin setup block before the existing Agent() constructor', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // Plugin setup block is present
      expect(written).toContain('user_id = payload.get("user_id")');
      expect(written).toContain('payments_plugin = create_payments_plugin(user_id, instrument_id, session_id)');
      expect(written).toContain('plugins = [payments_plugin] if payments_plugin else []');

      // Plugin setup appears before Agent(
      const pluginPos = written.indexOf('payments_plugin = create_payments_plugin');
      const agentPos = written.indexOf('agent = Agent(');
      expect(pluginPos).toBeGreaterThanOrEqual(0);
      expect(agentPos).toBeGreaterThan(pluginPos);
    });

    it('adds TODO comment to add plugins= to existing Agent() constructor', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      expect(written).toContain('# TODO: Add plugins=plugins to your Agent() constructor below');
    });

    it('inserts the payment import line', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      expect(written).toContain('from capabilities.payments.payments import create_payments_plugin');
    });
  });

  // =========================================================================
  // Test 3 – Minimal agent: no known pattern
  // =========================================================================
  describe('minimal agent with neither get_or_create_agent nor Agent() pattern', () => {
    const minimalMain = ['from strands import Agent', '', 'def h(e, c): pass'].join('\n');

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(minimalMain);
    });

    it('adds the import line at the top when there are no existing imports', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      expect(written).toContain('from capabilities.payments.payments import create_payments_plugin');
    });

    it('does NOT insert a plugin block when no known agent pattern found', async () => {
      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      expect(result.success).toBe(true);

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // No plugin setup injected
      expect(written).not.toContain('payments_plugin = create_payments_plugin');
      expect(written).not.toContain('plugins = [payments_plugin]');
    });
  });

  // =========================================================================
  // Test 4 – Idempotency: running twice doesn't double-add imports
  // =========================================================================
  describe('idempotency', () => {
    it('does not re-process main.py when payments.py already exists in cap dir', async () => {
      // Simulate already-wired state: payments.py already present
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return true; // already wired
        return false;
      });
      mockReadFileSync.mockReturnValue(
        'from capabilities.payments.payments import create_payments_plugin\ndef h(e,c): pass'
      );

      // First add
      const project = makeProject(CODE_LOCATION);
      await callAdd(primitive, project);

      // Second add (simulate calling add again with updated project that now has the payment manager)
      const _projectWithManager: AgentCoreProjectSpec = {
        ...project,
        payments: [
          {
            name: ADD_OPTIONS.name,
            authorizerType: ADD_OPTIONS.authorizerType,
            autoPayment: true,
            defaultSpendLimit: '10.00',
            connectors: [],
          },
        ],
      };
      // Reset the mock to allow the second write to the project spec
      mockWriteProjectSpec.mockResolvedValue(undefined);
      // But now payments already exist, so checkDuplicate will reject it
      // Instead test that writeFileSync on main.py is never called when payments.py already exists
      vi.clearAllMocks();
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return true; // already present
        return false;
      });
      mockReadProjectSpec.mockResolvedValue({ ...project, payments: [] });

      await primitive.add(ADD_OPTIONS);

      // wirePaymentCapability exits early (payments.py already exists), so main.py never written
      const mainPyWrite = mockWriteFileSync.mock.calls.find((c: unknown[]) => (c[0] as string) === MAIN_PY);
      expect(mainPyWrite).toBeUndefined();
    });

    it('does not double-add import if create_payments_plugin already in main.py', async () => {
      const alreadyPatched = [
        'from strands import Agent',
        'from capabilities.payments.payments import create_payments_plugin',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    payments_plugin = create_payments_plugin("u", None, None)',
        '    pass',
      ].join('\n');

      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false; // cap dir missing — enter wiring
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(alreadyPatched);

      await callAdd(primitive, makeProject(CODE_LOCATION));

      // main.py must NOT be written because create_payments_plugin already present
      const mainPyWrite = mockWriteFileSync.mock.calls.find((c: unknown[]) => (c[0] as string) === MAIN_PY);
      expect(mainPyWrite).toBeUndefined();
    });
  });

  // =========================================================================
  // Test 5 – capabilities/payments/ directory created and payments.py copied
  // =========================================================================
  describe('capabilities/payments/ directory and payments.py', () => {
    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      // Strands main.py — passes the framework gate; pattern doesn't match
      // either get_or_create or Agent() so file write is skipped, but cap dir
      // setup still runs.
      mockReadFileSync.mockReturnValue('from strands import Agent\n\ndef h(e, c): pass\n');
    });

    it('creates capabilities/payments/ directory with recursive flag', async () => {
      await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(mockMkdirSync).toHaveBeenCalledWith(CAP_DIR, { recursive: true });
    });

    it('copies payments.py from template to capabilities/payments/', async () => {
      await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(mockCopyFileSync).toHaveBeenCalledWith(PAYMENTS_PY_SRC, PAYMENTS_PY_DEST);
    });

    it('skips wiring entirely when template directory does not exist', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === TEMPLATE_DIR) return false; // template missing
        return false;
      });

      await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Test 6 – capabilities/__init__.py created if missing
  // =========================================================================
  describe('__init__.py creation', () => {
    beforeEach(() => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false; // init files absent
      });
      // Strands main.py to pass the framework gate
      mockReadFileSync.mockReturnValue('from strands import Agent\n\ndef h(e, c): pass\n');
    });

    it('creates capabilities/payments/__init__.py when absent', async () => {
      await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(mockWriteFileSync).toHaveBeenCalledWith(CAP_INIT, '');
    });

    it('creates capabilities/__init__.py when absent', async () => {
      await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(mockWriteFileSync).toHaveBeenCalledWith(PARENT_INIT, '');
    });

    it('does not overwrite capabilities/payments/__init__.py when it already exists', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        if (p === CAP_INIT) return true; // already exists
        if (p === PARENT_INIT) return true; // already exists
        return false;
      });
      mockReadFileSync.mockReturnValue('from strands import Agent\n\ndef h(e, c): pass\n');

      await callAdd(primitive, makeProject(CODE_LOCATION));

      const initWrites = mockWriteFileSync.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === CAP_INIT || (c[0] as string) === PARENT_INIT
      );
      expect(initWrites).toHaveLength(0);
    });
  });

  // =========================================================================
  // Test 7 – Import line inserted at the correct position
  // =========================================================================
  describe('import line position', () => {
    it('inserts at the top of the file regardless of existing imports', async () => {
      const main = [
        'import os',
        'import logging',
        'from strands import Agent, tool',
        'from bedrock_agentcore.runtime import BedrockAgentCoreApp',
        '',
        'app = BedrockAgentCoreApp()',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    pass',
      ].join('\n');

      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      const pluginImport = 'from capabilities.payments.payments import create_payments_plugin';
      const firstUserImport = 'import os';

      // Import lands at the very top of the file (no docstring / __future__
      // here), BEFORE any user-level import. This is intentional: trying to
      // splice into the middle of a possibly multi-line import block is the
      // bug R-13-1 was filed against.
      const pluginImportPos = written.indexOf(pluginImport);
      const firstUserImportPos = written.indexOf(firstUserImport);
      expect(pluginImportPos).toBe(0);
      expect(firstUserImportPos).toBeGreaterThan(pluginImportPos);
    });

    it('handles parenthesised multi-line `from x import (...)` blocks without splicing', async () => {
      // The pre-fix bug (R-13-1): a multi-line parenthesised import would have
      // its first physical line picked up by the regex, then the payment
      // import was inserted INSIDE the still-open parentheses, producing a
      // SyntaxError. After R-13-1 we never insert mid-import.
      const main = [
        'from strands import (',
        '    Agent,',
        '    tool,',
        '    HookProvider,',
        ')',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));
      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // The parenthesised block must remain intact; no insertion inside it.
      expect(written).toContain('from strands import (\n    Agent,\n    tool,\n    HookProvider,\n)');
      // Payment import is at the top, before the strands block.
      const pluginPos = written.indexOf('from capabilities.payments.payments import create_payments_plugin');
      const strandsPos = written.indexOf('from strands import (');
      expect(pluginPos).toBe(0);
      expect(strandsPos).toBeGreaterThan(pluginPos);
    });

    it('handles `agent = get_or_create_agent()` with a trailing `# type: ignore` comment', async () => {
      // R-13-2: prior regex required `\s*$` after the call which excluded
      // any trailing comment. PEP-484-style `# type: ignore` is common.
      const main = [
        'from strands import Agent',
        '',
        '_agent = None',
        '',
        'def get_or_create_agent():',
        '    global _agent',
        '    if _agent is None:',
        '        _agent = Agent(model=load_model(), tools=tools)',
        '    return _agent',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    agent = get_or_create_agent()  # type: ignore',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));
      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // Original call site is replaced (with or without the comment) and the
      // plugin block is injected.
      expect(written).not.toContain('agent = get_or_create_agent()  # type: ignore');
      expect(written).toContain('payments_plugin = create_payments_plugin');
      expect(written).toContain('agent = Agent(');
    });

    it('handles `_agent: Agent | None = None` (typed annotation form) when removing the singleton', async () => {
      const main = [
        'from strands import Agent',
        '',
        '_agent: "Agent | None" = None',
        '',
        'def get_or_create_agent():',
        '    global _agent',
        '    if _agent is None:',
        '        _agent = Agent(model=load_model(), tools=tools)',
        '    return _agent',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    agent = get_or_create_agent()',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));
      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      // The annotated singleton must be removed alongside its function — not
      // left orphaned at module scope.
      expect(written).not.toContain('_agent: "Agent | None" = None');
      expect(written).not.toContain('def get_or_create_agent');
    });

    it('aborts (throws) if call-site replaced but singleton has unrecognised shape', async () => {
      // Hand-crafted main where `agent = get_or_create_agent()` matches but the
      // singleton uses a shape we cannot parse — emit a clean error rather than
      // ship corrupted code.
      const main = [
        'from strands import Agent',
        '',
        // Lambda-style singleton — not the recognised `_agent = None` shape.
        '_agent = (lambda: None)()',
        '',
        'def get_or_create_agent():',
        '    return _agent',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    agent = get_or_create_agent()',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      const result = await callAdd(primitive, makeProject(CODE_LOCATION));
      // The add call surfaces the error; we want a clean failure, not silent
      // corruption.
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('main.py');
      }
    });

    it('S-02-1: re-add after remove still patches main.py when payments.py already exists', async () => {
      // Simulate a re-add where capabilities/payments/payments.py was left
      // behind by the previous add (remove() does not delete it). main.py
      // does NOT yet contain `create_payments_plugin` — must still be patched.
      const main = [
        'from strands import Agent',
        '',
        '_agent = None',
        '',
        'def get_or_create_agent():',
        '    global _agent',
        '    if _agent is None:',
        '        _agent = Agent(model=load_model(), tools=tools)',
        '    return _agent',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    agent = get_or_create_agent()',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return true; // left behind from prior add
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));

      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;
      // main.py was patched even though payments.py was already present.
      expect(written).toContain('create_payments_plugin');
      expect(written).toContain('payments_plugin = create_payments_plugin');
      // payments.py was NOT re-copied (idempotency on the file).
      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });

    it('inserts after a module docstring and `from __future__` block', async () => {
      const main = [
        '"""Module docstring."""',
        'from __future__ import annotations',
        '',
        'from strands import Agent',
        '',
        '@app.entrypoint',
        'async def invoke(payload, context):',
        '    pass',
      ].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(main);

      await callAdd(primitive, makeProject(CODE_LOCATION));
      const written: string = mockWriteFileSync.mock.calls.find(
        (c: unknown[]) => (c[0] as string) === MAIN_PY
      )![1] as string;

      const docstringPos = written.indexOf('"""Module docstring."""');
      const futurePos = written.indexOf('from __future__ import annotations');
      const pluginPos = written.indexOf('from capabilities.payments.payments import create_payments_plugin');
      // Docstring and __future__ must remain before the new import.
      expect(docstringPos).toBe(0);
      expect(futurePos).toBeLessThan(pluginPos);
      // Payment import lands BEFORE the user's `from strands import` (which
      // is fine — Python doesn't care about the order of regular imports).
      const strandsPos = written.indexOf('from strands import Agent');
      expect(pluginPos).toBeLessThan(strandsPos);
    });

    // Note: the "no existing imports" case is no longer reachable since
    // wirePaymentCapability requires `from strands import` to detect the
    // framework before wiring. A main.py with zero imports cannot be a
    // Strands template and is correctly skipped by the framework gate
    // (covered by the framework-gate tests below).
  });

  // =========================================================================
  // Test 8 – Framework gate: skip non-Strands runtimes
  // =========================================================================
  describe('framework gate (non-Strands runtimes)', () => {
    /**
     * Each fixture is a snippet from one of the templates we ship. The
     * shared expectation is the same for all: when main.py is NOT a Strands
     * agent, wirePaymentCapability must NOT touch the filesystem at all
     * (no cap dir, no payments.py copy, no main.py rewrite). The success
     * result still returns true and lists the runtime name in skippedRuntimes.
     */
    const fixtures: { framework: string; main: string }[] = [
      {
        framework: 'LangChain_LangGraph',
        main: [
          'import os',
          'from langchain_core.messages import HumanMessage',
          'from langgraph.prebuilt import create_react_agent',
          'from bedrock_agentcore.runtime import BedrockAgentCoreApp',
          '',
          'app = BedrockAgentCoreApp()',
          '',
          '@app.entrypoint',
          'async def invoke(payload, context):',
          '    pass',
        ].join('\n'),
      },
      {
        framework: 'GoogleADK',
        main: [
          'import os',
          'from google.adk.agents import Agent',
          'from google.adk.runners import Runner',
          'from bedrock_agentcore.runtime import BedrockAgentCoreApp',
          '',
          'app = BedrockAgentCoreApp()',
        ].join('\n'),
      },
      {
        framework: 'OpenAIAgents',
        main: [
          'import os',
          'from agents import Agent, Runner',
          'from bedrock_agentcore.runtime import BedrockAgentCoreApp',
          '',
          'app = BedrockAgentCoreApp()',
        ].join('\n'),
      },
      {
        framework: 'AutoGen',
        main: [
          'import os',
          'from autogen_agentchat.agents import AssistantAgent',
          'from bedrock_agentcore.runtime import BedrockAgentCoreApp',
          '',
          'app = BedrockAgentCoreApp()',
        ].join('\n'),
      },
    ];

    for (const fixture of fixtures) {
      it(`does not wire payments into ${fixture.framework} main.py`, async () => {
        mockExistsSync.mockImplementation((p: string) => {
          if (p === TEMPLATE_DIR) return true;
          if (p === PAYMENTS_PY_DEST) return false;
          if (p === MAIN_PY) return true;
          return false;
        });
        mockReadFileSync.mockReturnValue(fixture.main);

        const result = await callAdd(primitive, makeProject(CODE_LOCATION));

        // add() still succeeds — the manager goes into agentcore.json
        expect(result.success).toBe(true);

        // No filesystem mutations to the agent's source tree
        expect(mockMkdirSync).not.toHaveBeenCalled();
        expect(mockCopyFileSync).not.toHaveBeenCalled();
        const mainPyWrite = mockWriteFileSync.mock.calls.find((c: unknown[]) => (c[0] as string) === MAIN_PY);
        expect(mainPyWrite).toBeUndefined();
        const capInitWrite = mockWriteFileSync.mock.calls.find(
          (c: unknown[]) => (c[0] as string) === CAP_INIT || (c[0] as string) === PARENT_INIT
        );
        expect(capInitWrite).toBeUndefined();

        // Runtime name surfaced for the CLI to warn the user
        if (result.success) {
          expect(result.skippedRuntimes).toContain('my-agent');
        }
      });
    }

    it('skips wiring when main.py is missing entirely (cannot detect framework)', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return false;
        return false;
      });

      const result = await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(result.success).toBe(true);
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockCopyFileSync).not.toHaveBeenCalled();
      if (result.success) {
        expect(result.skippedRuntimes).toContain('my-agent');
      }
    });

    it('still wires when "from strands" appears in a Strands-typed main.py', async () => {
      const strandsMain = ['from strands import Agent', '', '@app.entrypoint', 'def h(p, c):', '    pass'].join('\n');
      mockExistsSync.mockImplementation((p: string) => {
        if (p === TEMPLATE_DIR) return true;
        if (p === PAYMENTS_PY_DEST) return false;
        if (p === MAIN_PY) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(strandsMain);

      const result = await callAdd(primitive, makeProject(CODE_LOCATION));

      expect(result.success).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith(CAP_DIR, { recursive: true });
      expect(mockCopyFileSync).toHaveBeenCalledWith(PAYMENTS_PY_SRC, PAYMENTS_PY_DEST);
      if (result.success) {
        expect(result.skippedRuntimes).toEqual([]);
      }
    });
  });
});
