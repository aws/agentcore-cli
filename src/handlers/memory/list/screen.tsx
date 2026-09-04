import { MemoryPicker } from "../../../components/MemoryPicker";
import type { ScreenProps } from "../../types";
import { useRegionNavigate } from "../../utils";

export function MemoryListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();

  return (
    <MemoryPicker
      {...props}
      breadcrumb={["agentcore", "memory", "list"]}
      description="list AgentCore Memories"
      onSelect={(memoryId) => navigate(`/agentcore/memory/get/${encodeURIComponent(memoryId)}`)}
    />
  );
}
