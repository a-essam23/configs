import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type DelegationStatus = "starting" | "running" | "done" | "failed" | "killed" | "timeout" | "stale";
export type NestedStatus = "blocked";

export interface DelegationSnapshot {
	type: "delegate_registry";
	version: 1;
	kind: "delegation";
	event: "started" | "update" | "finished";
	timestamp: string;
	id: string;
	number: number;
	status: DelegationStatus;
	parentSessionId: string;
	parentSessionFile?: string;
	parentLeafId?: string;
	childSessionId?: string;
	childSessionFile?: string;
	pid?: number;
	task: string;
	label: string;
	sessionName: string;
	cwd: string;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number | null;
	error?: string;
	lastOutput?: string;
	finalOutput?: string;
	timeoutMs?: number;
	waitForSeconds?: number;
	depth: number;
}

export interface NestedBlockedRecord {
	type: "delegate_registry";
	version: 1;
	kind: "nested_blocked";
	event: "nested_blocked";
	status: NestedStatus;
	timestamp: string;
	id: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	parentLeafId?: string;
	sourceDelegationId?: string;
	childSessionId?: string;
	task: string;
	label: string;
	cwd: string;
	depth: number;
	reason: string;
}

export type RegistryRecord = DelegationSnapshot | NestedBlockedRecord;

export function indexPath(storageDir: string): string {
	return join(storageDir, "index.jsonl");
}

export async function appendRegistryRecord(storageDir: string, record: RegistryRecord): Promise<void> {
	const file = indexPath(storageDir);
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readRegistry(storageDir: string): Promise<RegistryRecord[]> {
	let text = "";
	try {
		text = await readFile(indexPath(storageDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const records: RegistryRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as RegistryRecord;
			if (parsed.type === "delegate_registry" && parsed.version === 1) records.push(parsed);
		} catch {
			// Ignore corrupt lines. The registry is append-only; one bad write should not break listing.
		}
	}
	return records;
}

export function latestDelegationSnapshots(records: RegistryRecord[]): Map<string, DelegationSnapshot> {
	const latest = new Map<string, DelegationSnapshot>();
	for (const record of records) {
		if (record.kind !== "delegation") continue;
		latest.set(record.id, record);
	}
	return latest;
}

export function nestedBlockedRecords(records: RegistryRecord[]): NestedBlockedRecord[] {
	return records.filter((record): record is NestedBlockedRecord => record.kind === "nested_blocked");
}

export async function createStartedDelegation(
	storageDir: string,
	makeRecord: (number: number) => DelegationSnapshot,
): Promise<DelegationSnapshot> {
	const file = indexPath(storageDir);
	return withFileMutationQueue(file, async () => {
		await mkdir(dirname(file), { recursive: true });
		const records = await readRegistry(storageDir);
		const draft = makeRecord(nextNumberForParent(records, makeRecord(0).parentSessionId));
		await appendFile(file, `${JSON.stringify(draft)}\n`, "utf8");
		return draft;
	});
}

function nextNumberForParent(records: RegistryRecord[], parentSessionId: string): number {
	let max = 0;
	for (const record of records) {
		if (record.kind !== "delegation") continue;
		if (record.parentSessionId !== parentSessionId) continue;
		if (record.number > max) max = record.number;
	}
	return max + 1;
}

export function isPidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function markStaleIfNeeded(storageDir: string, snapshot: DelegationSnapshot): Promise<DelegationSnapshot> {
	if (snapshot.status !== "running" && snapshot.status !== "starting") return snapshot;
	if (isPidAlive(snapshot.pid)) return snapshot;
	const stale: DelegationSnapshot = {
		...snapshot,
		status: "stale",
		event: "update",
		timestamp: new Date().toISOString(),
		finishedAt: snapshot.finishedAt ?? new Date().toISOString(),
		error: snapshot.error ?? "Process is no longer running and no final status was recorded.",
	};
	await appendRegistryRecord(storageDir, stale);
	return stale;
}
