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
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
  FileText,
  Settings,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  Search,
  Image,
  ListChecks,
  Terminal,
  Braces,
  ShieldAlert
} from "lucide-react";
import type {
  QaTask,
  QaReport,
  QaIssue,
  QaTemplate,
  QaVerdict,
  BrowserState,
  AppProgressEvent,
  AgentRunMode,
  AppSettings
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
  const [mode, setMode] = useState<AgentRunMode>("standard");
  const [allowEscalation, setAllowEscalation] = useState(false);
  const [templates, setTemplates] = useState<QaTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    if (!window.qaApi) return;
    void window.qaApi.listTemplates().then(setTemplates);
  }, []);

  const handleCreateTask = useCallback(async () => {
    if (!inputName.trim() || !window.qaApi) return;
    const selectedTemplate = templates.find((template) => template.id === templateId);
    const targetUrl = selectedTemplate?.url || browserUrl;
    if (!targetUrl) {
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
        targetUrl,
        templateId: selectedTemplate?.id,
        mode,
        allowEscalation
      });
      setTasks((prev) => [task, ...prev]);
      onSelectTask(task.id);
      setInputName("");
      onRefresh();
    } finally {
      setCreating(false);
    }
  }, [inputName, browserUrl, mode, allowEscalation, onSelectTask, onRefresh, setTasks, templateId, templates]);

  const handleTemplateChange = useCallback((value: string) => {
    setTemplateId(value);
    const selectedTemplate = templates.find((template) => template.id === value);
    if (selectedTemplate) {
      setInputName(selectedTemplate.task);
      setUrlError("");
      setShowUrlHint(false);
    }
  }, [templates]);

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
        <select
          className="h-8 w-full rounded-lg border border-white/5 bg-white/5 px-2 text-[11px] text-zinc-300 outline-none focus:border-white/10"
          value={templateId}
          onChange={(e) => handleTemplateChange(e.target.value)}
          title="QA Template"
        >
          <option value="">Custom task</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>{template.title}</option>
          ))}
        </select>
        <div className="grid grid-cols-[1fr_auto] gap-2 px-1">
          <select
            className="h-8 rounded-lg border border-white/5 bg-white/5 px-2 text-[11px] text-zinc-300 outline-none focus:border-white/10"
            value={mode}
            onChange={(e) => setMode(e.target.value as AgentRunMode)}
            title="Automation Mode"
          >
            <option value="standard">Standard</option>
            <option value="browser-use">Browser-use</option>
            <option value="advanced">Advanced</option>
          </select>
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-white/5 bg-white/5 px-2 text-[10px] text-zinc-400">
            <input
              type="checkbox"
              checked={allowEscalation}
              onChange={(e) => setAllowEscalation(e.target.checked)}
              className="rounded border-white/10 bg-white/5 accent-zinc-500"
            />
            Escalate
          </label>
        </div>
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
          {/* Full width Prompt & URL */}
          <div
            className="w-full space-y-1 select-text cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="break-words whitespace-pre-wrap select-text cursor-text text-xs font-medium leading-relaxed">
              {task.name}
            </p>
            <p className="break-all whitespace-pre-wrap select-text cursor-text text-[10px] text-zinc-400 leading-normal">
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
          {/* Status and Controls at the top of the expanded tab */}
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
          {task.report ? (
            <QaResultCard task={task} report={task.report} />
          ) : task.steps.length > 0 && (
            <div className="space-y-1 select-text">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1 select-none">Steps</p>
              {[...task.steps].reverse().map((step) => (
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
  const [expanded, setExpanded] = useState(false);

  const isProviderError = (error: string | undefined): { isProvider: boolean; message: string } | null => {
    if (!error) return null;
    // Detect provider overload errors (529, overloaded_error, rate_limit_error, etc.)
    const providerPatterns = [
      /529/i, /overloaded_error/i, /rate_limit_error/i, /timeout/i,
      /ETIMEDOUT/i, /ECONNRESET/i, /429/i
    ];
    const isProvider = providerPatterns.some(pattern => pattern.test(error)) ||
      error.includes('Provider overloaded') || error.includes('Anthropic API') || error.includes('OpenAI API');
    if (isProvider) {
      // Extract compact message from error
      const match = error.match(/(Anthropic|OpenAI)\s+(API\s+)?(returned\s+)?(\d+|overloaded_error)/i);
      if (match) {
        return { isProvider: true, message: `${match[1]} ${match[3] || ''}${match[4]}. Retried and recovered.` };
      }
      return { isProvider: true, message: 'Provider temporarily unavailable. Retried and recovered.' };
    }
    return null;
  };

  const providerInfo = isProviderError(step.error);
  const hasProviderWarning = step.status === 'failed' && providerInfo?.isProvider;

  const statusColor =
    step.status === "done" ? "text-green-400" :
    step.status === "failed" ? hasProviderWarning ? "text-yellow-400" : "text-red-400" :
    step.status === "running" ? "text-blue-400" :
    "text-zinc-600";
  const statusIcon =
    step.status === "done" ? <CheckCircle2 size={11} /> :
    step.status === "failed" ? hasProviderWarning ? <AlertCircle size={11} /> : <XCircle size={11} /> :
    step.status === "running" ? <Loader2 size={11} className="animate-spin" /> :
    <Circle size={11} />;

  const hasLongResult = step.result && step.result.length > 150;
  const hasLongError = step.error && step.error.length > 150;
  const isExpandable = hasLongResult || hasLongError;

  return (
    <div className="flex items-start gap-2 py-0.5 select-text">
      <span className={`mt-0.5 shrink-0 select-none ${statusColor}`}>{statusIcon}</span>
      <div className="min-w-0 flex-1 select-text">
        <p className={`text-[11px] select-text cursor-text break-words whitespace-pre-wrap ${step.status === "failed" ? "text-red-400" : "text-zinc-300"}`}>{step.instruction}</p>
        {step.result && !expanded && !hasLongResult && <p className="text-[10px] text-zinc-500 mt-0.5 break-words whitespace-pre-wrap select-text cursor-text leading-normal">{step.result}</p>}
        {step.result && expanded && <p className="text-[10px] text-zinc-500 mt-0.5 break-words whitespace-pre-wrap select-text cursor-text leading-normal">{step.result}</p>}
        {step.result && hasLongResult && !expanded && <p className="text-[10px] text-zinc-500 mt-0.5 break-words whitespace-pre-wrap select-text cursor-text leading-normal">{step.result.slice(0, 150)}...<button className="text-indigo-400 hover:text-indigo-300 ml-1" onClick={() => setExpanded(true)}>View more</button></p>}
        {step.error && hasProviderWarning && <p className="text-[10px] text-yellow-400 mt-0.5 break-words whitespace-pre-wrap select-text cursor-text leading-normal">{providerInfo?.message}</p>}
        {step.error && !hasProviderWarning && !providerInfo && <p className="text-[10px] text-red-500 mt-0.5 break-words whitespace-pre-wrap select-text cursor-text leading-normal">{step.error}</p>}
        {step.error && providerInfo && <button className="text-[10px] text-zinc-500 hover:text-zinc-300 mt-0.5" onClick={() => setExpanded(!expanded)}>{expanded ? "Hide details" : "Show details"}</button>}
        {expanded && step.error && providerInfo && <p className="text-[9px] text-zinc-600 mt-0.5 break-all whitespace-pre-wrap select-text cursor-text leading-normal font-mono">{step.error}</p>}
        {step.screenshotPath && <p className="text-[10px] text-indigo-400 mt-0.5 select-text">Screenshot saved</p>}
        {expanded && isExpandable && <button className="text-[10px] text-zinc-500 hover:text-zinc-300 mt-0.5" onClick={() => setExpanded(false)}>Show less</button>}
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

type QaReportTab = "summary" | "product" | "agent" | "assertions" | "steps" | "screenshots" | "console" | "json";

function QaResultCard({ task, report }: { task: QaTask; report: QaReport }): JSX.Element {
  const [tab, setTab] = useState<QaReportTab>("summary");
  const [screenshots, setScreenshots] = useState<Record<string, string>>({});
  const result = report.resultJson;
  const status = (report.status || result?.status || "BLOCKED") as QaVerdict;
  const screenshotPaths = report.screenshots || [];
  const productIssues = result?.product_issues || (report.issues || []).filter((issue) => issue.category === "PRODUCT_ISSUE");
  const agentIssues = [
    ...(result?.agent_issues || []),
    ...(result?.verifier_issues || []),
    ...(result?.test_data_issues || []),
    ...(result?.environment_issues || [])
  ];
  const confidence = result?.validator_review?.confidence || (status === "PASS" || status === "PASS_WITH_WARNINGS" ? "HIGH" : "MEDIUM");

  useEffect(() => {
    if (!window.qaApi || screenshotPaths.length === 0) return;
    let canceled = false;
    screenshotPaths.slice(0, 8).forEach((artifactPath) => {
      void window.qaApi.readArtifact(task.id, artifactPath).then((artifact) => {
        if (!canceled && artifact.ok && artifact.dataUrl) {
          setScreenshots((prev) => ({ ...prev, [artifactPath]: artifact.dataUrl || "" }));
        }
      });
    });
    return () => {
      canceled = true;
    };
  }, [screenshotPaths.join("|"), task.id]);

  return (
    <div className="qa-report-panel space-y-3 select-text">
      <div className="qa-report-header flex flex-col gap-2">
        <div className={`qa-status-badge ${statusTone(status)}`}>Verdict: {status}</div>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-zinc-100 break-words">{report.title || report.taskName}</p>
          <p className="text-[10px] text-zinc-500 break-all">{report.targetUrl}</p>
          <p className="mt-0.5 text-[9px] uppercase tracking-wide text-zinc-600">Run Completed: {report.endTime ? "Yes" : "No"}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Metric label="Passed" value={result?.stats.assertions_passed ?? report.passedSteps} tone="text-green-300" />
        <Metric label="Failed" value={result?.stats.assertions_failed ?? report.failedSteps} tone="text-red-300" />
        <Metric label="Blocked" value={result?.stats.assertions_blocked ?? (report.blockedSteps || 0)} tone="text-amber-300" />
        <Metric label="Root Cause" value={report.rootCause || result?.root_cause || "None"} tone="text-zinc-300" />
        <Metric label="Browser" value={result?.environment.browser || "chromium"} tone="text-zinc-300" />
        <Metric label="Confidence" value={confidence} tone="text-zinc-300" />
      </div>

      <div className="qa-tabbar">
        <TabButton active={tab === "summary"} icon={<FileText size={11} />} label="Summary" onClick={() => setTab("summary")} />
        <TabButton active={tab === "product"} icon={<ShieldAlert size={11} />} label="Product Issues" onClick={() => setTab("product")} />
        <TabButton active={tab === "agent"} icon={<AlertCircle size={11} />} label="Agent Issues" onClick={() => setTab("agent")} />
        <TabButton active={tab === "assertions"} icon={<CheckCircle2 size={11} />} label="Assertions" onClick={() => setTab("assertions")} />
        <TabButton active={tab === "steps"} icon={<ListChecks size={11} />} label="Steps" onClick={() => setTab("steps")} />
        <TabButton active={tab === "screenshots"} icon={<Image size={11} />} label="Shots" onClick={() => setTab("screenshots")} />
        <TabButton active={tab === "console"} icon={<Terminal size={11} />} label="Console" onClick={() => setTab("console")} />
        <TabButton active={tab === "json"} icon={<Braces size={11} />} label="JSON" onClick={() => setTab("json")} />
      </div>

      {tab === "summary" && (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-zinc-300">{report.summary}</p>
          <div className="space-y-1.5">
            {(report.acceptanceCriteria || []).map((criterion) => (
              <div key={criterion.id} className="flex items-start gap-2 rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5">
                <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${statusDot(criterion.status)}`} />
                <div className="min-w-0">
                  <p className="text-[10px] text-zinc-300">{criterion.description}</p>
                  <p className="text-[9px] uppercase tracking-wide text-zinc-600">{criterion.id} / {criterion.status}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-zinc-500">{report.recommendation}</p>
        </div>
      )}

      {tab === "product" && (
        <div className="space-y-2">
          {productIssues.length === 0 ? (
            <p className="text-[11px] text-zinc-500">No verified product issues found.</p>
          ) : (
            productIssues.map((issue) => <IssueCard key={issue.id} issue={issue} />)
          )}
        </div>
      )}

      {tab === "agent" && (
        <div className="space-y-2">
          {agentIssues.length === 0 ? (
            <p className="text-[11px] text-zinc-500">No AgentQA, verifier, test data, or environment issues found.</p>
          ) : (
            agentIssues.map((issue) => <IssueCard key={issue.id} issue={issue} />)
          )}
        </div>
      )}

      {tab === "assertions" && (
        <div className="space-y-1.5">
          {(report.assertions || []).length === 0 ? (
            <p className="text-[11px] text-zinc-500">No assertions were produced.</p>
          ) : (
            (report.assertions || []).map((assertion) => (
              <div key={assertion.id} className="rounded-md border border-white/8 bg-zinc-950/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 break-words text-[10px] text-zinc-200">{assertion.description}</p>
                  <span className={`shrink-0 text-[9px] uppercase tracking-wide ${assertion.status === "PASS" ? "text-green-300" : assertion.status === "FAIL" ? "text-red-300" : "text-amber-300"}`}>{assertion.status}</span>
                </div>
                {assertion.selector ? <p className="mt-1 break-all text-[9px] text-zinc-600">Selector: {assertion.selector}</p> : null}
                <p className="mt-1 break-all text-[9px] text-zinc-500">Expected: {String(assertion.expected ?? "")}</p>
                <p className="break-all text-[9px] text-zinc-500">Actual: {String(assertion.actual ?? "")}</p>
                {assertion.evidence?.length ? <p className="break-all text-[9px] text-zinc-600">Evidence: {assertion.evidence.join("; ")}</p> : null}
              </div>
            ))
          )}
        </div>
      )}

      {tab === "steps" && (
        <div className="space-y-1">
          {report.reproducibleSteps?.map((step, index) => (
            <p key={`${index}-${step}`} className="text-[10px] leading-relaxed text-zinc-300">{index + 1}. {step}</p>
          ))}
          <div className="border-t border-white/5 pt-2">
            {task.steps.map((step) => <StepRow key={step.id} step={step} />)}
          </div>
        </div>
      )}

      {tab === "screenshots" && (
        <div className="space-y-2">
          {screenshotPaths.length === 0 ? (
            <p className="text-[11px] text-zinc-500">No screenshots captured.</p>
          ) : (
            screenshotPaths.slice(0, 8).map((artifactPath) => (
              <div key={artifactPath} className="rounded-md border border-white/8 bg-black/30 p-1.5">
                {screenshots[artifactPath] ? (
                  <img className="max-h-48 w-full rounded object-contain" src={screenshots[artifactPath]} alt={artifactPath} />
                ) : (
                  <div className="grid h-24 place-items-center text-[10px] text-zinc-600">Loading screenshot</div>
                )}
                <p className="mt-1 break-all text-[9px] text-zinc-500">{artifactPath}</p>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "console" && (
        <div className="space-y-2">
          <Metric label="Console Errors" value={result?.stats.console_errors || 0} tone="text-zinc-300" />
          <Metric label="Network Errors" value={result?.stats.network_errors || 0} tone="text-zinc-300" />
          <Metric label="Critical Network" value={result?.stats.critical_network_errors || 0} tone="text-zinc-300" />
          {(result?.network_errors || []).slice(0, 8).map((entry, index) => (
            <pre key={index} className="whitespace-pre-wrap rounded-md border border-white/8 bg-black/30 p-2 text-[9px] text-zinc-400">{JSON.stringify(entry, null, 2)}</pre>
          ))}
          <p className="break-all text-[10px] text-zinc-500">{report.artifacts?.console_log || "console.log"} / {report.artifacts?.network_log || "network.json"}</p>
        </div>
      )}

      {tab === "json" && (
        <pre className="max-h-72 overflow-auto rounded-md border border-white/8 bg-black/40 p-2 text-[9px] leading-relaxed text-zinc-300">
          {JSON.stringify(result || report, null, 2)}
        </pre>
      )}

      <div className="flex items-center gap-2 border-t border-white/5 pt-2">
        <button className="text-[10px] text-zinc-500 hover:text-zinc-200" onClick={() => window.qaApi?.exportReport(report.taskId, "markdown")}>Export MD</button>
        <button className="text-[10px] text-zinc-500 hover:text-zinc-200" onClick={() => window.qaApi?.exportReport(report.taskId, "json")}>Export JSON</button>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: string }): JSX.Element {
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-1.5">
      <p className={`text-sm font-semibold ${tone}`}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-zinc-600">{label}</p>
    </div>
  );
}

function IssueCard({ issue }: { issue: QaIssue }): JSX.Element {
  return (
    <div className="rounded-md border border-white/8 bg-zinc-950/60 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="min-w-0 break-words text-[11px] font-medium text-zinc-100">{issue.title}</p>
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-500">{issue.severity}</span>
      </div>
      <p className="text-[10px] text-zinc-500">{issue.category || "REPORT"} / {issue.type}</p>
      <p className="mt-1 break-words text-[10px] text-zinc-300">Expected: {issue.expected}</p>
      <p className="break-words text-[10px] text-zinc-400">Actual: {issue.actual}</p>
      {issue.evidence?.screenshots?.length ? (
        <p className="mt-1 break-all text-[9px] text-zinc-600">Evidence: {issue.evidence.screenshots.join(", ")}</p>
      ) : null}
      <p className="mt-1 break-words text-[10px] text-zinc-500">{issue.recommendation}</p>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] transition ${active ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function statusTone(status: QaVerdict): string {
  if (status === "PASS") return "border-green-400/30 bg-green-400/10 text-green-300";
  if (status === "PASS_WITH_WARNINGS") return "border-yellow-400/30 bg-yellow-400/10 text-yellow-300";
  if (status === "FAIL") return "border-red-400/30 bg-red-400/10 text-red-300";
  if (status === "BLOCKED") return "border-amber-400/30 bg-amber-400/10 text-amber-300";
  if (status === "WARNING") return "border-yellow-400/30 bg-yellow-400/10 text-yellow-300";
  return "border-zinc-400/30 bg-zinc-400/10 text-zinc-300";
}

function statusDot(status: QaVerdict): string {
  if (status === "PASS") return "bg-green-400";
  if (status === "FAIL") return "bg-red-400";
  if (status === "BLOCKED") return "bg-amber-400";
  if (status === "WARNING") return "bg-yellow-400";
  return "bg-zinc-500";
}

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
  const [settings, setSettings] = useState<AppSettings>({ apiProvider: "anthropic", apiKey: "", apiBaseUrl: "", model: "Minimax-M2.7", visionMode: false });
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
          <select className="input w-full" value={settings.apiProvider} onChange={(e) => setSettings((s) => ({ ...s, apiProvider: e.target.value as any }))}>
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

      <div className="space-y-3 pt-4 border-t border-white/10">
        <p className="text-[10px] font-medium text-amber-500 uppercase tracking-wider select-none">Experimental</p>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="settingsEnableCaptcha" checked={settings.enableCaptchaSolver} onChange={(e) => setSettings((s) => ({ ...s, enableCaptchaSolver: e.target.checked }))} className="rounded border-white/10 bg-white/5 accent-amber-500 cursor-pointer" />
          <label htmlFor="settingsEnableCaptcha" className="text-xs text-zinc-400 select-none cursor-pointer hover:text-zinc-300 transition-colors">Enable Captcha Solver (Groq Vision)</label>
        </div>
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">Groq API Key</label>
          <input className="input w-full" type="password" placeholder="gsk_..." value={settings.groqApiKey || ""} onChange={(e) => setSettings((s) => ({ ...s, groqApiKey: e.target.value }))} />
        </div>
        <div className="flex gap-2">
          <button className="secondary-button w-full" onClick={async () => {
            if (!settings.groqApiKey) return;
            setTesting(true);
            setTestResult(null);
            try {
              const res = await window.qaApi.testGroqCaptcha(null, settings.groqApiKey);
              setTestResult({ ok: res.ok, message: res.text });
            } catch (err) {
              setTestResult({ ok: false, message: `Error: ${err}` });
            } finally {
              setTesting(false);
            }
          }} disabled={testing || !settings.groqApiKey}>
            {testing ? <Loader2 size={12} className="animate-spin" /> : null}
            Test Captcha (Groq API)
          </button>
        </div>
      </div>

      <div className="flex gap-2 pt-4">
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
