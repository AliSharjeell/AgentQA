# AGENTS.md — AI Agent Guide to This Project

This document explains the project structure, conventions, and patterns for AI agents working on this codebase. It is intended for use with Claude Code and similar AI coding assistants.

---

## Project Overview

This is a **desktop application boilerplate** built with Electron + React + TypeScript + Tailwind CSS + Playwright. It is designed to be cloned and customized for any use case.

The current state includes stub implementations for Google Maps lead scraping, email enrichment, Gmail OAuth, and AI deep research — all of which should be replaced with your own domain logic.

---

## Repository Structure

```
src/
├── main/                   # Electron main process (Node.js / CommonJS target)
│   ├── index.ts           # Main entry: window creation, menu, IPC registration
│   ├── db/                # JSON data stores (app.getPath("userData"))
│   │   ├── leadsRepo.ts   # Search + lead CRUD, CSV export
│   │   └── outreachRepo.ts # Gmail OAuth tokens + campaign records
│   └── playwright/        # Browser automation utilities
│       ├── profiles.ts    # Chrome profile detection + management
│       └── login.ts       # Open browser to URL for manual OAuth login
├── preload/                # Context bridge (exposes mapsLeads API to renderer)
│   └── index.ts
├── renderer/              # React frontend
│   ├── index.html
│   └── src/
│       ├── main.tsx       # ReactDOM.createRoot entry point
│       ├── App.tsx        # Root shell: sidebar nav + page router
│       ├── styles.css    # Tailwind layers + CSS class components
│       └── pages/        # Page components (add your own here)
└── shared/                 # Types shared between main + renderer
    └── types.ts           # MapsLeadsApi interface + domain types
```

### Key Configuration Files

| File | Purpose |
|---|---|
| `package.json` | Name, scripts, dependencies |
| `electron.vite.config.ts` | electron-vite build config (main/preload/renderer entry points) |
| `tsconfig.json` | TypeScript config — ES2022 target, Bundler module resolution |
| `tailwind.config.ts` | Tailwind content paths + Poppins font |
| `postcss.config.cjs` | PostCSS with tailwindcss + autoprefixer |

---

## How the IPC Bridge Works

The renderer (React) never calls Electron APIs directly. All communication goes through a single contextBridge API (`window.mapsLeads`).

```
React (renderer) ──window.mapsLeads.method()──► preload ──ipcRenderer.invoke──► main ──ipcMain.handle──► Business logic
```

**Adding a new API method takes 3 files:**

1. **src/shared/types.ts** — add method to `MapsLeadsApi` interface
2. **src/preload/index.ts** — add `ipcRenderer.invoke()` call
3. **src/main/index.ts** — add `ipcMain.handle()` with handler function, then register in `registerIpc()`

The renderer calls it as `await window.mapsLeads.myMethod(args)`.

**For event streams (one-way push from main → renderer):**

1. Main uses `BrowserWindow.webContents.send("channel", data)`
2. Renderer uses `window.mapsLeads.onMyEvent((data) => { ... })` — returns unsubscribe function
3. MUST call unsubscribe on component unmount to prevent memory leaks

---

## Data Storage

Data is persisted as JSON files in `app.getPath("userData")` (typically `%APPDATA%/electron-react-boilerplate/`):

| File | Schema |
|---|---|
| `lead-boilerplate-store.json` | `{ nextSearchId, nextLeadId, searches[], leads[] }` |
| `outreach-store.json` | `{ nextAccountId, nextCampaignId, nextSendId, oauthConfig, gmailAccounts[], campaigns[], sends[] }` |

Both use **debounced writes** (300ms) to avoid excessive disk I/O.

---

## Naming Conventions

| Convention | Example |
|---|---|
| TypeScript interfaces | `PascalCase` — `LeadRecord`, `MapsLeadsApi` |
| Type aliases | `PascalCase` — `LeadStatus`, `ApiProvider` |
| IPC channel names | `colon-separated` — `searches:list`, `campaign:start` |
| Event channel names | `past-tense noun` — `leads:progress`, `campaign:progress` |
| React components | `PascalCase` — `DashboardPage`, `SettingsPage` |
| CSS utility classes | `kebab-case` — `space-y-5`, `text-zinc-100` |
| File names | `kebab-case` — `leads-repo.ts`, `campaign-store.ts` |

---

## TypeScript Configuration

- Target: **ES2022**
- Module: **ESNext**
- Module resolution: **Bundler** (required by electron-vite)
- Strict mode: **enabled**
- JSX: **react-jsx**
- No `esModuleInterop` quirks — use default imports

---

## React Patterns

### Component Structure

```tsx
export default function MyPage(): JSX.Element {
  const [state, setState] = useState(initialValue);

  useEffect(() => {
    // Load data on mount
    window.mapsLeads.someMethod().then(setState);
  }, []);

  return (
    <div className="space-y-5">
      {/* Use surface class for cards */}
      <section className="surface max-w-xl p-5">
        {/* content */}
      </section>
    </div>
  );
}
```

