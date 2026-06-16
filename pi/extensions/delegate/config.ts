import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ToolsMode = "inherit" | "default" | "none" | string[];
export type ExtensionsMode = "inherit" | "none";
export type ModelMode = "inherit" | "default" | string;
export type CwdMode = "parent" | string;
export type ProjectTrustMode = "inherit" | "approve" | "deny" | "default";
export type ShutdownMode = "terminate" | "leave-running";
export type DelegationUiScope = "current_session" | "all_sessions";
export type DelegationWidgetPlacement = "aboveEditor" | "belowEditor";

export interface DelegateDefaults {
	waitForSeconds: number;
	timeoutMs: number;
	tools: ToolsMode;
	extensions: ExtensionsMode;
	model: ModelMode;
	cwd: CwdMode;
	projectTrust: ProjectTrustMode;
	sessionNameTemplate: string;
}

export interface NestedConfig {
	enabled: boolean;
	maxDepth: number;
	recordBlockedAttempts: boolean;
}

export interface AgentOverridesConfig {
	allowed: string[];
	maxTimeoutMs: number;
	maxWaitForSeconds: number;
}

export interface ShutdownConfig {
	runningDelegations: ShutdownMode;
	killGraceMs: number;
}

export interface DelegateUiConfig {
	enabled: boolean;
	status: boolean;
	runningWidget: boolean;
	widgetPlacement: DelegationWidgetPlacement;
	pollIntervalMs: number;
	scope: DelegationUiScope;
	showCompletedForMs: number;
	maxWidgetItems: number;
}

export interface DelegateConfig {
	storageDir: string;
	defaults: DelegateDefaults;
	nested: NestedConfig;
	agentOverrides: AgentOverridesConfig;
	shutdown: ShutdownConfig;
	ui: DelegateUiConfig;
}

export interface DelegateCallOverrides {
	label?: string;
	waitForSeconds?: number;
	timeoutMs?: number;
	tools?: string;
	extensions?: ExtensionsMode;
	model?: string;
	cwd?: string;
	projectTrust?: ProjectTrustMode;
}

