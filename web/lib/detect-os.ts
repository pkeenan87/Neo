export type DetectedOS = "windows" | "macos" | "linux" | "unknown";

export function detectOS(userAgent: string): DetectedOS {
  const ua = userAgent.toLowerCase();

  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";

  return "unknown";
}
