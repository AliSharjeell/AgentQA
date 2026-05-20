import type { AppSettings } from '../shared/types';
import { callForScript } from './api';
import { buildPrompt, normalizeScript } from './prompt';
import { runHarnessScript, buildObservationScript, type HarnessStepEvent, type HarnessResult } from './harness';

export interface TaskStep {
  instruction: string;
  status: 'running' | 'done' | 'failed';
  result?: string;
  error?: string;
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  steps: TaskStep[];
  durationMs: number;
  url: string;
  error: string | null;
  report?: import('./harness').CliReport;
}

export interface RunTaskOptions {
  targetUrl: string;
  prompt: string;
  settings: AppSettings;
  cdpUrl?: string;           // If provided, connects to existing Chrome. Otherwise browser-harness uses its own daemon.
  onStep?: (event: HarnessStepEvent) => void;
  timeoutMs?: number;
  visionMode?: boolean;
}

export async function runQaTask(options: RunTaskOptions): Promise<TaskResult> {
  const { targetUrl, prompt, settings, cdpUrl, timeoutMs = 120000 } = options;
  const onStep = options.onStep || (() => {});
  const steps: TaskStep[] = [];
  const startTime = Date.now();

  const addStep = (instruction: string, status: TaskStep['status'], result?: string, error?: string): void => {
    // Auto-complete previous running step
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.status === 'running' && lastStep.instruction !== instruction) {
      lastStep.status = 'done';
    }
    steps.push({ instruction, status, result, error });
  };

  try {
    // Step 1: Observe the page via browser-harness observation script
    const obsScript = buildObservationScript(targetUrl);
    let observation = '';

    const obsResult = await runHarnessScript(obsScript, (event) => {
      onStep(event);
      addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
    }, cdpUrl, timeoutMs);

    if (obsResult.ok) {
      observation = obsResult.summary;
    } else {
      observation = `DOM inspection failed: ${obsResult.error || obsResult.summary}`;
    }

    if (!settings.apiKey) {
      return {
        ok: false,
        summary: 'No API key configured.',
        steps,
        durationMs: Date.now() - startTime,
        url: targetUrl,
        error: 'Save an API key in settings or pass --api-key so the QA agent can generate actions.'
      };
    }

    // Step 2: Generate and run action scripts (up to 3 attempts)
    let previousFailure = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      addStep(`Plan browser actions (attempt ${attempt})`, 'running');
      onStep({ instruction: `Plan browser actions (attempt ${attempt})`, status: 'running' });

      const fullPrompt = buildPrompt(prompt, targetUrl, observation, previousFailure, attempt, options.visionMode);
      const rawScript = await callForScript(settings, fullPrompt);
      const script = normalizeScript(rawScript);

      addStep(`Plan browser actions (attempt ${attempt})`, 'done', 'Generated action script.');
      onStep({ instruction: `Plan browser actions (attempt ${attempt})`, status: 'done', result: 'Generated action script.' });

      const result = await runHarnessScript(script, (event) => {
        onStep(event);
        addStep(event.instruction, event.status as TaskStep['status'], event.result, event.error);
      }, cdpUrl, timeoutMs);

      if (result.ok) {
        // Clean up any remaining running steps
        for (const step of steps) {
          if (step.status === 'running') step.status = 'done';
        }
        return {
          ok: true,
          summary: result.summary,
          steps,
          durationMs: Date.now() - startTime,
          url: targetUrl,
          error: null,
          report: result.report
        };
      }

      previousFailure = [previousFailure, `Attempt ${attempt} failed: ${result.error ?? result.summary}`].filter(Boolean).join('\n');
    }

    // All attempts failed
    for (const step of steps) {
      if (step.status === 'running') step.status = 'failed';
    }
    return {
      ok: false,
      summary: 'Could not complete the task after 3 attempts.',
      steps,
      durationMs: Date.now() - startTime,
      url: targetUrl,
      error: previousFailure || 'No successful action sequence was produced.'
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const step of steps) {
      if (step.status === 'running') step.status = 'failed';
    }
    return {
      ok: false,
      summary: 'Task execution failed.',
      steps,
      durationMs: Date.now() - startTime,
      url: targetUrl,
      error: message
    };
  }
}
