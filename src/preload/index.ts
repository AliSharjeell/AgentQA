/**
 * Preload script — bridges main process IPC to renderer.
 *
 * ## How It Works
 *
 * - contextBridge exposes qaApi to the renderer.
 * - Renderer calls window.qaApi.* methods only.
 * - All IPC uses ipcRenderer.invoke (request/response) or ipcRenderer.on (events).
 *
 * ## API Design
 *
 * - Browser methods: getBrowserState, navigateTo, refreshBrowser, goBack, goForward, setBrowserMode
 * - Task methods: listTasks, createTask, updateTask, deleteTask, startTask, stopTask, pauseTask, resumeTask
 * - Report methods: getTaskReport, exportReport
 * - Event subscriptions: onAppProgress, onBrowserState, onTaskProgress
 *
 * ## Event Cleanup
 *
 * - Each onXxx() returns a cleanup/unsubscribe function.
 * - Renderer MUST call the cleanup when the component unmounts.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { QaApi } from "../shared/types";

const api: QaApi = {
  // ── App / Settings ──
  getAppStatus: () => ipcRenderer.invoke("app:status"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testApiConnection: (url, method, headers, body) =>
    ipcRenderer.invoke("testApiConnection", url, method, headers, body),

  // ── Browser ──
  getBrowserState: () => ipcRenderer.invoke("browser:state"),
  navigateTo: (input) => ipcRenderer.invoke("browser:navigate", input),
  refreshBrowser: () => ipcRenderer.invoke("browser:refresh"),
  goBack: () => ipcRenderer.invoke("browser:back"),
  goForward: () => ipcRenderer.invoke("browser:forward"),
  setBrowserMode: (mode) => ipcRenderer.invoke("browser:mode", mode),

  // ── QA Tasks ──
  listTasks: () => ipcRenderer.invoke("tasks:list"),
  createTask: (input) => ipcRenderer.invoke("tasks:create", input),
  updateTask: (id, update) => ipcRenderer.invoke("tasks:update", id, update),
  deleteTask: (id) => ipcRenderer.invoke("tasks:delete", id),
  startTask: (taskId) => ipcRenderer.invoke("tasks:start", taskId),
  stopTask: (taskId) => ipcRenderer.invoke("tasks:stop", taskId),
  pauseTask: (taskId) => ipcRenderer.invoke("tasks:pause", taskId),
  resumeTask: (taskId) => ipcRenderer.invoke("tasks:resume", taskId),

  // ── Reports ──
  getTaskReport: (taskId) => ipcRenderer.invoke("reports:get", taskId),
  exportReport: (taskId, format) => ipcRenderer.invoke("reports:export", taskId, format),

  // ── Events ──
  onAppProgress: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, event: unknown) => callback(event as never);
    ipcRenderer.on("app:progress", listener);
    return () => ipcRenderer.removeListener("app:progress", listener);
  },
  onBrowserState: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, state: unknown) => callback(state as never);
    ipcRenderer.on("browser:stateChanged", listener);
    return () => ipcRenderer.removeListener("browser:stateChanged", listener);
  },
  onTaskProgress: (callback) => {
    const listener = (_: Electron.IpcRendererEvent, task: unknown) => callback(task as never);
    ipcRenderer.on("tasks:progress", listener);
    return () => ipcRenderer.removeListener("tasks:progress", listener);
  }
};

contextBridge.exposeInMainWorld("qaApi", api);