/**
 * QA Automation AI — Renderer entry point.
 */
import { useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Play,
  Pause,
  Square,
  Trash2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
  Plus,
  Bot,
  FileText,
  Settings,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  ArrowLeft,
  ArrowRight
} from "lucide-react";
import type {
  QaTask,
  QaTaskInput,
  QaReport,
  BrowserState,
  AppProgressEvent
} from "../../shared/types";

type Page = "main" | "settings";

const navStorageKey = "qaapp-nav-page";

function restorePage(): Page {
  const saved = localStorage.getItem(navStorageKey);
  if (saved === "settings") return "settings";
  return "main";
}

// ─── App Root ────────────────────────────────────────────────────────────────

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>(restorePage);
  const [browserState, setBrowserState] = useState<BrowserState>({
    url: "",
    title: "",
    ready: false,
    message: "Initializing..."
  });
  const [tasks, setTasks] = useState<QaTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(navStorageKey, page);
  }, [page]);

  useEffect(() => {
    if (!window.qaApi) return;

    void window.qaApi.listTasks().then(setTasks);
    void window.qaApi.getBrowserState().then(setBrowserState);

    const unsubBrowser = window.qaApi.onBrowserState(setBrowserState);
    const unsubProgress = window.qaApi.onAppProgress((event: AppProgressEvent) => {
      if (
        event.type === "task_progress" ||
        event.type === "task_complete" ||
        event.type === "task_failed" ||
        event.type === "step_complete"
      ) {
        void window.qaApi.listTasks().then(setTasks);
        if (event.taskId) setActiveTaskId(event.taskId);
      }
    });
    const unsubTask = window.qaApi.onTaskProgress((task: QaTask) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx === -1) return [...prev, task];
        const next = [...prev];
        next[idx] = task;
        return next;
      });
    });

    return () => {
      unsubBrowser();
      unsubProgress();
      unsubTask();
    };
  }, []);

  return (
    <main className="app-shell min-h-screen text-zinc-100">
      <div className="flex min-h-screen">
        {/* ── Sidebar ── */}
        <aside className="mica-sidebar window-drag sticky top-0 flex h-screen w-72 shrink-0 flex-col overflow-hidden border-r border-white/8 px-4 py-4">
          <div className="flex items-center py-1.5">
            <h1 className="text-sm font-semibold text-white tracking-wide">QA Automation AI</h1>
          </div>

          {page === "settings" ? (
            <SettingsPanel />
          ) : (
            <TaskPanel
              tasks={tasks}
              activeTaskId={activeTaskId}
              onSelectTask={setActiveTaskId}
              onRefresh={() => window.qaApi?.listTasks().then(setTasks)}
              setTasks={setTasks}
              browserUrl={browserState.url}
            />
          )}

          <div className="mt-auto border-t border-white/8 pt-3">
            <button
              className="inline-flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition"
              onClick={() => setPage(page === "main" ? "settings" : "main")}
            >
              <Settings size={14} />
              {page === "main" ? "Settings" : "Back to Tasks"}
            </button>
          </div>
        </aside>

        {/* ── Main Area ── */}
        <div className="main-area relative min-w-0 flex-1 overflow-hidden">
          {/* Browser toolbar strip */}
          <div className="window-no-drag fixed left-72 right-0 top-0 z-10 flex h-12 items-center gap-3 border-b border-white/8 bg-zinc-900/80 px-4 backdrop-blur-sm">
            <div className="flex items-center gap-1">
              <button
                className="browser-nav-btn"
                onClick={() => window.qaApi?.goBack()}
                title="Back"
              >
                <ArrowLeft size={14} />
              </button>
              <button
                className="browser-nav-btn"
                onClick={() => window.qaApi?.goForward()}
                title="Forward"
              >
                <ArrowRight size={14} />
              </button>
              <button
                className="browser-nav-btn"
                onClick={() => window.qaApi?.refreshBrowser()}
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>

            {/* URL input */}
            <div className="relative flex-1 max-w-2xl mx-auto">
              <input
                className="browser-url-input"
                placeholder="Enter URL..."
                defaultValue={browserState.url}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && window.qaApi) {
                    const url = (e.target as HTMLInputElement).value;
                    if (url) {
                      const urlToUse = url.startsWith("http") ? url : `https://${url}`;
                      void window.qaApi.navigateTo({ url: urlToUse });
                    }
                  }
                }}
              />
              {browserState.ready && (
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-200 transition-colors duration-150"
                  onClick={() => {
                    if (window.qaApi && browserState.url) {
                      void window.qaApi.navigateTo({ url: browserState.url });
                    }
                  }}
                  title="Reload"
                >
                  ↻
                </button>
              )}
            </div>
          </div>

          {/* Browser preview area */}
          <div className="absolute inset-0 pt-12">
            <BrowserPreview browserState={browserState} />
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Browser Preview ────────────────────────────────────────────────────────

