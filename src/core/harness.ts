import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const execAsync = promisify(exec);

export interface HarnessStepEvent {
  instruction: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  error?: string;
}

export interface CliReport {
  result: 'PASS' | 'FAIL' | 'INFRA_FAILED' | 'AGENT_FAILED' | 'FAIL_AGENT_QA';
  scenario: string;
  confirmedBugs: string[];
  warnings: string[];
  stepsExecuted: string[];
  evidence: string[];
  finalUrl: string;
  screenshots: string[];
  consoleErrors: string[];
  fixRecommendations: string[];
  faultLog?: QaFault[];
}

export interface HarnessResult {
  ok: boolean;
  summary: string;
  error?: string;
  report?: CliReport;
}

export type FaultSeverity = 'critical' | 'major' | 'minor' | 'warning';
export type FaultType = 'site_bug' | 'validation_issue' | 'console_error' | 'blocked_flow' | 'agent_issue' | 'infra';

export interface QaFault {
  severity: FaultSeverity;
  type: FaultType;
  title: string;
  details: string;
  evidence: string[];
  url: string;
  step: string;
}

export interface ObservedElement {
  id: string;
  type: string;
  description: string;
  value?: string | null;
  text?: string;
  tag: string;
  selector: string;
  href?: string;
  role?: string;
  name?: string;
  classes?: string;
  x: number;
  y: number;
  visible: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface PageObservation {
  taskUrl: string;
  page: {
    url?: string;
    title?: string;
    w?: number;
    h?: number;
  };
  availableElements: ObservedElement[];
  interactiveElements: ObservedElement[];
  pageText: string;
  consoleErrors: string[];
}

export type StructuredActionName = 'click' | 'type' | 'read' | 'scroll' | 'wait' | 'navigate' | 'batch';

export interface StructuredAction {
  action: StructuredActionName;
  targetId?: string;
  value?: string;
  url?: string;
  dy?: number;
  seconds?: number;
  confidence?: number;
  reason?: string;
  description?: string;
  actions?: StructuredAction[];
  _target?: ObservedElement | null;
}

interface ResolvedCommand {
  executable: string;
  args: string[];
}

interface ManagedBrowser {
  cdpUrl: string;
  process: ChildProcess;
}

let managedBrowserPromise: Promise<ManagedBrowser> | null = null;
let cleanupRegistered = false;

function getAgentQaDataDir(): string {
  return path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'agentqa');
}

function findChromeExecutable(): string {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
        process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/usr/bin/microsoft-edge'
        ];

  const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error('Could not find Chrome or Edge. Set CHROME_PATH to a Chrome-compatible browser executable.');
  }
  return found;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate a local debugging port.'));
      });
    });
  });
}

