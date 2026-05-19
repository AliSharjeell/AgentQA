import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Boilerplate: Chrome profile management.
 *
 * Extend or replace `listChromeProfiles()` with your own profile detection logic.
 */

export interface ChromeProfileOption {
  id: string;
  label: string;
  profilePath: string;
  profileDirectory: string;
  isDefault: boolean;
}

export function getDefaultProfile(): ChromeProfileOption {
  return {
    id: "default",
    label: "Default Profile",
    profilePath: path.join(app.getPath("userData"), "profiles", "DefaultProfile"),
    profileDirectory: "Default",
    isDefault: true
  };
}

export function listChromeProfiles(): ChromeProfileOption[] {
  const profiles = [getDefaultProfile()];
  const userDataDir = getChromeUserDataDir();

  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return profiles;
  }

  const localState = readLocalState(userDataDir);
  const infoCache = localState?.profile?.info_cache ?? {};
  const profileDirs = fs
    .readdirSync(userDataDir, { withFileEntities: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile\s+\d+$/.test(entry.name) || entry.name.startsWith("Profile")))
    .map((entry) => entry.name);

  for (const profileDirectory of profileDirs) {
    const info = infoCache[profileDirectory] as { name?: string; user_name?: string } | undefined;
    const display = [info?.name || profileDirectory, info?.user_name].filter(Boolean).join(" - ");
    profiles.push({
      id: `chrome:${profileDirectory}`,
      label: `Chrome: ${display}`,
      profilePath: userDataDir,
      profileDirectory,
      isDefault: false
    });
  }

  return profiles;
}

function getChromeUserDataDir(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  return path.join(localAppData, "Google", "Chrome", "User Data");
}

function readLocalState(userDataDir: string): { profile?: { info_cache?: Record<string, unknown> } } | null {
  const localStatePath = path.join(userDataDir, "Local State");
  if (!fs.existsSync(localStatePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(localStatePath, "utf8")) as { profile?: { info_cache?: Record<string, unknown> } };
  } catch {
    return null;
  }
}