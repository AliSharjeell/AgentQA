/**
 * Browser login utilities.
 * Opens a Chrome profile to a given URL for manual authentication.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import path from "node:path";

let loginContext: import("playwright").BrowserContext | null = null;

/**
 * Opens a Chrome browser to a URL using the specified profile.
 * Useful for manual login flows (OAuth, Google, etc.).
 *
 * @param url      The URL to open
 * @param profilePath      Path to the Chrome user data directory
 * @param profileDirectory Sub-directory (e.g. "Default", "Profile 1")
 */
export async function openGoogleLogin(profilePath: string, profileDirectory: string): Promise<void> {
  if (loginContext) {
    await loginContext.close().catch(() => undefined);
    loginContext = null;
  }

  const isBoilerplate = path.basename(profilePath) === "DefaultProfile";
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--window-position=100,100"
  ];

  if (!isBoilerplate) {
    args.push(`--profile-directory=${profileDirectory}`);
  }

  loginContext = await chromium.launchPersistentContext(profilePath, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args
  });

  loginContext.on("close", () => {
    loginContext = null;
  });

  const page = loginContext.pages()[0] ?? await loginContext.newPage();
  if (url.startsWith("chrome://")) {
    await page.evaluate((targetUrl) => {
      window.location.href = targetUrl;
    }, url);
    await page.waitForLoadState("domcontentloaded", { timeout: 45000 }).catch(() => undefined);
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  }

  // Move window to visible position
  const windows = await loginContext.pages();
  if (windows.length > 0) {
    await windows[0].evaluate(() => {
      window.moveTo(100, 100);
      window.focus();
    });
  }
}

/**
 * Opens the browser to the Google sign-in URL.
 */
export async function openBrowserLogin(profilePath: string, profileDirectory: string): Promise<void> {
  return openGoogleLogin("https://accounts.google.com/", profilePath, profileDirectory);
}

/**
 * Opens a chrome:// URL (e.g. password manager, sync settings).
 */
export function openChromeSettings(profilePath: string, profileDirectory: string, chromeUrl: string): void {
  const chromePath = findChromeExecutable();
  spawn(chromePath, [
    `--user-data-dir=${profilePath}`,
    `--profile-directory=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=100,100",
    chromeUrl
  ], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

function findChromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : null
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => {
    try {
      return require("fs").existsSync(candidate);
    } catch {
      return false;
    }
  }) ?? "chrome.exe";
}