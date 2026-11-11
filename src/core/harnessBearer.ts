import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { HttpBearerAuthSigner } from "@smithy/core";
import type { HttpRequest, TokenIdentity } from "@smithy/types";
import { InputValidationError } from "../errors";
import type { CoreOptions } from "./types";
import { toClientConfig } from "./utils";

const HTTP_BEARER_AUTH_SCHEME = "smithy.api#httpBearerAuth";

export function createBearerHarnessClient(
  options: CoreOptions,
  token: string,
): BedrockAgentCoreClient {
  const client = new BedrockAgentCoreClient({
    ...toClientConfig(options),
    httpAuthSchemeProvider: () => [{ schemeId: HTTP_BEARER_AUTH_SCHEME }],
    httpAuthSchemes: [
      {
        schemeId: HTTP_BEARER_AUTH_SCHEME,
        identityProvider: () => async (): Promise<TokenIdentity> => ({ token }),
        signer: new HttpBearerAuthSigner(),
      },
    ],
  });
  client.middlewareStack.add(
    (next) => async (args) => {
      if ((args.request as HttpRequest).protocol !== "https:") {
        throw new InputValidationError("CUSTOM_JWT requires an HTTPS endpoint");
      }
      return next(args);
    },
    { step: "finalizeRequest", priority: "low", name: "requireHttpsForHarnessBearerToken" },
  );
  return client;
}
