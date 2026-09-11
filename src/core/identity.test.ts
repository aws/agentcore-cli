import { describe, expect, mock, test } from "bun:test";
import {
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
  type ApiKeyCredentialProviderItem,
  type Oauth2CredentialProviderItem,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";
import type { AwsClients } from "./types";
import { IdentityClient } from "./identity";

const options = { region: "us-west-2", endpointUrl: "https://agentcore.example.test" };

type ListCommand = ListApiKeyCredentialProvidersCommand | ListOauth2CredentialProvidersCommand;

function identityClient(send: (command: ListCommand) => Promise<unknown>): IdentityClient {
  return new IdentityClient({
    control: () => ({ send: mock(send) }) as never,
  } as unknown as Pick<AwsClients, "control">);
}

const names = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `provider-${from + index}`);

// providerSource serves `total` providers in service pages of at most `cap`,
// like the Identity list APIs do, and records every request it sees.
function providerSource<T>(total: number, cap: number, make: (name: string) => T) {
  const all = names(1, total).map(make);
  const requests: Array<{ op: string; input: ListCommand["input"] }> = [];
  const send = async (command: ListCommand) => {
    requests.push({ op: command.constructor.name, input: command.input });
    const { nextToken, maxResults } = command.input;
    if (maxResults !== undefined && maxResults > cap) {
      throw new Error(`maxResults ${maxResults} exceeds the service cap of ${cap}`);
    }
    const start = nextToken === undefined ? 0 : Number(nextToken);
    const items = all.slice(start, start + (maxResults ?? all.length));
    const end = start + items.length;
    return { credentialProviders: items, nextToken: end < all.length ? String(end) : undefined };
  };
  return { send, requests };
}

const oauth2 = (name: string) => ({ name }) as Oauth2CredentialProviderItem;
const apiKey = (name: string) => ({ name }) as ApiKeyCredentialProviderItem;

describe("IdentityClient list pagination", () => {
  test("OAuth2: a page above the service cap of 20 is assembled from consecutive calls", async () => {
    const source = providerSource(50, 20, oauth2);
    const client = identityClient(source.send);

    const page = await client.listOauth2CredentialProviders(undefined, 45, options);

    expect(source.requests).toEqual([
      {
        op: "ListOauth2CredentialProvidersCommand",
        input: { nextToken: undefined, maxResults: 20 },
      },
      { op: "ListOauth2CredentialProvidersCommand", input: { nextToken: "20", maxResults: 20 } },
      { op: "ListOauth2CredentialProvidersCommand", input: { nextToken: "40", maxResults: 5 } },
    ]);
    expect(page.credentialProviders?.map((p) => p.name)).toEqual(names(1, 45));
    expect(page.nextToken).toBe("45");
  });

  test("OAuth2: the returned token continues exactly where the page ended", async () => {
    const source = providerSource(50, 20, oauth2);
    const client = identityClient(source.send);

    const page = await client.listOauth2CredentialProviders("45", 45, options);

    expect(source.requests.map((r) => r.input)).toEqual([{ nextToken: "45", maxResults: 20 }]);
    expect(page.credentialProviders?.map((p) => p.name)).toEqual(names(46, 50));
    expect(page.nextToken).toBeUndefined();
  });

  test("a page within the cap is one call with maxResults passed as given", async () => {
    const source = providerSource(50, 20, oauth2);
    const client = identityClient(source.send);

    const page = await client.listOauth2CredentialProviders(undefined, 5, options);

    expect(source.requests.map((r) => r.input)).toEqual([{ nextToken: undefined, maxResults: 5 }]);
    expect(page.credentialProviders?.map((p) => p.name)).toEqual(names(1, 5));
    expect(page.nextToken).toBe("5");
  });

  test("no maxResults passes straight through and returns the service response", async () => {
    const source = providerSource(50, 20, apiKey);
    const client = identityClient(source.send);

    const page = await client.listApiKeyCredentialProviders(undefined, undefined, options);

    expect(source.requests).toEqual([
      {
        op: "ListApiKeyCredentialProvidersCommand",
        input: { nextToken: undefined, maxResults: undefined },
      },
    ]);
    expect(page.credentialProviders?.map((p) => p.name)).toEqual(names(1, 50));
    expect(page.nextToken).toBeUndefined();
  });

  test("API key: the service cap is 100", async () => {
    const source = providerSource(150, 100, apiKey);
    const client = identityClient(source.send);

    const page = await client.listApiKeyCredentialProviders(undefined, 120, options);

    expect(source.requests.map((r) => r.input)).toEqual([
      { nextToken: undefined, maxResults: 100 },
      { nextToken: "100", maxResults: 20 },
    ]);
    expect(page.credentialProviders?.map((p) => p.name)).toEqual(names(1, 120));
    expect(page.nextToken).toBe("120");
  });

  test("rejects a non-positive maxResults before calling the service", async () => {
    const source = providerSource(5, 20, oauth2);
    const client = identityClient(source.send);

    await expect(
      client.listOauth2CredentialProviders(undefined, 0, options),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(source.requests).toEqual([]);
  });
});
