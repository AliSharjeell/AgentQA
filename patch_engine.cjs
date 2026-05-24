const fs = require('fs');
let code = fs.readFileSync('src/core/engine.ts', 'utf8');

// 1. Add pageSummary?: string to AgentResponse
code = code.replace(
  /interface AgentResponse \{\s*thought: string;/g,
  "interface AgentResponse {\n  thought: string;\n  pageSummary?: string;"
);

// 2. Add pageSummary: parsed?.pageSummary to all history.push calls that have thought: parsed?.thought
code = code.replace(
  /thought:\s*parsed\?\.thought/g,
  "thought: parsed?.thought, pageSummary: parsed?.pageSummary"
);

// Also handle the one `thought: parsed.thought || '',` around line 165
code = code.replace(
  /thought:\s*parsed\.thought \|\| '',/g,
  "thought: parsed.thought || '', pageSummary: parsed.pageSummary,"
);

fs.writeFileSync('src/core/engine.ts', code);
console.log('Patched engine.ts successfully.');
