import { z } from "zod";

const stateSchema = z.enum(["ok", "not_connected", "expired", "error"]);

export const liveStatusSchema = z.object({
  observedAt: z.string(),
  claudeSecond: z.object({
    status: stateSchema,
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(z.object({
      label: z.string(),
      usedPercent: z.number(),
      resetsAt: z.string().nullable(),
    })),
    message: z.string().nullable(),
  }),
  openRouter: z.object({
    status: stateSchema,
    spentUsdToday: z.number().nullable(),
    spentUsdWeek: z.number().nullable(),
    spentUsdMonth: z.number().nullable(),
    spentUsdTotal: z.number().nullable(),
    keyLimitUsd: z.number().nullable(),
    keyRemainingUsd: z.number().nullable(),
    message: z.string().nullable(),
  }),
  vps: z.object({
    status: z.enum(["ok", "error"]),
    diskTotalBytes: z.number().nullable(),
    diskFreeBytes: z.number().nullable(),
    memoryTotalBytes: z.number().nullable(),
    memoryAvailableBytes: z.number().nullable(),
    cpuUsedPercent: z.number().nullable(),
    message: z.string().nullable(),
  }),
}).strict();

export type LiveStatus = z.infer<typeof liveStatusSchema>;
