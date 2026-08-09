import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type DisplayMode = "daily" | "weekly" | "cumulative";
type Scope = "project" | "all";

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type UsageRecord = {
  day: string;
  provider: string;
  model: string;
  usage: UsageTotals;
};

type Task = {
  id: string;
  start: number;
  end: number;
};

type UsageData = {
  records: UsageRecord[];
  tasks: Task[];
  scannedSessions: number;
};

const COMMAND = "usage";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const COLORS = ["dim", "muted", "accent", "success", "warning", "error"] as const;

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addTotals(target: UsageTotals, source: any): void {
  target.input += finite(source?.input);
  target.output += finite(source?.output);
  target.cacheRead += finite(source?.cacheRead);
  target.cacheWrite += finite(source?.cacheWrite);
  target.cost += finite(source?.cost?.total);
}

function totalTokens(usage: UsageTotals): number {
  // This matches Pi's own usage-totals implementation, including cache tokens.
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resolveCwd(value: string): string {
  return path.resolve(value);
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseTimestamp(entry: any): number | undefined {
  const messageTimestamp = entry?.message?.timestamp;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  const timestamp = new Date(entry?.timestamp ?? "").getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function usageForEntry(entry: any): any | undefined {
  if (entry?.type === "message" && entry.message?.role === "assistant") {
    return entry.message.usage;
  }
  if (entry?.type === "message" && entry.message?.role === "toolResult") {
    return entry.message.usage;
  }
  if (entry?.type === "compaction" || entry?.type === "branch_summary") {
    return entry.usage;
  }
  return undefined;
}

function modelForEntry(entry: any, current: { provider: string; model: string }): void {
  if (entry?.type === "model_change") {
    if (typeof entry.provider === "string") current.provider = entry.provider;
    if (typeof entry.modelId === "string") current.model = entry.modelId;
  }
  if (entry?.type === "message" && entry.message?.role === "assistant") {
    if (typeof entry.message.provider === "string") current.provider = entry.message.provider;
    const model = entry.message.responseModel ?? entry.message.model;
    if (typeof model === "string") current.model = model;
  }
}

function addRecord(data: UsageData, entry: any, currentModel: { provider: string; model: string }): void {
  const usage = usageForEntry(entry);
  const timestamp = parseTimestamp(entry);
  if (!usage || timestamp === undefined) return;

  const isAssistant = entry.type === "message" && entry.message?.role === "assistant";
  const provider = isAssistant ? entry.message.provider : "Tools/summaries";
  const model = isAssistant
    ? entry.message.responseModel ?? entry.message.model
    : "Tools/summaries";

  const totals = emptyTotals();
  addTotals(totals, usage);
  if (totalTokens(totals) === 0 && totals.cost === 0) return;

  data.records.push({
    day: dayKey(timestamp),
    provider: provider || currentModel.provider || "unknown",
    model: model || currentModel.model || "unknown",
    usage: totals,
  });
}

function collectEntries(
  data: UsageData,
  entries: SessionEntry[],
  seenEntryIds: Set<string>,
): void {
  const currentModel = { provider: "unknown", model: "unknown" };
  let activeTask: Task | undefined;

  const closeTask = () => {
    if (activeTask) {
      data.tasks.push(activeTask);
      activeTask = undefined;
    }
  };

  for (const rawEntry of entries as any[]) {
    const entryId = typeof rawEntry.id === "string" ? rawEntry.id : undefined;
    if (entryId && seenEntryIds.has(entryId)) continue;
    if (entryId) seenEntryIds.add(entryId);

    const timestamp = parseTimestamp(rawEntry);
    modelForEntry(rawEntry, currentModel);

    if (rawEntry.type === "message" && rawEntry.message?.role === "user") {
      closeTask();
      if (timestamp !== undefined) {
        activeTask = { id: entryId ?? `${timestamp}`, start: timestamp, end: timestamp };
      }
    } else if (activeTask && timestamp !== undefined) {
      activeTask.end = Math.max(activeTask.end, timestamp);
    }

    addRecord(data, rawEntry, currentModel);
  }

  closeTask();
}

async function loadUsage(ctx: ExtensionContext, scope: Scope): Promise<UsageData> {
  const data: UsageData = { records: [], tasks: [], scannedSessions: 0 };
  const seenEntryIds = new Set<string>();
  const currentCwd = resolveCwd(ctx.cwd);
  const sessions = await SessionManager.listAll();

  for (const session of sessions as any[]) {
    if (scope === "project" && resolveCwd(session.cwd) !== currentCwd) continue;
    try {
      const manager = SessionManager.open(session.path);
      collectEntries(data, manager.getEntries(), seenEntryIds);
      data.scannedSessions++;
    } catch {
      // One malformed or concurrently-written session must not break the report.
    }
  }

  // Include an in-memory or just-created current session, while deduping persisted entries.
  if (scope === "project" || scope === "all") {
    collectEntries(data, ctx.sessionManager.getEntries(), seenEntryIds);
  }

  return data;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function keyFromDate(date: Date): string {
  return dayKey(date.getTime());
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function aggregateByDay(records: UsageRecord[]): Map<string, number> {
  const daily = new Map<string, number>();
  for (const record of records) {
    daily.set(record.day, (daily.get(record.day) ?? 0) + totalTokens(record.usage));
  }
  return daily;
}

function aggregateModels(records: UsageRecord[]): Map<string, number> {
  const models = new Map<string, number>();
  for (const record of records) {
    const key = `${record.provider}/${record.model}`;
    models.set(key, (models.get(key) ?? 0) + totalTokens(record.usage));
  }
  return models;
}

function streaks(daily: Map<string, number>): { current: number; best: number } {
  const today = startOfDay(new Date());
  let current = 0;
  for (let index = 0; ; index++) {
    const date = new Date(today.getTime() - index * DAY_MS);
    if ((daily.get(keyFromDate(date)) ?? 0) <= 0) break;
    current++;
  }

  const dates = [...daily.keys()].sort();
  let best = 0;
  let run = 0;
  let previous: Date | undefined;
  for (const key of dates) {
    if ((daily.get(key) ?? 0) <= 0) continue;
    const date = dateFromKey(key);
    run = previous && daysBetween(previous, date) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = date;
  }
  return { current, best };
}

function activityRange(): { start: Date; end: Date } {
  const end = startOfDay(new Date());
  // Show twelve calendar months, matching the Codex-style Aug–Jul layout,
  // rather than an arbitrary 365-day slice that can start mid-month.
  const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
  return { start, end };
}

function chartRange(daily: Map<string, number>): { start: Date; end: Date } {
  const base = activityRange();
  const activeMonths = [...daily.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([key]) => dateFromKey(key))
    .filter((date) => date >= base.start && date <= base.end);

  if (activeMonths.length === 0) return base;

  const first = activeMonths.reduce((earliest, date) =>
    date < earliest ? date : earliest,
  );
  const last = activeMonths.reduce((latest, date) =>
    date > latest ? date : latest,
  );

  return {
    start: new Date(first.getFullYear(), first.getMonth(), 1),
    end: new Date(
      Math.min(
        base.end.getTime(),
        new Date(last.getFullYear(), last.getMonth() + 1, 0).getTime(),
      ),
    ),
  };
}

function rangeDays(range: { start: Date; end: Date }): { days: Date[]; columns: number } {
  const gridStart = new Date(range.start.getTime() - range.start.getDay() * DAY_MS);
  const dayCount = Math.floor((range.end.getTime() - gridStart.getTime()) / DAY_MS) + 1;
  const columns = Math.ceil(dayCount / 7);
  return {
    days: Array.from({ length: columns * 7 }, (_, index) =>
      new Date(gridStart.getTime() + index * DAY_MS),
    ),
    columns,
  };
}

function cellValue(
  date: Date,
  daily: Map<string, number>,
  mode: DisplayMode,
  cumulativeBefore: Map<string, number>,
): number {
  const key = keyFromDate(date);
  if (mode === "daily") return daily.get(key) ?? 0;
  if (mode === "cumulative") return cumulativeBefore.get(key) ?? 0;

  let total = 0;
  for (let index = 0; index < 7; index++) {
    const previous = new Date(date.getTime() - index * DAY_MS);
    total += daily.get(keyFromDate(previous)) ?? 0;
  }
  return total;
}

function makeCumulative(daily: Map<string, number>, days: Date[]): Map<string, number> {
  const output = new Map<string, number>();
  let total = 0;
  for (const date of days) {
    const key = keyFromDate(date);
    total += daily.get(key) ?? 0;
    output.set(key, total);
  }
  return output;
}

function levelFor(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.min(COLORS.length - 1, Math.max(1, Math.ceil((value / maximum) * (COLORS.length - 1))));
}

function renderMonthHeader(
  days: Date[],
  columns: number,
  cellWidth: number,
  rangeStart: Date,
): string {
  const cells = Array.from({ length: columns * cellWidth }, () => " ");
  const boundaries: Array<{ column: number; label: string }> = [];

  for (let column = 0; column < columns; column++) {
    const date = days[column * 7]!;
    const previous = column === 0 ? undefined : days[(column - 1) * 7]!;
    if (date < rangeStart) continue;
    if (column === 0 || date.getMonth() !== previous!.getMonth()) {
      boundaries.push({
        column,
        label: date.toLocaleString(undefined, { month: "short" }),
      });
    }
  }

  // Month labels share the scaled grid. Use the full label when there is room;
  // otherwise use an initial, without ever overwriting a neighboring label.
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!;
    const nextColumn = boundaries[index + 1]?.column ?? columns;
    const startOffset = boundary.column * cellWidth;
    const available = (nextColumn - boundary.column) * cellWidth;
    const label = available >= boundary.label.length ? boundary.label : boundary.label[0]!;
    for (let offset = 0; offset < label.length && startOffset + offset < cells.length; offset++) {
      cells[startOffset + offset] = label[offset]!;
    }
  }
  return cells.join("");
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderHeatmap(
  theme: any,
  width: number,
  daily: Map<string, number>,
  mode: DisplayMode,
): string[] {
  const range = chartRange(daily);
  const { days, columns } = rangeDays(range);
  const cellWidth = width >= 110 ? 2 : 1;
  const cumulative = makeCumulative(daily, days);
  const values = days.map((date) => cellValue(date, daily, mode, cumulative));
  const maximum = Math.max(...values, 0);
  const { start: rangeStart, end: today } = range;
  const glyphs = ["·", "░", "▒", "▓", "█", "█"];
  const lines = [`    ${renderMonthHeader(days, columns, cellWidth, rangeStart)}`];

  for (let row = 0; row < 7; row++) {
    let line = ` ${WEEKDAYS[row]} `;
    for (let column = 0; column < columns; column++) {
      const index = column * 7 + row;
      const date = days[index]!;
      const value = values[index]!;
      const isInRange = date >= rangeStart && date <= today;
      if (!isInRange) {
        line += " ";
        continue;
      }
      const level = levelFor(value, maximum);
      const glyph = glyphs[level]!.repeat(cellWidth);
      line += theme.fg(COLORS[level], glyph);
    }
    lines.push(line);
  }
  return lines.map((line) => fitLine(line, width));
}

function renderModels(theme: any, records: UsageRecord[], width: number): string[] {
  const models = [...aggregateModels(records).entries()].sort((a, b) => b[1] - a[1]);
  const total = models.reduce((sum, [, tokens]) => sum + tokens, 0);
  const lines = [
    theme.fg("accent", theme.bold("Model usage")),
    theme.fg("dim", "  Tokens are grouped by provider/model; summaries are separate."),
    "",
  ];
  if (models.length === 0) {
    lines.push(theme.fg("dim", "  No model usage recorded."));
  } else {
    for (const [model, tokens] of models) {
      const percent = total > 0 ? `${((tokens / total) * 100).toFixed(1)}%` : "0.0%";
      lines.push(`  ${theme.fg("accent", formatTokens(tokens).padStart(7))}  ${percent.padStart(6)}  ${model}`);
    }
  }
  return lines.map((line) => fitLine(line, width));
}

function buildScreen(
  theme: any,
  width: number,
  data: UsageData,
  scope: Scope,
  mode: DisplayMode,
  view: "chart" | "models",
): string[] {
  const daily = aggregateByDay(data.records);
  const lifetime = data.records.reduce((sum, record) => sum + totalTokens(record.usage), 0);
  const peak = Math.max(...daily.values(), 0);
  const { current, best } = streaks(daily);
  const longestTask = data.tasks.reduce((longest, task) => Math.max(longest, task.end - task.start), 0);
  const scopeLabel = scope === "all" ? "all sessions" : "current project";
  const visibleRange = chartRange(daily);
  const visibleRangeLabel = `${visibleRange.start.toLocaleString(undefined, { month: "short" })}–${visibleRange.end.toLocaleString(undefined, { month: "short" })}`;

  if (view === "models") {
    return [
      theme.fg("muted", `Token activity · ${scopeLabel}`),
      "",
      ...renderModels(theme, data.records, width),
      "",
      theme.fg("dim", "  [m] chart  [p] scope  [r] refresh  [esc] close"),
    ].map((line) => fitLine(line, width));
  }

  const lines = [
    theme.fg("accent", theme.bold("Token activity")) + theme.fg("muted", "  ·  last 12 months"),
    theme.fg("dim", `  ${scopeLabel}  ·  ${visibleRangeLabel} active  ·  density: ${mode}  ·  ${data.scannedSessions} sessions`),
    "",
    `  Lifetime ${formatTokens(lifetime)}     Peak day ${formatTokens(peak)}`,
    `  Streak ${current}d (best ${best}d)     Longest task ${formatDuration(longestTask)}`,
    "",
    ...renderHeatmap(theme, width, daily, mode),
    "",
    theme.fg("dim", "  Less ") + ["·", "░", "▒", "▓", "█"].map((glyph, index) => theme.fg(COLORS[index], glyph)).join(" ") + theme.fg("dim", " More"),
    theme.fg("dim", "  [m] models  [p] scope  [d] density  [r] refresh  [esc] close"),
  ];
  return lines.map((line) => fitLine(line, width));
}

async function showUsage(ctx: ExtensionContext, initialArgs: string): Promise<void> {
  let scope: Scope = initialArgs.trim() === "project" ? "project" : "all";
  let mode: DisplayMode = "daily";
  let view: "chart" | "models" = "chart";

  ctx.ui.notify("Loading usage history…", "info");
  let data = await loadUsage(ctx, scope);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const component = {
      render(width: number): string[] {
        return buildScreen(theme, width, data, scope, mode, view);
      },
      invalidate() {
        tui.requestRender();
      },
      handleInput(input: string) {
        if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) {
          done();
          return;
        }
        if (input === "m") {
          view = view === "chart" ? "models" : "chart";
          tui.requestRender();
          return;
        }
        if (input === "p") {
          scope = scope === "all" ? "project" : "all";
          void loadUsage(ctx, scope).then((next) => {
            data = next;
            tui.requestRender();
          });
          tui.requestRender();
          return;
        }
        if (input === "d") {
          mode = mode === "daily" ? "weekly" : mode === "weekly" ? "cumulative" : "daily";
          tui.requestRender();
          return;
        }
        if (input === "r") {
          void loadUsage(ctx, scope).then((next) => {
            data = next;
            tui.requestRender();
          });
          return;
        }
      },
    };
    return component;
  });
}

export default function usageExtension(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND, {
    description: "Show historical token activity and model usage",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || (ctx as any).mode !== "tui") {
        ctx.ui.notify("/usage requires interactive TUI mode.", "warning");
        return;
      }
      await showUsage(ctx, args);
    },
  });
}
