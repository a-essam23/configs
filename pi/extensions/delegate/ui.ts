import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { loadDelegateConfig, type DelegateConfig } from "./config.ts";
import { shortId } from "./ids.ts";
import {
	appendRegistryRecord,
	isPidAlive,
	latestDelegationSnapshots,
	markStaleIfNeeded,
	nestedBlockedRecords,
	readRegistry,
	type DelegationSnapshot,
	type NestedBlockedRecord,
	type RegistryRecord,
} from "./registry.ts";
import type { DelegationRunner } from "./runner.ts";
import { finalAssistantOutput, findSessionFile, formatSessionFull, formatSessionTail, parseSessionFile, truncateText } from "./sessions.ts";

const RUNNING_STATUSES = new Set(["starting", "running"]);
const BAD_STATUSES = new Set(["failed", "killed", "timeout", "stale"]);

type Scope = "current_session" | "all_sessions";
type DetailMode = "summary" | "tail" | "full";

type DashboardItem =
	| { kind: "delegation"; id: string; status: string; label: string; parentSessionId: string; timestamp: string; snapshot: DelegationSnapshot }
	| { kind: "nested"; id: string; status: "blocked"; label: string; parentSessionId: string; timestamp: string; record: NestedBlockedRecord };

interface UiState {
	items: DashboardItem[];
	currentParentSessionId: string;
	counts: {
		running: number;
		done: number;
		bad: number;
		blocked: number;
		total: number;
	};
}

function currentParentSessionId(ctx: ExtensionContext): string {
	return process.env.PI_DELEGATION_PARENT_SESSION_ID || ctx.sessionManager.getSessionId();
}

function isCurrentScopeMatch(scope: Scope, parentSessionId: string, ctx: ExtensionContext): boolean {
	return scope === "all_sessions" || parentSessionId === currentParentSessionId(ctx);
}

function elapsed(startedAt: string | undefined, now = Date.now()): string {
	if (!startedAt) return "?";
	const ms = Math.max(0, now - new Date(startedAt).getTime());
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = seconds % 60;
	if (minutes < 60) return `${minutes}m${String(rem).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function isRecent(snapshot: DelegationSnapshot, showCompletedForMs: number, now = Date.now()): boolean {
	if (RUNNING_STATUSES.has(snapshot.status)) return true;
	if (showCompletedForMs <= 0) return false;
	const finished = snapshot.finishedAt ? new Date(snapshot.finishedAt).getTime() : undefined;
	return finished !== undefined && now - finished <= showCompletedForMs;
}

async function readUiState(ctx: ExtensionContext, config: DelegateConfig, scope: Scope): Promise<UiState> {
	const records = await readRegistry(config.storageDir);
	const delegations = latestDelegationSnapshots(records);
	for (const [id, snapshot] of Array.from(delegations.entries())) {
		delegations.set(id, await markStaleIfNeeded(config.storageDir, snapshot));
	}

	const items: DashboardItem[] = [];
	for (const snapshot of delegations.values()) {
		if (!isCurrentScopeMatch(scope, snapshot.parentSessionId, ctx)) continue;
		items.push({
			kind: "delegation",
			id: snapshot.id,
			status: snapshot.status,
			label: snapshot.label,
			parentSessionId: snapshot.parentSessionId,
			timestamp: snapshot.startedAt,
			snapshot,
		});
	}

	for (const record of nestedBlockedRecords(records)) {
		const parentSessionId = record.parentSessionId ?? "unknown";
		if (!isCurrentScopeMatch(scope, parentSessionId, ctx)) continue;
		items.push({
			kind: "nested",
			id: record.id,
			status: "blocked",
			label: record.label,
			parentSessionId,
			timestamp: record.timestamp,
			record,
		});
	}

	items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	let running = 0;
	let done = 0;
	let bad = 0;
	let blocked = 0;
	for (const item of items) {
		if (item.kind === "nested") {
			blocked++;
		} else if (RUNNING_STATUSES.has(item.status)) {
			running++;
		} else if (item.status === "done") {
			done++;
		} else if (BAD_STATUSES.has(item.status)) {
			bad++;
		}
	}

	return { items, currentParentSessionId: currentParentSessionId(ctx), counts: { running, done, bad, blocked, total: items.length } };
}

function formatStatusText(ctx: ExtensionContext, state: UiState): string | undefined {
	if (state.counts.total === 0) return undefined;
	const theme = ctx.ui.theme;
	const parts: string[] = [];
	if (state.counts.running > 0) parts.push(theme.fg("warning", `⏳${state.counts.running}`));
	if (state.counts.done > 0) parts.push(theme.fg("success", `✓${state.counts.done}`));
	if (state.counts.bad > 0) parts.push(theme.fg("error", `✗${state.counts.bad}`));
	if (state.counts.blocked > 0) parts.push(theme.fg("muted", `↯${state.counts.blocked}`));
	return `${theme.fg("muted", "delegates:")} ${parts.join(" ")}`;
}

function formatWidgetLines(ctx: ExtensionContext, config: DelegateConfig, state: UiState): string[] | undefined {
	const now = Date.now();
	const rows = state.items.filter((item) => {
		if (item.kind === "nested") return false;
		return isRecent(item.snapshot, config.ui.showCompletedForMs, now);
	});
	if (rows.length === 0) return undefined;

	const theme = ctx.ui.theme;
	const lines = [theme.fg("accent", theme.bold("Delegations"))];
	for (const item of rows.slice(-config.ui.maxWidgetItems)) {
		const snapshot = item.snapshot;
		const icon = RUNNING_STATUSES.has(snapshot.status)
			? theme.fg("warning", "⏳")
			: snapshot.status === "done"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		lines.push(
			`  ${icon} #${String(snapshot.number).padStart(3, "0")} ${theme.fg("dim", elapsed(snapshot.startedAt, now).padStart(6))} ${theme.fg("text", snapshot.label)} ${theme.fg("dim", snapshot.id)}`,
		);
	}
	if (rows.length > config.ui.maxWidgetItems) {
		lines.push(theme.fg("dim", `  … ${rows.length - config.ui.maxWidgetItems} more`));
	}
	return lines;
}

