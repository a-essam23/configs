import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DelegateConfig, DelegateDefaults, ToolsMode } from "./config.ts";
import { appendRegistryRecord, type DelegationSnapshot } from "./registry.ts";
import { findSessionFile } from "./sessions.ts";

export interface RunningDelegation {
	id: string;
	process: ChildProcessWithoutNullStreams;
	done: Promise<DelegationSnapshot>;
	getSnapshot: () => DelegationSnapshot;
	kill: (reason?: "killed" | "timeout") => Promise<DelegationSnapshot>;
}

export interface StartDelegationOptions {
	config: DelegateConfig;
	defaults: DelegateDefaults;
	snapshot: DelegationSnapshot;
	task: string;
	parentSessionId: string;
	parentSessionFile?: string;
	parentLeafId?: string;
	depth: number;
	notes: string[];
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function modelArg(pi: ExtensionAPI, ctx: ExtensionContext, model: DelegateDefaults["model"]): string | undefined {
	if (model === "default") return undefined;
	if (model === "inherit") {
		if (!ctx.model) return undefined;
		const base = `${ctx.model.provider}/${ctx.model.id}`;
		const thinking = pi.getThinkingLevel?.();
		return thinking && thinking !== "off" ? `${base}:${thinking}` : base;
	}
	return model;
}

function toolsArgs(pi: ExtensionAPI, tools: ToolsMode): string[] {
	if (tools === "default") return [];
	if (tools === "none") return ["--no-tools"];
	if (tools === "inherit") {
		const active = pi.getActiveTools?.() ?? [];
		return active.length > 0 ? ["--tools", active.join(",")] : [];
	}
	return tools.length > 0 ? ["--tools", tools.join(",")] : [];
}

function cwdFor(ctx: ExtensionContext, cwd: DelegateDefaults["cwd"]): string {
	if (cwd === "parent") return ctx.cwd;
	return path.isAbsolute(cwd) ? cwd : path.resolve(ctx.cwd, cwd);
}

function buildPrompt(task: string, snapshot: DelegationSnapshot): string {
	return [
		"You are a delegated Pi agent running in a separate session for a parent agent.",
		"Work normally and complete the delegated task. If you change files, summarize exactly what changed.",
		"",
		`Delegation id: ${snapshot.id}`,
		`Parent session id: ${snapshot.parentSessionId}`,
		snapshot.parentLeafId ? `Parent entry id: ${snapshot.parentLeafId}` : undefined,
		snapshot.parentSessionFile ? `Parent session file: ${snapshot.parentSessionFile}` : undefined,
		"",
		"Task:",
		task,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function textFromAssistantMessage(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

async function enrichChildSessionFile(config: DelegateConfig, snapshot: DelegationSnapshot): Promise<DelegationSnapshot> {
	if (!snapshot.childSessionId || snapshot.childSessionFile) return snapshot;
	const found = await findSessionFile(path.join(config.storageDir, snapshot.parentSessionId), snapshot.childSessionId);
	return found ? { ...snapshot, childSessionFile: found } : snapshot;
}

export class DelegationRunner {
	private running = new Map<string, RunningDelegation>();

	start(pi: ExtensionAPI, ctx: ExtensionContext, options: StartDelegationOptions): RunningDelegation {
		const { config, defaults, task, parentSessionId, depth, notes } = options;
		let snapshot = options.snapshot;
		let stderr = "";
		let stdoutBuffer = "";
		let settled = false;
		let forcedStatus: "killed" | "timeout" | undefined;
		let timeout: NodeJS.Timeout | undefined;

		const childSessionDir = path.join(config.storageDir, parentSessionId);
		void mkdir(childSessionDir, { recursive: true });

		const args = ["--mode", "json", "-p", "--session-dir", childSessionDir, "--name", snapshot.sessionName];

		const model = modelArg(pi, ctx, defaults.model);
		if (model) args.push("--model", model);

		args.push(...toolsArgs(pi, defaults.tools));

		if (defaults.extensions === "none") args.push("--no-extensions");

		if (defaults.projectTrust === "approve" || (defaults.projectTrust === "inherit" && ctx.isProjectTrusted())) {
			args.push("--approve");
		} else if (defaults.projectTrust === "deny" || (defaults.projectTrust === "inherit" && !ctx.isProjectTrusted())) {
			args.push("--no-approve");
		}

		args.push(buildPrompt(task, snapshot));

		const invocation = getPiInvocation(args);
		const childCwd = cwdFor(ctx, defaults.cwd);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: childCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_DELEGATION: "1",
				PI_DELEGATION_ID: snapshot.id,
				PI_DELEGATION_PARENT_SESSION_ID: parentSessionId,
				PI_DELEGATION_PARENT_SESSION_FILE: snapshot.parentSessionFile ?? "",
				PI_DELEGATION_PARENT_LEAF_ID: snapshot.parentLeafId ?? "",
				PI_DELEGATION_DEPTH: String(depth + 1),
				PI_DELEGATION_NONINTERACTIVE: "1",
			},
		});

		snapshot = {
			...snapshot,
			status: "running",
			event: "update",
			timestamp: new Date().toISOString(),
			pid: proc.pid,
			cwd: childCwd,
			lastOutput: notes.length > 0 ? notes.join("\n") : snapshot.lastOutput,
		};
		void appendRegistryRecord(config.storageDir, snapshot);

		const appendUpdate = async (patch: Partial<DelegationSnapshot>) => {
			snapshot = await enrichChildSessionFile(config, {
				...snapshot,
				...patch,
				event: patch.event ?? "update",
				timestamp: new Date().toISOString(),
			});
			await appendRegistryRecord(config.storageDir, snapshot);
		};

		const processJsonLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "session" && typeof event.id === "string") {
				void appendUpdate({ childSessionId: event.id });
				return;
			}

			if (event.type === "message_end" && event.message?.role === "assistant") {
				const output = textFromAssistantMessage(event.message);
				if (output) void appendUpdate({ lastOutput: output });
			}
		};

