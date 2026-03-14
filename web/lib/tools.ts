import type Anthropic from "@anthropic-ai/sdk";

type Tool = Anthropic.Messages.Tool;

export const TOOLS: Tool[] = [
  {
    name: "run_sentinel_kql",
    description: "Run a KQL query against the Microsoft Sentinel Log Analytics workspace. Choose the appropriate table for the investigation.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Valid KQL query to execute against the workspace",
        },
        timespan: {
          type: "string",
          description: "ISO 8601 duration string. Examples: PT1H (1 hour), PT24H (24 hours), P7D (7 days). Defaults to PT24H.",
        },
        description: {
          type: "string",
          description: "Human-readable explanation of what this query is looking for",
        },
      },
      required: ["query", "description"],
    },
  },
  {
    name: "get_sentinel_incidents",
    description: "List recent Sentinel incidents with optional severity and status filters. Good starting point for triage.",
    input_schema: {
      type: "object" as const,
      properties: {
        severity: {
          type: "string",
          enum: ["High", "Medium", "Low", "Informational"],
          description: "Filter by severity level",
        },
        status: {
          type: "string",
          enum: ["New", "Active", "Closed"],
          description: "Filter by incident status",
        },
        limit: {
          type: "number",
          description: "Number of incidents to return (default 10, max 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_xdr_alert",
    description: "Get full alert details from Defender XDR, including process tree, hashes, network, and timeline.",
    input_schema: {
      type: "object" as const,
      properties: {
        alert_id: {
          type: "string",
          description: "The alert ID from the XDR platform",
        },
        platform: {
          type: "string",
          enum: ["defender", "crowdstrike"],
          description: "Which XDR platform to query",
        },
      },
      required: ["alert_id", "platform"],
    },
  },
  {
    name: "search_xdr_by_host",
    description: "Search for all recent alerts and detections on a specific hostname or IP in the XDR platform.",
    input_schema: {
      type: "object" as const,
      properties: {
        hostname: {
          type: "string",
          description: "Hostname or FQDN of the machine",
        },
        platform: {
          type: "string",
          enum: ["defender", "crowdstrike"],
          description: "Which XDR platform to query",
        },
        hours: {
          type: "number",
          description: "How many hours back to search (default 48)",
        },
      },
      required: ["hostname", "platform"],
    },
  },
  {
    name: "get_user_info",
    description: "Look up Entra ID user details: MFA, groups, devices, and risk level.",
    input_schema: {
      type: "object" as const,
      properties: {
        upn: {
          type: "string",
          description: "User Principal Name, e.g. jsmith@goodwin.com",
        },
      },
      required: ["upn"],
    },
  },
  {
    name: "reset_user_password",
    description: "⚠️ DESTRUCTIVE — Force reset an Entra ID user's password and optionally revoke all active sessions and tokens. Use only when there is confirmed compromise evidence.",
    input_schema: {
      type: "object" as const,
      properties: {
        upn: {
          type: "string",
          description: "User Principal Name of the account to reset",
        },
        revoke_sessions: {
          type: "boolean",
          description: "If true, also revoke all active sign-in sessions and refresh tokens (recommended: true)",
        },
        justification: {
          type: "string",
          description: "Reason for the password reset — will be written to the audit log",
        },
      },
      required: ["upn", "justification"],
    },
  },
  {
    name: "isolate_machine",
    description: "⚠️ DESTRUCTIVE — Network-isolate an endpoint using Microsoft Defender for Endpoint or CrowdStrike RTR. The machine will lose all network connectivity except the XDR management channel.",
    input_schema: {
      type: "object" as const,
      properties: {
        hostname: {
          type: "string",
          description: "Hostname of the machine to isolate",
        },
        machine_id: {
          type: "string",
          description: "Platform-specific machine ID (optional if hostname is provided)",
        },
        platform: {
          type: "string",
          enum: ["defender", "crowdstrike"],
          description: "Which platform to use for isolation",
        },
        isolation_type: {
          type: "string",
          enum: ["Full", "Selective"],
          description: "Full blocks all traffic; Selective allows Defender/CrowdStrike management traffic only",
        },
        justification: {
          type: "string",
          description: "Reason for isolation — written to audit log",
        },
      },
      required: ["hostname", "platform", "justification"],
    },
  },
  {
    name: "unisolate_machine",
    description: "⚠️ DESTRUCTIVE — Release a previously isolated machine back onto the network.",
    input_schema: {
      type: "object" as const,
      properties: {
        hostname: {
          type: "string",
          description: "Hostname of the machine to release",
        },
        platform: {
          type: "string",
          enum: ["defender", "crowdstrike"],
        },
        justification: {
          type: "string",
          description: "Reason for releasing the isolation",
        },
      },
      required: ["hostname", "platform", "justification"],
    },
  },
  // Read-only but returns sensitive data that was intentionally truncated from
  // context. Available to all roles since it only accesses the current session.
  {
    name: "get_full_tool_result",
    description:
      "Retrieve the full, untruncated content of a previous tool result that was truncated to fit the context window. " +
      "Use this when a tool result was cut short and you need the complete data.",
    input_schema: {
      type: "object" as const,
      properties: {
        tool_use_id: {
          type: "string",
          description: "The tool_use_id of the truncated tool result to retrieve in full",
        },
      },
      required: ["tool_use_id"],
    },
  },
];

export const DESTRUCTIVE_TOOLS = new Set([
  "reset_user_password",
  "isolate_machine",
  "unisolate_machine",
]);
