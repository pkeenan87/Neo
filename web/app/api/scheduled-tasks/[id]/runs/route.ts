import { NextRequest, NextResponse } from "next/server";

import { resolveAuth } from "@/lib/auth-helpers";
import { getTask } from "@/lib/scheduled-task-store";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(request: NextRequest, { params }: RouteParams) {
  const identity = await resolveAuth(request);
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin role required" }, { status: 403 });
  }

  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Scheduled task not found" }, { status: 404 });

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");

  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const offset = Math.max(parseInt(offsetRaw ?? "0", 10) || 0, 0);

  // runHistory is stored ascending by startTime; the UI cares about
  // newest-first, so reverse before paginating.
  const reversed = [...task.runHistory].reverse();
  const page = reversed.slice(offset, offset + limit);

  return NextResponse.json({
    runs: page,
    total: task.runHistory.length,
    limit,
    offset,
  });
}
