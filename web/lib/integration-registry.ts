import type { IntegrationInfo } from "./types";

const AZURE_AD_SECRETS = [
  {
    key: "AZURE_TENANT_ID",
    label: "Tenant ID",
    description:
      "The Azure AD / Entra ID tenant ID (directory ID) for your organization.",
    required: true,
  },
  {
    key: "AZURE_CLIENT_ID",
    label: "Client ID",
    description:
      "The Application (client) ID of the Azure AD app registration used for API access.",
    required: true,
  },
  {
    key: "AZURE_CLIENT_SECRET",
    label: "Client Secret",
    description:
      "A client secret generated for the app registration. Used for OAuth2 client_credentials flow.",
    required: true,
  },
];

export const INTEGRATIONS: IntegrationInfo[] = [
  {
    slug: "microsoft-sentinel",
    name: "Microsoft Sentinel",
    iconName: "Shield",
    description:
      "Cloud-native SIEM for security analytics. Run KQL queries against Log Analytics and retrieve security incidents.",
    capabilities: ["run_sentinel_kql", "get_sentinel_incidents"],
    secrets: [
      ...AZURE_AD_SECRETS,
      {
        key: "AZURE_SUBSCRIPTION_ID",
        label: "Subscription ID",
        description:
          "The Azure subscription ID that contains your Sentinel workspace.",
        required: true,
      },
      {
        key: "SENTINEL_WORKSPACE_ID",
        label: "Workspace ID",
        description:
          "The Log Analytics workspace ID (GUID) for Sentinel KQL queries.",
        required: true,
      },
      {
        key: "SENTINEL_WORKSPACE_NAME",
        label: "Workspace Name",
        description:
          "The name of the Log Analytics workspace (used in ARM API paths for incidents).",
        required: true,
      },
      {
        key: "SENTINEL_RESOURCE_GROUP",
        label: "Resource Group",
        description:
          "The Azure resource group that contains the Sentinel workspace.",
        required: true,
      },
    ],
  },
  {
    slug: "microsoft-defender-xdr",
    name: "Microsoft Defender XDR",
    iconName: "ShieldAlert",
    description:
      "Endpoint detection and response. Retrieve XDR alerts, search by host, and isolate or release machines.",
    capabilities: [
      "get_xdr_alert",
      "search_xdr_by_host",
      "isolate_machine",
      "unisolate_machine",
    ],
    secrets: [...AZURE_AD_SECRETS],
  },
  {
    slug: "microsoft-entra-id",
    name: "Microsoft Entra ID",
    iconName: "Users",
    description:
      "Identity and access management. Look up user details, check MFA status, and reset passwords.",
    capabilities: ["get_user_info", "reset_user_password"],
    secrets: [...AZURE_AD_SECRETS],
  },
];

export function getIntegration(slug: string): IntegrationInfo | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}
