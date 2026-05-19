/**
 * Lead data repository for the Electron desktop app boilerplate.
 *
 * ## Data Storage
 *
 * JSON file at app.getPath("userData") / {appName}-store.json
 * Contains searches and leads arrays with auto-save (debounced 300ms).
 *
 * ## Extending for Your App
 *
 * - Replace LeadRecord fields with your domain model
 * - Add new repository functions for your data operations
 * - Update exportCsv() for your export format
 *
 * ## Type Conventions
 *
 * - LeadRecord: The main data entity (one row per lead)
 * - LeadSearch: A named search configuration with settings
 * - LeadInput: Raw fields when creating/updating a lead
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { app } from "electron";
import type {
  LeadContactUpdate,
  LeadRecord,
  LeadSearch,
  LeadSearchInput,
  LeadStatus
} from "../../shared/types";

// ─── Store Interface ────────────────────────────────────────────────────────

interface LeadStore {
  nextSearchId: number;
  nextLeadId: number;
  searches: LeadSearch[];
  leads: LeadRecord[];
}

let store: LeadStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

export function listSearches(): LeadSearch[] {
  return [...getStore().searches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
}

export function createSearch(input: LeadSearchInput): LeadSearch {
  const current = getStore();
  const now = timestamp();
  const search: LeadSearch = {
    id: current.nextSearchId,
    niche: input.niche.trim(),
    location: input.location.trim(),
    limit: Math.max(1, Math.min(1000, Math.round(input.limit ?? 500))),
    status: "idle",
    message: "Ready",
    createdAt: now,
    updatedAt: now
  };
  current.nextSearchId += 1;
  current.searches.push(search);
  saveStore();
  return search;
}

export function updateSearch(id: number, input: LeadSearchInput): LeadSearch {
  const search = getMutableSearch(id);
  search.niche = input.niche.trim();
  search.location = input.location.trim();
  search.limit = Math.max(1, Math.min(1000, Math.round(input.limit ?? search.limit)));
  search.updatedAt = timestamp();
  saveStore();
  return { ...search };
}

export function updateSearchState(
  id: number,
  status: LeadSearch["status"],
  message: string
): LeadSearch {
  const search = getMutableSearch(id);
  search.status = status;
  search.message = message;
  search.updatedAt = timestamp();
  saveStore();
  return { ...search };
}

export function getSearchById(id: number): LeadSearch {
  return { ...getMutableSearch(id) };
}

export function listLeads(): LeadRecord[] {
  return [...getStore().leads]
    .filter((l) => l.status !== "ignored")
    .sort((a, b) => b.foundAt.localeCompare(a.foundAt) || b.id - a.id);
}

export function upsertLead(input: Partial<LeadRecord> & { mapsUrl: string; searchId: number; company: string }): { lead: LeadRecord; isNew: boolean } {
  const current = getStore();
  const leadHash = createLeadHash(input);
  const existing = current.leads.find((lead) => lead.leadHash === leadHash);
  if (existing) {
    applyBaseLeadInput(existing, input);
    existing.updatedAt = timestamp();
    saveStore();
    return { lead: { ...existing }, isNew: false };
  }

  const now = timestamp();
  const lead: LeadRecord = {
    id: current.nextLeadId,
    leadHash,
    searchId: input.searchId,
    name: clean(input.name) ?? input.company,
    company: input.company,
    email: cleanEmail(input.email),
    phone: clean(input.phone),
    website: clean(input.website),
    address: clean(input.address),
    mapsUrl: input.mapsUrl,
    status: "new",
    foundAt: now,
    updatedAt: now
  };
  current.nextLeadId += 1;
  current.leads.push(lead);
  saveStore();
  return { lead, isNew: true };
}

export function updateLeadStatus(id: number, status: LeadStatus): LeadRecord {
  const lead = getMutableLead(id);
  lead.status = status;
  lead.updatedAt = timestamp();
  saveStore();
  return { ...lead };
}

export function updateLeadContact(id: number, input: LeadContactUpdate): LeadRecord {
  const lead = getMutableLead(id);
  if (input.company !== undefined) lead.company = input.company;
  if (input.email !== undefined) lead.email = cleanEmail(input.email);
  if (input.name !== undefined) lead.name = input.name ?? "";
  if (input.phone !== undefined) lead.phone = input.phone ?? null;
  if (input.notes !== undefined) lead.notes = input.notes ?? null;
  lead.updatedAt = timestamp();
  saveStore();
  return { ...lead };
}

export function exportLeadsCsv(filePath: string, _mode: "locations" | "companies" = "locations"): void {
  const leads = listLeads();
  const headers = ["company", "phone", "website", "address", "maps_url", "email", "status"];
  const lines: string[] = [headers.join(",")];
  for (const lead of leads) {
    lines.push(
      [lead.company, lead.phone, lead.website, lead.address, lead.mapsUrl, lead.email, lead.status]
        .map((v) => csvValue(String(v ?? "")))
        .join(",")
    );
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

export function deleteSearch(id: number): void {
  const current = getStore();
  current.searches = current.searches.filter((item) => item.id !== id);
  current.leads = current.leads.filter((lead) => lead.searchId !== id);
  saveStore();
}

// ─── Gmail / OAuth (delegated to outreachRepo) ──────────────────────────

export { getOAuthConfig, saveOAuthConfig, getConnectedGmailAccount, getLimitStatus, listEmailSends, previewCampaign, saveCampaign, updateDailySafeLimit, getCampaign } from "./outreachRepo";

// ─── Internal ──────────────────────────────────────────────────────────────

function getStore(): LeadStore {
  if (store) return store;

  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    store = emptyStore();
    saveStore();
    return store;
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<LeadStore>;
  store = {
    nextSearchId: parsed.nextSearchId ?? 1,
    nextLeadId: parsed.nextLeadId ?? 1,
    searches: parsed.searches ?? [],
    leads: parsed.leads ?? []
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

function emptyStore(): LeadStore {
  return { nextSearchId: 1, nextLeadId: 1, searches: [], leads: [] };
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), "lead-boilerplate-store.json");
}

function timestamp(): string {
  return new Date().toISOString();
}

function getMutableSearch(id: number): LeadSearch {
  const search = getStore().searches.find((item) => item.id === id);
  if (!search) throw new Error(`Search ${id} was not found.`);
  return search;
}

function getMutableLead(id: number): LeadRecord {
  const lead = getStore().leads.find((item) => item.id === id);
  if (!lead) throw new Error(`Lead ${id} was not found.`);
  return lead;
}

function createLeadHash(input: { company: string; phone?: string | null; address?: string | null; mapsUrl: string }): string {
  const company = (input.company || "").trim().toLowerCase();
  if (input.mapsUrl) {
    try {
      const url = new URL(input.mapsUrl);
      url.hash = "";
      return crypto.createHash("sha256").update(`${company}|${url.toString().toLowerCase()}`).digest("hex");
    } catch {
      return crypto.createHash("sha256").update(`${company}|${input.mapsUrl}`).digest("hex");
    }
  }
  if (input.phone) {
    const phone = input.phone.replace(/[^\d]/g, "");
    return crypto.createHash("sha256").update(`${company}|${phone}`).digest("hex");
  }
  if (input.address) {
    const addr = input.address.trim().toLowerCase();
    return crypto.createHash("sha256").update(`${company}|${addr}`).digest("hex");
  }
  return crypto.createHash("sha256").update(`${company}|${Date.now()}`).digest("hex");
}

function applyBaseLeadInput(lead: LeadRecord, input: Partial<LeadRecord>): void {
  if (input.company !== undefined) lead.company = input.company;
  if (input.name !== undefined) lead.name = input.name ?? "";
  if (input.phone !== undefined) lead.phone = input.phone ?? null;
  if (input.website !== undefined) lead.website = input.website ?? null;
  if (input.address !== undefined) lead.address = input.address ?? null;
  if (input.mapsUrl !== undefined) lead.mapsUrl = input.mapsUrl;
  if (input.email !== undefined) lead.email = cleanEmail(input.email);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || ["test@test.com", "example@email.com"].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function csvValue(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}