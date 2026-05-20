/**
 * QA Task data repository — JSON-based task storage.
 *
 * ## Data Storage
 *
 * JSON file at app.getPath("userData") / qa-tasks-store.json
 * Contains tasks array with auto-save (debounced 300ms).
 *
 * ## Task Lifecycle
 *
 * Status: todo → running → done | failed | paused
 * Each task has steps that progress through: pending → running → done | failed | skipped
 * When a task completes (done/failed), its report is attached.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { app } from "electron";
import type {
  QaTask,
  QaTaskInput,
  QaTaskUpdate,
  QaReport,
  QaTaskStep,
  TaskStatus,
  TaskStepStatus
} from "../../shared/types";

// ─── Store Interface ────────────────────────────────────────────────────────

interface TaskStore {
  nextId: number;
  tasks: QaTask[];
}

let store: TaskStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

export function listTasks(): QaTask[] {
  return [...getStore().tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createTask(input: QaTaskInput): QaTask {
  const current = getStore();
  const now = timestamp();
  const task: QaTask = {
    id: `qa-${current.nextId}`,
    name: input.name.trim(),
    targetUrl: input.targetUrl.trim(),
    status: "todo",
    steps: [],
    visionMode: input.visionMode,
    mode: input.mode || "standard",
    maxSteps: input.maxSteps,
    allowEscalation: input.allowEscalation,
    createdAt: now,
    updatedAt: now
  };
  current.nextId += 1;
  current.tasks.push(task);
  saveStore();
  return { ...task };
}

export function getTaskById(id: string): QaTask | null {
  return getStore().tasks.find((t) => t.id === id) ?? null;
}

export function updateTask(id: string, update: QaTaskUpdate): QaTask {
  const task = getMutableTask(id);
  if (update.name !== undefined) task.name = update.name.trim();
  if (update.targetUrl !== undefined) task.targetUrl = update.targetUrl.trim();
  if (update.status !== undefined) task.status = update.status;
  if (update.visionMode !== undefined) task.visionMode = update.visionMode;
  if (update.mode !== undefined) task.mode = update.mode;
  if (update.maxSteps !== undefined) task.maxSteps = update.maxSteps;
  if (update.allowEscalation !== undefined) task.allowEscalation = update.allowEscalation;
  task.updatedAt = timestamp();
  saveStore();
  return { ...task };
}

export function deleteTask(id: string): void {
  const current = getStore();
  current.tasks = current.tasks.filter((t) => t.id !== id);
  saveStore();
}

export function setTaskSteps(id: string, steps: QaTaskStep[]): QaTask {
  const task = getMutableTask(id);
  task.steps = steps;
  task.updatedAt = timestamp();
  saveStore();
  return { ...task };
}

export function updateStepStatus(
  taskId: string,
  stepId: string,
  status: TaskStepStatus,
  result?: string,
  screenshotPath?: string,
  error?: string
): QaTask {
  const task = getMutableTask(taskId);
  const step = task.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = status;
    if (result !== undefined) step.result = result;
    if (screenshotPath !== undefined) step.screenshotPath = screenshotPath;
    if (error !== undefined) step.error = error;
    step.timestamp = timestamp();
  }
  task.updatedAt = timestamp();
  saveStore();
  return { ...task };
}

export function attachReport(taskId: string, report: QaReport): QaTask {
  const task = getMutableTask(taskId);
  task.report = report;
  task.completedAt = timestamp();
  task.updatedAt = timestamp();
  saveStore();
  return { ...task };
}

export function getTaskReport(taskId: string): QaReport | null {
  const task = getStore().tasks.find((t) => t.id === taskId);
  return task?.report ?? null;
}

export function generateId(): string {
  return crypto.randomUUID().slice(0, 12);
}

// ─── Internal ──────────────────────────────────────────────────────────────

function getStore(): TaskStore {
  if (store) return store;

  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    store = emptyStore();
    saveStore();
    return store;
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<TaskStore>;
  store = {
    nextId: parsed.nextId ?? 1,
    tasks: parsed.tasks ?? []
  };
  return store;
}

function saveStore(): void {
  if (!store) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
    fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), "utf8");
  }, 300);
}

function emptyStore(): TaskStore {
  return { nextId: 1, tasks: [] };
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), "qa-tasks-store.json");
}

function timestamp(): string {
  return new Date().toISOString();
}

function getMutableTask(id: string): QaTask {
  const task = getStore().tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Task ${id} was not found.`);
  return task;
}
