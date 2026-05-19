import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import type {
  EmailCampaign,
  EmailCampaignInput,
  EmailPreview,
  EmailSendRecord,
  GmailAccount,
  GmailLimitStatus,
  GmailOAuthConfig,
  LeadRecord
} from "../../shared/types";
import { listLeads } from "./leadsRepo";

export const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";
export const defaultTemplateSubject = "Quick question";
export const defaultTemplateBody = `Hi @name,

I saw @company and thought you might be a good fit for what we're building.

We help businesses find and organize leads faster using AI.

Would you be open to a quick look?

Best,
Ali`;

interface StoredGmailAccount extends GmailAccount {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: string | null;
}

interface OutreachStore {
  nextAccountId: number;
  nextCampaignId: number;
  nextSendId: number;
  oauthConfig: GmailOAuthConfig;
  gmailAccounts: StoredGmailAccount[];
  campaigns: EmailCampaign[];
  sends: EmailSendRecord[];
}

let store: OutreachStore | null = null;

export function getOAuthConfig(): GmailOAuthConfig {
  return { ...getStore().oauthConfig };
}

export function saveOAuthConfig(config: GmailOAuthConfig): GmailOAuthConfig {
  const current = getStore();
  current.oauthConfig = {
    clientId: config.clientId.trim(),
    clientSecret: config.clientSecret.trim()
  };
  saveStore();
  return getOAuthConfig();
}

export function getConnectedGmailAccount(): GmailAccount | null {
  const account = getStore().gmailAccounts[0];
  return account ? publicAccount(account) : null;
}

