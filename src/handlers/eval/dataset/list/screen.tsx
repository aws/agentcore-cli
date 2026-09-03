import { useNavigate } from "react-router";
import { DatasetPicker } from "../../../../components/DatasetPicker";
import type { ScreenProps } from "../../../types";

export function DatasetListScreen(props: ScreenProps) {
  const navigate = useNavigate();

  return (
    <DatasetPicker
      {...props}
      breadcrumb={["agentcore", "eval", "dataset", "list"]}
      description="list datasets"
      onSelect={(datasetId) =>
        navigate(`/agentcore/eval/dataset/get/${encodeURIComponent(datasetId)}`)
      }
    />
  );
}
