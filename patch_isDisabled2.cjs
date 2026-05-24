const fs = require('fs');
let code = fs.readFileSync('src/core/harness.ts', 'utf8');

const helper = `
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

// It might be `js("""(() => {` or `js(f"""(() => {{`
code = code.replace(/js\(f?"""\(\(\) => (\{|\{\{)\n/g, 'js(f"""(() => $1\\n' + helper);

fs.writeFileSync('src/core/harness.ts', code);
console.log('Fixed harness.ts');
