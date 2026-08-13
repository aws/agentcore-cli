import { useNavigate, useParams } from "react-router";
import { MemoryPicker } from "../../../../components/MemoryPicker";
import type { ScreenProps } from "../../../types";
import { MemoryActorPicker } from "../../listPickers";

export function MemoryActorListScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { memoryId } = useParams();

  if (!memoryId) {
    return (
      <MemoryPicker
        {...props}
        breadcrumb={["agentcore", "memory", "actor", "list"]}
        description="choose a Memory to list actors for"
        onSelect={(id) => navigate(`/agentcore/memory/actor/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  return (
    <MemoryActorPicker
      {...props}
      memoryId={memoryId}
      breadcrumb={["agentcore", "memory", "actor", "list", memoryId]}
      description="choose an actor to list sessions for"
      onSelect={(actorId) =>
        navigate(
          `/agentcore/memory/session/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}`,
        )
      }
      onBack={() => navigate(-1)}
    />
  );
}