async function isCdpReachable(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startManagedBrowser(): Promise<ManagedBrowser> {
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const userDataDir = path.join(getAgentQaDataDir(), `chrome-cli-profile-${process.pid}-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const chrome = findChromeExecutable();
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      child.kill();
    });
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await isCdpReachable(cdpUrl)) {
      return { cdpUrl, process: child };
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before the debugging port became reachable. ${stderr.trim()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error(`Chrome debugging endpoint did not become reachable at ${cdpUrl}. ${stderr.trim()}`);
}

async function resolveCdpUrl(cdpUrl?: string): Promise<{ cdpUrl?: string; managed: boolean }> {
  if (cdpUrl) return { cdpUrl, managed: false };

  if (process.env.BU_CDP_URL && await isCdpReachable(process.env.BU_CDP_URL)) {
    return { cdpUrl: process.env.BU_CDP_URL, managed: false };
  }

  managedBrowserPromise ??= startManagedBrowser();
  const browser = await managedBrowserPromise;
  return { cdpUrl: browser.cdpUrl, managed: true };
}

function browserNameFor(cdpUrl: string, managed: boolean): string {
  if (managed) return `agentqa-cli-${process.pid}`;
  return `agentqa-${Buffer.from(cdpUrl).toString('base64url').slice(0, 24)}`;
}

// The set_value Python preamble that gets prepended to every script.
// Uses JavaScript to set input values progressively, making it observable in live preview and bypassing Electron's CDP double-typing bug.
const SET_VALUE_PREAMBLE = `
import json as _json
import time as _time

def set_value(selector, text):
    """Set an input's value progressively via JavaScript — works in React, Vue, and vanilla HTML."""
    _sel = _json.dumps(selector)
    _val = _json.dumps(text)
    js(f"""(() => {{
        const el = document.querySelector({_sel});
        if (!el) throw new Error('set_value: element not found: ' + {_sel});
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, {_val});
        else el.value = {_val};
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
        el.dispatchEvent(new Event('blur', {{ bubbles: true }}));
    }})()""")

`;

export function resolveBrowserHarnessCommand(): ResolvedCommand {
  if (process.env.BROWSER_HARNESS_PATH && fs.existsSync(process.env.BROWSER_HARNESS_PATH)) {
    return { executable: process.env.BROWSER_HARNESS_PATH, args: [] };
  }
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const pythonExePath = path.join(userProfile, 'AppData', 'Roaming', 'uv', 'tools', 'browser-harness', 'Scripts', 'python.exe');
    if (fs.existsSync(pythonExePath)) {
      return { executable: pythonExePath, args: ['-m', 'browser_harness.run'] };
    }
    const uvToolPath = path.join(userProfile, '.local', 'bin', 'browser-harness.exe');
    if (fs.existsSync(uvToolPath)) {
      return { executable: uvToolPath, args: [] };
    }
  }
  return { executable: 'browser-harness', args: [] };
}

export async function ensureBrowserHarnessInstalled(): Promise<boolean> {
  const resolved = resolveBrowserHarnessCommand();
  if (resolved.executable !== 'browser-harness' && fs.existsSync(resolved.executable)) {
    return true;
  }
  // Check if browser-harness is on PATH
  try {
    const checkCmd = process.platform === 'win32' ? 'where browser-harness' : 'which browser-harness';
    await execAsync(checkCmd);
    return true;
  } catch {
    // Not found
  }

  // Not found. Attempt to install via uv
  try {
    console.log("Browser-harness not found. Attempting to install via uv...");
    await execAsync('uv tool install git+https://github.com/browser-use/browser-harness');
    console.log("Browser-harness successfully installed via uv.");
    return true;
  } catch {
    try {
      console.log("uv failed or not found. Attempting to install via pip...");
      await execAsync('pip install git+https://github.com/browser-use/browser-harness');
      console.log("Browser-harness successfully installed via pip.");
      return true;
    } catch (err) {
      console.error("Could not auto-install browser-harness:", err);
      return false;
    }
  }
}

export function runHarnessScript(
  script: string,
  onStep: (event: HarnessStepEvent) => void,
  cdpUrl?: string,
  timeoutMs: number = 120000
): Promise<HarnessResult> {
  return new Promise(async (resolve) => {
    // Ensure browser-harness is installed/available at runtime
    await ensureBrowserHarnessInstalled();

    let resolvedCdp: { cdpUrl?: string; managed: boolean };
    try {
      resolvedCdp = await resolveCdpUrl(cdpUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, summary: 'Headless browser could not be started.', error: message });
      return;
    }

    const { executable, args } = resolveBrowserHarnessCommand();
    const env: Record<string, string | undefined> = { ...process.env };
    if (resolvedCdp.cdpUrl) {
      env.BU_CDP_URL = resolvedCdp.cdpUrl;
      env.BU_NAME = env.BU_NAME || browserNameFor(resolvedCdp.cdpUrl, resolvedCdp.managed);
    }
    const child = spawn(executable, args, {
      shell: false,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let finalResult: HarnessResult | null = null;
    let stderr = '';
    let stdout = '';
    let stdoutBuffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ ok: false, summary: 'Browser-harness timed out.', error: `Process did not finish within ${timeoutMs / 1000} seconds.` });
    }, timeoutMs);

    const finish = (result: HarnessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const handleLine = (line: string): void => {
      if (!line.startsWith('BH_EVENT ')) return;
      try {
        const event = JSON.parse(line.slice('BH_EVENT '.length)) as Partial<HarnessStepEvent> & Partial<HarnessResult> & { final?: boolean };
        if (event.final) {
          finalResult = { ok: Boolean(event.ok), summary: event.summary ?? '', error: event.error, report: event.report };
          return;
        }
        if (event.instruction) {
          onStep({
            instruction: event.instruction,
            status: (event.status as HarnessStepEvent['status']) ?? 'running',
            result: event.result,
            error: event.error
          });
        }
      } catch { /* ignore malformed */ }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        handleLine(stdoutBuffer.slice(0, idx).trim());
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ ok: false, summary: 'Browser-harness could not be started.', error: `${error.message}. Install: uv tool install git+https://github.com/browser-use/browser-harness` });
    });
    child.on('close', (code) => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      if (finalResult) { finish(finalResult); }
      else { finish({ ok: false, summary: 'Browser-harness exited prematurely.', error: `Exit code ${code}.\nStderr: ${stderr}\nStdout: ${stdout}` }); }
    });

    child.stdin.on('error', () => {});
    if (child.stdin.writable) {
      child.stdin.write(SET_VALUE_PREAMBLE + script);
      child.stdin.end();
    }
  });
}

