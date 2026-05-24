const fs = require('fs');
let code = fs.readFileSync('src/core/harness.ts', 'utf8');

const disabledCheck = `
    if active_target.get("disabled"):
        raise Exception("Action rejected: The target element is disabled, locked, or unclickable. Scroll up to find missing prerequisites.")
`;

// type_target
code = code.replace(
    /def type_target\(value\):\n    active_target = action\.get\("_target"\) or target\n    if not active_target:\n        raise Exception\("Target element is required for type action\."\)/,
    `def type_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for type action.")${disabledCheck}`
);

// set_checked_target
code = code.replace(
    /def set_checked_target\(checked\):\n    active_target = action\.get\("_target"\) or target\n    if not active_target:\n        raise Exception\("Target element is required for check\/radio action\."\)/,
    `def set_checked_target(checked):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for check/radio action.")${disabledCheck}`
);

// select_target
code = code.replace(
    /def select_target\(value\):\n    active_target = action\.get\("_target"\) or target\n    if not active_target:\n        raise Exception\("Target element is required for select action\."\)/,
    `def select_target(value):
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for select action.")${disabledCheck}`
);

// hover_target
code = code.replace(
    /def hover_target\(\):\n    active_target = action\.get\("_target"\) or target\n    if not active_target:\n        raise Exception\("Target element is required for hover action\."\)/,
    `def hover_target():
    active_target = action.get("_target") or target
    if not active_target:
        raise Exception("Target element is required for hover action.")${disabledCheck}`
);

fs.writeFileSync('src/core/harness.ts', code);
console.log('Patched target functions for disabled elements.');
