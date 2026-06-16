import type { DelegateDefaults } from "./config.ts";

export function shortId(id: string | undefined, length = 8): string {
	if (!id) return "unknown";
	return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, length) || "unknown";
}

export function padNumber(number: number): string {
	return String(number).padStart(3, "0");
}

export function delegationId(parentSessionId: string, number: number): string {
	return `del_${shortId(parentSessionId)}_${padNumber(number)}`;
}

export function nestedBlockedId(sourceDelegationId: string | undefined): string {
	const source = sourceDelegationId?.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
	return `nested_${source}_${Date.now().toString(36)}`;
}

export function taskSlug(task: string, fallback = "delegation"): string {
	const cleaned = task
		.replace(/[`*_#[\]()>~|{}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > 52 ? `${cleaned.slice(0, 49).trim()}…` : cleaned;
}

export function labelForTask(task: string, label?: string): string {
	return taskSlug(label?.trim() || task);
}

export function sessionName(
	defaults: DelegateDefaults,
	params: { parentSessionId: string; number: number; task: string; label?: string },
): string {
	const parent8 = shortId(params.parentSessionId);
	const number = padNumber(params.number);
	const slug = labelForTask(params.task, params.label);
	return defaults.sessionNameTemplate
		.replaceAll("{parent}", params.parentSessionId)
		.replaceAll("{parent8}", parent8)
		.replaceAll("{number}", number)
		.replaceAll("{slug}", slug);
}
