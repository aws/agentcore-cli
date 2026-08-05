import { createHash } from "node:crypto";
import { CreateRoleCommand, GetRoleCommand, type IAMClient, type Role } from "@aws-sdk/client-iam";

export class GatewayExecutionRole {
  static roleName(gatewayName: string, region: string): string {
    const suffix = createHash("sha256")
      .update(`${region}:${gatewayName}`)
      .digest("hex")
      .slice(0, 12);
    return `AgentCoreGateway-${gatewayName.slice(0, 32)}-${suffix}`;
  }

  static async ensure(iam: IAMClient, gatewayName: string, region: string): Promise<string> {
    const roleName = GatewayExecutionRole.roleName(gatewayName, region);

    try {
      const response = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return GatewayExecutionRole.requiredArn(response.Role, roleName);
    } catch (error) {
      if ((error as Error).name !== "NoSuchEntityException") throw error;
    }

    const response = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: GatewayExecutionRole.trustPolicy(),
        Description: `Default execution role for the AgentCore Gateway "${gatewayName}" created by the agentcore CLI`,
      }),
    );
    return GatewayExecutionRole.requiredArn(response.Role, roleName);
  }

  static async retryWhileUnassumable<T>(
    operation: () => Promise<T>,
    attempts = 8,
    delayMs = 2000,
    sleep: (delayMs: number) => Promise<void> = (delay) =>
      new Promise((resolve) => setTimeout(resolve, delay)),
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          (error as Error).name === "ValidationException" &&
          /role|assume|trust/i.test((error as Error).message ?? "");
        if (!retryable || attempt >= attempts) throw error;
        await sleep(delayMs);
      }
    }
  }

  private static requiredArn(role: Role | undefined, roleName: string): string {
    if (!role?.Arn) throw new Error(`IAM did not return an ARN for role "${roleName}"`);
    return role.Arn;
  }

  private static trustPolicy(): string {
    return JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "GatewayAssumeRolePolicy",
          Effect: "Allow",
          Principal: { Service: "bedrock-agentcore.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });
  }
}
