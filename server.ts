import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { isValidTimeZone, makeWindow } from "./lib/format";
import { USAGE_DATA_DIR } from "./lib/plugin-data";
import {
  applyEnvironmentThreads,
  applyProjectCatalog,
  catalogFromBbProjects,
  environmentIdFromProjectRow,
  finalizeProjectRows,
} from "./lib/projects";
import { mergedUsageSchema } from "./lib/rpc-schema";
import { UsageScanner } from "./lib/scan";
import type { MergedUsage, ProjectTotals } from "./lib/types";

const USAGE_COMMAND = "bb usage show [--days 7|30|90] [--force]";
const execFileAsync = promisify(execFile);
const PULL_REQUEST_CACHE_MS = 10 * 60 * 1_000;

const pullRequestActivitySchema = z.object({
  login: z.string().min(1),
  days: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      count: z.number().int().nonnegative(),
    }),
  ),
  total: z.number().int().nonnegative(),
  incomplete: z.boolean(),
});

type PullRequestActivity = z.infer<typeof pullRequestActivitySchema>;

const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    { message: "Invalid calendar date" },
  );

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z
      .object({
        timeZone: z
          .string()
          .min(1)
          .refine((value) => isValidTimeZone(value), {
            message: "Invalid IANA time zone",
          }),
        sinceDay: daySchema,
        untilDay: daySchema,
        force: z.boolean().optional(),
      })
      .strict()
      .refine((value) => value.sinceDay <= value.untilDay, {
        message: "sinceDay must be on or before untilDay",
        path: ["sinceDay"],
      }),
    output: mergedUsageSchema,
  },
  getPullRequestActivity: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: pullRequestActivitySchema,
  },
});

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function endOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

async function runGitHubCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * GitHub search caps one query at 1,000 items. Querying one month at a time
 * keeps a very active year accurate instead of returning a quiet-looking graph
 * with activity omitted after the first thousand pull requests.
 */
async function readPullRequestActivity(now = new Date()): Promise<PullRequestActivity> {
  const login = (await runGitHubCli(["api", "user", "--jq", ".login"])).trim();
  if (!login) throw new Error("GitHub is not signed in on this BB host.");

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const firstDay = addUtcDays(today, -364);
  const counts = new Map<string, number>();
  for (let day = firstDay; day <= today; day = addUtcDays(day, 1)) {
    counts.set(utcDay(day), 0);
  }

  let total = 0;
  let incomplete = false;
  for (let monthStart = firstDay; monthStart <= today; ) {
    const monthEnd = new Date(Math.min(endOfUtcMonth(monthStart).getTime(), today.getTime()));
    const query = `is:pr author:${login} created:${utcDay(monthStart)}..${utcDay(monthEnd)}`;
    const endpoint = `/search/issues?q=${encodeURIComponent(query)}&per_page=100&sort=created&order=asc`;
    const raw = await runGitHubCli([
      "api",
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
      endpoint,
    ]);
    const pages = z
      .array(
        z.object({
          total_count: z.number().int().nonnegative(),
          incomplete_results: z.boolean(),
          items: z.array(z.object({ created_at: z.string().datetime() })),
        }),
      )
      .parse(JSON.parse(raw));
    const resultCount = pages[0]?.total_count ?? 0;
    total += Math.min(resultCount, 1_000);
    incomplete ||= resultCount > 1_000 || pages.some((page) => page.incomplete_results);
    for (const page of pages) {
      for (const pullRequest of page.items) {
        const day = pullRequest.created_at.slice(0, 10);
        if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
      }
    }
    monthStart = addUtcDays(monthEnd, 1);
  }

  return {
    login,
    days: [...counts].map(([day, count]) => ({ day, count })),
    total,
    incomplete,
  };
}

type UsageCliOptions =
  | { days: 7 | 30 | 90; force: boolean }
  | { error: string };

function parseCliOptions(argv: readonly string[]): UsageCliOptions {
  if (argv[0] !== "show") {
    return { error: `Expected \"show\". Usage: ${USAGE_COMMAND}` };
  }

  let days: 7 | 30 | 90 = 30;
  let force = false;
  let sawDays = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--days") {
      const value = argv[i + 1];
      if (
        sawDays ||
        value === undefined ||
        !["7", "30", "90"].includes(value)
      ) {
        return {
          error: `--days must be specified once as 7, 30, or 90. Usage: ${USAGE_COMMAND}`,
        };
      }
      days = Number(value) as 7 | 30 | 90;
      sawDays = true;
      i += 1;
    } else if (arg === "--force") {
      if (force) {
        return { error: `--force must not be repeated. Usage: ${USAGE_COMMAND}` };
      }
      force = true;
    } else {
      return { error: `Unknown argument: ${arg}. Usage: ${USAGE_COMMAND}` };
    }
  }

  return { days, force };
}