		proc.stdout.on("data", (data) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processJsonLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});

		const finish = async (status: DelegationSnapshot["status"], exitCode?: number | null, error?: string) => {
			if (settled) return snapshot;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (stdoutBuffer.trim()) processJsonLine(stdoutBuffer);
			const finalOutput = snapshot.lastOutput ?? "";
			snapshot = await enrichChildSessionFile(config, {
				...snapshot,
				status,
				event: "finished",
				timestamp: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				exitCode,
				error: error || (status === "failed" ? stderr.trim() || undefined : undefined),
				finalOutput,
			});
			await appendRegistryRecord(config.storageDir, snapshot);
			this.running.delete(snapshot.id);
			return snapshot;
		};

		const done = new Promise<DelegationSnapshot>((resolve) => {
			proc.on("close", (code) => {
				const status = forcedStatus ?? (code === 0 ? "done" : "failed");
				finish(status, code).then(resolve).catch(() => resolve(snapshot));
			});
			proc.on("error", (error) => {
				finish(forcedStatus ?? "failed", null, error.message).then(resolve).catch(() => resolve(snapshot));
			});
		});

		const kill = async (reason: "killed" | "timeout" = "killed") => {
			forcedStatus = reason;
			if (!settled) {
				try {
					proc.kill("SIGTERM");
				} catch {
					// Ignore; the process may have already exited.
				}
				await new Promise((resolve) => setTimeout(resolve, config.shutdown.killGraceMs));
				if (!settled && proc.pid) {
					try {
						process.kill(proc.pid, 0);
						proc.kill("SIGKILL");
					} catch {
						// Ignore; the process exited during the grace period.
					}
				}
			}
			return finish(reason, null, reason === "timeout" ? `Timed out after ${defaults.timeoutMs}ms` : undefined);
		};

		if (defaults.timeoutMs > 0) {
			timeout = setTimeout(() => {
				void kill("timeout");
			}, defaults.timeoutMs);
			timeout.unref?.();
		}

		const running: RunningDelegation = {
			id: snapshot.id,
			process: proc,
			done,
			getSnapshot: () => snapshot,
			kill,
		};
		this.running.set(snapshot.id, running);
		return running;
	}

	get(id: string): RunningDelegation | undefined {
		return this.running.get(id);
	}

	listRunning(): RunningDelegation[] {
		return Array.from(this.running.values());
	}

	async shutdown(config: DelegateConfig): Promise<void> {
		if (config.shutdown.runningDelegations !== "terminate") return;
		await Promise.all(this.listRunning().map((delegation) => delegation.kill("killed")));
	}
}
