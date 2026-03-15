import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Slash command parsing ────────────────────────────────────

describe("slash command detection", () => {
  function parseSlashCommand(message) {
    if (!message.startsWith("/")) return null;
    const parts = message.split(/\s+/);
    const commandToken = parts[0].slice(1);
    const userArgs = parts.slice(1).join(" ");
    return { skillId: commandToken, userArgs };
  }

  it("detects a valid slash command", () => {
    const result = parseSlashCommand("/tor-login-investigation");
    assert.ok(result);
    assert.equal(result.skillId, "tor-login-investigation");
    assert.equal(result.userArgs, "");
  });

  it("extracts skill ID and user args", () => {
    const result = parseSlashCommand("/tor-login jsmith@contoso.com past 48 hours");
    assert.ok(result);
    assert.equal(result.skillId, "tor-login");
    assert.equal(result.userArgs, "jsmith@contoso.com past 48 hours");
  });

  it("returns null for non-slash messages", () => {
    assert.equal(parseSlashCommand("hello world"), null);
    assert.equal(parseSlashCommand(""), null);
  });

  it("handles slash at start with no command", () => {
    const result = parseSlashCommand("/");
    assert.ok(result);
    assert.equal(result.skillId, "");
  });

  it("does not trigger for slash in middle of message", () => {
    const result = parseSlashCommand("check /var/log for errors");
    assert.equal(result, null);
  });
});

// ── Instruction prepending ───────────────────────────────────

describe("skill instruction prepending", () => {
  function prependInstructions(skillName, instructions, userArgs) {
    return `[SKILL INVOCATION: ${skillName}]\n\nFollow these steps precisely:\n\n${instructions}\n\n---\n\nUser input: ${userArgs || "(no additional input)"}`;
  }

  it("formats correctly with user args", () => {
    const result = prependInstructions(
      "TOR Login Investigation",
      "1. Look up user\n2. Check logs",
      "jsmith@contoso.com"
    );
    assert.ok(result.startsWith("[SKILL INVOCATION: TOR Login Investigation]"));
    assert.ok(result.includes("1. Look up user"));
    assert.ok(result.includes("User input: jsmith@contoso.com"));
  });

  it("formats correctly without user args", () => {
    const result = prependInstructions(
      "Daily Triage",
      "Check all incidents",
      ""
    );
    assert.ok(result.includes("User input: (no additional input)"));
  });
});

// ── Role filtering ───────────────────────────────────────────

describe("skill role filtering", () => {
  const skills = [
    { id: "tor-login", name: "TOR Login", requiredRole: "reader" },
    { id: "password-reset", name: "Password Reset", requiredRole: "admin" },
    { id: "daily-triage", name: "Daily Triage", requiredRole: "reader" },
  ];

  function filterByRole(skillList, role) {
    return skillList.filter(
      (s) => s.requiredRole === "reader" || role === "admin"
    );
  }

  it("reader sees only reader skills", () => {
    const filtered = filterByRole(skills, "reader");
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((s) => s.requiredRole === "reader"));
  });

  it("admin sees all skills", () => {
    const filtered = filterByRole(skills, "admin");
    assert.equal(filtered.length, 3);
  });
});

// ── Skill lookup ─────────────────────────────────────────────

describe("skill lookup", () => {
  const skills = [
    { id: "tor-login", name: "TOR Login" },
    { id: "daily-triage", name: "Daily Triage" },
  ];

  function findSkill(id) {
    return skills.find((s) => s.id === id);
  }

  it("finds existing skill by ID", () => {
    const skill = findSkill("tor-login");
    assert.ok(skill);
    assert.equal(skill.name, "TOR Login");
  });

  it("returns undefined for nonexistent skill", () => {
    assert.equal(findSkill("nonexistent"), undefined);
  });
});

// ── Filter matching ──────────────────────────────────────────

describe("slash filter matching", () => {
  const skills = [
    { id: "tor-login", name: "TOR Login Investigation" },
    { id: "daily-triage", name: "Daily Triage" },
    { id: "host-forensics", name: "Host Forensics" },
  ];

  function filterSkills(query) {
    const q = query.toLowerCase();
    return skills.filter(
      (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
    );
  }

  it("filters by ID prefix", () => {
    const filtered = filterSkills("tor");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "tor-login");
  });

  it("filters by name substring", () => {
    const filtered = filterSkills("triage");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "daily-triage");
  });

  it("empty filter returns all", () => {
    assert.equal(filterSkills("").length, 3);
  });

  it("no match returns empty", () => {
    assert.equal(filterSkills("zzz").length, 0);
  });
});
