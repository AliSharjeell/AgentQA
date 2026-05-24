const fs = require('fs');
let code = fs.readFileSync('src/core/harness.ts', 'utf8');

const functions = [
  { name: 'type_target', body: 'type_target(value):' },
  { name: 'set_checked_target', body: 'set_checked_target(checked):' },
  { name: 'select_target', body: 'select_target(value):' },
  { name: 'hover_target', body: 'hover_target():' }
];

let changed = false;

functions.forEach(func => {
  const regex = new RegExp(`def ${func.body}[\\s\\S]*?active_target = action\\.get\\("_target"\\) or target\\s+if not active_target:\\s+raise Exception\\("Target element is required.*?"\\)`);
  if (regex.test(code)) {
    code = code.replace(regex, `def ${func.body}
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required.")
        
    if active_target.get("disabled"):
        raise Exception("Action rejected: The target element is disabled, locked, or unclickable. Scroll up to find missing prerequisites.")`);
    changed = true;
  }
});

fs.writeFileSync('src/core/harness.ts', code);
console.log('Patched target functions:', changed);