function buildDomSnapshotPython(): string {
  return `
    info = page_info()
    if not info:
        info = {}
    if not info.get("url"):
        info["url"] = js("window.location.href")
    if not info.get("title"):
        info["title"] = js("document.title")
    snapshot = js("""(() => {
      if (!window.__agentqaConsoleErrors) {
        window.__agentqaConsoleErrors = [];
        window.addEventListener('error', event => {
          window.__agentqaConsoleErrors.push(String(event.message || event.error || 'error'));
        });
        window.addEventListener('unhandledrejection', event => {
          window.__agentqaConsoleErrors.push(String(event.reason || 'unhandled rejection'));
        });
      }

      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
      };
      const selectorFor = (el) => {
        if (el.id) return '#' + cssEscape(el.id);
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
        if (testId) return '[' + (el.getAttribute('data-testid') ? 'data-testid' : el.getAttribute('data-test') ? 'data-test' : 'data-qa') + '="' + testId.replace(/"/g, '\\\\"') + '"]';
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
        const path = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && path.length < 5) {
          let part = cur.tagName.toLowerCase();
          const parent = cur.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter(child => child.tagName === cur.tagName);
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          path.unshift(part);
          cur = parent;
        }
        return path.join(' > ');
      };
      const describe = (el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const stableName = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.id || el.getAttribute('name') || '';
        const base = (
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          text ||
          el.href ||
          el.getAttribute('value') ||
          stableName ||
          String(el.className || '').replace(/\\s+/g, ' ').trim() ||
          el.tagName.toLowerCase()
        ).trim();
        if (stableName && base && !base.toLowerCase().includes(String(stableName).toLowerCase()) && /^(add to cart|remove|checkout|continue|login|submit)$/i.test(base)) {
          return (base + ' (' + stableName + ')').trim();
        }
        return base;
      };
      const typeFor = (el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const inputType = (el.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return inputType || 'input';
        if (tag === 'select') return 'select';
        if (tag === 'button' || role === 'button') return 'button';
        if (tag === 'a' || role === 'link') return 'link';
        if (role) return role;
        return tag;
      };

      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[tabindex],label'));
      const elements = [];
      let idx = 0;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        if (!visible) continue;
        const description = describe(el);
        if (!description && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;
        const value = 'value' in el ? String(el.value || '') : null;
        elements.push({
          id: 'elem_' + idx++,
          type: typeFor(el),
          description: description.slice(0, 160),
          value,
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          tag: el.tagName.toLowerCase(),
          selector: selectorFor(el),
          href: el.href || '',
          role: el.getAttribute('role') || '',
          name: el.getAttribute('name') || '',
          classes: String(el.className || '').slice(0, 100),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          visible: true,
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          checked: Boolean(el.checked || el.getAttribute('aria-checked') === 'true'),
          selected: Boolean(el.selected || el.getAttribute('aria-selected') === 'true')
        });
        if (elements.length >= 140) break;
      }
      return {
        availableElements: elements,
        pageText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4500),
        consoleErrors: (window.__agentqaConsoleErrors || []).slice(-12)
      };
    })()""")
    elements = snapshot.get("availableElements", []) if isinstance(snapshot, dict) else []
    page_text = snapshot.get("pageText", "") if isinstance(snapshot, dict) else ""
    console_errors = snapshot.get("consoleErrors", []) if isinstance(snapshot, dict) else []
    observation = {
        "taskUrl": target_url,
        "page": info,
        "availableElements": elements,
        "interactiveElements": elements,
        "pageText": page_text,
        "consoleErrors": console_errors
    }
`;
}

function indentPython(script: string, prefix: string): string {
  return script
    .split('\n')
    .map((line) => line.trim() ? `${prefix}${line}` : line)
    .join('\n');
}

function attachTargets(action: StructuredAction, target: ObservedElement | null): StructuredAction {
  if (action.action !== 'batch') {
    return { ...action, _target: target };
  }

  return {
    ...action,
    _target: target,
    actions: (action.actions || []).map((item) => ({
      ...item,
      _target: item._target ?? null
    }))
  };
}

export function buildObservationScript(targetUrl: string, navigate: boolean = false): string {
  const openStep = navigate
    ? `
    emit({"instruction": "Open " + target_url, "status": "running"})
    goto_url(target_url)
    wait_for_load()
    time.sleep(0.3)
    emit({"instruction": "Open " + target_url, "status": "done", "result": "Loaded " + str(js("window.location.href"))})
`
    : '';

  return `
import json
import time

target_url = ${JSON.stringify(targetUrl)}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
${openStep}
    emit({"instruction": "Inspect current page", "status": "running"})
${buildDomSnapshotPython()}
    emit({"instruction": "Inspect current page", "status": "done", "result": json.dumps(observation)})
    emit({"final": True, "ok": True, "summary": json.dumps(observation)})
except Exception as exc:
    emit({"final": True, "ok": False, "summary": "DOM inspection failed.", "error": str(exc)})
`;
}

