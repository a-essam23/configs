import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  SessionEntry,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Markdown,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme, renderDiff } from "@mariozechner/pi-coding-agent";

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part: any) => {
        if (part?.type === "text" && typeof part.text === "string")
          return part.text;
        if (part?.type === "image") return "[image]";
        if (part?.type === "toolCall") return `↳ ${part.name || "tool"}`;
        if (part?.type === "toolResult")
          return part.isError
            ? `✗ ${part.toolName || "tool"}`
            : `✓ ${part.toolName || "tool"}`;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function roleLabel(role: string | undefined): string {
  if (role === "assistant") return "pi";
  if (
    role === "tool" ||
    role === "toolResult" ||
    role === "toolCall" ||
    role === "bashExecution"
  )
    return "tool";
  return role || "msg";
}

function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function mouseWheelDirection(data: string): "up" | "down" | undefined {
  const esc = String.fromCharCode(27);
  const match = new RegExp(`${esc}\\[<(?<button>\\d+);\\d+;\\d+[mM]`).exec(
    data,
  );
  if (!match?.groups?.button) return undefined;
  const button = Number(match.groups.button);
  if (button === 64) return "up";
  if (button === 65) return "down";
  return undefined;
}

function loadHideThinkingDefault(): boolean {
  try {
    const settingsPath = path.join(
      process.env.USERPROFILE || "",
      ".pi",
      "agent",
      "settings.json",
    );
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.hideThinkingBlock !== false;
  } catch {
    return true;
  }
}

function shortenPath(rawPath: string, cwd: string): string {
  const absolutePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(cwd, rawPath);
  const bases = [process.env.USERPROFILE, cwd];
  for (const base of bases) {
    if (!base) continue;
    const relative = path.relative(path.resolve(base), absolutePath);
    if (relative === "") return "~";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `~\\${relative}`;
    }
  }
  return rawPath;
}

interface ToolCallInfo {
  name: string;
  arguments: Record<string, any>;
  timestamp?: number;
}

function renderBashCall(
  args: Record<string, any> | undefined,
  theme: Theme,
  width: number,
): string {
  const command =
    typeof args?.command === "string" && args.command ? args.command : "...";
  const timeout =
    typeof args?.timeout === "number"
      ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
      : "";
  return theme.bg(
    "toolSuccessBg",
    fitLine(
      `${theme.fg("toolTitle", theme.bold(`  $ ${command}`))}${timeout}`,
      width,
    ),
  );
}

function renderBashToolResult(
  msg: any,
  call: ToolCallInfo | undefined,
  theme: Theme,
  width: number,
): string[] {
  const text = messageText(msg).replace(/\r\n/g, "\n").trim();
  const outputLines = text ? text.split("\n") : [];
  const visibleLines = outputLines.slice(-5);
  const skipped = Math.max(0, outputLines.length - visibleLines.length);
  const out = ["", renderBashCall(call?.arguments, theme, width)];
  if (skipped > 0) {
    out.push(theme.bg("toolSuccessBg", fitLine("", width)));
    out.push(
      theme.bg(
        "toolSuccessBg",
        fitLine(theme.fg("muted", `  ... (${skipped} earlier lines)`), width),
      ),
    );
  }
  if (visibleLines.length > 0) {
    out.push(theme.bg("toolSuccessBg", fitLine("", width)));
    out.push(
      ...visibleLines.map((line) =>
        theme.bg(
          "toolSuccessBg",
          fitLine(theme.fg("toolOutput", `  ${line}`), width),
        ),
      ),
    );
  }
  if (
    typeof call?.timestamp === "number" &&
    typeof msg.timestamp === "number"
  ) {
    const elapsed = Math.max(0, msg.timestamp - call.timestamp) / 1000;
    out.push(theme.bg("toolSuccessBg", fitLine("", width)));
    out.push(
      theme.bg(
        "toolSuccessBg",
        fitLine(theme.fg("muted", `  Took ${elapsed.toFixed(1)}s`), width),
      ),
    );
  }
  out.push("");
  return out;
}

