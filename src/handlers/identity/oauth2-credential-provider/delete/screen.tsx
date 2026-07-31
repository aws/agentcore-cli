import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function Oauth2CredentialProviderDeleteScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "delete"]}
      command="agentcore identity oauth2-credential-provider delete --help"
    />
  );
}