async function killSnapshot(config: DelegateConfig, runner: DelegationRunner, snapshot: DelegationSnapshot): Promise<DelegationSnapshot> {
	const live = runner.get(snapshot.id);
	if (live) return live.kill("killed");

	if (snapshot.status !== "running" && snapshot.status !== "starting") return snapshot;
	if (isPidAlive(snapshot.pid)) {
		try {
			process.kill(snapshot.pid!, "SIGTERM");
		} catch {
			// Ignore; status update below records the requested kill.
		}
		await new Promise((resolve) => setTimeout(resolve, config.shutdown.killGraceMs));
		if (isPidAlive(snapshot.pid)) {
			try {
				process.kill(snapshot.pid!, "SIGKILL");
			} catch {
				// Ignore.
			}
		}
	}

	const killed: DelegationSnapshot = {
		...snapshot,
		status: "killed",
		event: "finished",
		timestamp: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		error: "Killed from /delegations UI.",
	};
	await appendRegistryRecord(config.storageDir, killed);
	return killed;
}

function nextDetailMode(mode: DetailMode): DetailMode {
	if (mode === "summary") return "tail";
	if (mode === "tail") return "full";
	return "summary";
}

async function resolveSnapshotSessionFile(config: DelegateConfig, snapshot: DelegationSnapshot): Promise<DelegationSnapshot> {
	if (snapshot.childSessionFile || !snapshot.childSessionId) return snapshot;
	const childSessionFile = await findSessionFile(`${config.storageDir}/${snapshot.parentSessionId}`, snapshot.childSessionId);
	if (!childSessionFile) return snapshot;
	const updated: DelegationSnapshot = {
		...snapshot,
		childSessionFile,
		event: "update",
		timestamp: new Date().toISOString(),
	};
	await appendRegistryRecord(config.storageDir, updated);
	return updated;
}

