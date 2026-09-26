import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCommit from "./commit.ts";
import registerHandoff from "./handoff.ts";
import registerMemories from "./memories.ts";
import registerPermissionGate from "./permission-gate.ts";
import registerQuestionnaire from "./questionnaire.ts";
import registerRulesMd from "./rules-md.ts";
import registerSkills from "./skills.ts";
import registerSessionTitle from "./session-title.ts";
import registerTodo from "./todo.ts";
import registerWorktree from "./worktree.ts";

export default function workflowExtension(pi: ExtensionAPI): void {
  registerCommit(pi);
  registerHandoff(pi);
  registerMemories(pi);
  registerPermissionGate(pi);
  registerQuestionnaire(pi);
  registerRulesMd(pi);
  registerSkills(pi);
  registerSessionTitle(pi);
  registerTodo(pi);
  registerWorktree(pi);
}
