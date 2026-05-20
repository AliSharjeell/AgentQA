export function buildPrompt(
  taskName: string,
  targetUrl: string,
  observation: string,
  previousFailure: string,
  attempt: number,
  visionMode: boolean = false
): string {
  const visionRules = visionMode 
    ? `- VISION MODE ENABLED: You MUST visually verify images, layout, and visual bugs. If product images are broken or repeated, or if layout is broken, report it as a CONFIRMED BUG and fail the test.
- Best result logic:
  * PASS = test objective completed and no confirmed bugs. PASS is only allowed if all required checks are verified with DOM/page or visual evidence.
  * FAIL = confirmed website/app bug found. If expected DOM evidence is missing, but you performed the required action correctly and the website state is wrong, report it as a CONFIRMED BUG and the final RESULT must be FAIL.
  * AGENT_FAILED or FAIL_AGENT_QA = agent failure. If expected DOM evidence is missing because you skipped a required action, restarted the scenario, clicked the wrong element, or did not check evidence, the final RESULT must be AGENT_FAILED or FAIL_AGENT_QA.
  * INFRA_FAILED = browser/tool/navigation/timeout failure. If URL becomes chrome-error://chromewebdata, a timeout occurs, or the browser crashes, report as INFRA_FAILED, not a website bug.`
    : `- If a bug requires visual comparison or screenshot interpretation (e.g. broken product images, repeated placeholder images, visual layout issues, image mismatch bugs), do NOT mark it as FAIL. Instead, add to your report warnings: "WARNING: Visual check skipped because current model is text-only."
- You should only verify evidence available through: page URL, DOM text, form values, button text, cart item names, validation messages, page headings, and console/network errors.
- Best result logic:
  * PASS = test objective completed and no confirmed bugs. PASS is only allowed if all required checks are verified with DOM/page evidence.
  * FAIL = confirmed website/app bug found. If expected DOM evidence is missing, but you performed the required action correctly and the website state is wrong, report it as a CONFIRMED BUG and the final RESULT must be FAIL.
  * AGENT_FAILED or FAIL_AGENT_QA = agent failure. If expected DOM evidence is missing because you skipped a required action, restarted the scenario, clicked the wrong element, or did not check evidence, the final RESULT must be AGENT_FAILED or FAIL_AGENT_QA.
  * INFRA_FAILED = browser/tool/navigation/timeout failure. If URL becomes chrome-error://chromewebdata, a timeout occurs, or the browser crashes, report as INFRA_FAILED, not a website bug.`;

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
- page_info() -> dict              # Returns {"url", "title", "w", "h"} (Note: url and title may be None. Prefer js("window.location.href") and js("document.title"))
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

7. You MUST explicitly verify your actions with actual DOM checks before marking the test/step as PASS. E.g., if the task says 'add 2 products', you MUST read the DOM (badge text) to verify it shows exactly '2' and check the cart page to verify exactly 2 item elements exist. If placing an order, you MUST read the DOM text to verify the final success message (e.g. 'Thank you for your order!') is present before reporting success. Do not assume any action succeeded just because a click occurred.

8. Before writing the final report, always evaluate js("window.location.href") after the final action to get the accurate current URL for your report. Do NOT rely solely on page_info().get('url') as it may return None. Never infer the final URL or final page state from memory.

9. To inspect or verify the DOM (like checking text or cart count), you MUST write JavaScript using js() and return the data to your Python script. Never hallucinate DOM state. Example: count = js("document.querySelector('.shopping_cart_badge')?.textContent").

10. NEVER restart or retry the scenario from the beginning (e.g. calling goto_url to go back to the homepage/login) on attempts 2 or 3 if the current page state (see DOM observation) shows you are already logged in or on a later page (e.g., Cart, Checkout). Resume your script directly from the current URL and page state. You MUST check the current URL and DOM observation in your Python script before calling goto_url(). If you are already logged in or past the login page, skip the login steps entirely and proceed from the current page. Starting from the beginning when you are already logged in is a failure and will result in AGENT_FAILED.

11. Wrap everything in try/except that emits a final error event.

12. CSS Selectors: ONLY use standard CSS selectors for querySelector(). NEVER use non-standard selectors like :contains() or :has-text(). To find elements by text, use standard JS like: Array.from(document.querySelectorAll('a, button')).find(e => e.textContent.toLowerCase().includes('log out') || e.textContent.toLowerCase().includes('logout'))

13. JS Dialogs (Alert/Confirm/Prompt): Browser dialogs will freeze the page. Before clicking any element that triggers a dialog, you MUST mock the dialog functions via js(). Example: js('window.alert = () => {}; window.confirm = () => true; window.prompt = () => "test";')

14. URL and Navigation Checks: If verifying a URL redirect or page load, you MUST use a loop with time.sleep() to wait for page_info()['url'] or DOM elements to update before failing. Redirects can take a few seconds.

15. Python String Escaping in js(): When passing JavaScript code to js(), you MUST avoid quote conflict. ALWAYS wrap JS expressions in triple single-quotes ('''...''') or triple double-quotes ("""...""") to prevent syntax errors from nested quotes (e.g. quotes in document.querySelector or textContent checks).

16. Strict Objective Compliance: Adhere strictly to the exact number of actions/products requested in the prompt. If the prompt says 'add 2 products', you MUST add exactly 2 products. Do not take shortcuts or add only 1.

17. Failure Classification logic: If expected DOM/page/visual evidence is missing or incorrect:
    - If you performed the required action correctly and the website state is wrong (e.g., you clicked "Add to Cart" but the cart badge remained 0) -> set RESULT to FAIL, confirmed website bug.
    - If you skipped the required action, restarted the scenario from the beginning unnecessarily, clicked the wrong element, or did not check evidence -> set RESULT to AGENT_FAILED (or FAIL_AGENT_QA).
    - If browser, tool, or navigation failed (e.g., page failed to load, CDP timeout) -> set RESULT to INFRA_FAILED.
    If a verification fails, the Python script MUST immediately emit the final result payload with the appropriate failure RESULT (FAIL, AGENT_FAILED, or INFRA_FAILED) and call sys.exit(0) (import sys at the top of your script). Do NOT continue to execute subsequent steps or assume success. Never report a PASS without concrete DOM evidence.

18. Viewport & Scrolling: click_at_xy(x, y) clicks at viewport (screen) coordinates, so the target element MUST be visible and inside the viewport to be clicked successfully. If an element might be off-screen/below the fold (like the "Finish" button on checkout overview pages), you MUST call e.scrollIntoView() in your js() snippet before getting the bounding rect, or use scroll(x, y, dy) to scroll down first. Example of scrolling an element into view and getting its coordinates:
    pos = js("""(() => { const e = document.querySelector('#finish'); if(!e) return null; e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()""")

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
      "result": "PASS" | "FAIL" | "INFRA_FAILED" | "AGENT_FAILED" | "FAIL_AGENT_QA",
      "scenario": "Short description of the prompt scenario",
      "confirmedBugs": ["bug 1", "bug 2"],
      "warnings": ["warning 1"],
      "stepsExecuted": ["step 1", "step 2"],
      "evidence": ["evidence 1"],
      "finalUrl": "<insert current URL from js('window.location.href') here>",
      "screenshots": [],
      "consoleErrors": [],
      "fixRecommendations": ["fix 1"]
    }
  })

