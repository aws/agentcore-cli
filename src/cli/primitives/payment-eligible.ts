import type { AgentEnvSpec } from '../../schema';

/**
 * Decide whether a runtime is eligible for payment auto-wiring and runtime
 * env-var injection. Payments today only ships a runtime shim for Python
 * Strands HTTP agents. Other runtimes (TypeScript, MCP/A2A/AGUI, non-Strands
 * Python frameworks) either have no shim or would be silently corrupted by
 * the Strands-shaped template / env-vars they cannot consume.
 *
 * Used by:
 * - PaymentManagerPrimitive.add (skips wirePaymentCapability)
 * - cdk-stack.ts payment loop (skips env-var injection on the runtime)
 * - dev/payment-env.ts (skips dev-mode env-var injection)
 *
 * Detection is conservative: when in doubt, treat as ineligible. Customers
 * with non-Strands runtimes are told via warning that payments must be wired
 * manually.
 */
export function isPaymentEligibleRuntime(runtime: AgentEnvSpec): boolean {
  // Protocol gate: payments shim is HTTP-only today.
  // The protocol field is optional; treat undefined as HTTP (the default).
  if (runtime.protocol && runtime.protocol !== 'HTTP') {
    return false;
  }

  // Language gate: shim is Python-only today. Inspect the entrypoint
  // file extension. Entrypoint format is "main.py" or "main.py:handler".
  const entrypoint = typeof runtime.entrypoint === 'string' ? runtime.entrypoint : '';
  const entrypointFile = entrypoint.split(':')[0] ?? '';
  if (!entrypointFile.endsWith('.py')) {
    return false;
  }

  // Framework gate (Strands) is enforced downstream by reading main.py
  // content; we cannot determine it from the runtime spec alone.
  return true;
}
