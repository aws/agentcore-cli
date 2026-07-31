import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function Oauth2CredentialProviderCreateScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "create"]}
      command="agentcore identity oauth2-credential-provider create --help"
    />
  );
}