export function buildActionScript(action: StructuredAction, target: ObservedElement | null, taskUrl: string): string {
  const actionWithTargets = attachTargets(action, target);
  return `
import json
import time

target_url = ${JSON.stringify(taskUrl)}
action = json.loads(${JSON.stringify(JSON.stringify(actionWithTargets))})
target = action.get("_target")

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

def target_selector():
    if not target:
        return ""
    return target.get("selector") or ""

def click_target():
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for click action.")
    selector = active_target.get("selector") or ""
    pos = None
    if selector:
        sel = json.dumps(selector)
        clicked = js(f"""(() => {{
          const el = document.querySelector({sel});
          if (!el) return false;
          el.scrollIntoView({{block: 'center', inline: 'center'}});
          if (typeof el.click === 'function') {{
            el.click();
            return true;
          }}
          el.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true, view: window }}));
          return true;
        }})()""")
        if clicked:
            return
        pos = js(f"""(() => {{
          const el = document.querySelector({sel});
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {{x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)}};
        }})()""")
    if not pos:
        pos = {"x": active_target.get("x", 0), "y": active_target.get("y", 0)}
    click_at_xy(int(pos["x"]), int(pos["y"]))

def type_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for type action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for type action.")
    set_value(selector, str(value or ""))

def read_target():
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for read action.")
    selector = active_target.get("selector") or ""
    if selector:
        sel = json.dumps(selector)
        value = js(f"""(() => {{
          const el = document.querySelector({sel});
          if (!el) return null;
          return ('value' in el && el.value !== undefined && el.value !== '') ? String(el.value) : String(el.innerText || el.textContent || '');
        }})()""")
        if value is not None:
            return str(value)
    return str(active_target.get("value") or active_target.get("description") or active_target.get("text") or "")

def execute_one(item):
    global action
    previous_action = action
    action = item
    kind = item.get("action")
    result = ""
    if kind == "click":
        click_target()
        result = "Clicked " + str((item.get("_target") or {}).get("id", item.get("targetId", "")))
    elif kind == "type":
        type_target(item.get("value", ""))
        result = "Typed into " + str((item.get("_target") or {}).get("id", item.get("targetId", "")))
    elif kind == "read":
        result = read_target()
    elif kind == "scroll":
        dy = int(item.get("dy") or -650)
        scroll(500, 500, dy=dy)
        result = "Scrolled by " + str(dy)
    elif kind == "wait":
        seconds = float(item.get("seconds") or 1)
        if seconds < 0:
            seconds = 0
        if seconds > 10:
            seconds = 10
        time.sleep(seconds)
        result = "Waited " + str(seconds) + " seconds"
    elif kind == "navigate":
        url = item.get("url")
        if not url:
            raise Exception("Navigate action requires url.")
        goto_url(str(url))
        wait_for_load()
        result = "Navigated to " + str(url)
    else:
        raise Exception("Unsupported action: " + str(kind))
    action = previous_action
    return result

try:
    instruction = action.get("description") or action.get("action", "action")
    emit({"instruction": instruction, "status": "running"})
    action_result = ""
    kind = action.get("action")
    url_before = js("window.location.href")
    text_before = js("(document.body && document.body.innerText || '').slice(0, 300)")
    if kind == "batch":
        results = []
        for item in action.get("actions", []):
            results.append(execute_one(item))
            time.sleep(0.12)
        action_result = "; ".join(results)
    else:
        action_result = execute_one(action)

    for _ in range(12):
        time.sleep(0.1)
        try:
            url_now = js("window.location.href")
            text_now = js("(document.body && document.body.innerText || '').slice(0, 300)")
            if url_now != url_before or text_now != text_before:
                break
        except Exception:
            break
    emit({"instruction": instruction, "status": "done", "result": action_result})
${buildDomSnapshotPython()}
    observation["actionResult"] = action_result
    emit({"final": True, "ok": True, "summary": json.dumps(observation)})
except Exception as exc:
    emit({"instruction": action.get("action", "action"), "status": "failed", "error": str(exc)})
    try:
${indentPython(buildDomSnapshotPython(), '    ')}
        observation["actionResult"] = "Failed: " + str(exc)
        emit({"final": True, "ok": False, "summary": json.dumps(observation), "error": str(exc)})
    except Exception:
        emit({"final": True, "ok": False, "summary": "Action execution failed.", "error": str(exc)})
`;
}
