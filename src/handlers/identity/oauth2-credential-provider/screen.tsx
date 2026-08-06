import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function Oauth2CredentialProviderScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "identity", "oauth2-credential-provider"]} />;
}
