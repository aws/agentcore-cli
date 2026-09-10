// isRoleUnassumableValidation is the harness predicate: AgentCore rejects a
// freshly created execution role with a ValidationException whose message names
// the role, the assume, or the trust relationship.
export function isRoleUnassumableValidation(error: Error): boolean {
  return error.name === "ValidationException" && /role|assume|trust/i.test(error.message ?? "");
}

// retryWhileRoleUnassumable retries `operation` while it fails with the error
// AgentCore raises for a role it cannot yet assume (fresh IAM roles propagate
// over several seconds). Any other failure — or exhausting the attempts —
// rethrows. `isRetryable` decides which errors count; it defaults to the
// harness ValidationException shape.
export async function retryWhileRoleUnassumable<T>(
  operation: () => Promise<T>,
  isRetryable: (error: Error) => boolean = isRoleUnassumableValidation,
  attempts = 8,
  delayMs = 2000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error as Error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