function renderEditDiff(diff: string, theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  return renderDiff(diff)
    .split("\n")
    .slice(0, 30)
    .flatMap((line) => {
      const wrapped = wrapTextWithAnsi(line, contentWidth);
      if (wrapped.length === 0) {
        return [theme.bg("toolSuccessBg", fitLine("", width))];
      }
      return wrapped.map((segment) =>
        theme.bg("toolSuccessBg", fitLine(`  ${segment}`, width)),
      );
    });
}

function renderMessageBlock(
  entry: any,
  index: number,
  theme: Theme,
  width: number,
  toolCalls?: Map<string, ToolCallInfo>,
  completedToolCallIds?: Set<string>,
  hideThinkingBlocks = true,
  cwd = "",
): string[] {
  const msg = entry.message;
  const role = roleLabel(msg?.role);
  const available = Math.max(10, width - 4);
  const bodyTheme = getMarkdownTheme();

  if (msg?.role === "assistant" && Array.isArray(msg.content)) {
    const out: string[] = [];
    let lastWasTool = false;
    let lastWasThinking = false;
    const hasVisibleContent = msg.content.some(
      (c: any) =>
        (c?.type === "text" && c.text.trim()) ||
        (c?.type === "thinking" && c.thinking.trim()),
    );
    if (hasVisibleContent) out.push("");

    for (const part of msg.content) {
      if (
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        if (out.length && (lastWasTool || lastWasThinking)) out.push("");
        const md = new Markdown(part.text.trim(), 1, 0, bodyTheme, {
          color: (t) => t,
        });
        out.push(...md.render(width));
        lastWasTool = false;
        lastWasThinking = false;
        continue;
      }
      if (part?.type === "thinking" && part.thinking?.trim()) {
        if (out.length && !lastWasTool) out.push("");
        if (hideThinkingBlocks) {
          out.push(theme.fg("thinkingText", theme.italic("Thinking...")));
        } else {
          const thinkingMd = new Markdown(
            part.thinking.trim(),
            1,
            0,
            bodyTheme,
            {
              color: (text) => theme.fg("thinkingText", text),
              italic: true,
            },
          );
          out.push(...thinkingMd.render(width));
        }
        lastWasTool = false;
        lastWasThinking = true;
        continue;
      }
      if (part?.type === "toolCall") {
        if (part.name === "bash" && completedToolCallIds?.has(part.id))
          continue;
        if (out.length && !lastWasTool) out.push("");
        if (part.name === "bash") {
          out.push(renderBashCall(part.arguments, theme, width));
          lastWasTool = true;
          lastWasThinking = false;
          continue;
        }
        const name = part.name || "tool";
        const rawPath =
          typeof part.arguments?.path === "string"
            ? part.arguments.path
            : undefined;
        const offset = part.arguments?.offset;
        const limit = part.arguments?.limit;
        const startLine = offset ?? (limit !== undefined ? 1 : undefined);
        const endLine =
          startLine !== undefined && limit !== undefined
            ? startLine + limit - 1
            : "";
        const range =
          startLine !== undefined
            ? theme.fg(
                "warning",
                `:${startLine}${endLine ? `-${endLine}` : ""}`,
              )
            : "";
        const displayPath = rawPath ? shortenPath(rawPath, cwd) : undefined;
        const pathLabel = displayPath
          ? `${theme.fg("accent", displayPath)}${range}`
          : undefined;
        const label = pathLabel
          ? `${theme.fg("toolTitle", theme.bold(name))} ${pathLabel}`
          : theme.fg("toolTitle", theme.bold(name));
        const pad = "  ";
        out.push(theme.bg("toolSuccessBg", fitLine(`${pad}${label}`, width)));
        lastWasTool = true;
        lastWasThinking = false;
      }
      if (part?.type === "toolResult") {
        if (out.length && !lastWasTool) out.push("");
        const text = typeof part.text === "string" ? part.text : "";
        const rawContent = text
          .split("\n")
          .filter(
            (l: string) =>
              l.trim() &&
              !l.includes("Use offset=") &&
              !l.includes("[Showing lines") &&
              !l.includes("[Truncated"),
          );
        while (
          rawContent.length > 0 &&
          rawContent[rawContent.length - 1] === ""
        )
          rawContent.pop();
        const content = rawContent.slice(0, 10);
        const remaining = rawContent.length - content.length;
        const pad = "  ";
        out.push(theme.bg("toolSuccessBg", fitLine("", width)));
        for (const line of content) {
          out.push(
            theme.bg(
              "toolSuccessBg",
              fitLine(theme.fg("toolOutput", `${pad}${line}`), width),
            ),
          );
        }
        if (remaining > 0) {
          out.push(
            theme.bg(
              "toolSuccessBg",
              fitLine(
                theme.fg("muted", `  ... (${remaining} more lines)`),
                width,
              ),
            ),
          );
        }
        lastWasTool = true;
        lastWasThinking = false;
      }
    }
    return out.length ? out : [theme.fg("dim", "(empty)")];
  }

  if (msg?.role === "toolCall") {
    const text = messageText(msg).replace(/\r\n/g, "\n").trim();
    const firstLine = (
      text.split("\n").find((line) => line.trim()) || "tool"
    ).trim();
    return [
      theme.bg(
        "toolSuccessBg",
        fitLine(
          theme.fg(
            "toolTitle",
            `  ${truncateToWidth(firstLine, available, "…")}`,
          ),
          width,
        ),
      ),
    ];
  }

  if (msg?.role === "toolResult") {
    const text = messageText(msg).replace(/\r\n/g, "\n").trim();
    const diff = typeof msg.details?.diff === "string" ? msg.details.diff : "";
    const toolCall = toolCalls?.get(msg.toolCallId);
    if (msg.toolName === "bash" || toolCall?.name === "bash") {
      return renderBashToolResult(msg, toolCall, theme, width);
    }
    if (msg.toolName !== "edit" || !diff) {
      const cleanLines = text.split("\n");
      while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === "")
        cleanLines.pop();
      const displayLines = cleanLines.slice(0, 10);
      const remaining = cleanLines.length - displayLines.length;
      const toolCallPath = toolCall?.arguments?.path;
      const ext =
        typeof toolCallPath === "string"
          ? toolCallPath.split(".").pop()?.toLowerCase()
          : undefined;
      const langMap: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        rs: "rust",
        go: "go",
        java: "java",
        rb: "ruby",
        c: "c",
        cpp: "cpp",
        h: "c",
        hpp: "cpp",
        cs: "csharp",
        php: "php",
        sh: "bash",
        json: "json",
        yaml: "yaml",
        yml: "yaml",
        md: "markdown",
        html: "html",
        css: "css",
        scss: "scss",
        sql: "sql",
        toml: "toml",
        xml: "xml",
      };
      const lang = ext ? langMap[ext] : undefined;
      const highlighted = lang
        ? bodyTheme.highlightCode!(
            displayLines.join("\n").replace(/\t/g, "   "),
            lang,
          )
        : displayLines.map((l) => theme.fg("toolOutput", l));
      const resultLines = [
        theme.bg("toolSuccessBg", fitLine("", width)),
        ...highlighted.map((hlLine: string) =>
          theme.bg("toolSuccessBg", fitLine(`  ${hlLine}`, width)),
        ),
      ];
      if (remaining > 0) {
        resultLines.push(
          theme.bg(
            "toolSuccessBg",
            fitLine(
              theme.fg("muted", `  ... (${remaining} more lines)`),
              width,
            ),
          ),
        );
      }
      return resultLines;
    }

    return renderEditDiff(diff, theme, width);
  }

  if (msg?.role === "bashExecution") {
    const text = messageText(msg).replace(/\r\n/g, "\n").trim();
    if (!text || text === "(empty)") return [];
    const firstLine = (
      text.split("\n").find((line) => line.trim()) || "bash"
    ).trim();
    return [
      "",
      theme.bg(
        "toolSuccessBg",
        fitLine(
          theme.fg(
            "toolTitle",
            `  $ ${truncateToWidth(firstLine, available, "…")}`,
          ),
          width,
        ),
      ),
    ];
  }

  if (role === "pi") {
    const text = messageText(msg).trim();
    if (!text) return [];
    const md = new Markdown(text, 1, 0, bodyTheme, { color: (t) => t });
    return ["", ...md.render(width)];
  }

  const text = messageText(msg).replace(/\r\n/g, "\n").trim();
  const color = role === "you" ? "accent" : "muted";
  const body = text
    ? text
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line || " ", available))
    : [theme.fg("dim", "(empty)")];
  const bodyLines = body.map((line) =>
    role === "user"
      ? theme.bg("userMessageBg", fitLine(`  ${line}`, width))
      : `  ${line}`,
  );
  if (role === "user")
    return [
      theme.bg("userMessageBg", fitLine("", width)),
      ...bodyLines,
      theme.bg("userMessageBg", fitLine("", width)),
      "",
    ];
  return [theme.fg(color as any, theme.bold(role)), ...bodyLines, ""];
}