async function attachEnvironmentThreads(
  bb: BbPluginApi,
  rows: ProjectTotals[],
): Promise<ProjectTotals[]> {
  const envIds = [
    ...new Set(
      rows
        .map((row) => environmentIdFromProjectRow(row))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (envIds.length === 0) return rows;

  const projectIds = new Set<string>();
  await Promise.all(
    envIds.map(async (environmentId) => {
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        projectIds.add(environment.projectId);
      } catch {
        // Destroyed environments stay unlabeled.
      }
    }),
  );
  if (projectIds.size === 0) return applyEnvironmentThreads(rows, new Map());

  const threadsByEnv = new Map<
    string,
    { threadId: string; title: string; attention: number; archived: boolean }
  >();
  await Promise.all(
    [...projectIds].map(async (projectId) => {
      try {
        const listed = await listProjectThreads(bb, projectId);
        for (const thread of listed) {
          if (!thread.environmentId || thread.deletedAt !== null) continue;
          const title = thread.title || thread.titleFallback;
          if (!title) continue;
          const next = {
            threadId: thread.id,
            title,
            attention: thread.latestAttentionAt,
            archived: thread.archivedAt !== null,
          };
          const current = threadsByEnv.get(thread.environmentId);
          if (current && !isPreferredThread(next, current)) continue;
          threadsByEnv.set(thread.environmentId, next);
        }
      } catch {
        // Thread list failures must not blank Model / Day / Project.
      }
    }),
  );

  return applyEnvironmentThreads(rows, threadsByEnv);
}

const THREAD_PAGE_SIZE = 200;
const THREAD_PAGE_CAP = 2000;

async function listProjectThreads(
  bb: BbPluginApi,
  projectId: string,
) {
  const out: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>> = [];
  for (const archived of [false, true] as const) {
    let offset = 0;
    while (offset < THREAD_PAGE_CAP) {
      const page = await bb.sdk.threads.list({
        projectId,
        includeHidden: true,
        ...(archived ? { archived: true } : {}),
        limit: THREAD_PAGE_SIZE,
        offset,
      });
      out.push(...page);
      if (page.length < THREAD_PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return out;
}

function isPreferredThread(
  next: { archived: boolean; attention: number },
  current: { archived: boolean; attention: number },
): boolean {
  if (next.archived !== current.archived) return !next.archived;
  return next.attention > current.attention;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cursorEnabled: {
      type: "boolean",
      label: "Include Cursor usage",
      description:
        "Read Cursor's local auth read-only and include account-level usage from cursor.com. The token is held in memory only.",
      default: false,
    },
    cursorDatabasePath: {
      type: "string",
      label: "Cursor auth database path",
      description:
        "Optional override for Cursor's state.vscdb path. Leave blank to use the platform default.",
      default: "",
    },
  });

  const scanner = new UsageScanner({
    dataDir: USAGE_DATA_DIR,
    log: (message) => bb.log.info(message),
  });
  let pullRequestCache: { value: PullRequestActivity; expiresAt: number } | null = null;

  async function cursorOptions() {
    const values = await settings.get();
    return {
      enabled: values.cursorEnabled,
      databasePath: values.cursorDatabasePath || undefined,
    };
  }

  async function resolveUsage(merged: MergedUsage): Promise<MergedUsage> {
    let catalog: ReturnType<typeof catalogFromBbProjects> = [];
    try {
      catalog = catalogFromBbProjects(
        await bb.sdk.projects.list({ includePersonal: true }),
      );
    } catch {
      // Folder-name merge still runs without a live project list.
    }
    const projects = applyProjectCatalog(merged.projects, catalog);
    return {
      ...merged,
      projects: finalizeProjectRows(
        await attachEnvironmentThreads(bb, projects),
        merged.costUsd,
      ),
    };
  }

  bb.rpc.register(rpcContract, {
    async getUsage({ sinceDay, untilDay, timeZone, force }) {
      const { merged } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force: force === true,
        cursor: await cursorOptions(),
      });
      return resolveUsage(merged);
    },
    async getPullRequestActivity({ force }) {
      if (!force && pullRequestCache && pullRequestCache.expiresAt > Date.now()) {
        return pullRequestCache.value;
      }
      const value = await readPullRequestActivity();
      pullRequestCache = { value, expiresAt: Date.now() + PULL_REQUEST_CACHE_MS };
      return value;
    },
  });

  bb.onDispose(() => scanner.flush());

  bb.cli.register({
    name: "usage",
    summary: "Show Claude / Codex / Pi / Cursor usage totals",
    commands: [
      {
        name: "show",
        summary: "Print usage for a window (default 30 days)",
        usage: "bb usage show [--days 7|30|90] [--force]",
      },
    ],
    async run(argv) {
      const options = parseCliOptions(argv);
      if ("error" in options) {
        return { exitCode: 2, stderr: `${options.error}\n` };
      }
      const { sinceDay, untilDay, timeZone } = makeWindow(options.days);
      const { merged: scanned } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force: options.force,
        cursor: await cursorOptions(),
      });
      const merged = await resolveUsage(scanned);
      const cursorSource = merged.sources.find(
        (source) => source.provider === "cursor",
      );
      const visibleProviders = merged.providers.filter(
        (provider) =>
          provider.provider !== "cursor" ||
          (cursorSource !== undefined && cursorSource.path !== "(disabled)"),
      );
      const cursorWarning =
        cursorSource &&
        cursorSource.path !== "(disabled)" &&
        cursorSource.status !== "ok"
          ? `Warning: Cursor usage is ${cursorSource.status}: ${
              cursorSource.message || "source unavailable."
            }`
          : null;

      const cacheLabel = merged.cache.summaryHit
        ? "summary cache"
        : `${merged.cache.fileHits} file hits / ${merged.cache.filesParsed} parsed`;

      const lines = [
        `Usage ${sinceDay} to ${untilDay}`,
        `Raw token cost: $${merged.costUsd.toFixed(2)}`,
        ...(cursorWarning ? [cursorWarning] : []),
        ...visibleProviders.map(
          (provider) =>
            `  ${provider.provider}: $${provider.costUsd.toFixed(2)} (${provider.totalTokens} tokens)`,
        ),
        ...(merged.projects.length > 0
          ? [
              "Projects:",
              ...merged.projects.map(
                (project) =>
                  `  ${project.project}: $${project.costUsd.toFixed(2)} (${project.totalTokens} tokens)`,
              ),
            ]
          : []),
        `Sessions: ${merged.sessions}`,
        `Scan: ${merged.scanDurationMs}ms · ${cacheLabel} · pricing ${merged.pricing.status}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
