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
  ArrowRight,
  Search,
  CheckSquare,
  XSquare
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
  const [urlInputVal, setUrlInputVal] = useState("");

  useEffect(() => {
    setUrlInputVal(browserState.url || "");
  }, [browserState.url]);

  const handleNavigate = useCallback(() => {
    if (!window.qaApi || !urlInputVal.trim()) return;
    const url = urlInputVal.trim();
    let urlToUse = url;
    if (!url.includes(".") || url.includes(" ")) {
      urlToUse = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
    } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
      urlToUse = `https://${url}`;
    }
    void window.qaApi.navigateTo({ url: urlToUse });
  }, [urlInputVal]);

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
        <aside className="mica-sidebar sticky top-0 flex h-screen w-72 shrink-0 flex-col overflow-hidden px-4 py-4">
          <div className="flex flex-col gap-3 pb-3 border-b border-white/5">
            <div className="window-drag flex items-center py-1.5">
              <h1 className="text-sm font-normal text-white tracking-wide">AgentQA</h1>
            </div>
            <button
              className="inline-flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition duration-200 active:scale-[0.98] select-none"
              onClick={() => setPage(page === "main" ? "settings" : "main")}
            >
              <Settings size={14} />
              {page === "main" ? "Settings" : "Back to Tasks"}
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
              browserUrl={browserState.url}
            />
          )}
        </aside>

        {/* ── Main Area ── */}
        <div className="main-area relative min-w-0 flex-1 overflow-hidden">
          {/* Browser toolbar strip */}
          <div className="window-drag fixed left-72 right-0 top-0 z-10 flex h-12 items-center gap-3 mica-topbar px-4">
            <div className="window-no-drag flex items-center gap-1">
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
            <div className="window-no-drag relative flex-1 max-w-2xl mx-auto">
              <input
                className="browser-url-input"
                placeholder="Enter URL or search..."
                value={urlInputVal}
                onChange={(e) => setUrlInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleNavigate();
                  }
                }}
              />
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 transition-colors duration-150 active:scale-90"
                onClick={handleNavigate}
                title="Search / Go"
              >
                <Search size={13} />
              </button>
            </div>
          </div>

          {/* Browser preview area */}
          <div className="absolute left-0 right-0 bottom-0 top-12 bg-zinc-950 rounded-tl-2xl border-t border-l border-white/10 overflow-hidden">
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
    <div className="window-no-drag mt-4 flex flex-1 flex-col overflow-hidden">
      {/* Task list */}
      <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
        {tasks.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-600">
            No tasks yet. Create one below.
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

      {/* New task chat-style input (pinned to bottom) */}
      <div className="mt-auto pt-3 border-t border-white/5 space-y-1.5">
        <div className="relative flex items-center">
          <input
            className={`h-9 w-full rounded-full border border-white/5 bg-white/5 pl-4 pr-10 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none transition-all duration-200 focus:border-white/10 focus:bg-white/10${urlError ? " border-red-500/50" : ""}`}
            placeholder="Enter a task..."
            value={inputName}
            onChange={(e) => { setInputName(e.target.value); setUrlError(""); setShowUrlHint(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleCreateTask();
              }
            }}
          />
          <button
            className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-white text-zinc-950 hover:bg-zinc-200 transition duration-150 active:scale-90 disabled:opacity-40 disabled:pointer-events-none"
            onClick={() => void handleCreateTask()}
            disabled={creating || !inputName.trim()}
            title="Create Task"
          >
            <ArrowRight size={14} />
          </button>
        </div>
        {urlError && (
          <p className="text-[10px] text-red-400 px-2">{urlError}</p>
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
  const isRunning = task.status === "running";
  const isPaused = task.status === "paused";

  return (
    <div
      className={`window-no-drag flex flex-col cursor-pointer transition-all duration-200 rounded-xl border select-none ${
        active
          ? "bg-white/8 border-white/10 text-white"
          : "border-transparent text-zinc-400 hover:bg-white/5 hover:border-white/5 hover:text-zinc-200 active:scale-[0.98]"
      }`}
      onClick={onClick}
    >
      {active ? (
        <div className="flex flex-col px-3 pt-3 pb-2 space-y-2.5">
          {/* Top row with Status and Controls */}
          <div className="flex items-center justify-between border-b border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <StatusIcon status={task.status} size={14} />
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                {task.status === "running" ? "Running" : task.status === "paused" ? "Paused" : task.status === "done" ? "Completed" : task.status === "failed" ? "Failed" : "To Do"}
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {task.status === "todo" && (
                <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onStart(); }} title="Start">
                  <Play size={11} />
                </button>
              )}
              {isRunning && (
                <>
                  <button className="grid h-6 w-6 place-items-center rounded text-yellow-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onPause(); }} title="Pause">
                    <Pause size={11} />
                  </button>
                  <button className="grid h-6 w-6 place-items-center rounded text-red-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onStop(); }} title="Stop">
                    <Square size={11} />
                  </button>
                </>
              )}
              {isPaused && (
                <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onResume(); }} title="Resume">
                  <Play size={11} />
                </button>
              )}
              <button className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-red-500/10 hover:text-red-400 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
                <Trash2 size={11} />
              </button>
            </div>
          </div>

          {/* Full width Prompt & URL */}
          <div
            className="w-full space-y-1 select-text cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="break-words whitespace-normal select-text cursor-text text-xs font-medium leading-relaxed">
              {task.name}
            </p>
            <p className="break-all whitespace-normal select-text cursor-text text-[10px] text-zinc-400 leading-normal">
              {task.targetUrl}
            </p>
          </div>
        </div>
      ) : (
        /* Collapsed Row */
        <div className="flex items-center gap-2.5 px-3 py-2">
          <StatusIcon status={task.status} size={14} />

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{task.name}</p>
            <p className="truncate text-[10px] text-zinc-500">{task.targetUrl}</p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {task.status === "todo" && (
              <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onStart(); }} title="Start">
                <Play size={11} />
              </button>
            )}
            {isRunning && (
              <>
                <button className="grid h-6 w-6 place-items-center rounded text-yellow-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onPause(); }} title="Pause">
                  <Pause size={11} />
                </button>
                <button className="grid h-6 w-6 place-items-center rounded text-red-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onStop(); }} title="Stop">
                  <Square size={11} />
                </button>
              </>
            )}
            {isPaused && (
              <button className="grid h-6 w-6 place-items-center rounded text-green-400 hover:bg-white/10 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onResume(); }} title="Resume">
                <Play size={11} />
              </button>
            )}
            <button className="grid h-6 w-6 place-items-center rounded text-zinc-500 hover:bg-red-500/10 hover:text-red-400 transition active:scale-95" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      {active && (
        <div 
          className="border-t border-white/5 px-3 py-2.5 space-y-2.5 text-zinc-400 text-xs select-text cursor-default"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Natural language response block at the top */}
          {task.status === "running" && (
            <div className="flex items-center gap-2 py-0.5 select-none pl-1">
              <Loader2 size={11} className="animate-spin text-indigo-400 shrink-0" />
              <p className="text-[11px] text-zinc-400">Executing browser automation...</p>
            </div>
          )}
          {task.status === "failed" && !task.report && (
            <div className="space-y-1 select-text">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 select-none">Error</p>
              <p className="text-[11px] text-red-400 leading-relaxed pl-1 select-text cursor-text">
                {task.steps.find((s) => s.status === "failed")?.error || "Task stopped due to an error."}
              </p>
            </div>
          )}
          {task.report?.summary && (
            <div className="space-y-1 select-text">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 select-none">Result</p>
              <p className="text-[11px] text-zinc-300 leading-relaxed pl-1 select-text cursor-text">{task.report.summary}</p>
            </div>
          )}

          {task.steps.length > 0 && (
            <div className="space-y-1 select-text">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 select-none">Steps</p>
              {task.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>
          )}

          {task.aiPlan && (
            <div className="select-text">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 select-none">AI Plan</p>
              <p className="text-xs text-zinc-400 leading-relaxed select-text cursor-text">{task.aiPlan}</p>
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
    <div className="flex items-start gap-2 py-0.5 select-text">
      <span className={`mt-0.5 shrink-0 select-none ${statusColor}`}>{statusIcon}</span>
      <div className="min-w-0 flex-1 select-text">
        <p className={`text-[11px] select-text cursor-text ${step.status === "failed" ? "text-red-400" : "text-zinc-300"}`}>{step.instruction}</p>
        {step.result && <p className="text-[10px] text-zinc-600 mt-0.5 truncate select-text cursor-text">{step.result}</p>}
        {step.error && <p className="text-[10px] text-red-500 mt-0.5 select-text cursor-text">{step.error}</p>}
        {step.screenshotPath && <p className="text-[10px] text-indigo-400 mt-0.5 select-text">Screenshot saved</p>}
      </div>
    </div>
  );
}

// ─── Status Icon ────────────────────────────────────────────────────────────

function StatusIcon({ status, size = 14 }: { status: QaTask["status"]; size?: number }): JSX.Element {
  if (status === "running") {
    return <Loader2 size={size} className="animate-spin text-blue-400 shrink-0" />;
  }

  if (status === "done") {
    return (
      <div className="w-3.5 h-3.5 rounded-[4px] bg-green-500 flex items-center justify-center text-zinc-950 shrink-0 select-none">
        <svg className="w-2.5 h-2.5 stroke-[3.5] stroke-current" fill="none" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="w-3.5 h-3.5 rounded-[4px] bg-red-500 flex items-center justify-center text-zinc-950 shrink-0 select-none">
        <svg className="w-2 h-2 stroke-[3.5] stroke-current" fill="none" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }

  if (status === "paused") {
    return (
      <div className="w-3.5 h-3.5 rounded-[4px] bg-yellow-500 flex items-center justify-center text-zinc-950 shrink-0 select-none">
        <svg className="w-1.5 h-1.5 fill-current" viewBox="0 0 24 24">
          <rect x="4" y="4" width="5" height="16" rx="1" />
          <rect x="15" y="4" width="5" height="16" rx="1" />
        </svg>
      </div>
    );
  }

  // Todo state
  return (
    <div className="w-3.5 h-3.5 rounded-[4px] border border-white/20 bg-white/5 shrink-0 transition-colors" />
  );
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
  const [settings, setSettings] = useState({ apiProvider: "anthropic", apiKey: "", apiBaseUrl: "", model: "Minimax-M2.7", visionMode: false });
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
    <div className="window-no-drag mt-4 flex-1 space-y-4 overflow-y-auto">
      <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider select-none">Settings</p>

      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Provider</label>
          <select className="input w-full" value={settings.apiProvider} onChange={(e) => setSettings((s) => ({ ...s, apiProvider: e.target.value }))}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">API Key</label>
          <input className="input w-full" type="password" placeholder="sk-..." value={settings.apiKey} onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Model</label>
          <input className="input w-full" placeholder="claude-sonnet-4-20250514" value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} />
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Base URL (optional)</label>
          <input className="input w-full" placeholder="Leave empty for default" value={settings.apiBaseUrl} onChange={(e) => setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))} />
        </div>
        <div className="flex items-center gap-2 pt-2">
          <input type="checkbox" id="settingsVisionMode" checked={settings.visionMode} onChange={(e) => setSettings((s) => ({ ...s, visionMode: e.target.checked }))} className="rounded border-white/10 bg-white/5 accent-zinc-500 cursor-pointer" />
          <label htmlFor="settingsVisionMode" className="text-xs text-zinc-400 select-none cursor-pointer hover:text-zinc-300 transition-colors">Enable Vision Mode (Multimodal LLM required)</label>
        </div>
      </div>

      <div className="flex gap-2">
        <button className="primary-button flex-1" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Settings"}</button>
        <button className="secondary-button" onClick={handleTest} disabled={testing || !settings.apiKey}>
          {testing ? <Loader2 size={12} className="animate-spin" /> : null}
          Test
        </button>
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs ${testResult.ok ? "border-green-500/20 bg-green-500/5 text-green-400" : "border-red-500/20 bg-red-500/5 text-red-400"}`}>
          {testResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          {testResult.message}
        </div>
      )}
    </div>
  );
}