function renderSession(
  theme: Theme,
  width: number,
  height: number,
  scroll: number,
  input: string,
  bodyLines: string[],
): string[] {
  const rows = Math.max(8, height);
  const viewport = Math.max(1, rows - 6);
  const maxScroll = Math.max(0, bodyLines.length - viewport);
  const normalizedScroll = Math.min(scroll, maxScroll);
  const start = Math.max(0, bodyLines.length - viewport - normalizedScroll);
  const visible =
    bodyLines.length > 0 ? bodyLines.slice(start, start + viewport) : [];
  const lines = [
    ...visible,
    "─".repeat(width),
    theme.fg("accent", input),
    "─".repeat(width),
  ];

  return lines.slice(0, rows).map((line) => fitLine(line, width));
}

export default function openTuiExtension(pi: ExtensionAPI) {
  let terminalRef: any;
  let terminalModesEnabled = false;
  const enableTerminalModes = () => {
    if (!terminalRef || terminalModesEnabled) return;
    terminalModesEnabled = true;
    terminalRef.write("\x1b[?1049h\x1b[?1007h");
  };
  const disableTerminalModes = () => {
    if (!terminalRef || !terminalModesEnabled) return;
    terminalModesEnabled = false;
    terminalRef.write("\x1b[?1007l\x1b[?1049l");
  };

  pi.on("session_shutdown", async () => {
    disableTerminalModes();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const { CustomEditor } = await import("@mariozechner/pi-coding-agent");
    let currentEditor: any;
    let scroll = 0;
    let hideThinkingBlocks = loadHideThinkingDefault();
    let cachedWidth = 0;
    let cachedEntryCount = -1;
    let cachedBodyLines: string[] = [];
    let cachedAssistantBlockStarts: number[] = [];
    let lastRenderWidth = 0;
    const invalidateBodyCache = () => {
      cachedWidth = 0;
      cachedEntryCount = -1;
      cachedBodyLines = [];
      cachedAssistantBlockStarts = [];
    };

    const getBodyLines = (width: number) => {
      const entries = ctx.sessionManager.getEntries();
      if (cachedWidth === width && cachedEntryCount === entries.length)
        return cachedBodyLines;
      cachedWidth = width;
      cachedEntryCount = entries.length;
      const messageEntries = entries.filter(
        (
          entry: SessionEntry,
        ): entry is Extract<SessionEntry, { type: "message" }> =>
          entry.type === "message",
      );
      const toolCalls = new Map<string, ToolCallInfo>();
      const completedToolCallIds = new Set<string>();
      for (const entry of messageEntries) {
        const msg = entry.message;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === "toolCall") {
              toolCalls.set(part.id, {
                name: part.name,
                arguments: part.arguments,
                timestamp: msg.timestamp,
              });
            }
          }
        }
        if (msg?.role === "toolResult") {
          completedToolCallIds.add(msg.toolCallId);
        }
      }
      const bodyLines: string[] = [];
      const assistantBlockStarts: number[] = [];
      for (let index = 0; index < messageEntries.length; index++) {
        const entry = messageEntries[index]!;
        const lines = renderMessageBlock(
          entry,
          index,
          ctx.ui.theme,
          width,
          toolCalls,
          completedToolCallIds,
          hideThinkingBlocks,
          ctx.cwd,
        );

        if (entry.message?.role === "assistant" && lines.length > 0) {
          assistantBlockStarts.push(bodyLines.length);
        }
        bodyLines.push(...lines);
      }
      cachedBodyLines = bodyLines;
      cachedAssistantBlockStarts = assistantBlockStarts;
      return cachedBodyLines;
    };

    const jumpToAssistantBlock = (
      direction: -1 | 1,
      width: number,
      height: number,
    ) => {
      const bodyLines = getBodyLines(width);
      const viewport = Math.max(1, Math.max(8, height) - 5);
      const maxScroll = Math.max(0, bodyLines.length - viewport);
      if (maxScroll === 0 || cachedAssistantBlockStarts.length === 0)
        return false;
      const currentTop = Math.max(0, bodyLines.length - viewport - scroll);
      let target: number | undefined;
      if (direction < 0) {
        for (let i = cachedAssistantBlockStarts.length - 1; i >= 0; i--) {
          const start = cachedAssistantBlockStarts[i]!;
          if (start < currentTop) {
            target = start;
            break;
          }
        }
      } else {
        for (let i = 0; i < cachedAssistantBlockStarts.length; i++) {
          const start = cachedAssistantBlockStarts[i]!;
          if (start > currentTop) {
            target = start;
            break;
          }
        }
      }
      if (target === undefined) return false;
      scroll = Math.max(
        0,
        Math.min(maxScroll, bodyLines.length - viewport - target),
      );
      return true;
    };

    const editorFactory = (
      tui: any,
      editorTheme: EditorTheme,
      keybindings: any,
    ) => {
      terminalRef = tui.terminal;
      enableTerminalModes();
      const editor = new CustomEditor(tui, editorTheme, keybindings);
      currentEditor = editor;

      const originalHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        const wheel = mouseWheelDirection(data);
        if (matchesKey(data, Key.ctrl("t"))) {
          hideThinkingBlocks = !hideThinkingBlocks;
          invalidateBodyCache();
          tui.requestRender(true);
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          if (
            jumpToAssistantBlock(
              -1,
              lastRenderWidth || tui.terminal.columns,
              tui.terminal.rows,
            )
          ) {
            tui.requestRender(true);
          }
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          if (
            jumpToAssistantBlock(
              1,
              lastRenderWidth || tui.terminal.columns,
              tui.terminal.rows,
            )
          ) {
            tui.requestRender(true);
          }
          return;
        }
        if (matchesKey(data, Key.end)) {
          scroll = 0;
          tui.requestRender(true);
          return;
        }
        if (matchesKey(data, Key.up) || wheel === "up") {
          scroll = Math.min(scroll + 3, 100000);
          tui.requestRender(true);
          return;
        }
        if (matchesKey(data, Key.down) || wheel === "down") {
          scroll = Math.max(0, scroll - 3);
          tui.requestRender(true);
          return;
        }
        originalHandleInput(data);
        tui.requestRender(true);
      };

      editor.render = (width: number): string[] => {
        lastRenderWidth = width;
        return renderSession(
          ctx.ui.theme,
          width,
          tui.terminal.rows,
          scroll,
          editor.getText?.() ?? "",
          getBodyLines(width),
        );
      };

      return editor;
    };

    const install = () => {
      ctx.ui.setEditorComponent(editorFactory);
      currentEditor?.invalidate?.();
    };

    install();
    setTimeout(install, 100);
    setTimeout(install, 500);
    setTimeout(install, 1000);
  });
}
