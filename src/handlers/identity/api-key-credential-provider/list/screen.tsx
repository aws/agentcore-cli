import type { ApiKeyCredentialProviderItem } from "@aws-sdk/client-bedrock-agentcore-control";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import type { DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { useCoreOpts, useRegionNavigate } from "../../../utils";

// identity list APIs cap maxResults at 20
const MAX_PAGE_SIZE = 20;

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
  const opts = useCoreOpts(ctx);
  const navigate = useRegionNavigate();

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
      maxPageSize={MAX_PAGE_SIZE}
      loadingMessage="loading API key credential providers…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No API key credential providers found in this Region."
      emptyPageMessage="No API key credential providers on this page."
    />
  );
}
