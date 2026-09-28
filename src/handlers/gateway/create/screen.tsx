import { ProjectResourceCreateScreen } from "../../../components/ProjectResourceCreateScreen";
import type { ScreenProps } from "../../types";

export function GatewayCreateScreen(props: ScreenProps) {
  return <ProjectResourceCreateScreen {...props} resource="gateway" />;
}
