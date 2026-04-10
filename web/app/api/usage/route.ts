import { NextRequest } from "next/server";
import { resolveAuth } from "@/lib/auth-helpers";
import { checkBudget } from "@/lib/usage-tracker";
import { USAGE_LIMITS, env } from "@/lib/config";

export async function GET(request: NextRequest) {
  const identity = await resolveAuth(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // checkBudget returns both usage summaries, avoiding redundant Cosmos queries
  const budget = await checkBudget(identity.ownerId);

  return new Response(
    JSON.stringify({
      enforced: env.ENABLE_USAGE_LIMITS,
      twoHourUsage: budget.twoHourUsage,
      weeklyUsage: budget.weeklyUsage,
      twoHourLimit: USAGE_LIMITS.twoHourWindow.maxInputTokens,
      weeklyLimit: USAGE_LIMITS.weeklyWindow.maxInputTokens,
      twoHourRemaining: budget.twoHourRemaining,
      weekRemaining: budget.weekRemaining,
      warning: budget.warning,
      projectedMonthlyCostUsd: budget.weeklyUsage.estimatedCostUsd * (30 / 7),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