### Event Listener Cleanup

```tsx
useEffect(() => {
  const unsubscribe = window.mapsLeads.onLeadProgress((event) => {
    setStatus(event.status);
    // handle event
  });
  return unsubscribe; // MUST return cleanup
}, []);
```

### Conditional Rendering for Pages

```tsx
{page === "myPage" && <MyPage />}
```

---

## Tailwind CSS / Design System

The `styles.css` defines CSS class components used throughout the app:

| Class | Tailwind equivalent | Use for |
|---|---|---|
| `.input` | Tailwind utilities | Text inputs, selects |
| `.primary-button` | Tailwind utilities | White-filled CTA buttons |
| `.secondary-button` | Tailwind utilities | Dark transparent buttons |
| `.danger-button` | Tailwind utilities | Red destructive actions |
| `.surface` | Tailwind utilities | Card containers |
| `.lead-table` | Tailwind utilities | Data tables with hover |
| `.window-drag` | `-webkit-app-region: drag` | Title bar drag zone |
| `.window-no-drag` | `-webkit-app-region: no-drag` | Clickable elements in drag zone |

**Always use these pre-defined classes** instead of duplicating Tailwind utilities. New button/input styles should be added to `styles.css` as shared class components.

### Color System

- Use `zinc` palette exclusively for dark theme consistency
- Text: `text-zinc-100` (body), `text-zinc-400` (secondary), `text-zinc-500` (labels), `text-white` (headings)
- Backgrounds: `bg-zinc-950`, `bg-zinc-900`, `bg-zinc-800`
- Borders: `border-white/10` (subtle), `border-white/20` (emphasized)

---

## Adding New Features

### Step-by-Step: Adding a New Feature

1. **Define types** in `src/shared/types.ts`
2. **Add repository functions** in `src/main/db/` (if data operations needed)
3. **Register IPC handlers** in `src/main/index.ts`
4. **Expose via preload** in `src/preload/index.ts`
5. **Create React component** in `src/renderer/src/pages/`
6. **Add to navigation** in `src/renderer/src/App.tsx`
7. **Add to .gitignore** if generating temporary files

### Modifying Existing Features

When modifying:
- **IPC handlers**: Check both main and preload for consistency
- **Types**: Check all files importing the type for breakages
- **React state**: Check cleanup functions in `useEffect` hooks
- **CSS classes**: Prefer existing `.surface`, `.input`, `.primary-button` patterns

---

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org):

```
feat:    New feature
fix:     Bug fix
refactor: Code change that neither fixes a bug nor adds a feature
style:   Formatting, whitespace (no code change)
docs:    Documentation changes
test:    Adding or updating tests
chore:   Maintenance, dependency updates
```

Examples:
- `feat: add search history page`
- `fix: prevent duplicate leads in CSV export`
- `refactor: extract campaign runner into separate module`
- `docs: add AGENTS.md for AI agent guidance`
- `chore: upgrade electron to v34`

---

## What to Remove for New Projects

When cloning for a new app, remove or replace:

- [ ] `src/main/playwright/` — replace with your automation logic
- [ ] `src/main/db/outreachRepo.ts` — replace with your data store
- [ ] `src/main/db/leadsRepo.ts` — replace with your data model
- [ ] `src/renderer/src/pages/` — replace with your pages
- [ ] `src/shared/types.ts` — replace domain types with yours
- [ ] `package.json` name + description
- [ ] Window title in `src/main/index.ts`
- [ ] App title in `src/renderer/src/App.tsx`
- [ ] Browser tab title in `src/renderer/index.html`

---

## Troubleshooting

### TypeScript errors after adding a new method
Ensure:
1. Method is in `MapsLeadsApi` (shared/types.ts)
2. Method is in preload (ipcRenderer.invoke call)
3. Handler is in main (ipcMain.handle)
4. All three have matching parameter types

### Renderer shows "no-op" or empty data
The data store files may not exist yet. First run initializes empty stores. Check the `userData` directory for JSON files.

### Build fails with module resolution errors
Make sure `tsconfig.json` has `"moduleResolution": "Bundler"`. Node resolution mode won't work with electron-vite.

---

## Key Files for Reference

| File | Lines | Purpose |
|---|---|---|
| `src/main/index.ts` | ~150 | Main process entry, IPC registration pattern |
| `src/preload/index.ts` | ~80 | IPC bridge API surface |
| `src/shared/types.ts` | ~200 | MapsLeadsApi + domain type definitions |
| `src/renderer/src/App.tsx` | ~180 | Root shell with navigation |
| `src/renderer/src/styles.css` | ~200 | Design system CSS classes |
| `src/main/db/leadsRepo.ts` | ~180 | Data repository pattern |