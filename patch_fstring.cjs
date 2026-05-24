const fs = require('fs');
let code = fs.readFileSync('src/core/harness.ts', 'utf8');

const advancedIsDisabled = `
      const isDisabled = (el) => {{
        if (!el) return false;
        
        // Native properties and attributes
        if (el.disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('data-disabled') === 'true') return true;
        
        // Computed styles
        try {{
          const style = window.getComputedStyle(el);
          if (style.pointerEvents === 'none') return true;
          if (style.cursor === 'not-allowed') return true;
          if (style.opacity && parseFloat(style.opacity) < 0.4) return true;
        }} catch (e) {{}}

        // Class names
        const c = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        if (c.includes('disabled') || c.includes('locked') || c.includes('inactive') || c.includes('unavailable') || c.includes('not-allowed')) return true;
        
        // Check parents for disabled fieldsets or container-level locks
        let parent = el.parentElement;
        let depth = 0;
        while (parent && parent !== document.body && depth < 5) {{
          if (parent.disabled) return true;
          if (parent.getAttribute('aria-disabled') === 'true') return true;
          const pc = typeof parent.className === 'string' ? parent.className.toLowerCase() : '';
          if (pc.includes('disabled') || pc.includes('locked') || pc.includes('inactive')) return true;
          try {{
            const pStyle = window.getComputedStyle(parent);
            if (pStyle.pointerEvents === 'none') return true;
          }} catch(e) {{}}
          parent = parent.parentElement;
          depth++;
        }}
        
        return false;
      }};
`;

// Replace the old isDisabled helper
code = code.replace(/const isDisabled = \(el\) => \{[\s\S]*?return false;\s*\};\n/g, advancedIsDisabled.trim() + '\n');

fs.writeFileSync('src/core/harness.ts', code);
console.log('Fixed harness.ts python f-string escaping');
