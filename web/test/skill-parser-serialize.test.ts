import { describe, expect, it } from "vitest";

import {
  DEFAULT_SKILL,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from "../lib/skill-parser";
import type { Skill } from "../lib/types";

// Round-trip tests pinning the contract that parseSkillMarkdown and
// serializeSkillMarkdown are inverse operations. The structured Skill
// editor relies on this contract: it serializes form state to the
// canonical Markdown shape before POSTing, then re-parses on edit.
// If the contract drifts, the form will appear to "lose" fields on
// edit-then-save.

function roundtrip(skill: Skill): Skill {
  return parseSkillMarkdown(skill.id, serializeSkillMarkdown(skill));
}

describe("serializeSkillMarkdown round-trip", () => {
  it("round-trips DEFAULT_SKILL", () => {
    const seeded: Skill = { ...DEFAULT_SKILL, id: "default-skill" };
    expect(roundtrip(seeded)).toEqual(seeded);
  });

  it("round-trips a multi-step Steps section with ### N. subheadings", () => {
    const skill: Skill = {
      id: "tor-login-investigation",
      name: "TOR Login Investigation",
      description: "Triage a TOR sign-in alert end-to-end.",
      instructions: [
        "### 1. Confirm the alert",
        "",
        "Look up the user and the sign-in event.",
        "",
        "### 2. Check geo + device",
        "",
        "Pull the last 7 days of sign-ins.",
      ].join("\n"),
      requiredTools: ["run_sentinel_kql", "get_user_info"],
      requiredRole: "reader",
      parameters: ["upn", "timeframe"],
    };

    expect(roundtrip(skill)).toEqual(skill);
  });

  it("round-trips an admin-role skill with destructive tools", () => {
    const skill: Skill = {
      id: "compromised-account-containment",
      name: "Compromised Account Containment",
      description: "Reset password and isolate device.",
      instructions: "### 1. Reset\n\nReset the user password.",
      requiredTools: ["reset_user_password", "isolate_machine"],
      requiredRole: "admin",
      parameters: ["upn", "machine_id"],
    };

    expect(roundtrip(skill)).toEqual(skill);
  });

  it("round-trips a skill with zero parameters and zero required tools", () => {
    const skill: Skill = {
      id: "minimal-skill",
      name: "Minimal",
      description: "Bare minimum.",
      instructions: "### 1. Do thing\n\nThing.",
      requiredTools: [],
      requiredRole: "reader",
      parameters: [],
    };

    expect(roundtrip(skill)).toEqual(skill);
  });

  it("produces output the parser reads back with the same role for both 'reader' and 'admin'", () => {
    for (const role of ["reader", "admin"] as const) {
      const skill: Skill = { ...DEFAULT_SKILL, id: `role-${role}`, requiredRole: role };
      expect(roundtrip(skill).requiredRole).toBe(role);
    }
  });

  it("emits the canonical section order parseSkillMarkdown expects", () => {
    const md = serializeSkillMarkdown({ ...DEFAULT_SKILL, id: "any" });
    const idxName = md.indexOf("# Skill: ");
    const idxDescription = md.indexOf("## Description");
    const idxTools = md.indexOf("## Required Tools");
    const idxRole = md.indexOf("## Required Role");
    const idxParameters = md.indexOf("## Parameters");
    const idxSteps = md.indexOf("## Steps");

    expect(idxName).toBeGreaterThanOrEqual(0);
    expect(idxDescription).toBeGreaterThan(idxName);
    expect(idxTools).toBeGreaterThan(idxDescription);
    expect(idxRole).toBeGreaterThan(idxTools);
    expect(idxParameters).toBeGreaterThan(idxRole);
    expect(idxSteps).toBeGreaterThan(idxParameters);
  });
});
