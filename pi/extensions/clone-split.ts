import { existsSync, unlinkSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

function createClonedSession(
  ctx: ExtensionContext,
  entryId: string,
  sourceSession: string,
): string {
  const sourceManager = SessionManager.open(
    sourceSession,
    ctx.sessionManager.getSessionDir(),
  );
  const clonedSession = sourceManager.createBranchedSession(entryId);
  if (!clonedSession) {
    throw new Error("Pi did not create the cloned session");
  }
  return clonedSession;
}

function buildGhosttyScript(command: string, cwd: string): string {
  const scriptCommand = appleScriptString(command);
  const scriptCwd = appleScriptString(cwd);

  return `tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to ${scriptCommand}
    set initial working directory of cfg to ${scriptCwd}
    set currentTerminal to focused terminal of selected tab of front window
    set newTerminal to split currentTerminal direction right with configuration cfg
end tell`;
}

async function openCloneInGhostty(
  pi: ExtensionAPI,
  sessionFile: string,
  cwd: string,
): Promise<void> {
  const cliPath = process.argv[1];
  const command = cliPath
    ? `${shellQuote(process.execPath)} ${shellQuote(cliPath)} --session ${shellQuote(sessionFile)}`
    : `pi --session ${shellQuote(sessionFile)}`;
  const script = buildGhosttyScript(command, cwd);
  const result = await pi.exec("osascript", ["-e", script], { timeout: 10_000 });

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `osascript exited with code ${result.code}`);
  }
}

export default function cloneSplitExtension(pi: ExtensionAPI): void {
  pi.on("session_before_fork", async (event, ctx) => {
    // /clone is represented as a fork at the current entry.
    if (event.position !== "at" || process.platform !== "darwin") return;

    const sourceSession = ctx.sessionManager.getSessionFile();
    if (!sourceSession || !existsSync(sourceSession)) return;

    let clonedSession: string | undefined;
    try {
      clonedSession = createClonedSession(ctx, event.entryId, sourceSession);
      await openCloneInGhostty(pi, clonedSession, ctx.cwd);
      ctx.ui.notify("Clone opened in a right-side Ghostty split", "info");
      return { cancel: true };
    } catch (error) {
      if (clonedSession && existsSync(clonedSession)) {
        unlinkSync(clonedSession);
      }

      ctx.ui.notify(
        `Could not open the clone in Ghostty; using native /clone instead: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    }
  });
}
