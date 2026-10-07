import { expect, test } from "bun:test";
import {
  DeleteWorkloadIdentityCommand,
  ResourceNotFoundException,
  ValidationException,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { GetWorkloadAccessTokenCommand } from "@aws-sdk/client-bedrock-agentcore";
import { IdentityClient } from "./identity";

const options = { region: "us-west-2" };
const notFound = () => new ResourceNotFoundException({ message: "missing", $metadata: {} });
const exists = () =>
  new ValidationException({
    message: "already exists",
    reason: "FieldValidationFailed",
    $metadata: {},
  });

function client(responses: Record<string, (() => unknown)[]>) {
  const sent: string[] = [];
  const send = async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    sent.push(name);
    const result = responses[name]!.shift()!();
    if (result instanceof Error) throw result;
    return result;
  };
  const identity = new IdentityClient({
    control: () => ({ send }) as never,
    data: () => ({ send }) as never,
  });
  return { identity, sent };
}

test.each([
  ["an existing identity", { GetWorkloadIdentityCommand: [() => ({})] }, false],
  [
    "a missing identity",
    { GetWorkloadIdentityCommand: [notFound], CreateWorkloadIdentityCommand: [() => ({})] },
    true,
  ],
  [
    "a create race another developer won",
    {
      GetWorkloadIdentityCommand: [notFound, () => ({})],
      CreateWorkloadIdentityCommand: [exists],
    },
    false,
  ],
])("ensure with %s", async (_case, responses, created) => {
  const { identity } = client(responses);

  expect(await identity.ensureWorkloadIdentity("agentcore-dev-p-default", options)).toEqual({
    created,
  });
});

test("ensure rethrows the create error when the second get fails", async () => {
  const { identity } = client({
    GetWorkloadIdentityCommand: [notFound, notFound],
    CreateWorkloadIdentityCommand: [exists],
  });

  await expect(identity.ensureWorkloadIdentity("n", options)).rejects.toThrow("already exists");
});

test("token and delete use the identity name", async () => {
  const { identity, sent } = client({
    GetWorkloadAccessTokenCommand: [() => ({ workloadAccessToken: "tok" })],
    DeleteWorkloadIdentityCommand: [() => ({})],
  });

  expect(await identity.getWorkloadAccessToken("n", options)).toBe("tok");
  await identity.deleteWorkloadIdentity("n", options);
  expect(sent).toEqual([GetWorkloadAccessTokenCommand.name, DeleteWorkloadIdentityCommand.name]);
});
