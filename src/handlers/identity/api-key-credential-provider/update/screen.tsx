import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function ApiKeyCredentialProviderUpdateScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "api-key-credential-provider", "update"]}
      command="agentcore identity api-key-credential-provider update --help"
    />
  );
}
