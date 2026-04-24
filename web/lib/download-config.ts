import type { DetectedOS } from "./detect-os";

export interface PlatformInfo {
  id: DetectedOS;
  name: string;
  iconName: string;
  fileExtension: string;
  blobFilename: string | null;
  downloadPath: string | null;
  version: string;
  releaseDate: string;
  fileSize: string | null;
  status: "available" | "coming-soon";
}

export const PLATFORMS: PlatformInfo[] = [
  {
    id: "windows",
    name: "Windows",
    iconName: "Monitor",
    fileExtension: ".exe",
    blobFilename: "neo-setup.exe",
    downloadPath: "/api/downloads/neo-setup.exe",
    version: "1.1.0",
    releaseDate: "2026-04-24",
    fileSize: null,
    status: "available",
  },
  {
    id: "macos",
    name: "macOS",
    iconName: "Apple",
    fileExtension: ".dmg",
    blobFilename: null,
    downloadPath: null,
    version: "—",
    releaseDate: "—",
    fileSize: null,
    status: "coming-soon",
  },
  {
    id: "linux",
    name: "Linux",
    iconName: "Terminal",
    fileExtension: ".tar.gz",
    blobFilename: null,
    downloadPath: null,
    version: "—",
    releaseDate: "—",
    fileSize: null,
    status: "coming-soon",
  },
];
