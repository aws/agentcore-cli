import { expect, test } from "bun:test";
import { projectFormat } from "./detect";

test("version 1 is v0", () => expect(projectFormat({ version: 1 })).toBe("v0"));

test("version 2 is v1", () => expect(projectFormat({ version: 2 })).toBe("v1"));

test("missing or odd versions fall through to v1 so v1 validation reports them", () => {
  expect(projectFormat({})).toBe("v1");
  expect(projectFormat(null)).toBe("v1");
  expect(projectFormat("version: 1")).toBe("v1");
  expect(projectFormat({ version: "1" })).toBe("v1");
});
