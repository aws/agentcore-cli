import { expect, test } from "bun:test";

export function techDebtTest(expiresAt: Date, message: string): void {
  test(`tech debt review deadline: ${expiresAt.toISOString()}`, () => {
    const now = Date.now();

    if (now >= expiresAt.getTime()) {
      console.error(message);
    }

    expect(now).toBeLessThan(expiresAt.getTime());
  });
}
