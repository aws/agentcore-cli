import z from "zod";

// Helpers for turning a wizard's text answers into the typed values a
// handler's input builder expects. Screens share them so an optional blank, a
// comma-separated list, or a number typed into a text field mean the same
// thing on every wizard.

// blankToUndefined trims, and treats an empty answer as "not given" so the
// builder applies the same default the flag path applies when a flag is absent.
export function blankToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// splitList reads a comma-separated answer as the list a repeatable flag
// produces; blanks between commas are dropped, and an empty answer is "not given".
export function splitList(value: string): string[] | undefined {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length === 0 ? undefined : entries;
}

// numberSchema validates a text answer against a numeric flag schema: anything
// unparseable is reported before the bounds are, and the bounds are the flag's
// own. `message` names what was expected, e.g. "enter a number of days".
export function numberSchema(
  inner: z.ZodType<number, number>,
  message = "enter a number",
): z.ZodType {
  return z
    .string()
    .transform((raw) => Number(raw))
    .refine((parsed) => Number.isFinite(parsed), { message })
    .pipe(inner);
}
