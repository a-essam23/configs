import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTps from "./tps.ts";
import registerUsage from "./usage.ts";
import registerSystemPromptDebug from "./system-prompt-debug.ts";
import registerDeepseekPeak from "./deepseek-peak.ts";

export default function observabilityExtension(pi: ExtensionAPI): void {
  registerTps(pi);
  registerUsage(pi);
  registerSystemPromptDebug(pi);
  registerDeepseekPeak(pi);
}
