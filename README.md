# Electron + React Desktop App Boilerplate

A production-ready starting point for cross-platform desktop applications. Built with **Electron + React + TypeScript + Tailwind CSS + Playwright** — ready to be customized for any use case.

---

## Features

- **Electron v34** with hidden title bar, Windows Mica material, transparent background
- **React 18** with TypeScript
- **Tailwind CSS v3** with a custom dark design system (Poppins font, zinc palette)
- **electron-vite** for fast HMR in dev and optimized builds
- **Playwright** browser automation utilities (Chrome profile management, login flows)
- **JSON data persistence** in `app.getPath("userData")`
- **IPC bridge** via `contextBridge` — renderer never calls Electron APIs directly
- **Stub implementations** for lead management, Gmail OAuth, and AI integrations — replace with your own logic

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Electron 34 |
| Build tool | electron-vite 3 |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS 3 |
| Icons | Lucide React |
| Browser automation | Playwright |
| AI SDK | Anthropic + OpenAI |
| Language | TypeScript 5 |

---

## Project Structure

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts            # Entry point — window, menu, IPC registration
│   ├── db/                 # JSON data stores
│   │   ├── leadsRepo.ts   # Lead/search CRUD + CSV export
│   │   └── outreachRepo.ts # Campaign + Gmail OAuth (token storage)
│   └── playwright/         # Browser automation utilities
│       ├── profiles.ts    # Chrome profile discovery + management
│       └── login.ts       # Open browser to URL for manual auth
├── preload/                 # Context bridge
│   └── index.ts           # window.mapsLeads API surface
├── renderer/               # React frontend
│   ├── index.html
│   └── src/
│       ├── main.tsx      # ReactDOM.createRoot entry
│       ├── App.tsx        # Root component — sidebar + page router
│       ├── styles.css     # Tailwind layers + .input/.button CSS classes
│       └── pages/         # Page components (add your own here)
└── shared/                 # Types shared between main + renderer
    └── types.ts           # MapsLeadsApi interface + domain types
```

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- **npm 10+**
- **Git**

### Clone & Install

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/electron-react-boilerplate.git
cd electron-react-boilerplate

# Install dependencies
npm install
```

### Run in Development

```bash
npm run dev
```

This opens an Electron window with hot module replacement. The main process restarts on file changes too.

### Build for Production

```bash
npm run build
```

Build output goes to `out/`. The packaged app is in `dist/`.

### Type Check

```bash
npm run typecheck
```

---

## Customizing for Your App

### 1. Rename the App

**package.json:**
```json
{
  "name": "your-app-name",
  "description": "Your app description"
}
```

**src/main/index.ts** — window title:
```ts
title: "Your App Name"
```

**src/renderer/index.html** — browser tab title:
```html
<title>Your App Name</title>
```

**src/renderer/src/App.tsx** — sidebar title:
```tsx
<h1 className="text-xl text-white">Your App Name</h1>
```

---

### 2. Add a New Page

**Step 1 — Create the page component** in `src/renderer/src/pages/`:

```tsx
// src/renderer/src/pages/MyPage.tsx
export default function MyPage(): JSX.Element {
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Section</p>
        <h1 className="mt-1 text-2xl text-white">My Page</h1>
      </header>
    </div>
  );
}
```

**Step 2 — Add to App.tsx navigation:**

```tsx
// Add to the Page type union
type Page = "dashboard" | "settings" | "myPage";

// Add nav button
<NavButton active={page === "myPage"} onClick={() => setPage("myPage")} icon={<MyIcon size={17} />}>
  My Page
</NavButton>

// Add route
{page === "myPage" && <MyPage />}
```

---

### 3. Add New IPC Handlers

The IPC pattern has 3 steps:

**Step 1 — src/shared/types.ts** — define the method signature:

```ts
// In MapsLeadsApi interface
myNewMethod: (param: string) => Promise<string>;
```

**Step 2 — src/preload/index.ts** — wire it through contextBridge:

```ts
myNewMethod: (param) => ipcRenderer.invoke("my:newMethod", param),
```

**Step 3 — src/main/index.ts** — implement the handler:

```ts
// In registerIpc():
ipcMain.handle("my:newMethod", async (_, param) => {
  return `Result: ${param}`;
});
```

**Step 4 — Call from React:**

```tsx
const result = await window.mapsLeads.myNewMethod("hello");
```

---

### 4. Add New Data Fields

**src/shared/types.ts** — extend `LeadRecord`:

