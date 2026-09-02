import { test, expect, describe, afterEach } from "bun:test";
import {
  renderScreen,
  waitForText,
  waitForFlatText,
  flatFrame,
  cleanupScreens,
} from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec } = createGatewayProjectTestHarness(
  "add-payment-manager-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

describe("project add payment-manager wizard", () => {
  test("default flow writes the same defaults the flag path writes, and warns the same way", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/payment-manager");

    await waitForText(r.lastFrame, "what should this payment manager be called?");
    await r.write("payments");
    await r.press("return");

    await waitForText(r.lastFrame, "how should payment requests be authorized?");
    expect(r.lastFrame()).toContain("● AWS_IAM (default)");
    await r.press("return");

    // AWS_IAM asks nothing about JWT issuers.
    await waitForText(r.lastFrame, "should agents settle payments on their own?");
    await r.press("return");

    await waitForText(r.lastFrame, "how much may one payment session spend?");
    await r.press("return");

    await waitForText(r.lastFrame, "what is this payment manager for?");
    await r.press("return");

    await waitForText(r.lastFrame, "this payment manager will be added to agentcore.json");
    const review = flatFrame(r.lastFrame);
    expect(review).toContain("authorizer AWS_IAM");
    expect(review).toContain("auto-payment on");
    expect(review).toContain("spend limit 10.00");
    await r.press("return");

    await waitForText(r.lastFrame, "added payment manager 'payments'");
    // The flag path's post-success warnings are shown too: the scaffolded
    // project has a runtime, and auto-payment defaults on.
    expect(r.lastFrame()).toContain("auto-payment is ENABLED");
    expect(r.lastFrame()).toContain("does not modify runtime source code");

    const managers = (await projectSpec(projectRoot)).payments;
    expect(managers).toEqual([
      {
        name: "payments",
        authorizerType: "AWS_IAM",
        connectors: [],
        autoPayment: true,
        defaultSpendLimit: "10.00",
      },
    ]);
    r.unmount();
  });

  test("CUSTOM_JWT adds the issuer steps and validates the discovery URL", async () => {
    const projectRoot = await inProject();
    const r = renderScreen("/agentcore/project/add/payment-manager");

    await waitForText(r.lastFrame, "what should this payment manager be called?");
    await r.write("jwtPayments");
    await r.press("return");

    await waitForText(r.lastFrame, "how should payment requests be authorized?");
    await r.press("down");
    await r.press("return");

    await waitForText(r.lastFrame, "where is your JWT issuer's OIDC discovery document?");
    await r.write("http://idp.example.com");
    await r.press("return");
    await waitForFlatText(r.lastFrame, "HTTPS");
    for (let i = 0; i < "http://idp.example.com".length; i++) await r.write("\x7f");
    await r.write("https://idp.example.com/.well-known/openid-configuration");
    await r.press("return");

    await waitForText(r.lastFrame, "which client IDs may pay?");
    await r.write("client-a, client-b");
    await r.press("return");
    await waitForText(r.lastFrame, "which audiences may pay?");
    await r.press("return");
    await waitForText(r.lastFrame, "which scopes may pay?");
    await r.write("pay");
    await r.press("return");

    await waitForText(r.lastFrame, "should agents settle payments on their own?");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "how much may one payment session spend?");
    for (let i = 0; i < "10.00".length; i++) await r.write("\x7f");
    await r.write("-5");
    await r.press("return");
    await waitForFlatText(r.lastFrame, "non-negative");
    await r.write("\x7f");
    await r.write("\x7f");
    await r.write("2.50");
    await r.press("return");
    await waitForText(r.lastFrame, "what is this payment manager for?");
    await r.press("return");

    await waitForText(r.lastFrame, "this payment manager will be added to agentcore.json");
    expect(flatFrame(r.lastFrame)).toContain("clients client-a, client-b");
    await r.press("return");
    await waitForText(r.lastFrame, "added payment manager 'jwtPayments'");
    expect(r.lastFrame()).not.toContain("auto-payment is ENABLED");

    expect((await projectSpec(projectRoot)).payments[0]).toMatchObject({
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedClients: ["client-a", "client-b"],
          allowedScopes: ["pay"],
        },
      },
      autoPayment: false,
      defaultSpendLimit: "2.50",
    });
    r.unmount();
  });
});