export function saveConnectedGmailAccount(input: {
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string | null;
}): GmailAccount {
  const current = getStore();
  const now = timestamp();
  const existing = current.gmailAccounts[0];
  const account: StoredGmailAccount = {
    id: existing?.id ?? current.nextAccountId,
    email: input.email,
    accessTokenEncrypted: encrypt(input.accessToken),
    refreshTokenEncrypted: encrypt(input.refreshToken || decrypt(existing?.refreshTokenEncrypted ?? "")),
    tokenExpiresAt: input.tokenExpiresAt,
    dailySafeLimit: existing?.dailySafeLimit ?? 30,
    maxProviderLimit: existing?.maxProviderLimit ?? 500,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (!existing) {
    current.nextAccountId += 1;
  }
  current.gmailAccounts = [account];
  saveStore();
  return publicAccount(account);
}

export function getGmailTokens(accountId: number): {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string | null;
} {
  const account = getStoredAccount(accountId);
  return {
    accessToken: decrypt(account.accessTokenEncrypted),
    refreshToken: decrypt(account.refreshTokenEncrypted),
    tokenExpiresAt: account.tokenExpiresAt
  };
}

export function updateGmailTokens(
  accountId: number,
  input: { accessToken: string; refreshToken?: string; tokenExpiresAt: string | null }
): void {
  const account = getStoredAccount(accountId);
  account.accessTokenEncrypted = encrypt(input.accessToken);
  if (input.refreshToken) {
    account.refreshTokenEncrypted = encrypt(input.refreshToken);
  }
  account.tokenExpiresAt = input.tokenExpiresAt;
  account.updatedAt = timestamp();
  saveStore();
}

export function updateDailySafeLimit(limit: number): GmailAccount {
  const account = getFirstStoredAccount();
  account.dailySafeLimit = Math.max(1, Math.min(100, Math.round(limit)));
  account.maxProviderLimit = 500;
  account.updatedAt = timestamp();
  saveStore();
  return publicAccount(account);
}

export function getLimitStatus(): GmailLimitStatus {
  const account = getStore().gmailAccounts[0];
  if (!account) {
    return {
      connectedEmail: null,
      safeDailyLimit: 30,
      maxProviderLimit: 500,
      sentLast24h: 0,
      remainingToday: 30,
      capReached: false
    };
  }

  const sentLast24h = countSentLast24h(account.id);
  const safeDailyLimit = Math.min(account.dailySafeLimit, 100, account.maxProviderLimit, 500);
  return {
    connectedEmail: account.email,
    safeDailyLimit,
    maxProviderLimit: Math.min(account.maxProviderLimit, 500),
    sentLast24h,
    remainingToday: Math.max(0, safeDailyLimit - sentLast24h),
    capReached: sentLast24h >= safeDailyLimit
  };
}

export function getCampaign(): EmailCampaign | null {
  const campaign = getStore().campaigns[0];
  return campaign ? { ...campaign } : null;
}

export function saveCampaign(input: EmailCampaignInput): EmailCampaign {
  const account = getFirstStoredAccount();
  const current = getStore();
  const now = timestamp();
  const existing = current.campaigns[0];
  const campaign: EmailCampaign = {
    id: existing?.id ?? current.nextCampaignId,
    gmailAccountId: account.id,
    templateSubject: input.templateSubject.trim() || defaultTemplateSubject,
    templateBody: input.templateBody.trim() || defaultTemplateBody,
    status: existing?.status ?? "draft",
    message: "Ready",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  if (!existing) {
    current.nextCampaignId += 1;
  }
  current.campaigns = [campaign];
  saveStore();
  return campaign;
}

export function updateCampaignState(
  id: number,
  status: EmailCampaign["status"],
  message: string
): EmailCampaign {
  const campaign = getMutableCampaign(id);
  campaign.status = status;
  campaign.message = message;
  campaign.updatedAt = timestamp();
  saveStore();
  return { ...campaign };
}

export function previewCampaign(input: EmailCampaignInput): EmailPreview[] {
  return eligibleLeads()
    .slice(0, 3)
    .map((lead) => ({
      leadId: lead.id,
      recipientEmail: lead.email!,
      subject: personalize(input.templateSubject || defaultTemplateSubject, lead),
      body: personalize(input.templateBody || defaultTemplateBody, lead)
    }));
}

export function listEmailSends(): EmailSendRecord[] {
  return [...getStore().sends].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

export function nextPendingLead(campaignId: number): LeadRecord | null {
  const sentOrPendingLeadIds = new Set(
    getStore()
      .sends.filter((send) => send.campaignId === campaignId)
      .map((send) => send.leadId)
  );
  return eligibleLeads().find((lead) => !sentOrPendingLeadIds.has(lead.id)) ?? null;
}

export function createPendingSend(campaign: EmailCampaign, lead: LeadRecord): EmailSendRecord {
  const current = getStore();
  const now = timestamp();
  const send: EmailSendRecord = {
    id: current.nextSendId,
    campaignId: campaign.id,
    leadId: lead.id,
    gmailAccountId: campaign.gmailAccountId,
    recipientEmail: lead.email!,
    personalizedSubject: personalize(campaign.templateSubject, lead),
    personalizedBody: personalize(campaign.templateBody, lead),
    status: "pending",
    gmailMessageId: null,
    error: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now
  };
  current.nextSendId += 1;
  current.sends.push(send);
  saveStore();
  return send;
}

export function markSendSent(id: number, gmailMessageId: string | null): EmailSendRecord {
  const send = getMutableSend(id);
  send.status = "sent";
  send.gmailMessageId = gmailMessageId;
  send.sentAt = timestamp();
  send.updatedAt = timestamp();
  saveStore();
  return { ...send };
}

export function markSendFailed(id: number, error: string): EmailSendRecord {
  const send = getMutableSend(id);
  send.status = "failed";
  send.error = error;
  send.updatedAt = timestamp();
  saveStore();
  return { ...send };
}

export function countSentLast24h(gmailAccountId: number): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getStore().sends.filter((send) => {
    return send.gmailAccountId === gmailAccountId && send.status === "sent" && send.sentAt && Date.parse(send.sentAt) >= cutoff;
  }).length;
}

export function personalize(template: string, lead: LeadRecord): string {
  return template
    .replaceAll("@name", lead.name || lead.businessName)
    .replaceAll("@company", lead.company || lead.businessName)
    .replaceAll("@email", lead.email ?? "");
}

function eligibleLeads(): LeadRecord[] {
  return listLeads().filter((lead) => Boolean(lead.email?.trim()) && lead.status !== "ignored");
}

function getFirstStoredAccount(): StoredGmailAccount {
  const account = getStore().gmailAccounts[0];
  if (!account) {
    throw new Error("Connect Gmail before creating a campaign.");
  }
  return account;
}

function getStoredAccount(id: number): StoredGmailAccount {
  const account = getStore().gmailAccounts.find((item) => item.id === id);
  if (!account) {
    throw new Error(`Gmail account ${id} was not found.`);
  }
  return account;
}

function getMutableCampaign(id: number): EmailCampaign {
  const campaign = getStore().campaigns.find((item) => item.id === id);
  if (!campaign) {
    throw new Error(`Campaign ${id} was not found.`);
  }
  return campaign;
}

function getMutableSend(id: number): EmailSendRecord {
  const send = getStore().sends.find((item) => item.id === id);
  if (!send) {
    throw new Error(`Email send ${id} was not found.`);
  }
  return send;
}

function publicAccount(account: StoredGmailAccount): GmailAccount {
  return {
    id: account.id,
    email: account.email,
    dailySafeLimit: account.dailySafeLimit,
    maxProviderLimit: account.maxProviderLimit,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function getStore(): OutreachStore {
  if (store) {
    return store;
  }

  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    store = emptyStore();
    saveStore();
    return store;
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<OutreachStore>;
  store = {
    nextAccountId: parsed.nextAccountId ?? 1,
    nextCampaignId: parsed.nextCampaignId ?? 1,
    nextSendId: parsed.nextSendId ?? 1,
    oauthConfig: parsed.oauthConfig ?? { clientId: "", clientSecret: "" },
    gmailAccounts: parsed.gmailAccounts ?? [],
    campaigns: parsed.campaigns ?? [],
    sends: parsed.sends ?? []
  };
  return store;
}

function saveStore(): void {
  if (!store) {
    return;
  }
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
  fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), "utf8");
}

function emptyStore(): OutreachStore {
  return {
    nextAccountId: 1,
    nextCampaignId: 1,
    nextSendId: 1,
    oauthConfig: { clientId: "", clientSecret: "" },
    gmailAccounts: [],
    campaigns: [],
    sends: []
  };
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), "outreach-store.json");
}

function encrypt(value: string): string {
  if (!value) {
    return "";
  }
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `b64:${Buffer.from(value, "utf8").toString("base64")}`;
}

function decrypt(value: string): string {
  if (!value) {
    return "";
  }
  if (value.startsWith("safe:") && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
  }
  if (value.startsWith("b64:")) {
    return Buffer.from(value.slice(4), "base64").toString("utf8");
  }
  return "";
}

export function createOauthState(): string {
  return crypto.randomBytes(18).toString("hex");
}

function timestamp(): string {
  return new Date().toISOString();
}
