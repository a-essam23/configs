import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyCallOverrides, loadDelegateConfig, type DelegateCallOverrides, type DelegateConfig } from "./config.ts";
import { delegationId, labelForTask, nestedBlockedId, sessionName, shortId } from "./ids.ts";
import {
	appendRegistryRecord,
	createStartedDelegation,
	isPidAlive,
	latestDelegationSnapshots,
	markStaleIfNeeded,
	nestedBlockedRecords,
	readRegistry,
	type DelegationSnapshot,
	type DelegationStatus,
	type NestedBlockedRecord,
	type RegistryRecord,
} from "./registry.ts";
import { DelegationRunner } from "./runner.ts";
import { finalAssistantOutput, findSessionFile, formatSessionFull, formatSessionTail, parseSessionFile, truncateText } from "./sessions.ts";
import { setupDelegateUi } from "./ui.ts";

const runner = new DelegationRunner();

const DelegateParams = Type.Object({
	task: Type.String({ description: "Task to delegate to a fresh Pi agent session" }),
	label: Type.Optional(Type.String({ description: "Short human-readable label for this delegation" })),
	waitForSeconds: Type.Optional(
		Type.Number({ description: "Wait up to this many seconds for completion before returning. Default: config value." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Kill the delegation after this many milliseconds. Default: config value." })),
	tools: Type.Optional(
		Type.String({
			description:
				'Tool mode for this delegation: "inherit" (parent active tools), "default" (normal Pi default), "none", or comma-separated tool names.',
		}),
	),
	extensions: Type.Optional(StringEnum(["inherit", "none"] as const, { description: "Extension loading mode" })),
	model: Type.Optional(
		Type.String({ description: 'Model for this delegation: "inherit", "default", or a Pi model pattern/id.' }),
	),
	cwd: Type.Optional(Type.String({ description: 'Working directory: "parent" or a path. Relative paths resolve from parent cwd.' })),
	projectTrust: Type.Optional(
		StringEnum(["inherit", "approve", "deny", "default"] as const, { description: "Project trust mode for child Pi" }),
	),
});

const ListParams = Type.Object({
	scope: Type.Optional(
		StringEnum(["current_session", "all_sessions"] as const, { description: "List delegations for current session or all sessions" }),
	),
	status: Type.Optional(
		Type.String({ description: 'Status filter: all, running, done, failed, killed, timeout, stale, blocked, or starting.' }),
	),
	query: Type.Optional(Type.String({ description: "Case-insensitive search over id, label, and task" })),
	includeNested: Type.Optional(Type.Boolean({ description: "Include nested delegation attempts. Default: true" })),
});

const CheckParams = Type.Object({
	id: Type.String({ description: "Delegation id, e.g. del_a13f9c2b_001" }),
	mode: Type.Optional(
		StringEnum(["summary", "tail", "full", "metadata"] as const, { description: "What to return about the delegation" }),
	),
	tailCount: Type.Optional(Type.Number({ description: "Number of recent session messages for tail mode. Default: 12" })),
});

const KillParams = Type.Object({
	id: Type.String({ description: "Delegation id to kill" }),
});

function nowIso(): string {
	return new Date().toISOString();
}

function currentDepth(): number {
	const raw = process.env.PI_DELEGATION_DEPTH;
	if (raw && /^\d+$/.test(raw)) return Number(raw);
	return process.env.PI_DELEGATION ? 1 : 0;
}

function rootParentSessionId(ctx: ExtensionContext): string {
	return process.env.PI_DELEGATION_PARENT_SESSION_ID || ctx.sessionManager.getSessionId();
}

function rootParentSessionFile(ctx: ExtensionContext): string | undefined {
	return process.env.PI_DELEGATION_PARENT_SESSION_FILE || ctx.sessionManager.getSessionFile();
}

function rootParentLeafId(ctx: ExtensionContext): string | undefined {
	return process.env.PI_DELEGATION_PARENT_LEAF_ID || ctx.sessionManager.getLeafId() || undefined;
}

async function recordNestedBlocked(
	ctx: ExtensionContext,
	config: DelegateConfig,
	task: string,
	label: string,
	depth: number,
): Promise<NestedBlockedRecord> {
	const record: NestedBlockedRecord = {
		type: "delegate_registry",
		version: 1,
		kind: "nested_blocked",
		event: "nested_blocked",
		status: "blocked",
		timestamp: nowIso(),
		id: nestedBlockedId(process.env.PI_DELEGATION_ID),
		parentSessionId: rootParentSessionId(ctx),
		parentSessionFile: rootParentSessionFile(ctx),
		parentLeafId: rootParentLeafId(ctx),
		sourceDelegationId: process.env.PI_DELEGATION_ID,
		childSessionId: ctx.sessionManager.getSessionId(),
		task,
		label,
		cwd: ctx.cwd,
		depth,
		reason: "Nested delegation is disabled by config.",
	};
	await appendRegistryRecord(config.storageDir, record);
	return record;
}

function content(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function delegationLine(snapshot: DelegationSnapshot): string {
	const status = snapshot.status.padEnd(8);
	return `#${String(snapshot.number).padStart(3, "0")} ${status} — ${snapshot.label} (${snapshot.id})`;
}

function nestedLine(record: NestedBlockedRecord): string {
	const source = record.sourceDelegationId ? ` from ${record.sourceDelegationId}` : "";
	return `nested blocked${source} — ${record.label} (${record.id})`;
}

async function loadLatest(config: DelegateConfig): Promise<{
	records: RegistryRecord[];
	delegations: Map<string, DelegationSnapshot>;
	nested: NestedBlockedRecord[];
}> {
	const records = await readRegistry(config.storageDir);
	const delegations = latestDelegationSnapshots(records);
	for (const [id, snapshot] of Array.from(delegations.entries())) {
		delegations.set(id, await markStaleIfNeeded(config.storageDir, snapshot));
	}
	return { records, delegations, nested: nestedBlockedRecords(records) };
}

function matchesQuery(record: { id: string; task: string; label?: string }, query: string | undefined): boolean {
	if (!query?.trim()) return true;
	const q = query.toLowerCase();
	return record.id.toLowerCase().includes(q) || record.task.toLowerCase().includes(q) || (record.label ?? "").toLowerCase().includes(q);
}

function statusMatches(status: string | undefined, actual: string): boolean {
	if (!status || status === "all") return true;
	return status === actual;
}

async function ensureSessionFile(config: DelegateConfig, snapshot: DelegationSnapshot): Promise<DelegationSnapshot> {
	if (snapshot.childSessionFile || !snapshot.childSessionId) return snapshot;
	const childSessionFile = await findSessionFile(`${config.storageDir}/${snapshot.parentSessionId}`, snapshot.childSessionId);
	if (!childSessionFile) return snapshot;
	const updated: DelegationSnapshot = { ...snapshot, childSessionFile, event: "update", timestamp: nowIso() };
	await appendRegistryRecord(config.storageDir, updated);
	return updated;
}

function summarizeSnapshot(snapshot: DelegationSnapshot): string {
	const lines = [
		`Delegation ${snapshot.id}`,
		`Status: ${snapshot.status}`,
		`Name: ${snapshot.sessionName}`,
		`Parent: ${snapshot.parentSessionId}`,
		snapshot.childSessionId ? `Child session: ${snapshot.childSessionId}` : undefined,
		snapshot.childSessionFile ? `Session file: ${snapshot.childSessionFile}` : undefined,
		snapshot.pid ? `PID: ${snapshot.pid}` : undefined,
		snapshot.error ? `Error: ${snapshot.error}` : undefined,
		"",
		"Task:",
		snapshot.task,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

export default function delegateExtension(pi: ExtensionAPI) {
	setupDelegateUi(pi, runner);

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a task to a fresh Pi agent session. Use for focused work in isolated context. Delegations are tracked and can be listed, checked, or killed.",
		promptSnippet: "Delegate focused work to a separate tracked Pi session",
		promptGuidelines: [
			"Use delegate when a task can run in a separate context while preserving this conversation.",
			"After starting a background delegation, use check_delegation or list_delegations to inspect progress.",
		],
		parameters: DelegateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadDelegateConfig(ctx);
			const task = params.task.trim();
			if (!task) return content("delegate requires a non-empty task.");

			const label = labelForTask(task, params.label);
			const depth = currentDepth();
			if (depth > 0 && (!config.nested.enabled || depth >= config.nested.maxDepth)) {
				let record: NestedBlockedRecord | undefined;
				if (config.nested.recordBlockedAttempts) record = await recordNestedBlocked(ctx, config, task, label, depth);
				return content(
					`Nested delegation blocked by config. ${record ? `Recorded as ${record.id}.` : ""}`.trim(),
					record,
				);
			}

			const overrides: DelegateCallOverrides = {
				label: params.label,
				waitForSeconds: params.waitForSeconds,
				timeoutMs: params.timeoutMs,
				tools: params.tools,
				extensions: params.extensions,
				model: params.model,
				cwd: params.cwd,
				projectTrust: params.projectTrust,
			};
			const { defaults, rejected, notes } = applyCallOverrides(config, overrides);
			if (rejected.length > 0) {
				return content(`Delegation rejected by config. Overrides not allowed: ${rejected.join(", ")}`);
			}

			const parentSessionId = rootParentSessionId(ctx);
			const parentSessionFile = rootParentSessionFile(ctx);
			const parentLeafId = rootParentLeafId(ctx);
			const startedAt = nowIso();

			const snapshot = await createStartedDelegation(config.storageDir, (number) => {
				const id = delegationId(parentSessionId, number);
				return {
					type: "delegate_registry",
					version: 1,
					kind: "delegation",
					event: "started",
					timestamp: startedAt,
					id,
					number,
					status: "starting",
					parentSessionId,
					parentSessionFile,
					parentLeafId,
					task,
					label,
					sessionName: sessionName(defaults, { parentSessionId, number, task, label }),
					cwd: ctx.cwd,
					startedAt,
					timeoutMs: defaults.timeoutMs,
					waitForSeconds: defaults.waitForSeconds,
					depth,
				};
			});

			const running = runner.start(pi, ctx, { config, defaults, snapshot, task, parentSessionId, depth, notes });
			if (defaults.waitForSeconds > 0) {
				const finished = await Promise.race([
					running.done.then((value) => value),
					delay(defaults.waitForSeconds * 1000).then(() => undefined),
				]);
				if (finished) {
					const output = finished.finalOutput || finished.lastOutput || "(no output)";
					return content(`${summarizeSnapshot(finished)}\n\nResult:\n${truncateText(output, 40_000)}`, finished);
				}
			}

			return content(
				[
					`Started delegation ${snapshot.id}`,
					`Status: running`,
					`Name: ${snapshot.sessionName}`,
					`Use check_delegation with id ${snapshot.id} to inspect progress.`,
					notes.length > 0 ? `Notes: ${notes.join("; ")}` : undefined,
				]
					.filter((line): line is string => line !== undefined)
					.join("\n"),
				running.getSnapshot(),
			);
		},
	});

	pi.registerTool({
		name: "list_delegations",
		label: "List Delegations",
		description: "List tracked delegations overall or for the current parent session, with status/search filters.",
		promptSnippet: "List tracked delegate sessions and nested delegation attempts",
		parameters: ListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadDelegateConfig(ctx);
			const scope = params.scope ?? "current_session";
			const status = params.status ?? "all";
			const includeNested = params.includeNested !== false;
			const parent = rootParentSessionId(ctx);
			const { delegations, nested } = await loadLatest(config);

			const grouped = new Map<string, string[]>();
			for (const snapshot of Array.from(delegations.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
				if (scope === "current_session" && snapshot.parentSessionId !== parent) continue;
				if (!statusMatches(status, snapshot.status)) continue;
				if (!matchesQuery(snapshot, params.query)) continue;
				const lines = grouped.get(snapshot.parentSessionId) ?? [];
				lines.push(`  ${delegationLine(snapshot)}`);
				grouped.set(snapshot.parentSessionId, lines);
			}

			if (includeNested && (status === "all" || status === "blocked")) {
				for (const record of nested) {
					const parentId = record.parentSessionId ?? "unknown";
					if (scope === "current_session" && parentId !== parent) continue;
					if (!matchesQuery(record, params.query)) continue;
					const lines = grouped.get(parentId) ?? [];
					lines.push(`  ${nestedLine(record)}`);
					grouped.set(parentId, lines);
				}
			}

			if (grouped.size === 0) return content("No delegations matched.");
			const output: string[] = [];
			for (const [parentId, lines] of grouped) {
				output.push(`Parent ${shortId(parentId)} (${parentId})`);
				output.push(...lines);
			}
			return content(output.join("\n"), { count: Array.from(grouped.values()).reduce((sum, lines) => sum + lines.length, 0) });
		},
	});

	pi.registerTool({
		name: "check_delegation",
		label: "Check Delegation",
		description: "Inspect a delegation by id. Reads registry metadata and the delegated Pi session when available.",
		promptSnippet: "Check status, result, or transcript of a tracked delegation",
		parameters: CheckParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadDelegateConfig(ctx);
			const mode = params.mode ?? "summary";
			const tailCount = Math.max(1, Math.min(100, Math.floor(params.tailCount ?? 12)));
			const { delegations, nested } = await loadLatest(config);
			const nestedRecord = nested.find((record) => record.id === params.id);
			if (nestedRecord) {
				return content(JSON.stringify(nestedRecord, null, 2), nestedRecord);
			}

			let snapshot = delegations.get(params.id);
			if (!snapshot) return content(`Unknown delegation id: ${params.id}`);
			snapshot = await ensureSessionFile(config, snapshot);
			const session = await parseSessionFile(snapshot.childSessionFile);
			const finalOutput = snapshot.finalOutput || finalAssistantOutput(session) || snapshot.lastOutput || "";

			if (mode === "metadata") {
				return content(JSON.stringify(snapshot, null, 2), snapshot);
			}

			if (mode === "tail") {
				const tail = formatSessionTail(session, tailCount) || snapshot.lastOutput || "(no session output yet)";
				return content(`${summarizeSnapshot(snapshot)}\n\nRecent session messages:\n${truncateText(tail, 50_000)}`, snapshot);
			}

			if (mode === "full") {
				const full = formatSessionFull(session) || snapshot.lastOutput || "(no session output yet)";
				return content(`${summarizeSnapshot(snapshot)}\n\nSession transcript:\n${truncateText(full, 80_000)}`, snapshot);
			}

			const result = finalOutput || "(no output yet)";
			return content(`${summarizeSnapshot(snapshot)}\n\nLatest result:\n${truncateText(result, 50_000)}`, snapshot);
		},
	});

	pi.registerTool({
		name: "kill_delegation",
		label: "Kill Delegation",
		description: "Terminate a running delegation by id.",
		promptSnippet: "Terminate a running delegated Pi session",
		parameters: KillParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await loadDelegateConfig(ctx);
			const live = runner.get(params.id);
			if (live) {
				const killed = await live.kill("killed");
				return content(`Killed delegation ${params.id}.`, killed);
			}

			const { delegations } = await loadLatest(config);
			const snapshot = delegations.get(params.id);
			if (!snapshot) return content(`Unknown delegation id: ${params.id}`);
			if (snapshot.status !== "running" && snapshot.status !== "starting") {
				return content(`Delegation ${params.id} is not running (status: ${snapshot.status}).`, snapshot);
			}
			if (!isPidAlive(snapshot.pid)) {
				const stale = await markStaleIfNeeded(config.storageDir, snapshot);
				return content(`Delegation ${params.id} is not running; marked ${stale.status}.`, stale);
			}

			try {
				process.kill(snapshot.pid!, "SIGTERM");
			} catch (error) {
				return content(`Failed to terminate ${params.id}: ${(error as Error).message}`, snapshot);
			}
			await delay(config.shutdown.killGraceMs);
			if (isPidAlive(snapshot.pid)) {
				try {
					process.kill(snapshot.pid!, "SIGKILL");
				} catch {
					// Ignore; status below records the kill request.
				}
			}

			const killed: DelegationSnapshot = {
				...snapshot,
				status: "killed" satisfies DelegationStatus,
				event: "finished",
				timestamp: nowIso(),
				finishedAt: nowIso(),
				error: "Killed by kill_delegation.",
			};
			await appendRegistryRecord(config.storageDir, killed);
			return content(`Killed delegation ${params.id}.`, killed);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const config = await loadDelegateConfig(ctx);
		await runner.shutdown(config);
	});
}
