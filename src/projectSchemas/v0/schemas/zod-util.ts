import { z } from 'zod';

/**
 * Creates a superRefine function that validates array elements are unique by a given key.
 *
 * @param keyFn - Function to extract the key from each element
 * @param errorMessage - Function to generate error message for duplicates
 * @returns A superRefine callback for use with z.array().superRefine()
 */
export function uniqueBy<T>(
  keyFn: (item: T) => string,
  errorMessage: (key: string) => string
): (items: T[], ctx: z.RefinementCtx) => void {
  return (items, ctx) => {
    const seen = new Set<string>();
    for (const [idx, item] of items.entries()) {
      const key = keyFn(item);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: errorMessage(key), path: [idx] });
      }
      seen.add(key);
    }
  };
}
