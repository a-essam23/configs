const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const loadTypeScript = require("jiti")(__filename);
const worktreeModule = loadTypeScript("../workflow/worktree.ts");
const {
	parseWorktreePaths,
	primaryRepositoryRoot,
	worktreeDirectory,
	worktreeHandoffCommand,
	worktreeHandoffConfirmation,
} = worktreeModule;
const worktreeExtension = worktreeModule.default;

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function withTemporaryDirectory(run) {
	const directory = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function withTemporaryDirectoryAsync(run) {
	const directory = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function appendAssistantMessage(sessionManager) {
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "saved response" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function gitResult(cwd, args) {
	try {
		return { code: 0, stdout: git(cwd, args), stderr: "" };
	} catch (error) {
		return {
			code: typeof error.status === "number" ? error.status : 1,
			stdout: error.stdout?.toString() ?? "",
			stderr: error.stderr?.toString() ?? "",
		};
	}
}

test("derives the shared primary repository worktree path", () => {
	const primaryRoot = primaryRepositoryRoot("/projects/app/.git");
	assert.equal(primaryRoot, "/projects/app");
	assert.equal(worktreeDirectory(primaryRoot, "feature/auth"), "/projects/app/.worktrees/feature/auth");
});

test("rejects worktree paths outside the configured root", () => {
	assert.throws(() => worktreeDirectory("/projects/app", "../outside"), /inside .worktrees/);
});

test("parses NUL-delimited Git worktree porcelain output", () => {
	const newlinePath = "/projects/app/.worktrees/feature\nauth";
	const output = `worktree /projects/app\0HEAD abc123\0\0worktree ${newlinePath}\0branch refs/heads/feature/auth\0\0`;
	assert.deepEqual(parseWorktreePaths(output), ["/projects/app", newlinePath]);
});

test("Git creates a nested branch worktree without copying dirty source files", () => {
	withTemporaryDirectory((directory) => {
		const repository = join(directory, "repository");
		mkdirSync(repository);
		git(repository, ["init", "-b", "main"]);
		git(repository, ["config", "user.email", "test@example.com"]);
		git(repository, ["config", "user.name", "Test User"]);
		writeFileSync(join(repository, "README.md"), "committed\n");
		git(repository, ["add", "README.md"]);
		git(repository, ["commit", "-m", "initial"]);
		writeFileSync(join(repository, "source-only.txt"), "uncommitted\n");

		const target = join(repository, ".worktrees", "feature", "auth");
		git(repository, ["worktree", "add", "-b", "feature/auth", target, "HEAD"]);

		assert.equal(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feature/auth");
		assert.equal(git(target, ["status", "--short"]).trim(), "");
		assert.equal(existsSync(join(target, "source-only.txt")), false);
	});
});

function gitRepositoryResult(args) {
	if (args.join(" ") === "rev-parse --show-toplevel") return { code: 0, stdout: "/projects/app\n", stderr: "" };
	if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
		return { code: 0, stdout: "/projects/app/.git\n", stderr: "" };
	}
	if (args.join(" ") === "rev-parse --is-bare-repository") return { code: 0, stdout: "false\n", stderr: "" };
	if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
	if (args[0] === "check-ref-format") return { code: 0, stdout: `${args.at(-1)}\n`, stderr: "" };
	throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
}

function registeredWorktreeTool() {
	let tool;
	const queued = [];
	worktreeExtension({
		registerCommand() {},
		registerTool(definition) {
			tool = definition;
		},
		exec: async (_command, args) => gitRepositoryResult(args),
		sendUserMessage: async (message, sendOptions) => {
			queued.push({ message, sendOptions });
		},
	});
	return { tool, queued };
}

test("agent handoff confirms base and path before queueing the command", async () => {
	const { tool, queued } = registeredWorktreeTool();
	const confirmations = [];
	const result = await tool.execute("call", { branch: "feature/auth" }, undefined, undefined, {
		hasUI: true,
		cwd: "/projects/app",
		ui: {
			confirm: async (title, message) => {
				confirmations.push({ title, message });
				return true;
			},
		},
	});

	assert.deepEqual(confirmations, [{
		title: "Create worktree?",
		message: worktreeHandoffConfirmation("abc123", "/projects/app/.worktrees/feature/auth"),
	}]);
	assert.deepEqual(queued, [{
		message: worktreeHandoffCommand("feature/auth"),
		sendOptions: { deliverAs: "followUp", expandPromptTemplates: true },
	}]);
	assert.equal(result.details.target, "/projects/app/.worktrees/feature/auth");
});

test("agent handoff compacts with pi-vcc before queueing", async () => {
	const { tool, queued } = registeredWorktreeTool();
	let compactOptions;
	const result = await tool.execute("call", { branch: "feature/auth", compact: true }, undefined, undefined, {
		hasUI: true,
		cwd: "/projects/app",
		ui: { confirm: async () => true, notify() {} },
		compact(options) {
			compactOptions = options;
		},
	});

	assert.equal(result.details.compacting, true);
	assert.equal(compactOptions.customInstructions, "__pi_vcc__");
	assert.deepEqual(queued, []);
	compactOptions.onComplete({ details: { compactor: "pi-vcc" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(queued, [{
		message: worktreeHandoffCommand("feature/auth"),
		sendOptions: { deliverAs: "followUp", expandPromptTemplates: true },
	}]);
});

test("agent handoff rejects compaction not handled by pi-vcc", async () => {
	const { tool, queued } = registeredWorktreeTool();
	let compactOptions;
	const notifications = [];
	await tool.execute("call", { branch: "feature/auth", compact: true }, undefined, undefined, {
		hasUI: true,
		cwd: "/projects/app",
		ui: {
			confirm: async () => true,
			notify: (message, type) => notifications.push({ message, type }),
		},
		compact(options) {
			compactOptions = options;
		},
	});

	compactOptions.onComplete({ details: { compactor: "pi-core" } });
	assert.deepEqual(queued, []);
	assert.deepEqual(notifications, [{
		message: "Worktree handoff was not queued: pi-vcc did not compact this session",
		type: "error",
	}]);
});

test("agent handoff does not queue a failed compaction", async () => {
	const { tool, queued } = registeredWorktreeTool();
	let compactOptions;
	const notifications = [];
	await tool.execute("call", { branch: "feature/auth", compact: true }, undefined, undefined, {
		hasUI: true,
		cwd: "/projects/app",
		ui: {
			confirm: async () => true,
			notify: (message, type) => notifications.push({ message, type }),
		},
		compact(options) {
			compactOptions = options;
		},
	});

	compactOptions.onError(new Error("Compaction cancelled"));
	assert.deepEqual(queued, []);
	assert.deepEqual(notifications, [{
		message: "Worktree handoff was not queued: Compaction cancelled",
		type: "error",
	}]);
});

test("agent handoff does not queue a rejected confirmation", async () => {
	const { tool, queued } = registeredWorktreeTool();
	const result = await tool.execute("call", { branch: "feature/auth" }, undefined, undefined, {
		hasUI: true,
		cwd: "/projects/app",
		ui: { confirm: async () => false },
	});

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(queued, []);
});

test("agent handoff rejects non-interactive mode", async () => {
	const { tool } = registeredWorktreeTool();
	await assert.rejects(
		tool.execute("call", { branch: "feature/auth" }, undefined, undefined, { hasUI: false }),
		/interactive confirmation/,
	);
});

test("worktree command creates, forks, and resumes the target session", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	await withTemporaryDirectoryAsync(async (directory) => {
		const repository = join(directory, "repository");
		const agentDirectory = join(directory, "agent");
		const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		try {
			mkdirSync(repository);
			git(repository, ["init", "-b", "main"]);
			git(repository, ["config", "user.email", "test@example.com"]);
			git(repository, ["config", "user.name", "Test User"]);
			writeFileSync(join(repository, "README.md"), "committed\n");
			git(repository, ["add", "README.md"]);
			git(repository, ["commit", "-m", "initial"]);
			writeFileSync(join(repository, "source-only.txt"), "uncommitted\n");

			const source = SessionManager.create(repository, join(agentDirectory, "source-sessions"));
			appendAssistantMessage(source);
			let command;
			worktreeExtension({
				registerTool() {},
				registerCommand(name, definition) {
					if (name === "worktree") command = definition;
				},
				exec: async (_command, args, options) => gitResult(options.cwd, args),
			});

			const switchedSessions = [];
			const context = {
				cwd: repository,
				isIdle: () => true,
				sessionManager: source,
				ui: { notify() {} },
				switchSession: async (sessionFile, options) => {
					switchedSessions.push(sessionFile);
					await options.withSession({ ui: { notify() {} } });
					return { cancelled: false };
				},
			};

			await command.handler("feature/auth", context);
			const target = join(repository, ".worktrees", "feature", "auth");
			assert.equal(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feature/auth");
			assert.equal(existsSync(join(target, "source-only.txt")), false);
			assert.equal(SessionManager.open(switchedSessions[0]).getCwd(), realpathSync(target));

			await command.handler("switch feature/auth", context);
			assert.equal(switchedSessions[1], switchedSessions[0]);
		} finally {
			if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
		}
	});
});

test("forkFrom requires a materialized session and preserves the target cwd", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	withTemporaryDirectory((directory) => {
		const sourceCwd = join(directory, "source");
		const targetCwd = join(directory, "target");
		const sessionDirectory = join(directory, "sessions");
		const source = SessionManager.create(sourceCwd, sessionDirectory);
		const sourceFile = source.getSessionFile();

		assert.ok(sourceFile);
		assert.throws(() => SessionManager.forkFrom(sourceFile, targetCwd, sessionDirectory), /empty or invalid/);

		appendAssistantMessage(source);

		const fork = SessionManager.forkFrom(sourceFile, targetCwd, sessionDirectory);
		assert.equal(fork.getCwd(), targetCwd);
		assert.ok(fork.getSessionFile());
	});
});
