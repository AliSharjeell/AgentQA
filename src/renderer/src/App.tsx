/**
 * QA Automation AI — Renderer entry point.
 *
 * ## Layout
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Title bar (drag zone)                                          │
 * ├──────────────────┬──────────────────────────────────────────────┤
 * │  Sidebar         │  Main area                                   │
 * │  ────────────    │  ─────────                                   │
 * │  URL bar         │  Browser preview                             │
 * │  Task input      │  (WebContentsView rendered by Electron,       │
 * │  Task list       │   not React — embedded below title bar)      │
 * │  ────────────    │                                             │
 * │  Task details    │                                             │
 * │  Report section  │                                             │
 * └──────────────────┴──────────────────────────────────────────────┘
 *
 * ## How It Works
 *
 * - Browser preview: Electron WebContentsView (managed in main process)
 * - React handles: task creation, status display, step detail, report rendering
 * - Events from main: browser state, task progress, app progress
 */
import { useEffect, useState, useCallback } from "react";
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
  Clock,
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

    // Load initial data
    void window.qaApi.listTasks().then(setTasks);
    void window.qaApi.getBrowserState().then(setBrowserState);

    // Subscribe to events
    const unsubBrowser = window.qaApi.onBrowserState(setBrowserState);
    const unsubProgress = window.qaApi.onAppProgress((event: AppProgressEvent) => {
      if (event.type === "task_progress" || event.type === "task_complete" || event.type === "task_failed") {
        void window.qaApi.listTasks().then(setTasks);
        if (event.taskId) setActiveTaskId(event.taskId);
      }
      if (event.type === "step_complete") {
        void window.qaApi.listTasks().then(setTasks);
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

  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null;

  return (
    <main className="app-shell min-h-screen text-zinc-100">
      <div className="flex min-h-screen">
        {/* ── Sidebar ── */}
        <aside className="mica-sidebar window-drag sticky top-0 flex h-screen w-80 shrink-0 flex-col overflow-hidden border-r border-white/8 bg-zinc-950/60 px-4 py-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600">
              <Bot size={16} className="text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-white leading-tight">QA Automation AI</h1>
              <div className="flex items-center gap-1.5">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${browserState.ready ? "bg-green-400" : "bg-zinc-600"}`} />
                <span className="text-[10px] text-zinc-500">{browserState.ready ? browserState.title || "Ready" : browserState.message}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            {/* URL bar */}
            <div className="relative flex-1">
              <input
                className="input w-full pr-7 text-xs"
                placeholder="https://example.com"
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
            </div>
            <button
              className="icon-button shrink-0 h-9 w-9"
              onClick={() => window.qaApi?.refreshBrowser()}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="icon-button shrink-0 h-9 w-9"
              onClick={() => window.qaApi?.goBack()}
              title="Back"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              className="icon-button shrink-0 h-9 w-9"
              onClick={() => window.qaApi?.goForward()}
              title="Forward"
            >
              <ArrowRight size={14} />
            </button>
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
          {/* Title bar drag zone */}
          <div className="window-drag fixed left-80 right-0 top-0 z-10 h-12" />

          {/* Browser preview area — Electron WebContentsView is rendered here */}
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
  if (!browserState.ready && browserState.message !== "Ready") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <Loader2 size={32} className="animate-spin text-indigo-400" />
        <p className="text-sm text-zinc-400">{browserState.message}</p>
      </div>
    );
  }
  if (!browserState.url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-zinc-900">
          <ExternalLink size={28} className="text-zinc-600" />
        </div>
        <p className="text-sm text-zinc-500">Enter a URL in the sidebar to start browsing</p>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0 bg-zinc-950">
        {/* Browser URL shown as a minimal chrome bar */}
        <div className="flex h-8 items-center gap-2 border-b border-white/8 bg-zinc-900/60 px-4">
          <span className="text-[10px] text-zinc-600">{browserState.title || browserState.url}</span>
        </div>
        {/* The actual browser content is rendered by Electron WebContentsView */}
        {/* which overlays this container via platform APIs */}
      </div>
    </div>
  );
}

// ─── Task Panel ─────────────────────────────────────────────────────────────

interface TaskPanelProps {
  tasks: QaTask[];
  activeTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onRefresh: () => void;
}

function TaskPanel({ tasks, activeTaskId, onSelectTask, onRefresh, setTasks }: TaskPanelProps & { setTasks: React.Dispatch<React.SetStateAction<QaTask[]>> }): JSX.Element {
  const [inputName, setInputName] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [showUrlField, setShowUrlField] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");

  useEffect(() => {
    if (window.qaApi) {
      void window.qaApi.getBrowserState().then((s) => setBrowserUrl(s.url));
    }
  }, []);

  const handleCreateTask = useCallback(async () => {
    if (!inputName.trim() || !window.qaApi) return;
    setCreating(true);
    try {
      const targetUrl = inputUrl.trim() || browserUrl || "https://example.com";
      const task = await window.qaApi.createTask({
        name: inputName.trim(),
        targetUrl
      });
      setTasks((prev) => [task, ...prev]);
      onSelectTask(task.id);
      setInputName("");
      setInputUrl("");
      setShowUrlField(false);
      onRefresh();
    } finally {
      setCreating(false);
    }
  }, [inputName, inputUrl, browserUrl, onSelectTask, onRefresh, setTasks]);

  return (
    <div className="mt-3 flex flex-1 flex-col overflow-hidden">
      {/* Task input */}
      <div className="mb-3 space-y-2">
        <div className="flex items-center gap-2">
          <Bot size={12} className="shrink-0 text-indigo-400" />
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">New Task</span>
        </div>
        <input
          className="input w-full text-sm"
          placeholder='e.g. "Test the login page"'
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!showUrlField && inputUrl.trim() === "") {
                setShowUrlField(true);
              } else {
                void handleCreateTask();
              }
            }
          }}
        />
        {showUrlField && (
          <input
            className="input w-full text-xs"
            placeholder="Target URL (optional — uses browser URL if empty)"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateTask();
            }}
          />
        )}
        <button
          className="primary-button w-full !h-9 text-xs"
          onClick={() => {
            if (!showUrlField && inputUrl.trim() === "") {
              setShowUrlField(true);
            } else {
              void handleCreateTask();
            }
          }}
          disabled={creating || !inputName.trim()}
        >
          <Plus size={13} />
          {creating ? "Creating..." : "Create Task"}
        </button>
      </div>

      <div className="border-t border-white/8 mb-3" />

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
        {/* Status icon */}
        <StatusIcon status={task.status} size={14} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-200">{task.name}</p>
          <p className="text-[10px] text-zinc-600 truncate">{task.targetUrl}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.status === "todo" && (
            <button
              className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10"
              onClick={(e) => { e.stopPropagation(); onStart(); }}
              title="Start task"
            >
              <Play size={11} />
            </button>
          )}
          {isRunning && (
            <>
              <button
                className="grid h-6 w-6 place-items-center rounded text-yellow-400 hover:bg-white/10"
                onClick={(e) => { e.stopPropagation(); onPause(); }}
                title="Pause task"
              >
                <Pause size={11} />
              </button>
              <button
                className="grid h-6 w-6 place-items-center rounded text-red-400 hover:bg-white/10"
                onClick={(e) => { e.stopPropagation(); onStop(); }}
                title="Stop task"
              >
                <Square size={11} />
              </button>
            </>
          )}
          {isPaused && (
            <button
              className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10"
              onClick={(e) => { e.stopPropagation(); onResume(); }}
              title="Resume task"
            >
              <Play size={11} />
            </button>
          )}
          <button
            className="grid h-6 w-6 place-items-center rounded text-zinc-600 hover:bg-white/10 hover:text-red-400"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete task"
          >
            <Trash2 size={11} />
          </button>
          <button
            className="grid h-6 w-6 place-items-center rounded text-zinc-600 hover:bg-white/10"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/8">
          {/* Step progress */}
          {task.steps.length > 0 && (
            <div className="px-3 py-2 space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-600 mb-1.5">Steps</p>
              {task.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>
          )}

          {/* Report */}
          {task.report && (
            <div className="border-t border-white/8 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-600 mb-1.5">Report</p>
              <ReportBadge report={task.report} />
            </div>
          )}

          {/* AI Plan */}
          {task.aiPlan && (
            <div className="border-t border-white/8 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-600 mb-1">AI Plan</p>
              <p className="text-xs text-zinc-400">{task.aiPlan}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: QaTask["steps"][number] }): JSX.Element {
  const statusColor = step.status === "done" ? "text-green-400" : step.status === "failed" ? "text-red-400" : step.status === "running" ? "text-blue-400" : "text-zinc-600";
  const statusIcon = step.status === "done" ? <CheckCircle2 size={11} /> : step.status === "failed" ? <XCircle size={11} /> : step.status === "running" ? <Loader2 size={11} className="animate-spin" /> : <Circle size={11} />;

  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={`mt-0.5 shrink-0 ${statusColor}`}>{statusIcon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[11px] ${step.status === "failed" ? "text-red-400" : "text-zinc-300"}`}>
          {step.instruction}
        </p>
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

// ─── Report Badge / Section ─────────────────────────────────────────────────

function ReportBadge({ report }: { report: QaReport }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const statusColor =
    report.overallStatus === "pass" ? "text-green-400 bg-green-400/10 border-green-400/20" :
    report.overallStatus === "fail" ? "text-red-400 bg-red-400/10 border-red-400/20" :
    "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusColor}`}>
          {report.overallStatus === "pass" ? "✅ PASS" : report.overallStatus === "fail" ? "❌ FAIL" : "⚠️ PARTIAL"}
        </span>
        <span className="text-[10px] text-zinc-600">{report.passedSteps}/{report.totalSteps} passed</span>
        <button
          className="ml-auto flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300"
          onClick={() => setExpanded(!expanded)}
        >
          <FileText size={10} />
          {expanded ? "Hide" : "View"}
        </button>
        <button
          className="text-[10px] text-zinc-600 hover:text-zinc-300"
          onClick={() => window.qaApi?.exportReport(report.taskId, "markdown")}
          title="Export as Markdown"
        >
          Export
        </button>
      </div>

      {expanded && (
        <div className="rounded-lg border border-white/8 bg-zinc-950 p-3 space-y-2 text-[11px]">
          <p className="text-zinc-400 leading-relaxed">{report.summary}</p>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-green-400/10 p-1.5">
              <p className="text-green-400 font-semibold">{report.passedSteps}</p>
              <p className="text-[9px] text-zinc-600">Passed</p>
            </div>
            <div className="rounded-lg bg-red-400/10 p-1.5">
              <p className="text-red-400 font-semibold">{report.failedSteps}</p>
              <p className="text-[9px] text-zinc-600">Failed</p>
            </div>
            <div className="rounded-lg bg-zinc-700/50 p-1.5">
              <p className="text-zinc-300 font-semibold">{report.totalSteps}</p>
              <p className="text-[9px] text-zinc-600">Total</p>
            </div>
            <div className="rounded-lg bg-indigo-400/10 p-1.5">
              <p className="text-indigo-400 font-semibold">{(report.durationMs / 1000).toFixed(1)}s</p>
              <p className="text-[9px] text-zinc-600">Duration</p>
            </div>
          </div>
          <div className="border-t border-white/8 pt-2 space-y-1">
            {report.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className={step.status === "done" ? "text-green-400" : step.status === "failed" ? "text-red-400" : "text-zinc-600"}>
                  {step.status === "done" ? "✅" : step.status === "failed" ? "❌" : "⏳"}
                </span>
                <span className="text-zinc-300 flex-1">{step.instruction}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Panel ─────────────────────────────────────────────────────────

function SettingsPanel(): JSX.Element {
  const [settings, setSettings] = useState<{ apiProvider: string; apiKey: string; apiBaseUrl: string; model: string }>({
    apiProvider: "anthropic",
    apiKey: "",
    apiBaseUrl: "",
    model: "claude-sonnet-4-20250514"
  });
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (window.qaApi) {
      void window.qaApi.getSettings().then((s) => {
        if (s) setSettings(s as typeof settings);
      });
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
      // Test the API by sending a simple request
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
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-3">Settings</p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Provider</label>
          <select
            className="input w-full text-sm"
            value={settings.apiProvider}
            onChange={(e) => setSettings((s) => ({ ...s, apiProvider: e.target.value }))}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Key</label>
          <input
            className="input w-full text-sm"
            type="password"
            placeholder="sk-..."
            value={settings.apiKey}
            onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Model</label>
          <input
            className="input w-full text-sm"
            placeholder="claude-sonnet-4-20250514"
            value={settings.model}
            onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Base URL (optional)</label>
          <input
            className="input w-full text-sm"
            placeholder="Leave empty for default"
            value={settings.apiBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          className="primary-button flex-1 !h-9 text-xs"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
        <button
          className="secondary-button !h-9 text-xs"
          onClick={handleTest}
          disabled={testing || !settings.apiKey}
        >
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

// Helper to keep tasks in scope
let _setTasksRef: React.Dispatch<React.SetStateAction<QaTask[]>> | null = null;