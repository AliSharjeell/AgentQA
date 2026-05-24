import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { FieldRegistry, FieldRegistryEntry } from '../shared/types';

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
  options?: Array<{
    value: string;
    label: string;
    selected?: boolean;
    disabled?: boolean;
  }>;
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
  expanded?: boolean;
}

export interface PageObservation {
  taskUrl: string;
  page: {
    url?: string;
    title?: string;
    w?: number;
    h?: number;
    sx?: number;
    sy?: number;
    pw?: number;
    ph?: number;
  };
  availableElements: ObservedElement[];
  interactiveElements: ObservedElement[];
  fieldRegistry?: FieldRegistry;
  pageText: string;
  consoleErrors: string[];
  networkErrors: string[];
}

export type StructuredActionName =
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'radio'
  | 'hover'
  | 'upload_file'
  | 'press_key'
  | 'wait_for'
  | 'read'
  | 'scroll'
  | 'wait'
  | 'navigate'
  | 'assert_text'
  | 'assert_url'
  | 'assert_visible'
  | 'assert_value'
  | 'assert_checked'
  | 'assert_selected'
  | 'assert_count'
  | 'screenshot'
  | 'batch';

export interface StructuredAction {
  action: StructuredActionName;
  targetId?: string;
  value?: string;
  key?: string;
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

// The form-control Python preamble that gets prepended to every script.
// Uses JavaScript for normal text input to avoid Electron's CDP double-typing bug.
const SET_VALUE_PREAMBLE = `
import json as _json
import time as _time

def set_value(selector, text):
    """Set text on inputs, textareas, contenteditable nodes, or editable descendants."""
    _sel = _json.dumps(selector)
    _val = _json.dumps(text)
    result = js(f"""(() => {{
        const el = document.querySelector({_sel});
        if (!el) throw new Error('set_value: element not found: ' + {_sel});
        const excludedInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
        const roleOf = (node) => String(node.getAttribute('role') || '').toLowerCase();
        const isTextInput = (node) => {{
            const tag = node.tagName.toLowerCase();
            const type = String(node.getAttribute('type') || '').toLowerCase();
            return tag === 'textarea' || (tag === 'input' && !excludedInputTypes.has(type));
        }};
        const isEditable = (node) => {{
            const role = roleOf(node);
            return isTextInput(node) || node.isContentEditable || role === 'textbox' || role === 'searchbox' || (role === 'combobox' && isTextInput(node));
        }};
        const editable = isEditable(el)
            ? el
            : el.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]), textarea, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"] input');
        if (!editable) throw new Error('set_value: no editable target for ' + {_sel});
        editable.scrollIntoView({{ block: 'center', inline: 'center' }});
        try {{ editable.focus({{ preventScroll: true }}); }} catch (_) {{ editable.focus(); }}
        const tag = editable.tagName.toLowerCase();
        const role = roleOf(editable);
        const useTextContent = editable.isContentEditable || (!('value' in editable) && (role === 'textbox' || role === 'searchbox'));
        if (useTextContent) {{
            editable.textContent = {_val};
            try {{
                const range = document.createRange();
                range.selectNodeContents(editable);
                range.collapse(false);
                const selection = window.getSelection();
                if (selection) {{
                    selection.removeAllRanges();
                    selection.addRange(range);
                }}
            }} catch (_) {{}}
        }} else {{
            const proto = Object.getPrototypeOf(editable);
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
                || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(editable, {_val});
            else editable.value = {_val};
        }}
        try {{
            editable.dispatchEvent(new InputEvent('input', {{ bubbles: true, cancelable: true, inputType: 'insertText', data: {_val} }}));
        }} catch (_) {{
            editable.dispatchEvent(new Event('input', {{ bubbles: true }}));
        }}
        editable.dispatchEvent(new Event('change', {{ bubbles: true }}));
        editable.dispatchEvent(new KeyboardEvent('keyup', {{ bubbles: true, key: '', code: '' }}));
        const actual = ('value' in editable)
            ? String(editable.value || '')
            : String(editable.innerText || editable.textContent || '').replace(/\\s+/g, ' ').trim();
        const expected = String({_val});
        if (actual !== expected) {{
            const normActual = actual.replace(/\\s+/g, ' ').trim();
            const normExpected = expected.replace(/\\s+/g, ' ').trim();
            if (normActual !== normExpected) throw new Error('set_value: value verification failed. Expected "' + expected + '" but found "' + actual + '".');
        }}
        return {{ ok: true, tag, role, actual }};
    }})()""")
    if not result or not result.get("ok"):
        raise Exception("set_value: value update failed for " + selector)
    return result

def click_element(selector, fallback_x=None, fallback_y=None):
    """Click an element with real pointer/mouse events at its center."""
    _sel = _json.dumps(selector)
    pos = js(f"""(() => {{
        const el = document.querySelector({_sel});
        if (!el) return null;
        el.scrollIntoView({{ block: 'center', inline: 'center' }});
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {{ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }};
    }})()""")
    if not pos:
        if fallback_x is None or fallback_y is None:
            raise Exception("click_element: element not found or not clickable: " + selector)
        pos = {"x": fallback_x, "y": fallback_y}
    click_at_xy(int(pos["x"]), int(pos["y"]))
    _time.sleep(0.08)
    return pos

def select_option(selector, text):
    """Select a native select option or a visible custom ARIA/menu option by text/value."""
    _sel = _json.dumps(selector)
    _val = _json.dumps(str(text or ""))
    native = js(f"""(() => {{
        const el = document.querySelector({_sel});
        if (!el) throw new Error('select_option: element not found: ' + {_sel});
        if (el.tagName.toLowerCase() !== 'select') return null;
        const expected = String({_val});
        const want = expected.replace(/\\s+/g, ' ').trim().toLowerCase();
        if (!want) throw new Error('select_option: option text/value is required.');
        const options = Array.from(el.options).map((option, index) => ({{
            option,
            index,
            value: String(option.value || ''),
            label: String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim(),
            disabled: Boolean(option.disabled)
        }})).filter(item => !item.disabled);
        const choose = (items) => {{
            if (items.length === 1) return items[0];
            if (items.length > 1) throw new Error('select_option: ambiguous native option match for "' + expected + '": ' + items.map(item => item.label || item.value).join(', '));
            return null;
        }};
        let match =
            choose(options.filter(item => item.value === expected)) ||
            choose(options.filter(item => item.label === expected)) ||
            choose(options.filter(item => item.value.replace(/\\s+/g, ' ').trim().toLowerCase() === want)) ||
            choose(options.filter(item => item.label.replace(/\\s+/g, ' ').trim().toLowerCase() === want)) ||
            choose(options.filter(item => item.value.replace(/\\s+/g, ' ').trim().toLowerCase().includes(want) || item.label.replace(/\\s+/g, ' ').trim().toLowerCase().includes(want)));
        if (!match) throw new Error('select_option: no native option matched "' + expected + '". Available: ' + options.map(item => item.label || item.value).join(', '));
        el.selectedIndex = match.index;
        el.value = match.option.value;
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
        return {{ ok: true, mode: 'native', label: match.label, value: String(el.value || '') }};
    }})()""")
    if native:
        return native

    click_element(selector)
    _time.sleep(0.2)
    option = js(f"""(() => {{
        const target = document.querySelector({_sel});
        const expected = String({_val});
        const want = expected.replace(/\\s+/g, ' ').trim().toLowerCase();
        if (!want) return {{ error: 'select_option: option text/value is required.' }};
        const visible = (node) => {{
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        }};
        const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const labelFor = (node) => String(
            node.getAttribute('aria-label') ||
            node.innerText ||
            node.textContent ||
            node.getAttribute('data-value') ||
            node.getAttribute('value') ||
            ''
        ).replace(/\\s+/g, ' ').trim();
        const optionSelector = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[data-value],[data-radix-collection-item],[cmdk-item],li,button';
        const nodes = [];
        const seen = new Set();
        const addNode = (node) => {{
            if (!node || seen.has(node) || node === target || !visible(node)) return;
            seen.add(node);
            const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('data-disabled') === 'true';
            const label = labelFor(node);
            if (!label || disabled) return;
            nodes.push({{ node, label, value: String(node.getAttribute('data-value') || node.getAttribute('value') || '') }});
        }};
        const controlledIds = target ? String(target.getAttribute('aria-controls') || target.getAttribute('aria-owns') || '').split(/\\s+/).filter(Boolean) : [];
        for (const id of controlledIds) {{
            const container = document.getElementById(id);
            if (container) Array.from(container.querySelectorAll(optionSelector)).forEach(addNode);
        }}
        Array.from(document.querySelectorAll(optionSelector)).forEach(addNode);
        const choose = (items) => {{
            if (items.length === 1) return items[0];
            if (items.length > 1) return {{ error: 'select_option: ambiguous custom option match for "' + expected + '": ' + items.slice(0, 8).map(item => item.label).join(', ') }};
            return null;
        }};
        let match =
            choose(nodes.filter(item => item.value === expected)) ||
            choose(nodes.filter(item => item.label === expected)) ||
            choose(nodes.filter(item => norm(item.value) === want)) ||
            choose(nodes.filter(item => norm(item.label) === want)) ||
            choose(nodes.filter(item => norm(item.value).includes(want) || norm(item.label).includes(want)));
        if (!match) return {{ error: 'select_option: no visible custom option matched "' + expected + '". Visible options: ' + nodes.slice(0, 20).map(item => item.label).join(', ') }};
        if (match.error) return match;
        match.node.scrollIntoView({{ block: 'center', inline: 'center' }});
        const rect = match.node.getBoundingClientRect();
        return {{ ok: true, mode: 'custom', label: match.label, value: match.value, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }};
    }})()""")
    if not option or option.get("error"):
        raise Exception(option.get("error") if option else "select_option: option lookup failed.")
    click_at_xy(int(option["x"]), int(option["y"]))
    _time.sleep(0.15)
    return option

def focus_target(selector):
    _sel = _json.dumps(selector)
    return js(f"""(() => {{
        const root = document.querySelector({_sel});
        if (!root) return false;
        const editable = root.matches('input,textarea,[contenteditable],[role="textbox"],[role="searchbox"]')
            ? root
            : root.querySelector('input,textarea,[contenteditable],[role="textbox"],[role="searchbox"]');
        const el = editable || root;
        el.scrollIntoView({{ block: 'center', inline: 'center' }});
        try {{ el.focus({{ preventScroll: true }}); }} catch (_) {{ el.focus(); }}
        return true;
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
        const originalConsoleError = console.error.bind(console);
        console.error = (...args) => {
          try {
            window.__agentqaConsoleErrors.push(args.map((arg) => {
              if (arg instanceof Error) return arg.stack || arg.message;
              if (typeof arg === 'object') return JSON.stringify(arg);
              return String(arg);
            }).join(' '));
          } catch (_) {}
          originalConsoleError(...args);
        };
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
      const labelledText = (el) => {
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
        const text = ids
          .map(id => document.getElementById(id))
          .filter(Boolean)
          .map(node => node.innerText || node.textContent || '')
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim();
        if (text) return text;
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
          if (label) return (label.innerText || label.textContent || '').replace(/\\s+/g, ' ').trim();
        }
        const wrappingLabel = el.closest('label');
        return wrappingLabel ? (wrappingLabel.innerText || wrappingLabel.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      };
      const visualLabel = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return '';
        const tag = el.tagName.toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return '';
        
        const candidates = Array.from(document.querySelectorAll('label, span, div, p'));
        let bestMatch = null;
        let bestDist = Infinity;
        for (const node of candidates) {
          if (node === el || node.contains(el) || el.contains(node)) continue;
          const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
          if (!text || text.length > 60) continue;
          
          const nRect = node.getBoundingClientRect();
          if (nRect.width === 0 || nRect.height === 0) continue;
          
          const isAbove = nRect.bottom <= rect.top + 8 && nRect.bottom >= rect.top - 40 && nRect.left >= rect.left - 40 && nRect.left <= rect.right;
          const isLeft = nRect.right <= rect.left + 8 && nRect.right >= rect.left - 150 && nRect.top >= rect.top - 15 && nRect.bottom <= rect.bottom + 15;
          
          if (isAbove || isLeft) {
            const dist = isAbove ? rect.top - nRect.bottom : rect.left - nRect.right;
            if (dist >= 0 && dist < bestDist) {
              bestDist = dist;
              bestMatch = text;
            }
          }
        }
        return bestMatch || '';
      };
      const describe = (el) => {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const stableName = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.id || el.getAttribute('name') || '';
        const base = (
          el.getAttribute('aria-label') ||
          labelledText(el) ||
          visualLabel(el) ||
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
        if (role === 'searchbox' || role === 'textbox' || role === 'combobox' || role === 'listbox' || role === 'option' || role.startsWith('menuitem')) return role;
        if (tag === 'input' || tag === 'textarea') return inputType || 'input';
        if (tag === 'select') return 'select';
        if (tag === 'button' || role === 'button') return 'button';
        if (tag === 'a' || role === 'link') return 'link';
        if (role) return role;
        return tag;
      };
      const optionsFor = (el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        if (tag === 'select') {
          return Array.from(el.options).slice(0, 40).map(option => ({
            value: String(option.value || ''),
            label: String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim(),
            selected: Boolean(option.selected),
            disabled: Boolean(option.disabled)
          }));
        }
        if (role === 'listbox' || role === 'menu') {
          return Array.from(el.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[data-value]')).slice(0, 40).map(option => ({
            value: String(option.getAttribute('data-value') || option.getAttribute('value') || ''),
            label: String(option.getAttribute('aria-label') || option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim(),
            selected: Boolean(option.getAttribute('aria-selected') === 'true' || option.getAttribute('data-state') === 'checked'),
            disabled: Boolean(option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true')
          })).filter(option => option.label || option.value);
        }
        const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '';
        const controlled = controls.split(/\\s+/).map(id => document.getElementById(id)).find(Boolean);
        if (controlled) {
          return Array.from(controlled.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[data-value]')).slice(0, 40).map(option => ({
            value: String(option.getAttribute('data-value') || option.getAttribute('value') || ''),
            label: String(option.getAttribute('aria-label') || option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim(),
            selected: Boolean(option.getAttribute('aria-selected') === 'true' || option.getAttribute('data-state') === 'checked'),
            disabled: Boolean(option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') === 'true')
          })).filter(option => option.label || option.value);
        }
        return undefined;
      };

      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[contenteditable],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="textbox"],[role="searchbox"],[aria-haspopup],[aria-expanded],[tabindex],label'));
      const elements = [];
      const registry = [];
      let idx = 0;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        if (!visible) continue;
        const description = describe(el);
        if (!description && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;
        const value = 'value' in el
          ? String(el.value || '')
          : (el.isContentEditable ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : null);
        elements.push({
          id: 'elem_' + idx++,
          type: typeFor(el),
          description: description.slice(0, 160),
          value,
          options: optionsFor(el),
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
          selected: Boolean(el.selected || el.getAttribute('aria-selected') === 'true'),
          expanded: el.getAttribute('aria-expanded') === 'true' ? true : el.getAttribute('aria-expanded') === 'false' ? false : undefined
        });

        const tag = el.tagName.toLowerCase();
        const isField = ['input', 'select', 'textarea'].includes(tag) || el.isContentEditable || (el.getAttribute('role') || '').includes('box');
        if (isField) {
          let labelSource = 'id';
          if (el.getAttribute('aria-label')) labelSource = 'aria-label';
          else if (el.getAttribute('aria-labelledby')) labelSource = 'aria-labelledby';
          else if (el.id && document.querySelector('label[for="' + cssEscape(el.id) + '"]')) labelSource = 'label-for';
          else if (el.closest('label')) labelSource = 'label-for';
          else if (el.getAttribute('placeholder')) labelSource = 'placeholder';
          else if (visualLabel(el)) labelSource = 'visual-proximity';
          else if (el.getAttribute('name')) labelSource = 'name';

          const opts = optionsFor(el);
          let selectedValue, selectedLabel;
          if (opts) {
            const selectedOpt = opts.find(o => o.selected);
            if (selectedOpt) {
              selectedValue = selectedOpt.value;
              selectedLabel = selectedOpt.label;
            }
          }

          registry.push({
            field_id: String(elements.length - 1),
            label: description.slice(0, 160),
            selector: selectorFor(el),
            tag,
            type: typeFor(el),
            name: el.getAttribute('name') || '',
            html_id: el.id || '',
            initial_value: String(value || ''),
            label_source: labelSource,
            confidence: 1.0,
            bbox: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
            nearby_text: [],
            options: opts,
            selected_value: selectedValue,
            selected_label: selectedLabel
          });
        }

        if (elements.length >= 140) break;
      }
      return {
        availableElements: elements,
        fieldRegistry: registry,
        pageText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4500),
        consoleErrors: (window.__agentqaConsoleErrors || []).slice(-12)
      };
    })()""")
    elements = snapshot.get("availableElements", []) if isinstance(snapshot, dict) else []
    field_registry = snapshot.get("fieldRegistry", []) if isinstance(snapshot, dict) else []
    page_text = snapshot.get("pageText", "") if isinstance(snapshot, dict) else ""
    console_errors = snapshot.get("consoleErrors", []) if isinstance(snapshot, dict) else []
    network_errors = []
    try:
        for event in drain_events():
            method = event.get("method", "")
            params = event.get("params", {})
            if method == "Network.loadingFailed":
                network_errors.append({
                    "type": "loadingFailed",
                    "requestId": params.get("requestId"),
                    "errorText": params.get("errorText", ""),
                    "blockedReason": params.get("blockedReason", "")
                })
            elif method == "Network.responseReceived":
                response = params.get("response", {})
                status = int(response.get("status", 0) or 0)
                if status >= 400:
                    network_errors.append({
                        "type": "httpError",
                        "status": status,
                        "url": response.get("url", ""),
                        "mimeType": response.get("mimeType", "")
                    })
    except Exception as network_exc:
        network_errors.append({"type": "captureFailed", "errorText": str(network_exc)})
    observation = {
        "taskUrl": target_url,
        "page": info,
        "availableElements": elements,
        "interactiveElements": elements,
        "fieldRegistry": field_registry,
        "pageText": page_text,
        "consoleErrors": console_errors,
        "networkErrors": network_errors[-50:]
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

export function buildScreenshotScript(outputPath: string, full: boolean = false): string {
  return `
import json
import os

output_path = ${JSON.stringify(outputPath)}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    saved_path = capture_screenshot(output_path, full=${full ? 'True' : 'False'})
    emit({"instruction": "Capture screenshot", "status": "done", "result": saved_path})
    emit({"final": True, "ok": True, "summary": json.dumps({"path": saved_path})})
except Exception as exc:
    emit({"instruction": "Capture screenshot", "status": "failed", "error": str(exc)})
    emit({"final": True, "ok": False, "summary": "Screenshot capture failed.", "error": str(exc)})
`;
}

export function buildAccessibilitySnapshotScript(): string {
  return `
import json

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
    tree = cdp("Accessibility.getFullAXTree")
    emit({"instruction": "Capture accessibility tree", "status": "done", "result": "Captured accessibility tree"})
    emit({"final": True, "ok": True, "summary": json.dumps(tree)})
except Exception as exc:
    emit({"instruction": "Capture accessibility tree", "status": "failed", "error": str(exc)})
    emit({"final": True, "ok": False, "summary": "Accessibility tree capture failed.", "error": str(exc)})
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
    if selector:
        click_element(selector, active_target.get("x", 0), active_target.get("y", 0))
        return
    click_at_xy(int(active_target.get("x", 0)), int(active_target.get("y", 0)))

def type_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for type action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for type action.")
    set_value(selector, str(value or ""))

def set_checked_target(checked):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for check/radio action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for check/radio action.")
    sel = json.dumps(selector)
    expected = "true" if checked else "false"
    result = js(f"""(() => {{
      const root = document.querySelector({sel});
      if (!root) throw new Error('set_checked: element not found: ' + {sel});
      const el = root.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]')
        ? root
        : root.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]');
      if (!el) throw new Error('set_checked: no checkbox/radio target for ' + {sel});
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('set_checked: target is disabled.');
      el.scrollIntoView({{ block: 'center', inline: 'center' }});
      const isChecked = () => Boolean(el.checked || el.getAttribute('aria-checked') === 'true');
      if (isChecked() !== {expected}) {{
        const rect = el.getBoundingClientRect();
        return {{ click: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }};
      }}
      return {{ click: false, checked: isChecked() }};
    }})()""")
    if result and result.get("click"):
        click_at_xy(int(result["x"]), int(result["y"]))
        time.sleep(0.1)
    actual = js(f"""(() => {{
      const root = document.querySelector({sel});
      const el = root && (root.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]')
        ? root
        : root.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]'));
      return Boolean(el && (el.checked || el.getAttribute('aria-checked') === 'true'));
    }})()""")
    if bool(actual) != bool(checked):
        raise Exception("set_checked: verification failed. Expected " + str(checked) + " but found " + str(actual))
    return "Checked" if checked else "Unchecked"

def select_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for select action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for select action.")
    result = select_option(selector, str(value or ""))
    label = result.get("label") or result.get("value") or value
    return "Selected " + str(label)

def hover_target():
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for hover action.")
    selector = active_target.get("selector") or ""
    if selector:
        sel = json.dumps(selector)
        pos = js(f"""(() => {{
          const el = document.querySelector({sel});
          if (!el) return null;
          el.scrollIntoView({{ block: 'center', inline: 'center' }});
          const rect = el.getBoundingClientRect();
          return {{ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }};
        }})()""")
    else:
        pos = {"x": active_target.get("x", 0), "y": active_target.get("y", 0)}
    if not pos:
        raise Exception("hover: element not found or not visible.")
    cdp("Input.dispatchMouseEvent", type="mouseMoved", x=int(pos["x"]), y=int(pos["y"]))
    return "Hovered " + str(active_target.get("id", "target"))

def upload_file_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for upload_file action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for upload_file action.")
    if not value:
        raise Exception("upload_file action requires an absolute file path value.")
    upload_file(selector, str(value))
    return "Uploaded file to " + selector

def press_key_target(value):
    active_target = action.get("_target") or target
    selector = (active_target or {}).get("selector") or ""
    if selector:
        focus_target(selector)
    key = str(action.get("key") or value or "Enter")
    press_key(key)
    return "Pressed " + key

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

def wait_for_target(value):
    active_target = action.get("_target") or target
    selector = (active_target or {}).get("selector") or str(value or "")
    if selector:
        if wait_for_element(selector, timeout=10, visible=True):
            return "Waited for visible " + selector
        raise Exception("wait_for: element did not become visible: " + selector)
    time.sleep(1)
    return "Waited for page state"

def assert_text_target(expected):
    active_target = action.get("_target") or target
    text = read_target() if active_target else js("(document.body && document.body.innerText || '')")
    want = str(expected or "")
    if want.lower() not in str(text).lower():
        raise Exception('assert_text failed. Expected text containing "' + want + '".')
    return "Asserted text contains " + want

def assert_url_target(expected):
    url = js("window.location.href")
    want = str(expected or "")
    if want and want not in str(url):
        raise Exception('assert_url failed. Expected URL containing "' + want + '" but found "' + str(url) + '".')
    return "Asserted URL " + str(url)

def assert_visible_target():
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for assert_visible action.")
    selector = active_target.get("selector") or ""
    if not selector:
        raise Exception("Target element has no usable selector for assert_visible action.")
    sel = json.dumps(selector)
    visible = js(f"""(() => {{
      const el = document.querySelector({sel});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }})()""")
    if not visible:
        raise Exception("assert_visible failed for " + selector)
    return "Asserted visible " + selector

def assert_value_target(expected):
    actual = read_target()
    want = str(expected or "")
    if str(actual) != want:
        raise Exception('assert_value failed. Expected "' + want + '" but found "' + str(actual) + '".')
    return "Asserted value " + want

def assert_checked_target(expected):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for assert_checked action.")
    selector = active_target.get("selector") or ""
    sel = json.dumps(selector)
    actual = js(f"""(() => {{
      const root = document.querySelector({sel});
      const el = root && (root.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]')
        ? root
        : root.querySelector('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]'));
      return Boolean(el && (el.checked || el.getAttribute('aria-checked') === 'true'));
    }})()""")
    want = str(expected).lower() not in ("false", "0", "no", "off", "")
    if bool(actual) != bool(want):
        raise Exception("assert_checked failed. Expected " + str(want) + " but found " + str(actual))
    return "Asserted checked " + str(want)

def assert_selected_target(expected):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for assert_selected action.")
    selector = active_target.get("selector") or ""
    sel = json.dumps(selector)
    selected = js(f"""(() => {{
      const el = document.querySelector({sel});
      if (!el) return null;
      if (el.tagName.toLowerCase() === 'select') {{
        const option = el.options[el.selectedIndex];
        return {{ value: String(el.value || ''), label: option ? String(option.label || option.textContent || '').replace(/\\s+/g, ' ').trim() : '' }};
      }}
      return {{ value: String(el.getAttribute('data-value') || ''), label: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() }};
    }})()""")
    want = str(expected or "").strip().lower()
    actual = ((selected or {}).get("value", "") + " " + (selected or {}).get("label", "")).strip().lower()
    if want and want not in actual:
        raise Exception('assert_selected failed. Expected "' + str(expected) + '" but found "' + actual + '".')
    return "Asserted selected " + str(expected)

def assert_count_target(expected):
    active_target = action.get("_target") or target
    selector = (active_target or {}).get("selector") or str(action.get("selector") or "")
    if not selector:
        raise Exception("assert_count requires a target selector.")
    sel = json.dumps(selector)
    actual = int(js(f"document.querySelectorAll({sel}).length") or 0)
    want = int(expected or 0)
    if actual != want:
        raise Exception("assert_count failed. Expected " + str(want) + " but found " + str(actual))
    return "Asserted count " + str(want)

def screenshot_action(value):
    path = str(value or "")
    if not path:
        raise Exception("screenshot action requires an output path value.")
    capture_screenshot(path, full=False)
    return "Screenshot saved " + path

def execute_one(item):
    global action
    previous_action = action
    action = item
    kind = item.get("action")
    result = ""
    if kind == "click":
        click_target()
        result = "Clicked " + str((item.get("_target") or {}).get("id", item.get("targetId", "")))
    elif kind == "type" or kind == "fill":
        type_target(item.get("value", ""))
        result = "Typed into " + str((item.get("_target") or {}).get("id", item.get("targetId", "")))
    elif kind == "select":
        result = select_target(item.get("value", ""))
    elif kind == "check" or kind == "radio":
        result = set_checked_target(True)
    elif kind == "uncheck":
        result = set_checked_target(False)
    elif kind == "hover":
        result = hover_target()
    elif kind == "upload_file":
        result = upload_file_target(item.get("value", ""))
    elif kind == "press_key":
        result = press_key_target(item.get("key") or item.get("value", "Enter"))
    elif kind == "wait_for":
        result = wait_for_target(item.get("value", ""))
    elif kind == "read":
        result = read_target()
    elif kind == "assert_text":
        result = assert_text_target(item.get("value", ""))
    elif kind == "assert_url":
        result = assert_url_target(item.get("value", ""))
    elif kind == "assert_visible":
        result = assert_visible_target()
    elif kind == "assert_value":
        result = assert_value_target(item.get("value", ""))
    elif kind == "assert_checked":
        result = assert_checked_target(item.get("value", True))
    elif kind == "assert_selected":
        result = assert_selected_target(item.get("value", ""))
    elif kind == "assert_count":
        result = assert_count_target(item.get("value", 0))
    elif kind == "screenshot":
        result = screenshot_action(item.get("value", ""))
    elif kind == "scroll":
        dy = int(item.get("dy") or -650)
        scroll(500, 500, dy=dy)
        scroll_y = js("Math.round(window.scrollY || document.documentElement.scrollTop || 0)")
        page_h = js("Math.round(document.documentElement.scrollHeight || document.body.scrollHeight || 0)")
        result = "Scrolled by " + str(dy) + " to y=" + str(scroll_y) + " of " + str(page_h)
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