async function detailTextForItem(config: DelegateConfig, item: DashboardItem, mode: DetailMode): Promise<string> {
	if (item.kind === "nested") {
		return [
			`Nested delegation attempt blocked`,
			`From: ${item.record.sourceDelegationId ?? "unknown"}`,
			`Reason: ${item.record.reason}`,
			"",
			"Task:",
			item.record.task,
		].join("\n");
	}

	const snapshot = await resolveSnapshotSessionFile(config, item.snapshot);
	if (!snapshot.childSessionFile) {
		return RUNNING_STATUSES.has(snapshot.status)
			? "Waiting for child session file…"
			: snapshot.finalOutput || snapshot.lastOutput || "No child session file recorded.";
	}

	const session = await parseSessionFile(snapshot.childSessionFile);
	if (mode === "summary") {
		return snapshot.finalOutput || snapshot.lastOutput || finalAssistantOutput(session) || "(no output yet)";
	}
	if (mode === "full") {
		return formatSessionFull(session) || snapshot.finalOutput || snapshot.lastOutput || "(no session output yet)";
	}
	return formatSessionTail(session, 18) || snapshot.lastOutput || "(no session output yet)";
}

class DelegationsDashboard {
	private config: DelegateConfig;
	private ctx: ExtensionContext;
	private runner: DelegationRunner;
	private requestRender: () => void;
	private done: () => void;
	private scope: Scope;
	private state: UiState | undefined;
	private selected = 0;
	private expanded = new Set<string>();
	private detailMode: DetailMode = "tail";
	private detailItemId: string | undefined;
	private detailText: string | undefined;
	private detailLoading = false;
	private detailError: string | undefined;
	private loading = false;
	private message: string | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(options: {
		config: DelegateConfig;
		ctx: ExtensionContext;
		runner: DelegationRunner;
		requestRender: () => void;
		done: () => void;
		scope: Scope;
	}) {
		this.config = options.config;
		this.ctx = options.ctx;
		this.runner = options.runner;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.scope = options.scope;
		void this.refresh();
		this.refreshTimer = setInterval(() => void this.refresh(false), this.config.ui.pollIntervalMs);
	}

	async refresh(showLoading = true): Promise<void> {
		if (this.loading) return;
		this.loading = showLoading;
		this.requestRender();
		try {
			this.state = await readUiState(this.ctx, this.config, this.scope);
			if (this.selected >= this.state.items.length) this.selected = Math.max(0, this.state.items.length - 1);
			void this.loadSelectedDetail(true);
		} catch (error) {
			this.message = `Refresh failed: ${(error as Error).message}`;
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	private selectedItem(): DashboardItem | undefined {
		return this.state?.items[this.selected];
	}

	private loadSelectedDetail(force = false): void {
		const item = this.selectedItem();
		if (!item) {
			this.detailItemId = undefined;
			this.detailText = undefined;
			this.detailError = undefined;
			this.detailLoading = false;
			this.requestRender();
			return;
		}

		const sameSelection = this.detailItemId === item.id;
		if (!force && sameSelection && this.detailText !== undefined && !this.detailError) return;
		const id = item.id;
		const mode = this.detailMode;
		const keepExisting = force && sameSelection && this.detailText !== undefined;
		this.detailItemId = id;
		if (!keepExisting) this.detailText = undefined;
		this.detailError = undefined;
		this.detailLoading = true;
		this.requestRender();

		void detailTextForItem(this.config, item, mode)
			.then((text) => {
				if (this.selectedItem()?.id !== id || this.detailMode !== mode) return;
				this.detailText = text;
				this.detailError = undefined;
			})
			.catch((error) => {
				if (this.selectedItem()?.id !== id || this.detailMode !== mode) return;
				this.detailError = (error as Error).message;
			})
			.finally(() => {
				if (this.selectedItem()?.id !== id || this.detailMode !== mode) return;
				this.detailLoading = false;
				this.requestRender();
			});
	}

	dispose(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
	}

	handleInput(data: string): void {
		const items = this.state?.items ?? [];
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.dispose();
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
			this.loadSelectedDetail();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
			this.loadSelectedDetail();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "r")) {
			void this.refresh();
			return;
		}
		if (matchesKey(data, "a")) {
			this.scope = this.scope === "current_session" ? "all_sessions" : "current_session";
			this.selected = 0;
			void this.refresh();
			return;
		}
		if (matchesKey(data, "t")) {
			this.detailMode = nextDetailMode(this.detailMode);
			this.loadSelectedDetail(true);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const item = items[this.selected];
			if (item) {
				if (this.expanded.has(item.id)) this.expanded.delete(item.id);
				else this.expanded.add(item.id);
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "k")) {
			const item = items[this.selected];
			if (item?.kind === "delegation") {
				if (!RUNNING_STATUSES.has(item.snapshot.status)) {
					this.message = `${item.id} is not running (${item.snapshot.status})`;
					this.requestRender();
					return;
				}
				this.message = `Killing ${item.id}…`;
				this.requestRender();
				void killSnapshot(this.config, this.runner, item.snapshot)
					.then((snapshot) => {
						this.message = `Killed ${snapshot.id}`;
						return this.refresh(false);
					})
					.catch((error) => {
						this.message = `Kill failed: ${(error as Error).message}`;
						this.requestRender();
					});
			}
		}
	}