function BrowserPreview({ browserState }: { browserState: BrowserState }): JSX.Element {
  if (!browserState.url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-zinc-900">
          <ExternalLink size={28} className="text-zinc-600" />
        </div>
        <p className="text-sm text-zinc-500">Enter a URL above to start browsing</p>
      </div>
    );
  }
  if (!browserState.ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <Loader2 size={32} className="animate-spin text-indigo-400" />
        <p className="text-sm text-zinc-400">{browserState.message}</p>
      </div>
    );
  }
  // The Electron WebContentsView renders beneath this div.
  // Its content is visible in the area below the toolbar.
  return <div className="h-full w-full" />;
}

// ─── Task Panel ─────────────────────────────────────────────────────────────

interface TaskPanelProps {
  tasks: QaTask[];
  activeTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onRefresh: () => void;
  setTasks: React.Dispatch<React.SetStateAction<QaTask[]>>;
  browserUrl: string;
}

function TaskPanel({ tasks, activeTaskId, onSelectTask, onRefresh, setTasks, browserUrl }: TaskPanelProps): JSX.Element {
  const [inputName, setInputName] = useState("");
  const [showUrlHint, setShowUrlHint] = useState(false);
  const [urlError, setUrlError] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateTask = useCallback(async () => {
    if (!inputName.trim() || !window.qaApi) return;
    if (!browserUrl) {
      setUrlError("Navigate to a URL first using the bar above");
      setShowUrlHint(true);
      return;
    }
    setUrlError("");
    setShowUrlHint(false);
    setCreating(true);
    try {
      const task = await window.qaApi.createTask({
        name: inputName.trim(),
        targetUrl: browserUrl
      });
      setTasks((prev) => [task, ...prev]);
      onSelectTask(task.id);
      setInputName("");
      onRefresh();
    } finally {
      setCreating(false);
    }
  }, [inputName, browserUrl, onSelectTask, onRefresh, setTasks]);

  return (
    <div className="mt-4 flex flex-1 flex-col overflow-hidden">
      {/* New task input */}
      <div className="space-y-2">
        <span className="text-[11px] text-zinc-400 uppercase tracking-wide">New Task</span>
        <input
          className={`input w-full text-sm${urlError ? " border-red-500/50" : ""}`}
          placeholder='e.g. "Test the login page"'
          value={inputName}
          onChange={(e) => { setInputName(e.target.value); setUrlError(""); setShowUrlHint(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleCreateTask(); }
          }}
        />
        {urlError && (
          <p className="text-[10px] text-red-400">{urlError}</p>
        )}
        <button
          className="primary-button w-full !h-9 text-xs"
          onClick={() => void handleCreateTask()}
          disabled={creating || !inputName.trim()}
        >
          <Plus size={13} />
          {creating ? "Creating..." : "Create Task"}
        </button>
      </div>

      <div className="border-t border-white/8 my-4" />

      {/* Task list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-600">
            No tasks yet. Create one above.
          </div>
        ) : (
          tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              active={task.id === activeTaskId}
              onClick={() => onSelectTask(task.id === activeTaskId ? null : task.id)}
              onStart={() => window.qaApi?.startTask(task.id)}
              onStop={() => window.qaApi?.stopTask(task.id)}
              onPause={() => window.qaApi?.pauseTask(task.id)}
              onResume={() => window.qaApi?.resumeTask(task.id)}
              onDelete={() => {
                window.qaApi?.deleteTask(task.id);
                setTasks((prev) => prev.filter((t) => t.id !== task.id));
                if (activeTaskId === task.id) onSelectTask(null);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Task Item ──────────────────────────────────────────────────────────────

interface TaskItemProps {
  task: QaTask;
  active: boolean;
  onClick: () => void;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

function TaskItem({ task, active, onClick, onStart, onStop, onPause, onResume, onDelete }: TaskItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isRunning = task.status === "running";
  const isPaused = task.status === "paused";

  return (
    <div className="rounded-lg border border-white/8 bg-zinc-900/40 overflow-hidden">
      <div
        className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 transition ${active ? "bg-white/5" : "hover:bg-white/5"}`}
        onClick={onClick}
      >
        <StatusIcon status={task.status} size={14} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-200">{task.name}</p>
          <p className="truncate text-[10px] text-zinc-600">{task.targetUrl}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.status === "todo" && (
            <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); onStart(); }} title="Start">
              <Play size={11} />
            </button>
          )}
          {isRunning && (
            <>
              <button className="grid h-6 w-6 place-items-center rounded text-yellow-400 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); onPause(); }} title="Pause">
                <Pause size={11} />
              </button>
              <button className="grid h-6 w-6 place-items-center rounded text-red-400 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); onStop(); }} title="Stop">
                <Square size={11} />
              </button>
            </>
          )}
          {isPaused && (
            <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); onResume(); }} title="Resume">
              <Play size={11} />
            </button>
          )}
          <button className="grid h-6 w-6 place-items-center rounded text-zinc-600 hover:bg-white/10 hover:text-red-400" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
            <Trash2 size={11} />
          </button>
          <button className="grid h-6 w-6 place-items-center rounded text-zinc-600 hover:bg-white/10" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/8">
          {task.steps.length > 0 && (
            <div className="px-3 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1.5">Steps</p>
              {task.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>
          )}
          {task.report && (
            <div className="border-t border-white/8 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1.5">Report</p>
              <ReportBadge report={task.report} />
            </div>
          )}
          {task.aiPlan && (
            <div className="border-t border-white/8 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">AI Plan</p>
              <p className="text-xs text-zinc-400">{task.aiPlan}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: QaTask["steps"][number] }): JSX.Element {
  const statusColor =
    step.status === "done" ? "text-green-400" :
    step.status === "failed" ? "text-red-400" :
    step.status === "running" ? "text-blue-400" :
    "text-zinc-600";
  const statusIcon =
    step.status === "done" ? <CheckCircle2 size={11} /> :
    step.status === "failed" ? <XCircle size={11} /> :
    step.status === "running" ? <Loader2 size={11} className="animate-spin" /> :
    <Circle size={11} />;

  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={`mt-0.5 shrink-0 ${statusColor}`}>{statusIcon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[11px] ${step.status === "failed" ? "text-red-400" : "text-zinc-300"}`}>{step.instruction}</p>
        {step.result && <p className="text-[10px] text-zinc-600 mt-0.5 truncate">{step.result}</p>}
        {step.error && <p className="text-[10px] text-red-500 mt-0.5">{step.error}</p>}
        {step.screenshotPath && <p className="text-[10px] text-indigo-400 mt-0.5">Screenshot saved</p>}
      </div>
    </div>
  );
}

// ─── Status Icon ────────────────────────────────────────────────────────────

function StatusIcon({ status, size = 14 }: { status: QaTask["status"]; size?: number }): JSX.Element {
  const color =
    status === "done" ? "text-green-400" :
    status === "failed" ? "text-red-400" :
    status === "running" ? "text-blue-400" :
    status === "paused" ? "text-yellow-400" :
    "text-zinc-600";
  const icon =
    status === "done" ? <CheckCircle2 size={size} /> :
    status === "failed" ? <XCircle size={size} /> :
    status === "running" ? <Loader2 size={size} className="animate-spin" /> :
    status === "paused" ? <Pause size={size} /> :
    <Circle size={size} />;
  return <span className={`shrink-0 ${color}`}>{icon}</span>;
}

// ─── Report Badge ──────────────────────────────────────────────────────────

function ReportBadge({ report }: { report: QaReport }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const statusBadge =
    report.overallStatus === "pass" ? "✅ **PASS** — All steps completed successfully" :
    report.overallStatus === "fail" ? "❌ **FAIL** — Task could not be completed" :
    "⚠️  **PARTIAL** — Some steps completed, some failed";

  const markdownReport = [
    statusBadge,
    "",
    `## Task: ${report.taskName}`,
    "",
    `**Target URL:** ${report.targetUrl}`,
    `**Started:** ${new Date(report.startTime).toLocaleString()}`,
    `**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`,
    "",
    `## Summary`,
    "",
    report.summary,
    "",
    `## Step-by-Step Results`,
    "",
    ...report.steps.map((step, i) => {
      const icon = step.status === "done" ? "✅" : step.status === "failed" ? "❌" : "⏭️ ";
      const status = step.status === "done" ? "Completed" : step.status === "failed" ? "Failed" : "Skipped";
      const lines = [
        `### ${i + 1}. ${step.instruction}`,
        `**Status:** ${icon} ${status}`,
      ];
      if (step.result) lines.push(`**Result:** ${step.result}`);
      if (step.error) lines.push(`**Error:** ${step.error}`);
      if (step.screenshotPath) lines.push(`**Screenshot:** Saved at \`${step.screenshotPath}\``);
      lines.push("");
      return lines.join("\n");
    }),
    "",
    report.aiReasoning ? `## AI Reasoning\n\n${report.aiReasoning}` : ""
  ].join("\n");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${report.overallStatus === "pass" ? "text-green-400 bg-green-400/10 border-green-400/20" : report.overallStatus === "fail" ? "text-red-400 bg-red-400/10 border-red-400/20" : "text-yellow-400 bg-yellow-400/10 border-yellow-400/20"}`}>
          {report.overallStatus === "pass" ? "✅ PASS" : report.overallStatus === "fail" ? "❌ FAIL" : "⚠️ PARTIAL"}
        </span>
        <span className="text-[10px] text-zinc-600">{report.passedSteps}/{report.totalSteps} passed</span>
        <button className="ml-auto flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300" onClick={() => setExpanded(!expanded)}>
          <FileText size={10} />
          {expanded ? "Hide" : "View"}
        </button>
        <button className="text-[10px] text-zinc-600 hover:text-zinc-300" onClick={() => window.qaApi?.exportReport(report.taskId, "markdown")}>
          Export
        </button>
      </div>

      {expanded && (
        <div className="rounded-lg border border-white/8 bg-zinc-950 p-4 overflow-y-auto max-h-96">
          <div className="prose prose-invert prose-sm max-w-none text-zinc-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownReport}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Panel ─────────────────────────────────────────────────────────

function SettingsPanel(): JSX.Element {
  const [settings, setSettings] = useState({ apiProvider: "anthropic", apiKey: "", apiBaseUrl: "", model: "Minimax-M2.7" });
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (window.qaApi) {
      void window.qaApi.getSettings().then((s) => { if (s) setSettings(s as typeof settings); });
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!window.qaApi) return;
    setSaving(true);
    try {
      await window.qaApi.saveSettings(settings as never);
      setTestResult({ ok: true, message: "Settings saved!" });
    } catch (e) {
      setTestResult({ ok: false, message: `Error: ${e}` });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleTest = useCallback(async () => {
    if (!window.qaApi || !settings.apiKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const baseUrl = settings.apiBaseUrl || (settings.apiProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com");
      const res = await window.qaApi.testApiConnection(
        `${baseUrl}/v1/models`,
        "GET",
        { Authorization: `Bearer ${settings.apiKey}` },
        undefined as unknown as string
      );
      setTestResult({ ok: res.ok, message: res.ok ? `API connected (${res.status})` : `Error: ${res.body}` });
    } catch (e) {
      setTestResult({ ok: false, message: `Connection failed: ${e}` });
    } finally {
      setTesting(false);
    }
  }, [settings]);

  return (
    <div className="mt-4 flex-1 space-y-4 overflow-y-auto">
      <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Settings</p>

      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Provider</label>
          <select className="input w-full text-sm" value={settings.apiProvider} onChange={(e) => setSettings((s) => ({ ...s, apiProvider: e.target.value }))}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Key</label>
          <input className="input w-full text-sm" type="password" placeholder="sk-..." value={settings.apiKey} onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Model</label>
          <input className="input w-full text-sm" placeholder="claude-sonnet-4-20250514" value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Base URL (optional)</label>
          <input className="input w-full text-sm" placeholder="Leave empty for default" value={settings.apiBaseUrl} onChange={(e) => setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))} />
        </div>
      </div>

      <div className="flex gap-2">
        <button className="primary-button flex-1 !h-9 text-xs" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Settings"}</button>
        <button className="secondary-button !h-9 text-xs" onClick={handleTest} disabled={testing || !settings.apiKey}>
          {testing ? <Loader2 size={12} className="animate-spin" /> : null}
          Test
        </button>
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${testResult.ok ? "border-green-400/20 bg-green-400/10 text-green-400" : "border-red-400/20 bg-red-400/10 text-red-400"}`}>
          {testResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          {testResult.message}
        </div>
      )}
    </div>
  );
}