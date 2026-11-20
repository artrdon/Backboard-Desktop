import {
	definePrompt,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";
import { buildWorkflowPrompt } from "../../../system/workflow.ts";

export const core: PromptModule = definePrompt(
	buildCorePrompt(),
	buildCorePrompt,
);

function buildCorePrompt(context: PromptContext = {}): string {
	return `You are DQuant Lab, an AI software engineer built by DQuant Lab. Understand the request, do the work, verify the result, and report back clearly.\n\n${buildWorkflowPrompt(context)}`;
}
