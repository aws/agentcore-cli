import type { ApiKeyCredentialProviderItem } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

interface ApiKeyProviderRow extends Record<string, unknown> {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const apiKeyProviderColumns = [
  { key: "name", header: "name", flex: true },
  { key: "createdAt", header: "created UTC", width: 16, render: formatTimestamp },
  { key: "updatedAt", header: "updated UTC", width: 16, render: formatTimestamp },
] satisfies DataTableColumn<ApiKeyProviderRow>[];

function toRow(provider: ApiKeyCredentialProviderItem): ApiKeyProviderRow {
  return {
    name: provider.name ?? "",
    createdAt: provider.createdTime?.toISOString() ?? "-",
    updatedAt: provider.lastUpdatedTime?.toISOString() ?? "-",
  };
}

export function ApiKeyCredentialProviderListScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "identity", "api-key-credential-provider", "list"]}
      description="list API key credential providers"
      queryKey={["api-key-credential-providers", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.identity.listApiKeyCredentialProviders(token, pageSize, opts);
        return {
          items: response.credentialProviders ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={apiKeyProviderColumns}
      getValue={(row) => row.name}
      onSelect={(name) =>
        navigate(`/agentcore/identity/api-key-credential-provider/get/${encodeURIComponent(name)}`)
      }
      onBack={() => navigate("/agentcore/identity/api-key-credential-provider")}
      loadingMessage="loading API key credential providers…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No API key credential providers found in this Region."
      emptyPageMessage="No API key credential providers on this page."
    />
  );
}
