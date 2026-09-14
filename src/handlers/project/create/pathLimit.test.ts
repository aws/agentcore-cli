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

// The deepest file npm installs under agentcore/cdk is 155 characters below the project root,
// so a 104-character root is the longest that still fits under Windows' 260-character MAX_PATH.
test("allows a 104-character project root and refuses 105 on Windows", () => {
  const root = (length: number) => "C:\\" + "x".repeat(length - 3 - 5); // leaves room for "\\Demo"
  expect(() => assertProjectPathFits("Demo", "win32", { cwd: root(104) })).not.toThrow();
  expect(() => assertProjectPathFits("Demo", "win32", { cwd: root(105) })).toThrow(
    /105 characters/,
  );
});
