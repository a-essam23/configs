import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCommit from "./commit.ts";
import registerHandoff from "./handoff.ts";
import registerMemories from "./memories.ts";
import registerQuestionnaire from "./questionnaire.ts";
import registerRulesMd from "./rules-md.ts";
import registerSkills from "./skills.ts";
import registerTodo from "./todo.ts";

export default function workflowExtension(pi: ExtensionAPI): void {
  registerCommit(pi);
  registerHandoff(pi);
  registerMemories(pi);
  registerQuestionnaire(pi);
  registerRulesMd(pi);
  registerSkills(pi);
  registerTodo(pi);
}
