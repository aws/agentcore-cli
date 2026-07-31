import { CliOnlyScreen } from "../../../../components/CliOnlyScreen";
import type { ScreenProps } from "../../../types";

export function Oauth2CredentialProviderUpdateScreen(props: ScreenProps) {
  return (
    <CliOnlyScreen
      {...props}
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "update"]}
      command="agentcore identity oauth2-credential-provider update --help"
    />
  );
}
