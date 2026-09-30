import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LiveStatus } from "./live-status";

const CLAUDE_DIR = "/root/.claude-second";
const OPENCODE_AUTH_FILE = "/root/.local/share/opencode/auth.json";

type ClaudeStatus = LiveStatus["claudeSecond"];
type OpenRouterStatus = LiveStatus["openRouter"];
type VpsStatus = LiveStatus["vps"];

function claudeUnavailable(status: ClaudeStatus["status"], message: string): ClaudeStatus {
  return { status, accountEmail: null, planLabel: null, windows: [], message };
}

function openRouterUnavailable(status: OpenRouterStatus["status"], message: string): OpenRouterStatus {
  return {
    status,
    spentUsdToday: null,
    spentUsdWeek: null,
    spentUsdMonth: null,
    spentUsdTotal: null,
    keyLimitUsd: null,
    keyRemainingUsd: null,
    message,
  };
}

function safeMoney(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function readClaudeAccount() {
  for (const file of [path.join(CLAUDE_DIR, ".claude.json"), `${CLAUDE_DIR}.json`]) {
    try {
      const account = JSON.parse(await fs.readFile(file, "utf8")).oauthAccount;
      if (account) return account;
    } catch {}
  }
  return null;
}

async function readClaudeSecond(): Promise<ClaudeStatus> {
  let credentials: {
    accessToken: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
  try {
    const file = JSON.parse(await fs.readFile(path.join(CLAUDE_DIR, ".credentials.json"), "utf8"));
    credentials = file.claudeAiOauth;
    if (typeof credentials?.accessToken !== "string" || credentials.accessToken.length === 0)
      return claudeUnavailable("not_connected", "Deuxième compte Claude à connecter.");
  } catch {
    return claudeUnavailable("not_connected", "Deuxième compte Claude à connecter.");
  }
  if (credentials.expiresAt && Date.now() >= credentials.expiresAt)
    return claudeUnavailable("expired", "La connexion Claude a expiré.");

  const account = await readClaudeAccount();
  const email = typeof account?.emailAddress === "string" ? account.emailAddress : null;
  const multiplier = Number(credentials.rateLimitTier?.match(/max_(\d+)x/)?.[1]) || null;
  const subscription = credentials.subscriptionType;
  const planLabel = subscription === "max"
    ? `Max (${multiplier ?? "?"}x)`
    : subscription ? subscription[0].toUpperCase() + subscription.slice(1) : null;

  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401)
      return { status: "expired", accountEmail: email, planLabel, windows: [], message: "La connexion Claude a expiré." };
    if (!response.ok)
      return { status: "error", accountEmail: email, planLabel, windows: [], message: `Claude : erreur HTTP ${response.status}.` };
    const data = await response.json() as Record<string, any>;
    const windows: ClaudeStatus["windows"] = [];
    for (const [field, label] of [["five_hour", "Session actuelle"], ["seven_day", "Semaine"]] as const) {
      const item = data[field];
      if (typeof item?.utilization !== "number") continue;
      windows.push({
        label,
        usedPercent: Math.max(0, item.utilization),
        resetsAt: typeof item.resets_at === "string" ? item.resets_at : null,
      });
    }
    for (const limit of Array.isArray(data.limits) ? data.limits : []) {
      const model = limit?.scope?.model?.display_name;
      if (limit?.kind !== "weekly_scoped" || typeof model !== "string" || typeof limit.percent !== "number") continue;
      windows.push({
        label: model,
        usedPercent: Math.max(0, limit.percent),
        resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null,
      });
    }
    return { status: "ok", accountEmail: email, planLabel, windows, message: null };
  } catch {
    return { status: "error", accountEmail: email, planLabel, windows: [], message: "Impossible de lire l’usage Claude." };
  }
}

async function readOpenRouter(): Promise<OpenRouterStatus> {
  let key: string;
  try {
    const auth = JSON.parse(await fs.readFile(OPENCODE_AUTH_FILE, "utf8"));
    key = auth?.openrouter?.key;
    if (typeof key !== "string" || key.length === 0)
      return openRouterUnavailable("not_connected", "Clé OpenRouter à ajouter.");
  } catch {
    return openRouterUnavailable("not_connected", "Clé OpenRouter à ajouter.");
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401)
      return openRouterUnavailable("expired", "La clé OpenRouter n’est plus valide.");
    if (!response.ok)
      return openRouterUnavailable("error", `OpenRouter : erreur HTTP ${response.status}.`);
    const data = (await response.json() as { data?: Record<string, unknown> }).data;
    if (safeMoney(data?.usage) === null)
      return openRouterUnavailable("error", "Réponse OpenRouter incomplète.");
    return {
      status: "ok",
      spentUsdToday: safeMoney(data?.usage_daily),
      spentUsdWeek: safeMoney(data?.usage_weekly),
      spentUsdMonth: safeMoney(data?.usage_monthly),
      spentUsdTotal: safeMoney(data?.usage),
      keyLimitUsd: safeMoney(data?.limit),
      keyRemainingUsd: safeMoney(data?.limit_remaining),
      message: null,
    };
  } catch {
    return openRouterUnavailable("error", "Impossible de lire la consommation OpenRouter.");
  }
}

async function availableMemory(): Promise<number> {
  try {
    const memInfo = await fs.readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(memInfo);
    if (match) return Number(match[1]) * 1024;
  } catch {}
  return os.freemem();
}

async function readVps(): Promise<VpsStatus> {
  try {
    const stat = await fs.statfs("/");
    const diskTotalBytes = stat.blocks * stat.bsize;
    const diskFreeBytes = stat.bavail * stat.bsize;
    const memoryTotalBytes = os.totalmem();
    const memoryAvailableBytes = await availableMemory();
    const first = os.cpus().map((cpu) => cpu.times);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = os.cpus().map((cpu) => cpu.times);
    let idle = 0;
    let total = 0;
    for (let i = 0; i < Math.min(first.length, second.length); i += 1) {
      const a = first[i];
      const b = second[i];
      if (!a || !b) continue;
      idle += b.idle - a.idle;
      total += (b.user + b.nice + b.sys + b.idle + b.irq) -
        (a.user + a.nice + a.sys + a.idle + a.irq);
    }
    return {
      status: "ok",
      diskTotalBytes,
      diskFreeBytes,
      memoryTotalBytes,
      memoryAvailableBytes,
      cpuUsedPercent: total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : null,
      message: null,
    };
  } catch {
    return {
      status: "error",
      diskTotalBytes: null,
      diskFreeBytes: null,
      memoryTotalBytes: null,
      memoryAvailableBytes: null,
      cpuUsedPercent: null,
      message: "Impossible de lire les ressources du VPS.",
    };
  }
}

export async function readLiveStatus(): Promise<LiveStatus> {
  const [claudeSecond, openRouter, vps] = await Promise.all([
    readClaudeSecond(),
    readOpenRouter(),
    readVps(),
  ]);
  return { observedAt: new Date().toISOString(), claudeSecond, openRouter, vps };
}
