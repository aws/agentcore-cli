import { useNavigate } from "react-router";
import { MemoryPicker } from "../../../components/MemoryPicker";
import type { ScreenProps } from "../../types";

export function MemoryListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <MemoryPicker
      {...props}
      breadcrumb={["agentcore", "memory", "list"]}
      onSelect={(memoryId) => navigate(`/agentcore/memory/get/${encodeURIComponent(memoryId)}`)}
    />
  );
}
