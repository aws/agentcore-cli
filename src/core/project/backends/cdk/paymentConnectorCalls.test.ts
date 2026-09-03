import { describe, expect, test } from "bun:test";
import { paymentManagerId } from "./paymentConnectorCalls";

describe("paymentManagerId", () => {
  test("takes the identifier out of the ARN CloudFormation reports", () => {
    expect(
      paymentManagerId(
        "arn:aws:bedrock-agentcore:us-east-1:603141041947:payment-manager/payments-xlcjhrs0pa",
      ),
    ).toBe("payments-xlcjhrs0pa");
  });

  test("passes a bare identifier through", () => {
    expect(paymentManagerId("payments-xlcjhrs0pa")).toBe("payments-xlcjhrs0pa");
  });
});
