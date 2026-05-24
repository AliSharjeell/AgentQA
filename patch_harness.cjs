const fs = require('fs');
let code = fs.readFileSync('src/core/harness.ts', 'utf8');

const isDisabledHelper = `
      const isDisabled = (el) => {
        if (!el) return false;
        if (el.disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('data-disabled') === 'true') return true;
        const c = el.className;
        if (typeof c === 'string') {
          const lower = c.toLowerCase();
          if (lower.includes('disabled') || lower.includes('locked') || lower.includes('inactive')) return true;
        }
        return false;
      };
`;

// Insert the helper in buildDomSnapshotPython()
code = code.replace('const cssEscape = (value) => {', isDisabledHelper + '      const cssEscape = (value) => {');

// Replace inline checks in buildDomSnapshotPython
code = code.replace(/disabled:\s*Boolean\(el\.disabled\s*\|\|\s*el\.getAttribute\('aria-disabled'\)\s*===\s*'true'\)/g, 'disabled: isDisabled(el)');
code = code.replace(/disabled:\s*Boolean\(option\.disabled\)/g, 'disabled: isDisabled(option)');
code = code.replace(/disabled:\s*Boolean\(option\.getAttribute\('aria-disabled'\)\s*===\s*'true'\s*\|\|\s*option\.getAttribute\('data-disabled'\)\s*===\s*'true'\)/g, 'disabled: isDisabled(option)');

// Also fix in buildActionScript (for read_selector_state and set_checked)
code = code.replace(/if\s*\(\s*el\.disabled\s*\|\|\s*el\.getAttribute\('aria-disabled'\)\s*===\s*'true'\s*\)/g, 
  "if (el.disabled || el.getAttribute('aria-disabled') === 'true' || (typeof el.className==='string' && (el.className.toLowerCase().includes('disabled') || el.className.toLowerCase().includes('locked'))))");

fs.writeFileSync('src/core/harness.ts', code);
console.log('Done replacing in harness.ts');
