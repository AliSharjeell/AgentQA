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

2. js() returns a dict/list/string/int/bool/None. NEVER pass js() directly to click_at_xy().
   CORRECT pattern for clicking elements:
     pos = js("(() => { const e = document.querySelector('#btn'); if(!e) return null; const r = e.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()")
     if pos: click_at_xy(int(pos['x']), int(pos['y']))

3. For select/dropdown elements, use js() to set the value:
     js("document.querySelector('select#country').value = 'US'; document.querySelector('select#country').dispatchEvent(new Event('change', {bubbles:true}))")

4. Always import json and time at the top. Use time.sleep(0.5) between actions.

5. Use triple-quoted strings for multi-line JS in js(). Never leave strings unterminated.

6. Write robust scripts. Do not raise exceptions or exit early if an element takes a moment to load. Use loops and time.sleep() to wait for elements instead of failing the attempt.

7. You MUST explicitly verify your actions before marking the test as PASS. If adding an item to a cart, you MUST read the DOM to verify the cart item matches what you selected. Do not assume an action succeeded just because a click occurred.

8. Before writing the final report, always call page_info() after the final action to get the accurate current URL for your report. Never infer the final URL from memory.

9. Wrap everything in try/except that emits a final error event.

Required output format:
- Return ONLY valid Python code. No markdown fences, no comments before imports.
- Start with imports and emit helper, then try/except block.
- Emit progress: emit({"instruction": "...", "status": "running"|"done"|"failed", "result": "...", "error": "..."})
- Emit exactly one final event with the full report:
  emit({
    "final": True,
    "ok": bool,
    "summary": "Short summary",
    "report": {
      "result": "PASS" | "FAIL" | "INFRA_FAILED",
      "scenario": "Short description of the prompt scenario",
      "confirmedBugs": ["bug 1", "bug 2"],
      "warnings": ["warning 1"],
      "stepsExecuted": ["step 1", "step 2"],
      "evidence": ["evidence 1"],
      "finalUrl": "https://...",
      "screenshots": [],
      "consoleErrors": [],
      "fixRecommendations": ["fix 1"]
    }
  })

Agent Instructions:
- Open the target URL with goto_url(), wait_for_load(), time.sleep(1).
- Use set_value() for ALL form fields.
- Use click_at_xy() only for buttons/links. Always extract int x,y from js() result dict.
- After submitting forms, wait_for_load() + time.sleep(1) + verify with page_info().
- Never report a bug unless verified twice after waiting and scrolling.
- A scenario can complete successfully but still be FAIL if confirmed bugs are found.
- Best result logic:
  * PASS = test objective completed and no confirmed bugs. PASS is only allowed if all required checks are verified with DOM/page evidence.
  * FAIL = confirmed website/app bug found. If either a confirmed bug exists (e.g. product images are broken, or selected cart items do not match the clicked products), report as CONFIRMED BUG and the final RESULT must be FAIL.
  * INFRA_FAILED = browser/tool/navigation/timeout failure. If URL becomes chrome-error://chromewebdata, report as INFRA_FAILED.
- If no bugs are found after thorough testing, the report result should be PASS. Do NOT invent or speculate about issues that were not actually observed. Do NOT report expected error messages (like invalid login prompts) as bugs if the test is a negative scenario.
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
