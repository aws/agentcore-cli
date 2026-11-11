import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  dependsOnOf,
  isCustomResource,
  referencesIn,
  renameReferences,
  stripReferences,
} from "./templates";

const RESOURCES = new Set(["Role", "Fn", "Bucket"]);
const isResource = (id: string) => RESOURCES.has(id);

describe("referencesIn", () => {
  test("finds Ref, both Fn::GetAtt forms, and Fn::Sub placeholders, with their paths", () => {
    const refs = referencesIn(
      {
        RoleArn: { "Fn::GetAtt": ["Role", "Arn"] },
        FunctionName: { "Fn::GetAtt": "Fn.Arn" },
        Roles: [{ Ref: "Role" }],
        Policy: {
          Statement: [
            { Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": ["Bucket", "Arn"] }, "/*"]] } },
          ],
        },
        Url: { "Fn::Sub": "https://${Bucket}/${Fn.Arn}" },
      },
      isResource,
    );
    expect(refs).toEqual([
      { target: "Role", path: "RoleArn", attribute: "Arn" },
      { target: "Fn", path: "FunctionName", attribute: "Arn" },
      { target: "Role", path: "Roles.[]" },
      { target: "Bucket", path: "Policy.Statement.[].Resource.[]", attribute: "Arn" },
      { target: "Bucket", path: "Url" },
      { target: "Fn", path: "Url", attribute: "Arn" },
    ]);
  });

  test("skips parameters, pseudo parameters, Fn::Sub variables, and escapes", () => {
    const refs = referencesIn(
      {
        A: { Ref: "AWS::Region" },
        B: { Ref: "BootstrapVersion" },
        C: {
          "Fn::Sub": ["${Role}-${!Fn}-${AWS::AccountId}", { Role: { Ref: "Bucket" } }],
        },
      },
      isResource,
    );
    expect(refs).toEqual([{ target: "Bucket", path: "C.Role" }]);
  });
});

describe("renameReferences", () => {
  const renames = new Map([
    ["Role", "NewRole"],
    ["Fn", "NewFn"],
  ]);

  test("rewrites every reference form, and nothing else", () => {
    expect(
      renameReferences(
        {
          RoleArn: { "Fn::GetAtt": ["Role", "Arn"] },
          FunctionName: { "Fn::GetAtt": "Fn.Arn" },
          Whole: { "Fn::GetAtt": "Fn" },
          Roles: [{ Ref: "Role" }, { Ref: "Other" }],
          PolicyName: "Role",
          Url: { "Fn::Sub": "${Role}/${Fn.Arn}/${!Role}/${Other}" },
          WithVars: { "Fn::Sub": ["${Role}-${Fn}", { Role: { Ref: "Fn" } }] },
        },
        renames,
      ),
    ).toEqual({
      RoleArn: { "Fn::GetAtt": ["NewRole", "Arn"] },
      FunctionName: { "Fn::GetAtt": "NewFn.Arn" },
      Whole: { "Fn::GetAtt": "NewFn" },
      Roles: [{ Ref: "NewRole" }, { Ref: "Other" }],
      PolicyName: "Role",
      Url: { "Fn::Sub": "${NewRole}/${NewFn.Arn}/${!Role}/${Other}" },
      // ${Role} is the Fn::Sub's own variable here, so only ${Fn} and the map's Ref change.
      WithVars: { "Fn::Sub": ["${Role}-${NewFn}", { Role: { Ref: "NewFn" } }] },
    });
  });

  test("leaves objects that only look like intrinsics alone", () => {
    const value = { Ref: "Role", Extra: 1 };
    expect(renameReferences(value, renames)).toEqual(value);
  });
});

describe("stripReferences", () => {
  test("replaces references with placeholders, so renamed values compare equal", () => {
    const a = {
      X: { Ref: "Role" },
      Y: { "Fn::GetAtt": ["Fn", "Arn"] },
      Z: { "Fn::Sub": "${Role}-${AWS::Region}" },
    };
    const b = {
      X: { Ref: "Other" },
      Y: { "Fn::GetAtt": ["Else", "Arn"] },
      Z: { "Fn::Sub": "${Other}-${AWS::Region}" },
    };
    const anyResource = (id: string) => !id.startsWith("AWS::");
    expect(canonicalJson(stripReferences(a, anyResource))).toBe(
      canonicalJson(stripReferences(b, anyResource)),
    );
    expect(stripReferences({ Z: { "Fn::Sub": ["${Role}", { Role: "x" }] } }, anyResource)).toEqual({
      Z: { "Fn::Sub": ["${Role}", { Role: "x" }] },
    });
  });
});

describe("helpers", () => {
  test("canonicalJson sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: undefined, e: null })).toBe(
      '{"b":[{"c":2,"d":1}],"e":null}',
    );
  });

  test("dependsOnOf reads both forms", () => {
    expect(dependsOnOf({ Type: "T", DependsOn: "A" })).toEqual(["A"]);
    expect(dependsOnOf({ Type: "T", DependsOn: ["A", "B"] })).toEqual(["A", "B"]);
    expect(dependsOnOf({ Type: "T" })).toEqual([]);
  });

  test("isCustomResource covers both custom resource spellings", () => {
    expect(isCustomResource("Custom::AWSCDKCfnJson")).toBe(true);
    expect(isCustomResource("AWS::CloudFormation::CustomResource")).toBe(true);
    expect(isCustomResource("AWS::Lambda::Function")).toBe(false);
  });
});
