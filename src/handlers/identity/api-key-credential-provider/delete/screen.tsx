import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function ApiKeyCredentialProviderDeleteScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "api-key-credential-provider", "delete"]}
      command="agentcore identity api-key-credential-provider delete --help"
    />
  );
}
