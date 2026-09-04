import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { JsonDetail } from "../../../../components/JsonDetail";
import { ResourceDetailScreen } from "../../../../components/ResourceDetailScreen";
import type { ScreenProps } from "../../../types";
import { useCoreOpts } from "../../../utils";

function useOauth2ProviderDetail({ ctx, core }: ScreenProps, name: string | undefined) {
  const opts = useCoreOpts(ctx);
  return useQuery({
    queryKey: ["oauth2-credential-provider", opts.region, name],
    queryFn: () => core.identity.getOauth2CredentialProvider(name!, opts),
    enabled: name !== undefined,
  });
}

export function Oauth2CredentialProviderGetScreen(props: ScreenProps) {
  const navigate = useNavigate();
  const { name } = useParams();
  const detail = useOauth2ProviderDetail(props, name);

  return (
    <ResourceDetailScreen
      breadcrumb={["agentcore", "identity", "oauth2-credential-provider", "get", name ?? ""]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      items={{
        name: detail.data?.name ?? "",
        vendor: detail.data?.credentialProviderVendor ?? "-",
        status: detail.data?.status ?? "-",
        ...(detail.data?.failureReason ? { failureReason: detail.data.failureReason } : {}),
        secretSource: detail.data?.clientSecretSource ?? "-",
        clientSecretArn: detail.data?.clientSecretArn?.secretArn ?? "-",
        ...(detail.data?.callbackUrl ? { callbackUrl: detail.data.callbackUrl } : {}),
        createdAt: detail.data?.createdTime?.toISOString() ?? "-",
        updatedAt: detail.data?.lastUpdatedTime?.toISOString() ?? "-",
        arn: detail.data?.credentialProviderArn ?? "",
      }}
      actions={
        name && detail.data
          ? [
              {
                name: "detail",
                description: "show the full JSON definition",
                onSelect: () =>
                  navigate(
                    `/agentcore/identity/oauth2-credential-provider/get/${encodeURIComponent(name)}/json`,
                  ),
              },
            ]
          : []
      }
      loadingLabel="loading OAuth2 credential provider…"
      onRetry={() => void detail.refetch()}
      selectLabel="open"
    />
  );
}

export function Oauth2CredentialProviderGetJsonScreen(props: ScreenProps) {
  const { name } = useParams();
  const detail = useOauth2ProviderDetail(props, name);

  return (
    <JsonDetail
      breadcrumb={[
        "agentcore",
        "identity",
        "oauth2-credential-provider",
        "get",
        name ?? "",
        "json",
      ]}
      isPending={detail.isPending}
      error={detail.isError ? (detail.error as Error) : null}
      data={detail.data}
      loadingLabel="loading OAuth2 credential provider…"
      onRetry={() => void detail.refetch()}
    />
  );
}
