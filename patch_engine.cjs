const fs = require('fs');
let code = fs.readFileSync('src/core/engine.ts', 'utf8');

const loopStartIdx = code.indexOf('for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {');
const beforeLoop = code.slice(0, loopStartIdx);
let inLoop = code.slice(loopStartIdx);

inLoop = inLoop.replace(/history\.push\(\{/g, 'history.push({ thought: parsed?.thought,');

const summaryLogic = `
    const estimatedHistoryChars = JSON.stringify(history).length;
    if (estimatedHistoryChars > 80000 && history.length > 5) {
      addStep('Compressing history context...', 'running');
      onStep({ instruction: 'Compressing history context...', status: 'running' });
      try {
        const summaryPrompt = \`You are a QA Agent context compressor.\\nYour task is to summarize the following history of QA actions and reasoning into a concise but highly detailed sequence.\\nRetain the critical logic, step numbers, and state changes, but compress the text.\\nHistory to summarize:\\n\${JSON.stringify(history)}\`;
        const summaryText = await callForScript(settings, summaryPrompt, { phase: 'planning' });
        history.splice(0, history.length, { step: 0, action: 'history_summary', status: 'success', result: summaryText, url: currentUrl });
        addStep('History compressed', 'done');
        onStep({ instruction: 'History compressed', status: 'done' });
      } catch (e) {
        addStep('History compression failed, truncating...', 'done');
        const truncated = history.slice(-5);
        history.splice(0, history.length, ...truncated);
      }
    }

    addStep(\``;

inLoop = inLoop.replace('    addStep(`Plan next QA action', summaryLogic + 'Plan next QA action');

code = beforeLoop + inLoop;
fs.writeFileSync('src/core/engine.ts', code);
