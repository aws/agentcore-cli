import type {
  CryptoWalletNetwork,
  EmbeddedCryptoWallet,
  LinkedAccount,
  PaymentInstrumentType,
} from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonObjectFlag } from "../../../utils";
import type { CreatePaymentInstrumentInput } from "../../types";

// Pinning these lists against the SDK types turns a new enum value into a
// compile-time reminder to widen the flag.
const INSTRUMENT_TYPES = [
  "EMBEDDED_CRYPTO_WALLET",
] as const satisfies readonly PaymentInstrumentType[];
const DEFAULT_INSTRUMENT_TYPE: PaymentInstrumentType = "EMBEDDED_CRYPTO_WALLET";
const NETWORKS = ["ETHEREUM", "SOLANA"] as const satisfies readonly CryptoWalletNetwork[];

export const createCreatePaymentInstrumentHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a payment instrument (an embedded crypto wallet) for a user",
    flags: [
      flag("manager-id", "the payment manager ID that owns the instrument", z.string().optional()),
      flag(
        "user-id",
        "the user the instrument belongs to (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("agent-name", "agent name recorded for observability", z.string().optional()),
      flag(
        "connector-id",
        "the payment connector that provisions the wallet",
        z.string().optional(),
      ),
      flag(
        "type",
        `instrument type (${INSTRUMENT_TYPES.join(" | ")}; default ${DEFAULT_INSTRUMENT_TYPE})`,
        z.enum(INSTRUMENT_TYPES).default(DEFAULT_INSTRUMENT_TYPE),
      ),
      flag(
        "network",
        `blockchain network of the wallet (${NETWORKS.join(" | ")}; shorthand form)`,
        z.enum(NETWORKS).optional(),
      ),
      flag(
        "email",
        "email address linked to the wallet (repeatable; shorthand form)",
        z.array(z.string()).optional(),
      ),
      flag(
        "phone-number",
        "E.164 phone number linked to the wallet (repeatable; shorthand form)",
        z.array(z.string()).optional(),
      ),
      flag(
        "instrument-details",
        "full wallet definition (JSON EmbeddedCryptoWallet; inline, file://<path>, or - for stdin); replaces the shorthand flags",
        z.string().optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare invocation can
      // fall through to the TUI once a screen exists.
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }
      if (!flags["connector-id"]) {
        throw new InputValidationError(
          "required option '--connector-id <connector-id>' not specified",
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const wallet = await resolveWallet(flags, source);

      const request: CreatePaymentInstrumentInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentConnectorId: flags["connector-id"],
        paymentInstrumentType: flags.type,
        paymentInstrumentDetails: { embeddedCryptoWallet: wallet },
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.createPaymentInstrument(request, coreOptsFromCtx(ctx)));
    },
  });

type WalletFlags = {
  network?: CryptoWalletNetwork;
  email?: string[];
  "phone-number"?: string[];
  "instrument-details"?: string;
};

// resolveWallet builds the EmbeddedCryptoWallet from whichever input form the
// caller chose. The JSON form is passed through as-is (deep validation is left to
// the service); the shorthand form covers the common email/SMS onboarding case.
async function resolveWallet(
  flags: WalletFlags,
  source: SourceResolver,
): Promise<EmbeddedCryptoWallet> {
  const shorthandUsed =
    flags.network !== undefined || flags.email !== undefined || flags["phone-number"] !== undefined;

  if (flags["instrument-details"] !== undefined) {
    if (shorthandUsed) {
      throw new InputValidationError(
        "--instrument-details is mutually exclusive with --network, --email, and --phone-number",
      );
    }
    return parseJsonObjectFlag<EmbeddedCryptoWallet>(
      "instrument-details",
      await source.resolveText("instrument-details", flags["instrument-details"]),
    )!;
  }

  if (!flags.network) {
    throw new InputValidationError("required option '--network <network>' not specified");
  }
  const linkedAccounts: LinkedAccount[] = [
    ...(flags.email ?? []).map((emailAddress) => ({ email: { emailAddress } })),
    ...(flags["phone-number"] ?? []).map((phoneNumber) => ({ sms: { phoneNumber } })),
  ];
  if (linkedAccounts.length === 0) {
    throw new InputValidationError(
      "the shorthand form needs at least one --email or --phone-number to link to the wallet",
    );
  }
  return { network: flags.network, linkedAccounts };
}
