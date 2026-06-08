/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 *
 * Patterns checked:
 *   rm -rf / recursive rm
 *   sudo
 *   chmod / chown 777
 *   git push --force / -f
 *   git reset --hard
 *   git clean -f
 *   git commit
 *   git checkout
 *   curl | sh / wget | bash
 *   dd writing to /dev/ block devices
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [
		/\brm\s+(-rf?|--recursive)/i,
		/\bsudo\b/i,
		/\b(chmod|chown)\b.*777/i,
		/\bgit\s+push\s+.*-(f\b|-force)/i,
		/\bgit\s+reset\s+--hard\b/i,
		/\bgit\s+clean\s+.*-f/i,
		/\bgit\s+commit\b/i,
		/\bgit\s+checkout\b/i,
		/\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
		/\bdd\s+.*of=\/dev\//i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
