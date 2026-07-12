/**
 * DeepSeek Peak-Hour Indicator
 *
 * Ultra-minimal footer indicator: shows ⚡ + time remaining during peak
 * pricing hours, and nothing during off-peak.
 *
 * Peak hours (UTC): 1:00–4:00 AM and 6:00–10:00 AM
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Peak hour definitions (UTC, [start, end)) ──────────────────────────────
const PEAK_PERIODS: Array<{ start: number; end: number }> = [
  { start: 1, end: 4 },   // 1:00 – 4:00 AM UTC
  { start: 6, end: 10 },  // 6:00 – 10:00 AM UTC
];

const MINUTE_MS = 60 * 1000;

// ── Time helpers ───────────────────────────────────────────────────────────

/** Return the current peak period if we're inside one, or undefined. */
function currentPeakPeriod(utcHours: number): { start: number; end: number } | undefined {
  return PEAK_PERIODS.find((p) => utcHours >= p.start && utcHours < p.end);
}

/** Format a duration in ms to "Xh Ym" or "Xm" for short durations. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.ceil(ms / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Build the status text — minimal during peak, nothing during off-peak. */
function buildStatusText(now: Date): string | undefined {
  const period = currentPeakPeriod(now.getUTCHours());
  if (!period) return undefined; // off-peak → no status

  // ms until the end of this peak period
  const endMs =
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      period.end,
      0, 0, 0,
    );
  const remaining = endMs - now.getTime();

  if (remaining <= 0) return undefined; // just rolled over, will catch next tick
  return `⚡ ${formatDuration(remaining)} left`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;

  function isDeepSeekProvider(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "deepseek";
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!isDeepSeekProvider(ctx)) {
      ctx.ui.setStatus("deepseek-peak", undefined);
      return;
    }
    const text = buildStatusText(new Date());
    ctx.ui.setStatus("deepseek-peak", text ?? undefined);
  }

  function startTimer(ctx: ExtensionContext): void {
    stopTimer();
    lastCtx = ctx;
    statusTimer = setInterval(() => {
      if (lastCtx) updateStatus(lastCtx);
    }, 30_000);
  }

  function stopTimer(): void {
    if (statusTimer !== null) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    lastCtx = null;
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    updateStatus(ctx);
    if (isDeepSeekProvider(ctx)) startTimer(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
    if (isDeepSeekProvider(ctx)) startTimer(ctx);
    else stopTimer();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
  });
}
