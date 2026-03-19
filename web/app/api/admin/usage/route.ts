import { NextRequest, NextResponse } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { getAllUsersUsage } from "@/lib/usage-tracker";
import { USAGE_LIMITS } from "@/lib/config";
import { logger, hashPii } from "@/lib/logger";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (identity.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const page = Math.max(0, Number(request.nextUrl.searchParams.get("page") ?? 0));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(request.nextUrl.searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE)),
  );

  try {
    const allUsers = await getAllUsersUsage();
    const totalPages = Math.max(1, Math.ceil(allUsers.length / pageSize));
    const pageSlice = allUsers.slice(page * pageSize, (page + 1) * pageSize);

    return NextResponse.json({
      users: pageSlice.map(({ userId, twoHourUsage, weeklyUsage }) => ({
        userIdHash: hashPii(userId),
        twoHourUsage,
        weeklyUsage,
      })),
      page,
      totalPages,
      limits: {
        twoHourMax: USAGE_LIMITS.twoHourWindow.maxInputTokens,
        weeklyMax: USAGE_LIMITS.weeklyWindow.maxInputTokens,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Failed to fetch admin usage", "admin-usage", {
      errorMessage: message,
    });
    return NextResponse.json(
      { error: "Failed to fetch usage data. Check server logs." },
      { status: 500 },
    );
  }
}
