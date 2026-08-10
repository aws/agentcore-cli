import { z } from "zod";
export function uniqueBy<T>(
  keyFn: (item: T) => string,
  errorMessage: (key: string) => string,
): (items: T[] | null | undefined, ctx: z.RefinementCtx) => void {
  return (items, ctx) => {
    if (!items) return;
    const seen = new Set<string>();
    for (const [idx, item] of items.entries()) {
      const key = keyFn(item);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: errorMessage(key), path: [idx] });
      }
      seen.add(key);
    }
  };
}
