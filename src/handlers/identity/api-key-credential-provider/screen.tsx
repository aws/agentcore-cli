import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

export function ApiKeyCredentialProviderScreen(props: ScreenProps) {
  return (
    <RouterScreen {...props} path={["agentcore", "identity", "api-key-credential-provider"]} />
  );
}
