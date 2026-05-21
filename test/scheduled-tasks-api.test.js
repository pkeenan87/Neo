import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Replicated request-body validator from the POST route ────
// Mirrors validateCreatePayload in
// web/app/api/scheduled-tasks/route.ts so the validation surface
// is testable without spinning up a Next.js route handler.

const VALID_DESTINATIONS = ["teams-channel", "cosmos-log", "email"];
const MAX_DURATION_SECONDS_CAP = 600;

function validateCreatePayload(body) {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  if (typeof body.name !== "string" || !body.name.trim()) return "name is required";
  if (typeof body.description !== "string") return "description is required";

  const schedule = body.schedule;
  if (
    !schedule ||
    typeof schedule.cronExpression !== "string" ||
    typeof schedule.timezone !== "string"
  ) {
    return "schedule.cronExpression and schedule.timezone are required";
  }

  const task = body.task;
  if (!task || typeof task.promptTemplate !== "string" || !Array.isArray(task.allowedTools)) {
    return "task.promptTemplate and task.allowedTools[] are required";
  }
  if (typeof task.maxDurationSeconds !== "number" || task.maxDurationSeconds <= 0) {
    return "task.maxDurationSeconds must be a positive number";
  }
  if (task.maxDurationSeconds > MAX_DURATION_SECONDS_CAP) {
    return `task.maxDurationSeconds cannot exceed ${MAX_DURATION_SECONDS_CAP}`;
  }
  for (const t of task.allowedTools) {
    if (typeof t !== "string") return "task.allowedTools must be string[]";
  }

  const routing = body.routing;
  if (!routing || typeof routing.destination !== "string") {
    return "routing.destination is required";
  }
  if (!VALID_DESTINATIONS.includes(routing.destination)) {
    return `routing.destination must be one of: ${VALID_DESTINATIONS.join(", ")}`;
  }
  if (routing.destination === "teams-channel") {
    if (typeof routing.teamsTeamId !== "string" || typeof routing.teamsChannelId !== "string") {
      return "teams-channel destination requires teamsTeamId and teamsChannelId";
    }
  }

  return null; // ok
}

const VALID_BODY = {
  name: "Test task",
  description: "Test",
  schedule: { cronExpression: "0 8 * * 1", timezone: "America/New_York" },
  task: {
    promptTemplate: "Run a hunt for {{lookbackDays}} days.",
    variables: { lookbackDays: 7 },
    allowedTools: ["run_sentinel_kql"],
    maxDurationSeconds: 60,
  },
  routing: { destination: "cosmos-log" },
};

// ── Tests ────────────────────────────────────────────────────

describe("validateCreatePayload", () => {
  it("accepts a well-formed payload", () => {
    assert.equal(validateCreatePayload(VALID_BODY), null);
  });

  it("rejects non-object body", () => {
    assert.match(validateCreatePayload(null), /JSON object/);
    assert.match(validateCreatePayload("string"), /JSON object/);
  });

  it("requires name", () => {
    const out = validateCreatePayload({ ...VALID_BODY, name: "" });
    assert.match(out, /name is required/);
  });

  it("requires description", () => {
    const { description: _omit, ...rest } = VALID_BODY;
    void _omit;
    assert.match(validateCreatePayload(rest), /description is required/);
  });

  it("requires schedule.cronExpression and timezone", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      schedule: { cronExpression: "0 8 * * 1" },
    });
    assert.match(out, /schedule.cronExpression and schedule.timezone are required/);
  });

  it("requires task.promptTemplate and allowedTools", () => {
    const out = validateCreatePayload({ ...VALID_BODY, task: { ...VALID_BODY.task, allowedTools: undefined } });
    assert.match(out, /task.promptTemplate and task.allowedTools/);
  });

  it("rejects maxDurationSeconds <= 0", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      task: { ...VALID_BODY.task, maxDurationSeconds: 0 },
    });
    assert.match(out, /positive number/);
  });

  it("rejects maxDurationSeconds > cap", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      task: { ...VALID_BODY.task, maxDurationSeconds: MAX_DURATION_SECONDS_CAP + 1 },
    });
    assert.match(out, /cannot exceed/);
  });

  it("rejects non-string elements in allowedTools", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      task: { ...VALID_BODY.task, allowedTools: ["ok", 123] },
    });
    assert.match(out, /task.allowedTools must be string/);
  });

  it("rejects unknown destination", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      routing: { destination: "pager" },
    });
    assert.match(out, /routing.destination must be one of/);
  });

  it("teams-channel destination requires teamsTeamId + teamsChannelId", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      routing: { destination: "teams-channel" },
    });
    assert.match(out, /teams-channel destination requires teamsTeamId and teamsChannelId/);
  });

  it("teams-channel destination with both ids is accepted", () => {
    const out = validateCreatePayload({
      ...VALID_BODY,
      routing: {
        destination: "teams-channel",
        teamsTeamId: "00000000-0000-0000-0000-000000000001",
        teamsChannelId: "19:abc@thread.tacv2",
      },
    });
    assert.equal(out, null);
  });
});
