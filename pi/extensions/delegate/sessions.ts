import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ParsedSession {
	header?: { id?: string; cwd?: string; timestamp?: string; [key: string]: unknown };
	entries: any[];
}

export async function findSessionFile(rootDir: string, sessionId: string | undefined): Promise<string | undefined> {
	if (!sessionId) return undefined;
	const files = await findJsonlFiles(rootDir);
	for (const file of files) {
		try {
			const text = await readFile(file, "utf8");
			const firstLine = text.split("\n", 1)[0];
			if (!firstLine) continue;
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return file;
		} catch {
			// Ignore unreadable/corrupt session files.
		}
	}
	return undefined;
}

async function findJsonlFiles(dir: string): Promise<string[]> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findJsonlFiles(fullPath)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(fullPath);
		}
	}
	return files;
}

export async function parseSessionFile(path: string | undefined): Promise<ParsedSession> {
	if (!path) return { entries: [] };
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { entries: [] };
	}

	const parsed: ParsedSession = { entries: [] };
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (index === 0 && entry.type === "session") parsed.header = entry;
			else parsed.entries.push(entry);
		} catch {
			// Ignore corrupt lines.
		}
	}
	return parsed;
}

export function textFromMessage(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) {
		if (typeof message.summary === "string") return message.summary;
		if (typeof message.output === "string") return message.output;
		return "";
	}

	const parts: string[] = [];
	for (const part of message.content) {
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part?.type === "toolCall") parts.push(`[tool_call ${part.name ?? "unknown"}]`);
		else if (part?.type === "thinking" && typeof part.thinking === "string") parts.push(`[thinking omitted]`);
		else if (part?.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

export function finalAssistantOutput(session: ParsedSession): string {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const entry = session.entries[i];
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const text = textFromMessage(entry.message).trim();
		if (text) return text;
	}
	return "";
}

export function formatSessionTail(session: ParsedSession, count: number): string {
	const messageEntries = session.entries.filter((entry) => entry?.type === "message");
	return formatEntries(messageEntries.slice(-Math.max(1, count)));
}

export function formatSessionFull(session: ParsedSession): string {
	return formatEntries(session.entries.filter((entry) => entry?.type === "message"));
}

function formatEntries(entries: any[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const msg = entry.message;
		if (!msg) continue;
		const role = msg.role ?? "message";
		if (role === "toolResult") {
			const body = indent(textFromMessage(msg).trim() || "(empty)");
			lines.push(`toolResult:${msg.toolName ? ` ${msg.toolName}` : ""}\n${body}`);
			continue;
		}
		if (role === "assistant") {
			const text = textFromMessage(msg).trim();
			const stop = msg.stopReason ? ` [${msg.stopReason}]` : "";
			lines.push(`assistant${stop}\n${indent(text || "(empty)")}`);
			continue;
		}
		lines.push(`${role}\n${indent(textFromMessage(msg).trim() || "(empty)")}`);
	}
	return lines.join("\n\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(0, maxChars - 120);
	return `${text.slice(0, keep)}\n\n[truncated: ${text.length - keep} chars omitted]`;
}
