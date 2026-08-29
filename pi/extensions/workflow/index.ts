import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCommit from "./commit.ts";
import registerContextFiles from "./context-files.ts";
import registerHandoff from "./handoff.ts";
import registerMemories from "./memories.ts";
import registerQuestionnaire from "./questionnaire.ts";
import registerRulesMd from "./rules-md.ts";
import registerSkills from "./skills.ts";
import registerSessionTitle from "./session-title.ts";
import registerTodo from "./todo.ts";

export default function workflowExtension(pi: ExtensionAPI): void {
  registerCommit(pi);
  registerContextFiles(pi);
  registerHandoff(pi);
  registerMemories(pi);
  registerQuestionnaire(pi);
  registerRulesMd(pi);
  registerSkills(pi);
  registerSessionTitle(pi);
  registerTodo(pi);
}