	render(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const lines: string[] = [];
		const state = this.state;
		const title = `Delegations (${this.scope === "current_session" ? "current session" : "all sessions"})`;
		lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
		if (state) {
			lines.push(
				truncateToWidth(
					theme.fg(
						"dim",
						`Parent ${shortId(state.currentParentSessionId)}  total ${state.counts.total}  running ${state.counts.running}  done ${state.counts.done}  issues ${state.counts.bad}  blocked ${state.counts.blocked}`,
					),
					width,
				),
			);
		}
		lines.push(
			truncateToWidth(
				theme.fg("dim", "↑↓ select • enter expand • t detail mode • k kill running • r refresh • a all/current • esc close"),
				width,
			),
		);
		if (this.message) lines.push(truncateToWidth(theme.fg("warning", this.message), width));
		if (this.loading && !state) lines.push(truncateToWidth(theme.fg("dim", "Loading…"), width));
		lines.push("");

		const items = state?.items ?? [];
		if (items.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "No delegations found."), width));
			return lines;
		}

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const selected = i === this.selected;
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			if (item.kind === "nested") {
				const row = `${prefix}${theme.fg("muted", "↯ blocked")} ${theme.fg("text", item.label)} ${theme.fg("dim", item.id)}`;
				lines.push(truncateToWidth(row, width));
				if (this.expanded.has(item.id)) {
					lines.push(truncateToWidth(theme.fg("dim", `    from: ${item.record.sourceDelegationId ?? "unknown"}`), width));
					lines.push(truncateToWidth(theme.fg("dim", `    task: ${item.record.task}`), width));
				}
				continue;
			}

			const snapshot = item.snapshot;
			const icon = RUNNING_STATUSES.has(snapshot.status)
				? theme.fg("warning", "⏳")
				: snapshot.status === "done"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const row = `${prefix}${icon} #${String(snapshot.number).padStart(3, "0")} ${snapshot.status.padEnd(8)} ${theme.fg("text", snapshot.label)} ${theme.fg("dim", snapshot.id)} ${theme.fg("dim", elapsed(snapshot.startedAt))}`;
			lines.push(truncateToWidth(row, width));

			if (this.expanded.has(item.id)) {
				if (snapshot.childSessionFile) lines.push(truncateToWidth(theme.fg("dim", `    session: ${snapshot.childSessionFile}`), width));
				if (snapshot.error) lines.push(truncateToWidth(theme.fg("error", `    error: ${snapshot.error}`), width));
				const latest = snapshot.finalOutput || snapshot.lastOutput;
				if (latest) {
					for (const line of latest.split("\n").slice(0, 6)) {
						lines.push(truncateToWidth(theme.fg("dim", `    ${line}`), width));
					}
				}
				lines.push(truncateToWidth(theme.fg("dim", `    task: ${snapshot.task}`), width));
			}
		}
		this.renderDetailPane(lines, width);
		return lines;
	}

	private renderDetailPane(lines: string[], width: number): void {
		const theme = this.ctx.ui.theme;
		const item = this.selectedItem();
		if (!item) return;

		lines.push("");
		lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
		const title = item.kind === "delegation" ? `Selected: ${item.id} (${this.detailMode})` : `Selected: ${item.id}`;
		lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));

		if (item.kind === "delegation") {
			const snapshot = item.snapshot;
			const meta = [
				`status ${snapshot.status}`,
				snapshot.pid ? `pid ${snapshot.pid}` : undefined,
				`elapsed ${elapsed(snapshot.startedAt)}`,
				snapshot.childSessionId ? `child ${shortId(snapshot.childSessionId)}` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join(" · ");
			lines.push(truncateToWidth(theme.fg("dim", meta), width));
			if (snapshot.childSessionFile) lines.push(truncateToWidth(theme.fg("dim", `session: ${snapshot.childSessionFile}`), width));
			if (snapshot.error) lines.push(truncateToWidth(theme.fg("error", `error: ${snapshot.error}`), width));
		} else {
			lines.push(truncateToWidth(theme.fg("dim", `blocked from ${item.record.sourceDelegationId ?? "unknown"}`), width));
		}

		lines.push("");
		if (this.detailLoading && !this.detailText) {
			lines.push(truncateToWidth(theme.fg("dim", "Loading selected delegation activity…"), width));
			return;
		}
		if (this.detailLoading && this.detailText) {
			lines.push(truncateToWidth(theme.fg("dim", "Refreshing selected delegation activity…"), width));
		}
		if (this.detailError) {
			lines.push(truncateToWidth(theme.fg("error", `Detail load failed: ${this.detailError}`), width));
			return;
		}

		const detail = truncateText(this.detailText || "(no activity yet)", this.detailMode === "full" ? 30_000 : 12_000);
		const maxLines = this.detailMode === "full" ? 80 : 34;
		const detailLines = detail.split("\n");
		for (const line of detailLines.slice(0, maxLines)) {
			lines.push(truncateToWidth(theme.fg("toolOutput", line || " "), width));
		}
		if (detailLines.length > maxLines) {
			lines.push(truncateToWidth(theme.fg("dim", `… ${detailLines.length - maxLines} more lines; press t for another detail mode`), width));
		}
	}

	invalidate(): void {
		// This component builds theme strings at render-time; no cached state to clear.
	}
}

