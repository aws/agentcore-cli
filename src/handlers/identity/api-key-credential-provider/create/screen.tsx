import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function ApiKeyCredentialProviderCreateScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "api-key-credential-provider", "create"]}
      command="agentcore identity api-key-credential-provider create --help"
    />
  );
}
