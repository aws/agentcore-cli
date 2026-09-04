import { useParams } from "react-router";
import { MemoryPicker } from "../../../../components/MemoryPicker";
import type { ScreenProps } from "../../../types";
import { MemoryActorPicker, MemorySessionPicker } from "../../listPickers";
import { useRegionNavigate } from "../../../utils";

export function MemorySessionListScreen(props: ScreenProps) {
  const navigate = useRegionNavigate();
  const { memoryId, actorId } = useParams();

  if (!memoryId) {
    return (
      <MemoryPicker
        {...props}
        breadcrumb={["agentcore", "memory", "session", "list"]}
        description="choose a Memory to list sessions for"
        onSelect={(id) => navigate(`/agentcore/memory/session/list/${encodeURIComponent(id)}`)}
      />
    );
  }

  if (!actorId) {
    return (
      <MemoryActorPicker
        {...props}
        memoryId={memoryId}
        breadcrumb={["agentcore", "memory", "session", "list", memoryId]}
        description="choose an actor to list sessions for"
        onSelect={(id) =>
          navigate(
            `/agentcore/memory/session/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(id)}`,
          )
        }
        onBack={() => navigate(-1)}
      />
    );
  }

  return (
    <MemorySessionPicker
      {...props}
      memoryId={memoryId}
      actorId={actorId}
      breadcrumb={["agentcore", "memory", "session", "list", memoryId, actorId]}
      description="choose a session to list events for"
      onSelect={(id) =>
        navigate(
          `/agentcore/memory/event/list/${encodeURIComponent(memoryId)}/${encodeURIComponent(actorId)}/${encodeURIComponent(id)}`,
        )
      }
      onBack={() => navigate(-1)}
    />
  );
}
