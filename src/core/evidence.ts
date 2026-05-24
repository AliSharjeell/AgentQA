import fs from 'node:fs';
import path from 'node:path';
import type { QaArtifactManifest, QaEvidenceStatus, QaRunAction } from '../shared/types';
import type { PageObservation } from './harness';
import type { AgentExecutor } from './executor';
import { redactValue } from './sanitize';

export interface EvidenceWarning {
  message: string;
  artifact?: string;
}

export class EvidenceCollector {
  readonly rootDir: string;
  readonly screenshotsDir: string;
  private readonly warnings: EvidenceWarning[] = [];
  private screenshotFailures = 0;

  constructor(
    readonly runId: string,
    baseDir?: string
  ) {
    const defaultBase = path.join(process.env.APPDATA || process.env.HOME || process.cwd(), 'agentqa', 'runs');
    this.rootDir = path.join(baseDir || defaultBase, runId);
    this.screenshotsDir = path.join(this.rootDir, 'screenshots');
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, 'dom'), { recursive: true });
  }

  get evidenceStatus(): QaEvidenceStatus {
    return this.screenshotFailures > 0 || this.warnings.length > 0 ? 'PARTIAL' : 'COMPLETE';
  }

  getWarnings(): EvidenceWarning[] {
    return [...this.warnings];
  }

  relative(absolutePath: string): string {
    return path.relative(this.rootDir, absolutePath).replace(/\\/g, '/');
  }

  pathFor(relativePath: string): string {
    return path.join(this.rootDir, relativePath);
  }

  async captureScreenshot(
    executor: AgentExecutor,
    fileName: string,
    options: { full?: boolean; required?: boolean } = {}
  ): Promise<string | undefined> {
    const outputPath = path.join(this.screenshotsDir, fileName);
    const result = await executor.screenshot(outputPath, Boolean(options.full));
    if (result.ok && result.path) {
      return this.relative(result.path);
    }

    this.screenshotFailures++;
    this.warnings.push({
      message: `${options.required ? 'Required s' : 'S'}creenshot capture failed: ${result.error || 'unknown error'}`,
      artifact: this.relative(outputPath)
    });
    return undefined;
  }

  saveDomSnapshot(fileName: string, observation: PageObservation): string {
    return this.writeJson(path.join('dom', fileName), observation);
  }

  saveConsoleLog(observations: PageObservation[]): string {
    const lines = observations
      .flatMap((observation) => observation.consoleErrors || [])
      .filter(Boolean);
    return this.writeText('console.log', lines.join('\n'));
  }

  saveNetworkLog(observations: PageObservation[]): string {
    const entries = observations.flatMap((observation) => observation.networkErrors || []);
    return this.writeJson('network.json', entries);
  }

  async saveAccessibilityTree(executor: AgentExecutor): Promise<string | undefined> {
    const result = await executor.accessibilitySnapshot();
    if (!result.ok) {
      this.warnings.push({ message: `Accessibility tree capture failed: ${result.error || 'unknown error'}` });
      return undefined;
    }
    return this.writeJson('accessibility-tree.json', result.data ?? {});
  }

  saveActionTrace(actions: QaRunAction[]): string {
    return this.writeJson('action-trace.json', actions);
  }

  writeJson(relativePath: string, value: unknown): string {
    const absolutePath = this.pathFor(relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(redactValue(value), null, 2), 'utf8');
    return relativePath.replace(/\\/g, '/');
  }

  writeText(relativePath: string, value: string): string {
    const absolutePath = this.pathFor(relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, value, 'utf8');
    return relativePath.replace(/\\/g, '/');
  }

  manifest(overrides: Partial<QaArtifactManifest> = {}): QaArtifactManifest {
    return {
      html_report: 'report.html',
      markdown_report: 'report.md',
      json_result: 'result.json',
      screenshots_dir: 'screenshots/',
      ...overrides
    };
  }
}