export function setupDelegateUi(pi: ExtensionAPI, runner: DelegationRunner) {
	let timer: NodeJS.Timeout | undefined;

	async function update(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const config = await loadDelegateConfig(ctx);
		if (!config.ui.enabled) {
			ctx.ui.setStatus("delegate", undefined);
			ctx.ui.setWidget("delegate-running", undefined);
			return;
		}

		const scope = config.ui.scope;
		const state = await readUiState(ctx, config, scope);
		if (config.ui.status) ctx.ui.setStatus("delegate", formatStatusText(ctx, state));
		else ctx.ui.setStatus("delegate", undefined);

		if (config.ui.runningWidget) {
			ctx.ui.setWidget("delegate-running", formatWidgetLines(ctx, config, state), { placement: config.ui.widgetPlacement });
		} else {
			ctx.ui.setWidget("delegate-running", undefined);
		}
	}

	function stop(ctx?: ExtensionContext) {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx?.hasUI) {
			ctx.ui.setStatus("delegate", undefined);
			ctx.ui.setWidget("delegate-running", undefined);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		stop(ctx);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const config = await loadDelegateConfig(ctx);
		if (!config.ui.enabled) return;
		await update(ctx);
		timer = setInterval(() => void update(ctx), config.ui.pollIntervalMs);
		timer.unref?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});

	pi.registerCommand("delegations", {
		description: "Show delegate sessions and running delegation status",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/delegations requires TUI mode", "error");
				return;
			}
			const config = await loadDelegateConfig(ctx);
			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				let dashboard: DelegationsDashboard;
				dashboard = new DelegationsDashboard({
					config,
					ctx,
					runner,
					requestRender: () => tui.requestRender(),
					done: () => done(undefined),
					scope: config.ui.scope,
				});
				return dashboard;
			});
			await update(ctx);
		},
	});
}
