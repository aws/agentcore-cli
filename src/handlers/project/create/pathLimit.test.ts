import { expect, test } from "bun:test";
import { InputValidationError } from "../../../errors";
import { assertProjectPathFits } from "./pathLimit";

const deep = "C:\\Users\\a\\OneDrive - Company\\" + "nested\\".repeat(20);

test.each([
  ["win32", "C:\\Users\\a", "Demo", false],
  ["win32", deep, "Demo", true],
  ["darwin", deep, "Demo", false],
] as const)("on %s under %s creating %s throws: %s", (platform, cwd, name, throws) => {
  const check = () => assertProjectPathFits(name, platform, { cwd });
  if (throws) expect(check).toThrow(InputValidationError);
  else expect(check).not.toThrow();
});
