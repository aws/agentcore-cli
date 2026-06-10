import type { InvokeContext } from '../action';
import { handleInvoke } from '../action';
import type { InvokeOptions } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock seam.
//
// The WARN footgun guard, the `resolvedPaymentUserId` resolution, and the
// auto-session user scoping all live in `handleInvoke` AFTER `resolveInvokeTarget`
// succeeds and require an HTTP agent. None of that is reachable through the
// `runCLI` integration harness without a real deployment (resolveInvokeTarget
// short-circuits on "no deployed targets" before the guard runs). So we mock the
// target resolver + the AWS calls and assert on the resolved-layer behavior.
// ---------------------------------------------------------------------------

const mockResolveInvokeTarget = vi.fn();
const mockGetOrCreatePaymentSession = vi.fn();
const mockInvokeAgentRuntime = vi.fn();
const mockInvokeAgentRuntimeStreaming = vi.fn();

// NOTE: vi.mock paths resolve relative to THIS test file (src/cli/commands/invoke/__tests__/),
// not relative to action.ts. action.ts's `../../aws` and `../../logging` therefore become
// `../../../aws` and `../../../logging` here, and `./resolve` becomes `../resolve`.
vi.mock('../resolve', () => ({
  resolveInvokeTarget: (...args: unknown[]) => mockResolveInvokeTarget(...args),
}));

vi.mock('../../../feature-flags', () => ({
  isPreviewEnabled: () => false,
}));

// Mock the entire aws barrel. Re-export the real DEFAULT_RUNTIME_USER_ID constant
// so the production fallback value stays in sync with the source of truth.
vi.mock('../../../aws', () => ({
  DEFAULT_RUNTIME_USER_ID: 'default-user',
  getOrCreatePaymentSession: (...args: unknown[]) => mockGetOrCreatePaymentSession(...args),
  invokeAgentRuntime: (...args: unknown[]) => mockInvokeAgentRuntime(...args),
  invokeAgentRuntimeStreaming: (...args: unknown[]) => mockInvokeAgentRuntimeStreaming(...args),
  // Unused-by-these-tests members the module also exports; stubbed so importing
  // the barrel does not blow up.
  buildAguiRunInput: vi.fn(),
  executeBashCommand: vi.fn(),
  invokeA2ARuntime: vi.fn(),
  invokeAguiRuntime: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpInitSession: vi.fn(),
  mcpListTools: vi.fn(),
}));

// InvokeLogger touches the filesystem on construction; replace with a no-op.
vi.mock('../../../logging', () => ({
  InvokeLogger: class {
    logFilePath = '/tmp/fake.log';
    logPrompt = vi.fn();
    logResponse = vi.fn();
    logError = vi.fn();
    logInfo = vi.fn();
  },
}));

const HTTP_AGENT = { name: 'TestAgent', protocol: 'HTTP' as const };

/** Build a successful resolveInvokeTarget result with an HTTP agent. */
function resolvedOk(overrides: Record<string, unknown> = {}) {
  return {
    success: true as const,
    agentSpec: HTTP_AGENT,
    targetName: 'default',
    targetConfig: { name: 'default', region: 'us-east-1' },
    region: 'us-east-1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    baggage: undefined,
    ...overrides,
  };
}

/** Minimal InvokeContext. `project.payments` controls the footgun guard. */
function makeContext(payments: { name: string; defaultSpendLimit?: number }[] = []): InvokeContext {
  return {
    project: { name: 'p', runtimes: [HTTP_AGENT], payments } as never,
    deployedState: {
      targets: {
        default: {
          resources: {
            payments: { pm1: { managerArn: 'arn:aws:bedrock-agentcore:us-east-1:123:payment-manager/pm1' } },
          },
        },
      },
    } as never,
    awsTargets: [{ name: 'default', region: 'us-east-1' }] as never,
  };
}

