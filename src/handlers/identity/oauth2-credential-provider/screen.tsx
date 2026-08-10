import { RouterScreen } from "../../../components/RouterScreen";
import type { ScreenProps } from "../../types";

const OMIT = ["create", "update", "delete"];

export function Oauth2CredentialProviderScreen(props: ScreenProps) {
  return (
    <RouterScreen
      {...props}
      path={["agentcore", "identity", "oauth2-credential-provider"]}
      omit={OMIT}
    />
  );
}
