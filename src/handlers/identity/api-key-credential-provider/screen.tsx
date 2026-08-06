import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create", "update", "delete"];

export function ApiKeyCredentialProviderScreen(props: ScreenProps) {
  return (
    <RouterScreen
      {...props}
      path={["agentcore", "identity", "api-key-credential-provider"]}
      omit={OMIT}
    />
  );
}
