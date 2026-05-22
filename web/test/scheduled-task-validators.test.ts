import { describe, expect, it } from "vitest";

import {
  ROUTING_ALLOWED_TOOLS,
  TASK_NAME_MAX,
  validateRoutingShape,
  validateTaskName,
} from "../lib/scheduled-task-validators";

describe("validateRoutingShape — tool destination", () => {
  it("accepts a well-formed tool destination", () => {
    const err = validateRoutingShape({
      destination: "tool",
      toolName: "send_teams_message",
      fallbackDestination: "cosmos-log",
    });
    expect(err).toBeNull();
  });

  it("rejects tool destination without toolName", () => {
    const err = validateRoutingShape({
      destination: "tool",
    });
    expect(err).toMatch(/requires toolName/);
  });

  it("rejects tool destination with toolName empty string", () => {
    const err = validateRoutingShape({
      destination: "tool",
      toolName: "   ",
    });
    expect(err).toMatch(/requires toolName/);
  });

  it("rejects tool destination with a toolName outside ROUTING_ALLOWED_TOOLS", () => {
    const err = validateRoutingShape({
      destination: "tool",
      toolName: "run_sentinel_kql",
    });
    expect(err).toMatch(/not in ROUTING_ALLOWED_TOOLS/);
  });

  it("rejects tool destination with a destructive toolName even if it were in the allowlist", () => {
    // Hardcode a known-destructive name; the validator's defence-in-depth
    // check rejects it even before the allowlist check (the allowlist
    // happens to also reject it, so the test only asserts an error
    // surfaces — not which message).
    const err = validateRoutingShape({
      destination: "tool",
      toolName: "delete_indicator",
    });
    expect(err).not.toBeNull();
  });

  it("rejects fallbackDestination = tool (recursion guard)", () => {
    const err = validateRoutingShape({
      destination: "cosmos-log",
      fallbackDestination: "tool",
    });
    expect(err).toMatch(/fallbackDestination cannot be "tool"/);
  });

  it("ROUTING_ALLOWED_TOOLS contains the two notification tools", () => {
    expect(ROUTING_ALLOWED_TOOLS.has("send_teams_message")).toBe(true);
    expect(ROUTING_ALLOWED_TOOLS.has("send_email")).toBe(true);
  });
});

describe("validateTaskName (F4) — length + control/formatting chars", () => {
  it("accepts a normal name", () => {
    expect(validateTaskName("Weekly lateral movement hunt")).toBeNull();
  });

  it("rejects an empty / whitespace-only name", () => {
    expect(validateTaskName("")).toMatch(/name is required/);
    expect(validateTaskName("   ")).toMatch(/name is required/);
  });

  it("rejects non-string", () => {
    expect(validateTaskName(undefined)).toMatch(/name is required/);
    expect(validateTaskName(123)).toMatch(/name is required/);
  });

  it("rejects a name exceeding TASK_NAME_MAX", () => {
    expect(validateTaskName("x".repeat(TASK_NAME_MAX + 1))).toMatch(
      /characters or fewer/,
    );
  });

  it("accepts a name exactly at TASK_NAME_MAX", () => {
    expect(validateTaskName("x".repeat(TASK_NAME_MAX))).toBeNull();
  });

  it("rejects ASCII control characters in the name", () => {
    expect(validateTaskName("hunt\nwith newline")).toMatch(/control or formatting/);
    expect(validateTaskName("hunt\twith tab")).toMatch(/control or formatting/);
    expect(validateTaskName("hunt\x00with null")).toMatch(/control or formatting/);
  });

  it("rejects Unicode formatting attack characters in the name", () => {
    // U+202E (Right-to-Left Override) — used to spoof identity rendering.
    expect(validateTaskName("hunt‮evil")).toMatch(/control or formatting/);
    // U+200B (Zero Width Space) — invisible noise.
    expect(validateTaskName("hunt​hidden")).toMatch(/control or formatting/);
    // U+2066 (LRI) — BiDi isolate, spoof attack.
    expect(validateTaskName("hunt⁦malicious")).toMatch(/control or formatting/);
    // U+FEFF (BOM / ZW NBSP).
    expect(validateTaskName("hunt﻿mid")).toMatch(/control or formatting/);
  });
});

describe("validateRoutingShape — existing destinations unaffected", () => {
  it("teams-channel still requires teamsTeamId and teamsChannelId", () => {
    expect(validateRoutingShape({ destination: "teams-channel" })).toMatch(
      /requires teamsTeamId/,
    );
    expect(
      validateRoutingShape({
        destination: "teams-channel",
        teamsTeamId: "team-1",
        teamsChannelId: "19:abc@thread.tacv2",
      }),
    ).toBeNull();
  });

  it("cosmos-log requires no extra fields", () => {
    expect(validateRoutingShape({ destination: "cosmos-log" })).toBeNull();
  });

  it("unknown destination rejected", () => {
    expect(validateRoutingShape({ destination: "lp-print" })).toMatch(
      /must be one of/,
    );
  });
});
