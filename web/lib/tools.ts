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
    name: "get_machine_isolation_status",
    description:
      "Check the real-time network isolation status and health of a machine via Microsoft Defender for Endpoint. " +
      "Returns whether the machine is currently isolated, pending isolation, or not isolated, along with health status and risk score.",
    input_schema: {
      type: "object" as const,
      properties: {
        hostname: {
          type: "string",
          description: "Hostname or FQDN of the machine",
        },
        machine_id: {
          type: "string",
          description: "Defender machine ID — optional if hostname is provided",
          maxLength: 64,
        },
      },
      required: ["hostname"],
    },
  },
  {
    name: "search_user_messages",
    description:
      "Search a user's Exchange Online mailbox for specific messages by sender, subject, body content, or date range via Microsoft Graph. " +
      "Returns message IDs needed for reporting actions.",
    input_schema: {
      type: "object" as const,
      properties: {
        upn: {
          type: "string",
          description: "User Principal Name of the mailbox owner, e.g. jsmith@goodwin.com",
        },
        sender: {
          type: "string",
          description: "Filter by sender email address",
        },
        subject: {
          type: "string",
          description: "Filter by subject text (partial match)",
        },
        search_text: {
          type: "string",
          description: "Free-text search across subject, body, and sender",
        },
        days: {
          type: "number",
          description: "How many days back to search (default 7, max 90)",
          maximum: 90,
        },
      },
      required: ["upn"],
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
    name: "dismiss_user_risk",
    description:
      "⚠️ DESTRUCTIVE — Dismiss the risk state for a user in Entra ID Identity Protection. " +
      "This re-enables login for users blocked by conditional access risk policies.",
    input_schema: {
      type: "object" as const,
      properties: {
        upn: {
          type: "string",
          description: "User Principal Name of the account to dismiss risk for",
        },
        justification: {
          type: "string",
          description: "Reason for dismissing the risk — written to audit log",
        },
      },
      required: ["upn", "justification"],
    },
  },
  {
    name: "list_ca_policies",
    description:
      "List all Conditional Access policies from Microsoft Entra ID. Returns policy names, states (enabled/disabled/report-only), " +
      "conditions (users, apps, locations, platforms, risk levels), grant controls (MFA, block, compliant device), and session controls. " +
      "Set resolve_names to true to resolve GUIDs to display names (slower).",
    input_schema: {
      type: "object" as const,
      properties: {
        resolve_names: {
          type: "boolean",
          description: "Resolve user/group/role/app GUIDs to display names (default: false — faster without resolution)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_ca_policy",
    description:
      "Get full details of a specific Conditional Access policy by ID from Microsoft Entra ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        policy_id: {
          type: "string",
          description: "The Conditional Access policy ID",
        },
        resolve_names: {
          type: "boolean",
          description: "Resolve user/group/role/app GUIDs to display names (default: false)",
        },
      },
      required: ["policy_id"],
    },
  },
  {
    name: "list_named_locations",
    description:
      "List all named locations configured in Conditional Access. Returns IP-based locations (CIDR ranges with trusted flag) " +
      "and country-based locations. Useful for resolving location GUIDs referenced in CA policies.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
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
  {
    name: "report_message_as_phishing",
    description:
      "⚠️ DESTRUCTIVE — Report a message in a user's Exchange Online mailbox as phishing or junk via Microsoft Graph. " +
      "Use after searching for the message with search_user_messages to obtain the message ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        upn: {
          type: "string",
          description: "User Principal Name of the mailbox owner",
        },
        message_id: {
          type: "string",
          description: "The Graph message ID obtained from search_user_messages",
        },
        report_type: {
          type: "string",
          enum: ["phishing", "junk"],
          description: "Type of report — phishing (default) or junk",
        },
        justification: {
          type: "string",
          description: "Reason for reporting — written to audit log",
        },
      },
      required: ["upn", "message_id", "justification"],
    },
  },
  {
    name: "list_threatlocker_approvals",
    description:
      "List ThreatLocker application approval requests. Returns pending requests by default with request details, file hashes, and requesting user/computer.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "ignored"],
          description: "Filter by request status (default: pending)",
        },
        search_text: {
          type: "string",
          description: "Search by hostname, username, or file path",
          maxLength: 200,
        },
        page: {
          type: "number",
          description: "Page number (default: 1)",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_threatlocker_approval",
    description:
      "Get full details of a specific ThreatLocker approval request by ID, including application matching information and file details.",
    input_schema: {
      type: "object" as const,
      properties: {
        approval_request_id: {
          type: "string",
          description: "The approval request GUID",
        },
      },
      required: ["approval_request_id"],
    },
  },
  {
    name: "approve_threatlocker_request",
    description:
      "⚠️ DESTRUCTIVE — Approve a ThreatLocker application approval request. By default applies the policy to the requesting computer only.",
    input_schema: {
      type: "object" as const,
      properties: {
        approval_request_id: {
          type: "string",
          description: "The approval request GUID to approve",
        },
        policy_level: {
          type: "string",
          enum: ["computer", "group", "organization"],
          description: "Scope of the approval — computer (default), group, or entire organization",
        },
        justification: {
          type: "string",
          description: "Reason for approval — written to audit log",
        },
      },
      required: ["approval_request_id", "justification"],
    },
  },
  {
    name: "deny_threatlocker_request",
    description:
      "⚠️ DESTRUCTIVE — Deny (ignore) a ThreatLocker application approval request.",
    input_schema: {
      type: "object" as const,
      properties: {
        approval_request_id: {
          type: "string",
          description: "The approval request GUID to deny",
        },
        justification: {
          type: "string",
          description: "Reason for denial — written to audit log",
        },
      },
      required: ["approval_request_id", "justification"],
    },
  },
  {
    name: "search_threatlocker_computers",
    description:
      "Search for computers in ThreatLocker by hostname, username, or last check-in IP. " +
      "Returns computer IDs needed for maintenance mode actions.",
    input_schema: {
      type: "object" as const,
      properties: {
        search_text: {
          type: "string",
          description: "Computer name, username, or IP address to search for",
        },
        search_by: {
          type: "string",
          enum: ["name", "username", "ip"],
          description: "Search field (default: name)",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 25)",
        },
      },
      required: ["search_text"],
    },
  },
  {
    name: "get_threatlocker_computer",
    description:
      "Get full details of a ThreatLocker computer including current maintenance mode, group, and options.",
    input_schema: {
      type: "object" as const,
      properties: {
        computer_id: {
          type: "string",
          description: "The computer GUID",
        },
      },
      required: ["computer_id"],
    },
  },
  {
    name: "set_maintenance_mode",
    description:
      "⚠️ DESTRUCTIVE — Set a ThreatLocker computer's maintenance mode. " +
      "Supports learning, installation, monitor, secured, network monitor, and storage monitor modes. " +
      "Specify duration in hours or an absolute end time.",
    input_schema: {
      type: "object" as const,
      properties: {
        computer_id: {
          type: "string",
          description: "The computer GUID",
        },
        organization_id: {
          type: "string",
          description: "The organization GUID",
        },
        mode: {
          type: "string",
          enum: ["learning", "installation", "monitor", "secured", "network_monitor", "storage_monitor"],
          description: "Maintenance mode to set",
        },
        duration_hours: {
          type: "number",
          description: "Duration in hours (calculates end time from now)",
        },
        end_time: {
          type: "string",
          description: "Absolute end time (ISO-8601). Takes precedence over duration_hours.",
        },
        learning_type: {
          type: "string",
          enum: ["autocomp", "autogroup", "autosystem"],
          description: "Learning mode type (default: autogroup). Only used when mode is 'learning'.",
        },
      },
      required: ["computer_id", "organization_id", "mode"],
    },
  },
  {
    name: "schedule_bulk_maintenance",
    description:
      "⚠️ DESTRUCTIVE — Schedule maintenance mode on multiple ThreatLocker computers with a start and end time window.",
    input_schema: {
      type: "object" as const,
      properties: {
        computers: {
          type: "array",
          description: "Array of computers, each with computer_id, organization_id, and computer_group_id",
          items: {
            type: "object",
            properties: {
              computer_id: { type: "string", description: "Computer GUID" },
              organization_id: { type: "string", description: "Organization GUID" },
              computer_group_id: { type: "string", description: "Computer group GUID" },
            },
            required: ["computer_id", "organization_id", "computer_group_id"],
          },
        },
        mode: {
          type: "string",
          enum: ["learning", "installation", "monitor", "disable_tamper"],
          description: "Maintenance mode to schedule",
        },
        start_time: {
          type: "string",
          description: "Schedule start time (ISO-8601)",
        },
        end_time: {
          type: "string",
          description: "Schedule end time (ISO-8601)",
        },
        permit_end: {
          type: "boolean",
          description: "Allow end user to end maintenance early from their computer (default: false)",
        },
      },
      required: ["computers", "mode", "start_time", "end_time"],
    },
  },
  {
    name: "enable_secured_mode",
    description:
      "⚠️ DESTRUCTIVE — Return ThreatLocker computers to Secured mode (end maintenance mode).",
    input_schema: {
      type: "object" as const,
      properties: {
        computers: {
          type: "array",
          description: "Array of computers, each with computer_id and organization_id",
          items: {
            type: "object",
            properties: {
              computer_id: { type: "string", description: "Computer GUID" },
              organization_id: { type: "string", description: "Organization GUID" },
            },
            required: ["computer_id", "organization_id"],
          },
        },
      },
      required: ["computers"],
    },
  },
  {
    name: "block_indicator",
    description:
      "⚠️ DESTRUCTIVE — Create a custom indicator in Microsoft Defender for Endpoint. " +
      "The indicator is enforced fleet-wide on ALL enrolled devices immediately via Network Protection and Defender AV. " +
      "A wrong indicator blocks a legitimate resource for every user simultaneously. Use only for confirmed IOCs. " +
      "Indicators are permanent unless an expiration is set.",
    input_schema: {
      type: "object" as const,
      properties: {
        value: {
          type: "string",
          description: "The indicator value — a domain, IP address, URL, file hash, or certificate thumbprint",
        },
        indicator_type: {
          type: "string",
          enum: ["domain", "ip", "url", "sha1", "sha256", "md5", "cert"],
          description: "Type of indicator",
        },
        action: {
          type: "string",
          enum: ["block", "warn", "audit"],
          description: "Action to take (default: block). File hashes with 'block' automatically use BlockAndRemediate.",
        },
        title: {
          type: "string",
          description: "Title for the indicator (e.g., 'IR-2024-001 C2 Domain')",
        },
        description: {
          type: "string",
          description: "Optional description with context about the indicator",
        },
        severity: {
          type: "string",
          enum: ["informational", "low", "medium", "high"],
          description: "Severity level (default: high)",
        },
        expiration: {
          type: "string",
          description: "ISO-8601 expiration datetime (optional — indicator is permanent if omitted)",
        },
        generate_alert: {
          type: "boolean",
          description: "Generate an alert when the indicator is triggered (default: true)",
        },
      },
      required: ["value", "indicator_type", "title"],
    },
  },
  {
    name: "import_indicators",
    description:
      "⚠️ DESTRUCTIVE — Batch import up to 500 custom indicators into Microsoft Defender for Endpoint. " +
      "All indicators are enforced fleet-wide on ALL enrolled devices immediately. Each indicator must have a title.",
    input_schema: {
      type: "object" as const,
      properties: {
        indicators: {
          type: "array",
          description: "Array of indicator objects, each with value, indicator_type, action, title, and severity",
        },
        description: {
          type: "string",
          description: "Shared description applied to all indicators in the batch",
        },
        expiration: {
          type: "string",
          description: "Shared ISO-8601 expiration datetime for all indicators in the batch",
        },
      },
      required: ["indicators"],
    },
  },
  {
    name: "list_indicators",
    description:
      "List current custom indicators in Microsoft Defender for Endpoint. Filterable by indicator type.",
    input_schema: {
      type: "object" as const,
      properties: {
        indicator_type: {
          type: "string",
          enum: ["domain", "ip", "url", "sha1", "sha256", "md5", "cert"],
          description: "Filter by indicator type (optional — returns all types if omitted)",
        },
        top: {
          type: "number",
          description: "Maximum number of indicators to return (default: 25)",
        },
      },
      required: [],
    },
  },
  {
    name: "delete_indicator",
    description:
      "⚠️ DESTRUCTIVE — Delete a custom indicator from Microsoft Defender for Endpoint by its numeric ID. " +
      "Obtain the ID from list_indicators — do not delete an indicator whose value and title you have not verified.",
    input_schema: {
      type: "object" as const,
      properties: {
        indicator_id: {
          type: "number",
          description: "The numeric ID of the indicator to delete (obtained from list_indicators)",
        },
        justification: {
          type: "string",
          description: "Reason for deleting the indicator — written to audit log",
        },
      },
      required: ["indicator_id", "justification"],
    },
  },
  {
    name: "lookup_asset",
    description:
      "Look up an IT asset by hostname, IP address, or serial number in Lansweeper. " +
      "Returns a combined profile: asset identity (name, type, IP, OS, manufacturer/model), " +
      "ownership tags (Business Owner, BIA Tier, Role, Technology Owner), " +
      "primary user (most frequently logged-in), and vulnerability summary (count, severity breakdown, top CVEs).",
    input_schema: {
      type: "object" as const,
      properties: {
        search: {
          type: "string",
          description: "The hostname, IP address, or serial number to look up",
        },
        search_type: {
          type: "string",
          enum: ["name", "ip", "serial"],
          description: "Hint for how to interpret the search value. Auto-detected if omitted (IPv4 → ip, otherwise → name). Use 'serial' explicitly for serial number lookups.",
        },
      },
      required: ["search"],
    },
  },
  {
    name: "search_abnormal_messages",
    description:
      "Search across all messages in Abnormal Security by sender, recipient, subject, attachment, judgement, and more. " +
      "Returns a paginated message list with total count. Use this before remediation to identify affected messages.",
    input_schema: {
      type: "object" as const,
      properties: {
        sender_email: {
          type: "string",
          description: "Filter by sender email address",
        },
        sender_name: {
          type: "string",
          description: "Filter by sender display name",
        },
        recipient_email: {
          type: "string",
          description: "Filter by recipient email address",
        },
        subject: {
          type: "string",
          description: "Filter by message subject (partial match)",
        },
        attachment_name: {
          type: "string",
          description: "Filter by attachment file name",
        },
        attachment_md5_hash: {
          type: "string",
          description: "Filter by attachment MD5 hash (32-character hex string)",
        },
        body_link: {
          type: "string",
          description: "Filter by URL found in message body",
        },
        sender_ip: {
          type: "string",
          description: "Filter by sender IP address",
        },
        judgement: {
          type: "string",
          enum: ["attack", "borderline", "spam", "graymail", "safe"],
          description: "Filter by Abnormal's message judgement classification",
        },
        source: {
          type: "string",
          enum: ["abnormal", "quarantine"],
          description: "Search source — 'abnormal' for detected messages, 'quarantine' for quarantined (default: abnormal)",
        },
        start_time: {
          type: "string",
          description: "Start of time range (ISO 8601). Defaults to 48 hours ago if omitted.",
        },
        end_time: {
          type: "string",
          description: "End of time range (ISO 8601). Defaults to now if omitted.",
        },
        page_number: {
          type: "number",
          description: "Page number for pagination (default: 1)",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 50, max: 1000)",
        },
      },
      required: [],
    },
  },
  {
    name: "remediate_abnormal_messages",
    description:
      "⚠️ DESTRUCTIVE — Bulk remediate messages via Abnormal Security. Actions: delete messages, move to inbox, or submit to Detection360. " +
      "Provide either an explicit list of message IDs or use remediate_all with search filters. " +
      "Always search first to confirm the scope before remediating.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["delete", "move_to_inbox", "submit_to_d360"],
          description: "Remediation action to take on the messages",
        },
        remediation_reason: {
          type: "string",
          enum: ["false_negative", "misdirected", "unsolicited", "other"],
          description: "Reason for the remediation",
        },
        messages: {
          type: "array",
          description: "Explicit list of messages to remediate. Each item needs message_id and recipient_email.",
        },
        remediate_all: {
          type: "boolean",
          description: "If true, remediate all messages matching the search_filters. Requires search_filters.",
        },
        search_filters: {
          type: "object",
          description: "Search filters to identify messages when using remediate_all (same fields as search_abnormal_messages).",
        },
        justification: {
          type: "string",
          description: "Reason for the remediation — written to audit log",
        },
      },
      required: ["action", "remediation_reason", "justification"],
    },
  },
  {
    name: "get_abnormal_remediation_status",
    description:
      "Check the status of a previously submitted Abnormal Security remediation action. " +
      "Returns whether the remediation is pending, in progress, completed, or failed.",
    input_schema: {
      type: "object" as const,
      properties: {
        activity_log_id: {
          type: "string",
          description: "The activity log ID returned by a previous remediate_abnormal_messages call",
        },
      },
      required: ["activity_log_id"],
    },
  },
  {
    name: "get_vendor_risk",
    description:
      "Assess vendor email compromise (VEC) risk for a domain using Abnormal Security. " +
      "Returns risk level, vendor contacts, internal contacts, countries, IP addresses, and community intelligence flags.",
    input_schema: {
      type: "object" as const,
      properties: {
        vendor_domain: {
          type: "string",
          description: "The vendor domain to assess (e.g., 'example.com')",
        },
      },
      required: ["vendor_domain"],
    },
  },
  {
    name: "list_vendors",
    description:
      "List all known vendors with their risk levels from Abnormal Security. Paginated.",
    input_schema: {
      type: "object" as const,
      properties: {
        page_size: {
          type: "number",
          description: "Results per page (default: 25, max: 100)",
        },
        page_number: {
          type: "number",
          description: "Page number (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_vendor_activity",
    description:
      "Get the event timeline for a vendor domain from Abnormal Security. " +
      "Shows suspicious domains, attack goals, actions taken, and engagement status.",
    input_schema: {
      type: "object" as const,
      properties: {
        vendor_domain: {
          type: "string",
          description: "The vendor domain to get activity for",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 25, max: 100)",
        },
        page_number: {
          type: "number",
          description: "Page number (default: 1)",
        },
      },
      required: ["vendor_domain"],
    },
  },
  {
    name: "list_vendor_cases",
    description:
      "List vendor compromise cases from Abnormal Security. Filterable by first observed or last modified time. " +
      "Cases include insights like look-alike domains, young sender domains, and inconsistent registrars.",
    input_schema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "string",
          enum: ["firstObservedTime", "lastModifiedTime"],
          description: "Time-based filter field (optional)",
        },
        filter_value: {
          type: "string",
          description: "ISO-8601 datetime to filter from (optional, used with filter)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_vendor_case",
    description:
      "Get full details of a vendor compromise case from Abnormal Security. " +
      "Includes insights (look-alike domains, young domains, inconsistent registrars) and message timeline with sender, recipient, subject, and threat judgement.",
    input_schema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "The vendor case ID to retrieve",
        },
      },
      required: ["case_id"],
    },
  },
  {
    name: "get_employee_profile",
    description:
      "Get an employee's organizational context and behavioral baseline from Abnormal Security. " +
      "Returns name, title, manager, and Genome data including common login IPs, sign-in locations, devices, and browsers with frequency ratios.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The employee's email address",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "get_employee_login_history",
    description:
      "Get an employee's 30-day login history from Abnormal Security. " +
      "Returns structured login events with IP addresses, locations, timestamps, and devices. Useful for post-compromise forensics.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The employee's email address",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "list_abnormal_threats",
    description:
      "List recent email threats from Abnormal Security. Defaults to the last 24 hours. " +
      "Shows threat IDs, attack types, and summaries for triage.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_time: {
          type: "string",
          description: "ISO-8601 start of time range (default: 24 hours ago)",
        },
        end_time: {
          type: "string",
          description: "ISO-8601 end of time range (default: now)",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 25, max: 100)",
        },
        page_number: {
          type: "number",
          description: "Page number (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_abnormal_threat",
    description:
      "Get full details of a specific email threat from Abnormal Security. " +
      "Includes attack type, strategy, vector, sender analysis, attachments, URLs, remediation status, and portal link.",
    input_schema: {
      type: "object" as const,
      properties: {
        threat_id: {
          type: "string",
          description: "The threat ID to retrieve details for",
        },
      },
      required: ["threat_id"],
    },
  },
  {
    name: "list_ato_cases",
    description:
      "List Account Takeover cases from Abnormal Security. Filterable by last modified time. " +
      "Shows case IDs, severity, affected employee, and status.",
    input_schema: {
      type: "object" as const,
      properties: {
        filter_value: {
          type: "string",
          description: "ISO-8601 datetime — only return cases modified after this time (optional)",
        },
        page_size: {
          type: "number",
          description: "Results per page (default: 25, max: 100)",
        },
        page_number: {
          type: "number",
          description: "Page number (default: 1)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_ato_case",
    description:
      "Get full details of an Account Takeover case from Abnormal Security. " +
      "Combines case details (severity, affected employee, AI summary, linked threats) with the full analysis timeline " +
      "(impossible travel, mail rule changes, suspicious sign-ins, lateral phishing indicators).",
    input_schema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "The ATO case ID to investigate",
        },
      },
      required: ["case_id"],
    },
  },
  {
    name: "action_ato_case",
    description:
      "⚠️ DESTRUCTIVE — Take action on an Abnormal Security Account Takeover case. " +
      "Acknowledge the case or mark it as requiring further action.",
    input_schema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "The ATO case ID to act on",
        },
        action: {
          type: "string",
          enum: ["action_required", "acknowledge"],
          description: "Action to take on the case",
        },
        justification: {
          type: "string",
          description: "Reason for the action — written to audit log",
        },
      },
      required: ["case_id", "action", "justification"],
    },
  },
  // ── AppOmni ──────────────────────────────────────────────────
  {
    name: "list_appomni_services",
    description:
      "List all SaaS applications monitored by AppOmni with posture scores, user counts, and connection status.",
    input_schema: {
      type: "object" as const,
      properties: {
        service_type: {
          type: "string",
          description: "Filter by SaaS type (e.g. m365, sfdc, box, gws, slack, zoom)",
        },
        search: { type: "string", description: "Search term to filter services" },
        score_gte: { type: "number", description: "Minimum posture score (0–100)" },
        score_lte: { type: "number", description: "Maximum posture score (0–100)" },
        limit: { type: "number", description: "Max results per page (default 50, max 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "get_appomni_service",
    description:
      "Get detailed metadata, sync status, user stats, and policy posture for a specific monitored SaaS service.",
    input_schema: {
      type: "object" as const,
      properties: {
        service_id: { type: "number", description: "Monitored service ID (integer)" },
        service_type: { type: "string", description: "Service type slug (e.g. m365, sfdc, box)" },
      },
      required: ["service_id", "service_type"],
    },
  },
  {
    name: "list_appomni_findings",
    description:
      "List posture findings — unified view of policy violations and data exposure insights across the SaaS estate.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["open", "closed"], description: "Filter by finding status" },
        risk_score_gte: { type: "number", description: "Minimum risk score" },
        risk_score_lte: { type: "number", description: "Maximum risk score" },
        monitored_service_ids: {
          type: "array",
          items: { type: "number" },
          description: "Filter by monitored service IDs",
        },
        category: { type: "string", description: "Filter by risk category (e.g. permissions, configuration, data_exposure)" },
        compliance_framework: { type: "string", description: "Filter by compliance framework (e.g. SOC2, NIST, HIPAA)" },
        source_type: { type: "string", enum: ["scanner", "insight"], description: "Filter by source type" },
        first_opened_gte: { type: "string", description: "Findings opened on or after this ISO-8601 datetime" },
        first_opened_lte: { type: "string", description: "Findings opened on or before this ISO-8601 datetime" },
        limit: { type: "number", description: "Max results per page (default 100, max 100)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "get_appomni_finding",
    description:
      "Get full details of a posture finding including compliance controls, occurrence counts, and remediation context.",
    input_schema: {
      type: "object" as const,
      properties: {
        finding_id: { type: "string", description: "Finding UUID" },
      },
      required: ["finding_id"],
    },
  },
  {
    name: "list_appomni_finding_occurrences",
    description:
      "List individual violation instances (occurrences) for posture findings, with user/resource context.",
    input_schema: {
      type: "object" as const,
      properties: {
        finding_id: { type: "string", description: "Filter by finding UUID" },
        status: { type: "string", enum: ["open", "closed"], description: "Filter by occurrence status" },
        detailed_status: {
          type: "string",
          enum: ["new", "in_research", "in_remediation", "done"],
          description: "Filter by detailed status",
        },
        monitored_service_ids: {
          type: "array",
          items: { type: "number" },
          description: "Filter by monitored service IDs",
        },
        limit: { type: "number", description: "Max results per page (default 100, max 100)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "list_appomni_insights",
    description:
      "List data exposure and risk insights discovered by AppOmni across monitored SaaS services.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: "Comma-separated statuses to filter (open, dismissed, closed). E.g. 'open,dismissed'",
        },
        monitored_service_ids: {
          type: "array",
          items: { type: "number" },
          description: "Filter by monitored service IDs",
        },
        first_seen_gte: { type: "string", description: "Insights first seen on or after this ISO-8601 datetime" },
        last_seen_gte: { type: "string", description: "Insights last seen on or after this ISO-8601 datetime" },
        limit: { type: "number", description: "Max results per page (default 50, max 500)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "list_appomni_policy_issues",
    description:
      "List open policy issues (rule events) — specific rule violations detected by posture policy scans.",
    input_schema: {
      type: "object" as const,
      properties: {
        policy_ids: {
          type: "array",
          items: { type: "number" },
          description: "Filter by policy IDs",
        },
        service_org_ids: {
          type: "array",
          items: { type: "number" },
          description: "Filter by service organization IDs",
        },
        service_type: { type: "string", description: "Filter by service type" },
        limit: { type: "number", description: "Max results per page (default 50, max 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "list_appomni_identities",
    description:
      "List unified identities across all monitored SaaS services — shows permission levels, activity, and linked accounts.",
    input_schema: {
      type: "object" as const,
      properties: {
        identity_status: {
          type: "string",
          description: "Comma-separated statuses (e.g. 'active,inactive')",
        },
        permission_level: {
          type: "string",
          description: "Comma-separated levels (e.g. 'admin,elevated,standard')",
        },
        service_types: {
          type: "string",
          description: "Comma-separated service types (e.g. 'm365,sfdc,slack')",
        },
        search: { type: "string", description: "Search by username or email" },
        last_login_gte: { type: "string", description: "Last login on or after this ISO-8601 datetime" },
        last_login_lte: { type: "string", description: "Last login on or before this ISO-8601 datetime" },
        limit: { type: "number", description: "Max results per page (default 25, max 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "get_appomni_identity",
    description:
      "Get a unified identity profile with all linked SaaS accounts, permission levels, and activity across services.",
    input_schema: {
      type: "object" as const,
      properties: {
        identity_id: { type: "number", description: "Unified identity ID (integer)" },
      },
      required: ["identity_id"],
    },
  },
  {
    name: "list_appomni_discovered_apps",
    description:
      "List SaaS applications discovered by AppOmni's app discovery module with review status and criticality.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["approved", "pending", "rejected"], description: "Filter by review status" },
        criticality: { type: "string", enum: ["high", "medium", "low"], description: "Filter by criticality" },
        owner: { type: "string", description: "Filter by owner email" },
        search: { type: "string", description: "Search by app name" },
        limit: { type: "number", description: "Max results per page (default 50, max 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "get_appomni_audit_logs",
    description:
      "Retrieve AppOmni platform audit logs — who changed what in the SSPM platform. Useful for investigating configuration changes.",
    input_schema: {
      type: "object" as const,
      properties: {
        since: { type: "string", description: "Logs since this ISO-8601 datetime" },
        before: { type: "string", description: "Logs before this ISO-8601 datetime" },
        action_type: { type: "string", description: "Filter by action type (e.g. policy_scan_ended, user_login_saml)" },
        monitored_service_id: { type: "number", description: "Filter by monitored service ID" },
        user_id: { type: "number", description: "Filter by user ID" },
        policy_id: { type: "number", description: "Filter by policy ID" },
        limit: { type: "number", description: "Max results per page (default 50, max 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: [],
    },
  },
  {
    name: "action_appomni_finding",
    description:
      "⚠️ DESTRUCTIVE — Update finding occurrence status or close by exception. " +
      "Use 'update_status' to set detailed status (new/in_research/in_remediation/done). " +
      "Use 'close_exception' to close with a reason (risk_accepted/false_positive/compensating_controls/not_applicable/confirmed_intended).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["update_status", "close_exception"],
          description: "Action to perform",
        },
        occurrence_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of occurrence UUIDs to act on",
        },
        detailed_status: {
          type: "string",
          enum: ["new", "in_research", "in_remediation", "done"],
          description: "Required when action is 'update_status'",
        },
        reason: {
          type: "string",
          enum: ["risk_accepted", "false_positive", "compensating_controls", "not_applicable", "confirmed_intended"],
          description: "Required when action is 'close_exception'",
        },
        expires: {
          type: "string",
          description: "Optional ISO-8601 expiration date for exception (close_exception only)",
        },
        message: {
          type: "string",
          description: "Optional message/comment for the action",
        },
      },
      required: ["action", "occurrence_ids"],
    },
  },
  // Read-only SQL query against a reference-mode CSV attachment. Registered
  // conditionally by the agent loop — only exposed when the current conversation
  // has at least one reference-mode CSV attachment.
  {
    name: "query_csv",
    description:
      "Run a read-only SQL query against a CSV attachment that is too large to inline. " +
      "The table name is always 'csv'. Only SELECT / WITH / PRAGMA table_info(csv) are permitted. " +
      "Prefer aggregations (COUNT, GROUP BY, AVG) over raw row dumps — results are capped at 100 rows.",
    input_schema: {
      type: "object" as const,
      properties: {
        csv_id: {
          type: "string",
          description: "The csv_id from the <csv_attachment mode=\"reference\"> block you want to query.",
        },
        query: {
          type: "string",
          description: "A read-only SQL statement against the 'csv' table.",
        },
      },
      required: ["csv_id", "query"],
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
  "dismiss_user_risk",
  "isolate_machine",
  "unisolate_machine",
  "report_message_as_phishing",
  "approve_threatlocker_request",
  "deny_threatlocker_request",
  "set_maintenance_mode",
  "schedule_bulk_maintenance",
  "enable_secured_mode",
  "block_indicator",
  "import_indicators",
  "delete_indicator",
  "remediate_abnormal_messages",
  "action_ato_case",
  "action_appomni_finding",
]);
