import type { Oauth2CredentialProviderItem } from "@aws-sdk/client-bedrock-agentcore-control";
import { useNavigate } from "react-router";
import { formatTimestamp } from "../../../../components/formatTimestamp";
import { PaginatedTablePicker } from "../../../../components/PaginatedTablePicker";
import { TIMESTAMP_WIDTH, type DataTableColumn } from "../../../../components/ui/data-table";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

// The Identity list APIs cap maxResults at 20
const MAX_PAGE_SIZE = 20;

interface Oauth2ProviderRow extends Record<string, unknown> {
  name: string;
  vendor: string;
  createdAt: string;
  updatedAt: string;
}

export const oauth2ProviderColumns = [
  { key: "name", header: "name", flex: true },
  { key: "vendor", header: "vendor", width: 18 },
  { key: "createdAt", header: "created UTC", width: TIMESTAMP_WIDTH, render: formatTimestamp },
  { key: "updatedAt", header: "updated UTC", width: TIMESTAMP_WIDTH, render: formatTimestamp },
] satisfies DataTableColumn<Oauth2ProviderRow>[];

function toRow(provider: Oauth2CredentialProviderItem): Oauth2ProviderRow {
  return {
    name: provider.name ?? "",
    vendor: provider.credentialProviderVendor ?? "-",
    createdAt: provider.createdTime?.toISOString() ?? "-",
    updatedAt: provider.lastUpdatedTime?.toISOString() ?? "-",
  };
}

export function Oauth2CredentialProviderListScreen({ ctx, core }: ScreenProps) {
  const opts = coreOptsFromCtx(ctx);
  const navigate = useNavigate();

  return (
    <PaginatedTablePicker
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "list"]}
      queryKey={["oauth2-credential-providers", opts.region]}
      loadPage={async (token, pageSize) => {
        const response = await core.identity.listOauth2CredentialProviders(token, pageSize, opts);
        return {
          items: response.credentialProviders ?? [],
          nextToken: response.nextToken,
        };
      }}
      toRow={toRow}
      columns={oauth2ProviderColumns}
      getValue={(row) => row.name}
      onSelect={(name) =>
        navigate(`/agentcore/identity/oauth2-credential-provider/get/${encodeURIComponent(name)}`)
      }
      onBack={() => navigate("/agentcore/identity/oauth2-credential-provider")}
      maxPageSize={MAX_PAGE_SIZE}
      loadingMessage="Loading OAuth2 credential providers…"
      errorMessage={(error) => `Error: ${error.message}`}
      emptyMessage="No OAuth2 credential providers found in this Region."
      emptyPageMessage="No OAuth2 credential providers on this page."
    />
  );
}
