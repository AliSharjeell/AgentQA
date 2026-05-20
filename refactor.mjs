import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.join(process.cwd(), 'src', 'main', 'index.ts');
let content = fs.readFileSync(indexPath, 'utf8');

if (!content.includes('import { runQaTask } from "../core/engine"')) {
  content = content.replace(
    'import {',
    'import { runQaTask } from "../core/engine";\nimport {'
  );
}

// Replace runBrowserHarnessTask
const taskStart = content.indexOf('async function runBrowserHarnessTask(task: QaTask): Promise<boolean> {');
const taskEnd = content.indexOf('type HarnessStepEvent = {');
if (taskStart === -1 || taskEnd === -1) throw new Error("Could not find runBrowserHarnessTask");

const newRunTask = `async function runBrowserHarnessTask(task: QaTask): Promise<boolean> {
  const steps: QaTask["steps"] = [];
  const startTime = new Date().toISOString();

  const addStep = (instruction: string, status: TaskStepStatus, result?: string, error?: string): void => {
    steps.push({
      id: generateId(),
      order: steps.length + 1,
      instruction,
      status,
      result,
      error,
      timestamp: new Date().toISOString()
    });
    setTaskSteps(task.id, [...steps]);
  };

  try {
    emitProgress({ type: "task_progress", taskId: task.id, message: "Running browser-harness in preview..." });
    const settings = loadSettings();
    
    // Ensure the browser view is initialized
    if (browserView && !browserView.webContents.getURL().includes(task.targetUrl)) {
      browserView.webContents.loadURL(task.targetUrl).catch(() => {});
    }

    const engineResult = await runQaTask({
      targetUrl: task.targetUrl,
      prompt: task.name,
      settings,
      cdpUrl: \`http://127.0.0.1:\${PREVIEW_DEBUG_PORT}\`,
      onStep: (event) => {
        if (event.status === "running") {
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.status === "running" && lastStep.instruction !== event.instruction) {
            lastStep.status = "done";
            lastStep.timestamp = new Date().toISOString();
          }
          const existing = steps.find(s => s.instruction === event.instruction && s.status === "running");
          if (!existing) {
            addStep(event.instruction, "running");
          }
          return;
        }

        const matchingStep = [...steps].reverse().find(s => s.instruction === event.instruction);
        if (matchingStep) {
          matchingStep.status = event.status as TaskStepStatus;
          matchingStep.result = event.result;
          matchingStep.error = event.error;
          matchingStep.timestamp = new Date().toISOString();
          setTaskSteps(task.id, [...steps]);
        } else {
          const lastStep = steps[steps.length - 1];
          if (lastStep && lastStep.status === "running") {
            lastStep.status = event.status as TaskStepStatus;
            lastStep.result = event.result;
            lastStep.error = event.error;
            lastStep.timestamp = new Date().toISOString();
            setTaskSteps(task.id, [...steps]);
          } else {
            addStep(event.instruction, event.status as TaskStepStatus, event.result, event.error);
          }
        }
      }
    });

    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }
    setTaskSteps(task.id, [...steps]);

    if (!engineResult.ok) {
      throw new Error(engineResult.error || engineResult.summary);
    }

    const endTime = new Date().toISOString();
    const passedSteps = steps.filter((step) => step.status === "done").length;
    const failedSteps = steps.filter((step) => step.status === "failed").length;
    
    // Merge engine's LLM-generated report if available
    const r = engineResult.report;
    const overallStatus = r ? (r.result === "PASS" ? "pass" : "fail") : "pass";
    
    const report: QaReport = {
      taskId: task.id,
      taskName: task.name,
      targetUrl: task.targetUrl,
      overallStatus,
      summary: engineResult.summary,
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      skippedSteps: 0,
      startTime,
      endTime,
      durationMs: new Date(endTime).getTime() - new Date(startTime).getTime(),
      steps: steps.map((step) => ({
        instruction: step.instruction,
        status: step.status,
        result: step.result ?? "",
        duration: 0,
        error: step.error
      })),
      screenshots: r?.screenshots ?? [],
      aiReasoning: r 
        ? \`Scenario: \${r.scenario}\\n\\nConfirmed Bugs: \${r.confirmedBugs.join(', ') || 'None'}\\n\\nFix Recommendations: \${r.fixRecommendations.join(', ') || 'None'}\`
        : "Executed by browser-harness against the embedded preview browser via CDP."
    };

    attachReport(task.id, report);
    updateTask(task.id, { status: "done" });
    emitProgress({ type: "task_complete", taskId: task.id, data: report });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const runningStep = [...steps].reverse().find((step) => step.status === "running");
    if (runningStep) {
      runningStep.status = "failed";
      runningStep.error = message;
      runningStep.timestamp = new Date().toISOString();
    } else {
      addStep("Run browser check", "failed", undefined, message);
    }

    for (const step of steps) {
      if (step.status === "running") {
        step.status = "done";
        step.timestamp = new Date().toISOString();
      }
    }

    setTaskSteps(task.id, [...steps]);
    emitProgress({ type: "task_failed", taskId: task.id, message });
    updateTask(task.id, { status: "failed" });
    return true;
  }
}

`;

content = content.substring(0, taskStart) + newRunTask + content.substring(taskEnd);

// Now remove the rest of the unneeded functions starting from type HarnessStepEvent
const harnessEnd = content.indexOf('// ─── Window References ────────────────────────────────────────────────────────');
if (harnessEnd !== -1) {
    const afterTaskEnd = content.substring(content.indexOf(newRunTask) + newRunTask.length);
    const actualHarnessStart = content.indexOf('type HarnessStepEvent = {');
    content = content.substring(0, actualHarnessStart) + content.substring(harnessEnd);
}

// Remove unused unused isBrowserHarnessRepositoryTask etc
const unusedHelpersStart = content.indexOf('function isBrowserHarnessRepositoryTask');
const unusedHelpersEnd = content.indexOf('// ─── Progress Emitter ─────────────────────────────────────────────────────');
if (unusedHelpersStart !== -1 && unusedHelpersEnd !== -1) {
    content = content.substring(0, unusedHelpersStart) + content.substring(unusedHelpersEnd);
}

fs.writeFileSync(indexPath, content, 'utf8');
console.log('Refactor complete');