const DEFAULT_CONFIG: DelegateConfig = {
	storageDir: join(getAgentDir(), "delegations"),
	defaults: {
		waitForSeconds: 0,
		timeoutMs: 15 * 60 * 1000,
		tools: "default",
		extensions: "inherit",
		model: "inherit",
		cwd: "parent",
		projectTrust: "inherit",
		sessionNameTemplate: "delegate p:{parent8} #{number} — {slug}",
	},
	nested: {
		enabled: false,
		maxDepth: 0,
		recordBlockedAttempts: true,
	},
	agentOverrides: {
		allowed: ["label", "waitForSeconds", "timeoutMs", "tools", "extensions", "model", "cwd", "projectTrust"],
		maxTimeoutMs: 30 * 60 * 1000,
		maxWaitForSeconds: 5 * 60,
	},
	shutdown: {
		runningDelegations: "terminate",
		killGraceMs: 3000,
	},
	ui: {
		enabled: true,
		status: true,
		runningWidget: true,
		widgetPlacement: "belowEditor",
		pollIntervalMs: 2000,
		scope: "current_session",
		showCompletedForMs: 10_000,
		maxWidgetItems: 5,
	},
};

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base: DelegateConfig, partial: DeepPartial<DelegateConfig>): DelegateConfig {
	return {
		...base,
		...partial,
		defaults: { ...base.defaults, ...(isPlainObject(partial.defaults) ? partial.defaults : {}) },
		nested: { ...base.nested, ...(isPlainObject(partial.nested) ? partial.nested : {}) },
		agentOverrides: {
			...base.agentOverrides,
			...(isPlainObject(partial.agentOverrides) ? partial.agentOverrides : {}),
		},
		shutdown: { ...base.shutdown, ...(isPlainObject(partial.shutdown) ? partial.shutdown : {}) },
		ui: { ...base.ui, ...(isPlainObject(partial.ui) ? partial.ui : {}) },
	};
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${path}: ${(error as Error).message}`);
	}
}

function extensionConfigPath(): string | undefined {
	return typeof __dirname === "string" ? join(__dirname, "..", "..", "delegate.json") : undefined;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeStorageDir(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") return DEFAULT_CONFIG.storageDir;
	const expanded = value.startsWith("~/") ? join(process.env.HOME ?? getAgentDir(), value.slice(2)) : value;
	return resolve(expanded);
}

function normalizeTools(value: unknown, fallback: ToolsMode): ToolsMode {
	if (Array.isArray(value)) return stringArray(value, Array.isArray(fallback) ? fallback : []);
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed === "inherit" || trimmed === "default" || trimmed === "none") return trimmed;
	if (trimmed.includes(",")) return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
	return trimmed ? [trimmed] : fallback;
}

function normalizeExtensions(value: unknown, fallback: ExtensionsMode): ExtensionsMode {
	return value === "none" || value === "inherit" ? value : fallback;
}

function normalizeModel(value: unknown, fallback: ModelMode): ModelMode {
	if (value === "inherit" || value === "default") return value;
	if (typeof value === "string" && value.trim()) return value.trim();
	return fallback;
}

function normalizeCwd(value: unknown, fallback: CwdMode): CwdMode {
	if (value === "parent") return value;
	if (typeof value === "string" && value.trim()) return value.trim();
	return fallback;
}

function normalizeProjectTrust(value: unknown, fallback: ProjectTrustMode): ProjectTrustMode {
	return value === "inherit" || value === "approve" || value === "deny" || value === "default" ? value : fallback;
}

function normalizeShutdownMode(value: unknown, fallback: ShutdownMode): ShutdownMode {
	return value === "terminate" || value === "leave-running" ? value : fallback;
}

function normalizeUiScope(value: unknown, fallback: DelegationUiScope): DelegationUiScope {
	return value === "current_session" || value === "all_sessions" ? value : fallback;
}

function normalizeWidgetPlacement(value: unknown, fallback: DelegationWidgetPlacement): DelegationWidgetPlacement {
	return value === "aboveEditor" || value === "belowEditor" ? value : fallback;
}

function normalizeConfig(config: DelegateConfig): DelegateConfig {
	const maxTimeoutMs = numberInRange(
		config.agentOverrides.maxTimeoutMs,
		DEFAULT_CONFIG.agentOverrides.maxTimeoutMs,
		1000,
		24 * 60 * 60 * 1000,
	);
	const maxWaitForSeconds = numberInRange(
		config.agentOverrides.maxWaitForSeconds,
		DEFAULT_CONFIG.agentOverrides.maxWaitForSeconds,
		0,
		60 * 60,
	);

	return {
		storageDir: normalizeStorageDir(config.storageDir),
		defaults: {
			waitForSeconds: numberInRange(config.defaults.waitForSeconds, DEFAULT_CONFIG.defaults.waitForSeconds, 0, maxWaitForSeconds),
			timeoutMs: numberInRange(config.defaults.timeoutMs, DEFAULT_CONFIG.defaults.timeoutMs, 1000, maxTimeoutMs),
			tools: normalizeTools(config.defaults.tools, DEFAULT_CONFIG.defaults.tools),
			extensions: normalizeExtensions(config.defaults.extensions, DEFAULT_CONFIG.defaults.extensions),
			model: normalizeModel(config.defaults.model, DEFAULT_CONFIG.defaults.model),
			cwd: normalizeCwd(config.defaults.cwd, DEFAULT_CONFIG.defaults.cwd),
			projectTrust: normalizeProjectTrust(config.defaults.projectTrust, DEFAULT_CONFIG.defaults.projectTrust),
			sessionNameTemplate:
				typeof config.defaults.sessionNameTemplate === "string" && config.defaults.sessionNameTemplate.trim()
					? config.defaults.sessionNameTemplate
					: DEFAULT_CONFIG.defaults.sessionNameTemplate,
		},
		nested: {
			enabled: config.nested.enabled === true,
			maxDepth: numberInRange(config.nested.maxDepth, DEFAULT_CONFIG.nested.maxDepth, 0, 10),
			recordBlockedAttempts: config.nested.recordBlockedAttempts !== false,
		},
		agentOverrides: {
			allowed: stringArray(config.agentOverrides.allowed, DEFAULT_CONFIG.agentOverrides.allowed),
			maxTimeoutMs,
			maxWaitForSeconds,
		},
		shutdown: {
			runningDelegations: normalizeShutdownMode(
				config.shutdown.runningDelegations,
				DEFAULT_CONFIG.shutdown.runningDelegations,
			),
			killGraceMs: numberInRange(config.shutdown.killGraceMs, DEFAULT_CONFIG.shutdown.killGraceMs, 100, 60_000),
		},
		ui: {
			enabled: config.ui.enabled !== false,
			status: config.ui.status !== false,
			runningWidget: config.ui.runningWidget !== false,
			widgetPlacement: normalizeWidgetPlacement(config.ui.widgetPlacement, DEFAULT_CONFIG.ui.widgetPlacement),
			pollIntervalMs: numberInRange(config.ui.pollIntervalMs, DEFAULT_CONFIG.ui.pollIntervalMs, 500, 60_000),
			scope: normalizeUiScope(config.ui.scope, DEFAULT_CONFIG.ui.scope),
			showCompletedForMs: numberInRange(config.ui.showCompletedForMs, DEFAULT_CONFIG.ui.showCompletedForMs, 0, 10 * 60_000),
			maxWidgetItems: numberInRange(config.ui.maxWidgetItems, DEFAULT_CONFIG.ui.maxWidgetItems, 1, 20),
		},
	};
}

export async function loadDelegateConfig(ctx: ExtensionContext): Promise<DelegateConfig> {
	let config = { ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults } };

	const extensionPath = extensionConfigPath();
	if (extensionPath) {
		const extensionConfig = await readJsonIfExists<DeepPartial<DelegateConfig>>(extensionPath);
		if (extensionConfig) config = mergeConfig(config, extensionConfig);
	}

	const globalPath = join(getAgentDir(), "delegate.json");
	const globalConfig = await readJsonIfExists<DeepPartial<DelegateConfig>>(globalPath);
	if (globalConfig) config = mergeConfig(config, globalConfig);

	const projectPath = join(ctx.cwd, ".pi", "delegate.json");
	if (ctx.isProjectTrusted() && existsSync(projectPath)) {
		const projectConfig = await readJsonIfExists<DeepPartial<DelegateConfig>>(projectPath);
		if (projectConfig) config = mergeConfig(config, projectConfig);
	}

	return normalizeConfig(config);
}

export function applyCallOverrides(
	config: DelegateConfig,
	overrides: DelegateCallOverrides,
): { defaults: DelegateDefaults; rejected: string[]; notes: string[] } {
	const defaults: DelegateDefaults = { ...config.defaults };
	const rejected: string[] = [];
	const notes: string[] = [];
	const allowed = new Set(config.agentOverrides.allowed);

	const apply = <K extends keyof DelegateCallOverrides>(key: K, fn: (value: NonNullable<DelegateCallOverrides[K]>) => void) => {
		const value = overrides[key];
		if (value === undefined) return;
		if (!allowed.has(key)) {
			rejected.push(key);
			return;
		}
		fn(value as NonNullable<DelegateCallOverrides[K]>);
	};

	apply("waitForSeconds", (value) => {
		const next = numberInRange(value, defaults.waitForSeconds, 0, config.agentOverrides.maxWaitForSeconds);
		if (next !== value) notes.push(`waitForSeconds capped at ${next}`);
		defaults.waitForSeconds = next;
	});

	apply("timeoutMs", (value) => {
		const next = numberInRange(value, defaults.timeoutMs, 1000, config.agentOverrides.maxTimeoutMs);
		if (next !== value) notes.push(`timeoutMs capped at ${next}`);
		defaults.timeoutMs = next;
	});

	apply("tools", (value) => {
		defaults.tools = normalizeTools(value, defaults.tools);
	});

	apply("extensions", (value) => {
		defaults.extensions = normalizeExtensions(value, defaults.extensions);
	});

	apply("model", (value) => {
		defaults.model = normalizeModel(value, defaults.model);
	});

	apply("cwd", (value) => {
		defaults.cwd = normalizeCwd(value, defaults.cwd);
	});

	apply("projectTrust", (value) => {
		defaults.projectTrust = normalizeProjectTrust(value, defaults.projectTrust);
	});

	if (overrides.label !== undefined && !allowed.has("label")) rejected.push("label");

	return { defaults, rejected, notes };
}
