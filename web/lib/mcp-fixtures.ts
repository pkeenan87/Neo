// ─────────────────────────────────────────────────────────────
//  Mock-mode fixtures for MCP server responses.
//
//  When `MOCK_MODE !== "false"`, the Wiz MCP server URL is
//  replaced with a localhost sentinel and the agent loop's MCP-
//  tool-result handler short-circuits to a canned response from
//  this module. Lets contributors develop the Wiz path without
//  real credentials.
//
//  Each fixture is keyed by tool name. The shape matches what
//  Anthropic's MCP connector synthesises into an `mcp_tool_result`
//  content block, minus the `tool_use_id` (which the caller fills
//  in from the matching `mcp_tool_use` block).
// ─────────────────────────────────────────────────────────────

import type { WizMcpToolName } from "./mcp-servers";

interface WizFixture {
  is_error?: boolean;
  content: string;
}

/**
 * Canned responses for the commonly invoked Wiz read tools.
 * Shaped to look like realistic Security Graph results without
 * leaking any real customer data. Mock data only — never
 * referenced in the Cosmos / live-mode code path.
 */
const WIZ_FIXTURES: Record<WizMcpToolName, WizFixture> = {
  wiz_get_issues: {
    content: JSON.stringify(
      {
        items: [
          {
            id: "mock-issue-001",
            severity: "critical",
            title: "Public S3 bucket with sensitive data exposure",
            status: "OPEN",
            project: "demo-prod",
            createdAt: "2026-05-09T14:22:00Z",
          },
          {
            id: "mock-issue-002",
            severity: "high",
            title: "Over-privileged IAM role attached to compute instance",
            status: "IN_PROGRESS",
            project: "demo-prod",
            createdAt: "2026-05-10T08:11:00Z",
          },
        ],
        totalCount: 2,
        mock: true,
      },
      null,
      2,
    ),
  },
  wiz_get_vulnerabilities: {
    content: JSON.stringify(
      {
        items: [
          {
            id: "mock-vuln-001",
            cve: "CVE-2026-12345",
            severity: "high",
            packageName: "openssl",
            packageVersion: "3.0.0",
            affectedResources: 7,
          },
        ],
        totalCount: 1,
        mock: true,
      },
      null,
      2,
    ),
  },
  wiz_get_compliance: {
    content: JSON.stringify(
      {
        framework: "CIS-AWS-1.5",
        passedControls: 142,
        failedControls: 8,
        notApplicable: 14,
        complianceScore: 0.946,
        mock: true,
      },
      null,
      2,
    ),
  },
  wiz_list_cloud_resources: {
    content: JSON.stringify(
      {
        items: [
          { id: "mock-res-001", type: "AwsEc2Instance", findings: 3 },
          { id: "mock-res-002", type: "AwsS3Bucket", findings: 1 },
        ],
        totalCount: 2,
        mock: true,
      },
      null,
      2,
    ),
  },
  wiz_search_security_graph: {
    content: JSON.stringify(
      {
        nodes: 0,
        edges: 0,
        query: "(empty mock — no live graph in MOCK_MODE)",
        mock: true,
      },
      null,
      2,
    ),
  },
  wiz_get_defend_threat: {
    is_error: true,
    content:
      "Wiz Defend is not available in MOCK_MODE. Set MOCK_MODE=false and configure WIZ_MCP_TOKEN to use this tool.",
  },
  wiz_get_blast_radius: {
    is_error: true,
    content:
      "Wiz blast-radius assessment is not available in MOCK_MODE. Set MOCK_MODE=false to use this tool.",
  },
};

/**
 * Return the canned fixture for a tool name, or undefined if the
 * tool isn't in the catalogue. Callers should treat `undefined`
 * as "fall through to a generic mock response" so adding a new
 * Wiz tool doesn't crash dev runs before the catalogue is
 * updated.
 */
export function getWizFixture(
  toolName: string,
): { content: string; is_error?: boolean } | undefined {
  if (toolName in WIZ_FIXTURES) {
    return WIZ_FIXTURES[toolName as WizMcpToolName];
  }
  return undefined;
}

/**
 * Sentinel response when an unknown Wiz tool is invoked in mock
 * mode. Operators see this as a hint that the catalogue in
 * `mcp-servers.ts` needs a corresponding fixture entry.
 */
export function unknownWizToolFixture(toolName: string): {
  content: string;
  is_error: boolean;
} {
  return {
    is_error: true,
    content: `MOCK_MODE: no fixture defined for Wiz tool '${toolName}'. Add one in web/lib/mcp-fixtures.ts.`,
  };
}
