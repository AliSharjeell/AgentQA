import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface HarnessStepEvent {
  instruction: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  error?: string;
}

export interface CliReport {
  result: 'PASS' | 'FAIL' | 'INFRA_FAILED';
  scenario: string;
  confirmedBugs: string[];
  warnings: string[];
  stepsExecuted: string[];
  evidence: string[];
  finalUrl: string;
  screenshots: string[];
  consoleErrors: string[];
  fixRecommendations: string[];
}

export interface HarnessResult {
  ok: boolean;
  summary: string;
  error?: string;
  report?: CliReport;
}

interface ResolvedCommand {
  executable: string;
  args: string[];
}

// The set_value Python preamble that gets prepended to every script.
// Uses JavaScript to set input values — bypasses Electron's CDP double-typing bug.
const SET_VALUE_PREAMBLE = `
import json as _json

def set_value(selector, text):
    """Set an input's value via JavaScript — works in React, Vue, and vanilla HTML."""
    _sel = _json.dumps(selector)
    _val = _json.dumps(text)
    js(f"""(() => {{
        const el = document.querySelector({_sel});
        if (!el) throw new Error('set_value: element not found: ' + {_sel});
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (descriptor && descriptor.set) {{
            descriptor.set.call(el, {_val});
        }} else {{
            el.value = {_val};
        }}
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }})()""");

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

export function runHarnessScript(
  script: string,
  onStep: (event: HarnessStepEvent) => void,
  cdpUrl?: string,
  timeoutMs: number = 120000
): Promise<HarnessResult> {
  return new Promise((resolve) => {
    const { executable, args } = resolveBrowserHarnessCommand();
    const env: Record<string, string | undefined> = { ...process.env };
    if (cdpUrl) {
      env.BU_CDP_URL = cdpUrl;
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
      child.kill();
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
      finish({ ok: false, summary: 'Browser-harness could not be started.', error: `${error.message}. Install: uv tool install git+https://github.com/browser-use/browser-harness` });
    });
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      if (finalResult) { finish(finalResult); }
      else { finish({ ok: false, summary: 'Browser-harness exited prematurely.', error: `Exit code ${code}.\nStderr: ${stderr}\nStdout: ${stdout}` }); }
    });

    child.stdin.write(SET_VALUE_PREAMBLE + script);
    child.stdin.end();
  });
}

export function buildObservationScript(targetUrl: string): string {
  return `
import json

target_url = ${JSON.stringify(targetUrl)}

def emit(payload):
    print("BH_EVENT " + json.dumps(payload), flush=True)

try:
    emit({"instruction": "Open " + target_url, "status": "running"})
    goto_url(target_url)
    wait_for_load()
    import time
    time.sleep(1)
    info = page_info()
    emit({"instruction": "Open " + target_url, "status": "done", "result": "Loaded " + info.get("url", target_url)})

    emit({"instruction": "Inspect DOM", "status": "running"})
    elements = js("""(() => {
      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[tabindex]'));
      return nodes.slice(0, 120).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
        return {
          index, tag: el.tagName.toLowerCase(),
          text: text.slice(0, 140), href: el.href || '', name: el.getAttribute('name') || '',
          id: el.id || '', classes: String(el.className || '').slice(0, 120),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)
        };
      });
    })()""")
    observation = {"taskUrl": target_url, "page": info, "interactiveElements": elements}
    emit({"instruction": "Inspect DOM", "status": "done", "result": json.dumps(observation)})
    emit({"final": True, "ok": True, "summary": json.dumps(observation)})
except Exception as exc:
    emit({"final": True, "ok": False, "summary": "DOM inspection failed.", "error": str(exc)})
`;
}