```ts
export interface LeadRecord {
  id: number;
  // ... existing fields ...
  // ── Your custom fields ──
  myField: string | null;
  anotherField: number;
}
```

**src/main/db/leadsRepo.ts** — update repository functions to handle the new fields.

---

### 5. Style with Tailwind + Design System

The `styles.css` includes a base design system:

| Class | Purpose |
|---|---|
| `.input` | Text input styling |
| `.primary-button` | White-filled CTA button |
| `.secondary-button` | Dark transparent button |
| `.danger-button` | Red destructive button |
| `.surface` | Card with border + background |
| `.lead-table` | Table with sticky header, hover, selection |
| `.window-drag` | Makes element draggable for title bar |
| `.window-no-drag` | Prevents children from dragging |

Use the zinc color palette (`text-zinc-100`, `bg-zinc-900`, etc.) for consistency.

---

### 6. Browser Automation

The `src/main/playwright/` directory provides Chrome profile utilities:

```ts
import { getDefaultProfile, listChromeProfiles, openBrowserLogin } from "./playwright/profiles";

// Get available Chrome profiles
const profiles = listChromeProfiles();

// Open browser for manual login
await openBrowserLogin(profile.profilePath, profile.profileDirectory);
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React)                                            │
│  - window.mapsLeads.* — IPC calls                            │
│  - Never calls Electron APIs directly                        │
│  - No nodeIntegration, no sandbox bypass                     │
└──────────────────────┬──────────────────────────────────────┘
                       │ contextBridge (preload/index.ts)
┌──────────────────────▼──────────────────────────────────────┐
│  Main Process (Node.js / Electron)                            │
│  - app.getPath("userData") for data storage                  │
│  - ipcMain.handle() for request/response IPC                │
│  - webContents.send() for push events to renderer            │
│  - Owns: file system, native dialogs, browser automation     │
└─────────────────────────────────────────────────────────────┘
```

### Data Storage

Data is stored as JSON files in `app.getPath("userData")`:

| File | Purpose |
|---|---|
| `lead-boilerplate-store.json` | Search + lead data |
| `outreach-store.json` | Gmail OAuth + campaign data |

Both use debounced writes (300ms delay) to avoid excessive disk I/O.

### IPC Channels

| Channel | Direction | Purpose |
|---|---|---|
| `searches:list` | invoke | Get all searches |
| `leads:list` | invoke | Get all leads |
| `search:start` | invoke | Start a scraper run |
| `leads:exportCsv` | invoke | Export to CSV |
| `openExternal` | invoke | Open URL in system browser |
| `app:profiles` | invoke | List available Chrome profiles |
| `gmail:connect` | invoke | Start Gmail OAuth flow |
| `leads:progress` | send (main→renderer) | Real-time scraper updates |
| `campaign:progress` | send (main→renderer) | Real-time campaign updates |

---

## Design System

### Color Palette

Uses `zinc` palette (neutral gray) for a cohesive dark theme.

- Background: `#101114` (main area), transparent (sidebar)
- Text: `#d4d4d8` (body), `#ffffff` (headings)
- Borders: `border-white/10` (subtle), `border-white/20` (active)

### Typography

- **Font:** Poppins (Google Fonts) — set in `styles.css`
- Fallback: `ui-sans-serif, system-ui, sans-serif`
- Scale: `text-xs` (labels), `text-sm` (body), `text-lg` (subheadings), `text-2xl` (headings)

### Spacing

Use Tailwind spacing (`space-y-5`, `p-5`, `gap-3`, etc.). Standard card padding is `p-5`.

---

## Available Scripts

```bash
npm run dev        # Start dev server with HMR
npm run build      # Production build
npm run typecheck  # TypeScript type checking
npm run start      # Preview production build locally
```

---

## Troubleshooting

### "Cannot find module" after cloning

Run `npm install` — dependencies are not committed to the repo.

### Electron window shows nothing

Make sure `npm run dev` opened the Electron window (not just the browser). The Electron window has a custom title bar with a drag zone.

### TypeScript errors in shared/types.ts

The boilerplate uses domain stub types. Replace them with your actual domain types — TypeScript will enforce consistency across main/preload/renderer.

### Playwright browser doesn't launch

Make sure Google Chrome is installed. Playwright uses `chromium.launchPersistentContext` with the `chrome` channel. On Windows, ensure Chrome is in your PATH or in the default installation location.

---

## License

MIT — use this boilerplate to build any desktop application.