Agent Instructions:
- Open the target URL with goto_url(), wait_for_load(), time.sleep(1).
- Use set_value() for ALL form fields.
- Use click_at_xy() only for buttons/links. Always extract int x,y from js() result dict.
- After submitting forms, wait_for_load() + time.sleep(1) + verify with js('window.location.href').
- Never report a bug unless verified twice after waiting and scrolling. For dynamic loading, use loops and time.sleep() to wait. Do not mark slow loading as a bug if it eventually loads.
- A scenario can complete successfully but still be FAIL if confirmed bugs are found.
${visionRules}
- Script assertions: Your Python script MUST strictly assert conditions (e.g., check badge count is 2, check cart items is 2, check thank you message). If a check fails, do NOT continue; immediately emit the final payload with the appropriate failure RESULT (FAIL, AGENT_FAILED, or INFRA_FAILED) and call sys.exit(0) (import sys at the top of your script).
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
    current_url = js('window.location.href')
    emit({'instruction': 'Click login button', 'status': 'done', 'result': 'Now at ' + current_url})

    emit({'final': True, 'ok': True, 'summary': 'Successfully logged in.'})
except Exception as exc:
    emit({'final': True, 'ok': False, 'summary': 'Script failed.', 'error': str(exc)})`;
}

export function normalizeScript(script: string): string {
  const trimmed = script.trim();
  const fenceMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}
