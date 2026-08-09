import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface DeltaEntry {
	time: number;
	chars: number;
}

const WINDOW_MS = 3000;

function currentTps(window: DeltaEntry[]): number {
	if (window.length < 2) return 0;
	const first = window[0]!;
	const last = window[window.length - 1]!;
	const durationMs = last.time - first.time;
	if (durationMs <= 0) return 0;

	let totalChars = 0;
	for (const entry of window) {
		totalChars += entry.chars;
	}
	return totalChars / 4 / (durationMs / 1000);
}

function pruneWindow(window: DeltaEntry[], now: number): void {
	const cutoff = now - WINDOW_MS;
	while (window.length > 0 && window[0]!.time < cutoff) {
		window.shift();
	}
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;
	let deltaWindow: DeltaEntry[] = [];
	let currentCtx: ExtensionContext | null = null;
	let totalOutputChars = 0;

	function stop() {
		agentStartMs = null;
		deltaWindow = [];
		currentCtx = null;
		totalOutputChars = 0;
	}

	function updateWorkingMessage() {
		if (agentStartMs === null || !currentCtx) return;

		const now = Date.now();
		pruneWindow(deltaWindow, now);

		const totalElapsed = (now - agentStartMs) / 1000;
		const tps = currentTps(deltaWindow);
		const theme = currentCtx.ui.theme;

		let msg: string;
		if (tps > 0) {
			const estimatedTokens = Math.round(totalOutputChars / 4);
			msg =
				theme.fg("accent", `${tps.toFixed(0)} tok/s`) +
				theme.fg("dim", `  │  ${estimatedTokens.toLocaleString()} out  │  ${totalElapsed.toFixed(1)}s`);
		} else if (deltaWindow.length > 0) {
			// Window is building up (< 2 entries)
			msg = theme.fg("dim", `${totalElapsed.toFixed(1)}s`);
		} else if (totalOutputChars > 0) {
			// Was streaming but window emptied (tool execution)
			const estimatedTokens = Math.round(totalOutputChars / 4);
			msg = theme.fg("dim", `tool…  │  ${estimatedTokens.toLocaleString()} out  │  ${totalElapsed.toFixed(1)}s`);
		} else {
			msg = theme.fg("dim", `${totalElapsed.toFixed(1)}s`);
		}
		currentCtx.ui.setWorkingMessage(msg);
	}

	pi.on("agent_start", (_event, ctx) => {
		agentStartMs = Date.now();
		deltaWindow = [];
		totalOutputChars = 0;
		currentCtx = ctx;
	});

	pi.on("message_update", (event) => {
		if (agentStartMs === null) return;

		const ev = event.assistantMessageEvent;
		let chars = 0;

		if (ev.type === "text_delta") {
			chars = ev.delta.length;
		} else if (ev.type === "thinking_delta") {
			chars = ev.delta.length;
		} else if (ev.type === "toolcall_delta") {
			chars = ev.delta.length;
		}

		if (chars > 0) {
			const now = Date.now();
			pruneWindow(deltaWindow, now);
			deltaWindow.push({ time: now, chars });
			totalOutputChars += chars;
		}

		// Sync with real usage when available
		if ("partial" in ev && ev.partial.usage?.output) {
			totalOutputChars = ev.partial.usage.output * 4;
		} else if (ev.type === "done" && ev.message.usage?.output) {
			totalOutputChars = ev.message.usage.output * 4;
		}

		updateWorkingMessage();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) {
			stop();
			return;
		}

		const elapsedMs = agentStartMs ? Date.now() - agentStartMs : 0;
		stop();

		ctx.ui.setWorkingMessage();

		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!message || typeof message !== "object") continue;
			const m = message as { role?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
			if (m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input ?? 0;
			output += m.usage.output ?? 0;
			cacheRead += m.usage.cacheRead ?? 0;
			cacheWrite += m.usage.cacheWrite ?? 0;
			totalTokens += m.usage.totalTokens ?? 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const msg = `TPS ${tokensPerSecond.toFixed(1)} tok/s  │  out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
		ctx.ui.notify(msg, "info");
	});

	pi.on("session_shutdown", () => {
		stop();
		if (currentCtx) {
			currentCtx.ui.setWorkingMessage();
		}
	});
}
