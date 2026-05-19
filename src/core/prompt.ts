export function buildPrompt(
  taskName: string,
  targetUrl: string,
  observation: string,
  previousFailure: string,
  attempt: number
): string {
  return `You are generating Python code for browser-harness, a CDP browser automation harness.
The code will be piped directly to the browser-harness CLI via stdin and will control the already-visible live preview browser.
IMPORTANT: A helper function set_value(selector, text) is already defined for you in the preamble. Use it for ALL form inputs.

Task: ${taskName}
Target URL: ${targetUrl}
Attempt: ${attempt} of 3

Current browser/DOM observation:
${observation}

Previous failure or retry context:
${previousFailure || 'None'}

Available helper functions (all synchronous, already in global scope):

Navigation & Page:
- goto_url(url)                    # Navigate to URL
- wait_for_load()                  # Wait for page load event
- page_info() -> dict              # Returns {"url", "title", "w", "h"}
- js(expression) -> any            # Evaluate JavaScript, returns result

Form Input (USE set_value for ALL text/password/email/search fields):
- set_value(selector, text)        # Sets input value via JavaScript. Works with React, Vue, vanilla HTML.
                                   # Example: set_value('#user-name', 'standard_user')
                                   # Example: set_value('input[name="password"]', 'secret_sauce')
- press_key(key)                   # Press a key: "Enter", "Tab", "Escape", "Backspace", "ArrowDown"

Clicking:
- click_at_xy(x, y)               # Click at viewport coordinates. x, y MUST be int.

Scrolling:
- scroll(x, y, dy=-300)           # Scroll at (x,y) by dy pixels

Waiting:
- wait_for_element(selector, timeout=5.0) -> bool

Screenshots:
- capture_screenshot(path=None, full=False) -> str

CRITICAL RULES:
1. For ALL form fields (text, password, email, search, textarea), use set_value(selector, text).
   Do NOT use fill_input, type_text, or click_at_xy + type_text for form fields.
   set_value uses JavaScript to set values and fire React/Vue-compatible events.

2. js() returns a dict/list/string/int/bool/None. NEVER pass js() directly to click_at_xy().
   CORRECT pattern for clicking elements:
     pos = js("(() => { const e = document.querySelector('#btn'); if(!e) return null; const r = e.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()")
     if pos: click_at_xy(int(pos['x']), int(pos['y']))

3. For select/dropdown elements, use js() to set the value:
     js("document.querySelector('select#country').value = 'US'; document.querySelector('select#country').dispatchEvent(new Event('change', {bubbles:true}))")

4. Always import json and time at the top. Use time.sleep(0.5) between actions.

5. Use triple-quoted strings for multi-line JS in js(). Never leave strings unterminated.

6. Wrap everything in try/except that emits a final error event.

Required output format:
- Return ONLY valid Python code. No markdown fences, no comments before imports.
- Start with imports and emit helper, then try/except block.
- Emit progress: emit({"instruction": "...", "status": "running"|"done"|"failed", "result": "...", "error": "..."})
- Emit exactly one final: emit({"final": True, "ok": bool, "summary": "...", "error": "..."})

Agent Instructions:
- Open the target URL with goto_url(), wait_for_load(), time.sleep(1).
- Use set_value() for ALL form fields.
- Use click_at_xy() only for buttons/links. Always extract int x,y from js() result dict.
- After submitting forms, wait_for_load() + time.sleep(1) + verify with page_info().
- Never report a bug unless verified twice after waiting and scrolling.
- If no bugs are found after thorough testing, say "No confirmed bugs found" in the summary. Do NOT invent or speculate about issues that were not actually observed.
- If URL becomes chrome-error://chromewebdata, report as infrastructure failure, not website bug.
- Wrap everything in try/except.

Complete example — login flow:
import json
import time

def emit(payload):
    print('BH_EVENT ' + json.dumps(payload), flush=True)

try:
    emit({'instruction': 'Open login page', 'status': 'running'})
    goto_url('https://example.com/login')
    wait_for_load()
    time.sleep(1)
    emit({'instruction': 'Open login page', 'status': 'done', 'result': 'Loaded'})

    emit({'instruction': 'Enter credentials', 'status': 'running'})
    set_value('#username', 'myuser')
    time.sleep(0.3)
    set_value('#password', 'mypass')
    time.sleep(0.3)
    emit({'instruction': 'Enter credentials', 'status': 'done', 'result': 'Filled username and password'})

    emit({'instruction': 'Click login button', 'status': 'running'})
    pos = js("(() => { const e = document.querySelector('button[type=submit]'); if(!e) return null; const r = e.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()")
    if pos:
        click_at_xy(int(pos['x']), int(pos['y']))
    else:
        press_key('Enter')
    wait_for_load()
    time.sleep(1)
    info = page_info()
    emit({'instruction': 'Click login button', 'status': 'done', 'result': 'Now at ' + info.get('url', '')})

    emit({'final': True, 'ok': True, 'summary': 'Successfully logged in.'})
except Exception as exc:
    emit({'final': True, 'ok': False, 'summary': 'Script failed.', 'error': str(exc)})`;
}

export function normalizeScript(script: string): string {
  const trimmed = script.trim();
  const fenceMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