async function invoke(options: InvokeOptions, ctx: InvokeContext = makeContext()) {
  return handleInvoke(ctx, { prompt: 'hi', ...options });
}

describe('handleInvoke — payments', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockResolveInvokeTarget.mockResolvedValue(resolvedOk());
    mockInvokeAgentRuntime.mockResolvedValue({ content: 'ok', sessionId: 's' });
    mockGetOrCreatePaymentSession.mockResolvedValue('sess-new');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    stderrSpy.mockRestore();
  });

  function stderrText(): string {
    return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  // -------------------------------------------------------------------------
  // Footgun WARN: stderr-only, never hard-fails, never pollutes JSON stdout.
  // (This block also exercises resolvedPaymentUserId = paymentUserId ?? userId:
  // whether the warning fires is driven entirely by that resolution.)
  // -------------------------------------------------------------------------
  describe('footgun WARN', () => {
    it('warns (stderr) when project has payments but no resolved payments identity', async () => {
      const result = await invoke({}, makeContext([{ name: 'pm1' }]));
      expect(stderrText()).toContain('no --payment-user-id');
      expect(stderrText()).toContain('default-user');
      // Never hard-fails: invoke still succeeds.
      expect(result.success).toBe(true);
    });

    it('warns when a payment flag (--payment-instrument-id) is used without an identity', async () => {
      await invoke({ paymentInstrumentId: 'pi-1' }, makeContext([]));
      expect(stderrText()).toContain('no --payment-user-id');
    });

    it('warns when --auto-session is used without an identity', async () => {
      await invoke({ autoSession: true }, makeContext([]));
      expect(stderrText()).toContain('no --payment-user-id');
    });

    it('does NOT warn when a payments identity is resolved, even with payments enabled', async () => {
      await invoke({ paymentUserId: 'alice' }, makeContext([{ name: 'pm1' }]));
      expect(stderrText()).not.toContain('no --payment-user-id');
    });

    it('does NOT warn for a non-payments invoke with no payment flags', async () => {
      await invoke({}, makeContext([]));
      expect(stderrText()).not.toContain('no --payment-user-id');
    });
  });

  // -------------------------------------------------------------------------
  // Auto-session user scoping: getOrCreatePaymentSession is scoped to the SAME
  // identity the agent pays as (resolvedPaymentUserId ?? DEFAULT_RUNTIME_USER_ID).
  // -------------------------------------------------------------------------
  describe('--auto-session user scoping', () => {
    it('scopes the session to --payment-user-id when set', async () => {
      await invoke({ autoSession: true, paymentUserId: 'alice' }, makeContext([{ name: 'pm1' }]));
      expect(mockGetOrCreatePaymentSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice' }));
    });

    it('scopes the session to --user-id when --payment-user-id is omitted', async () => {
      await invoke({ autoSession: true, userId: 'bob' }, makeContext([{ name: 'pm1' }]));
      expect(mockGetOrCreatePaymentSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob' }));
    });

    it('falls back to DEFAULT_RUNTIME_USER_ID when neither identity is set', async () => {
      await invoke({ autoSession: true }, makeContext([{ name: 'pm1' }]));
      expect(mockGetOrCreatePaymentSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'default-user' }));
    });

    it('errors (not call getOrCreatePaymentSession) when --auto-session and --payment-session-id collide', async () => {
      const result = await invoke({ autoSession: true, paymentSessionId: 's1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('mutually exclusive');
      expect(mockGetOrCreatePaymentSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Protocol guard: payment FLAGS rejected for non-HTTP agents.
  // -------------------------------------------------------------------------
  describe('protocol guard', () => {
    it('rejects payment flags for non-HTTP agents', async () => {
      mockResolveInvokeTarget.mockResolvedValue(resolvedOk({ agentSpec: { name: 'McpAgent', protocol: 'MCP' } }));
      const result = await invoke({ paymentInstrumentId: 'pi-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('only supported for HTTP protocol');
    });
  });
});
