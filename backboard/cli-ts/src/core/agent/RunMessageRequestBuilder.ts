import {
	formatBackboardMemoryMode,
	type MemoryMode,
	type MemoryProfile,
	type ThinkingConfig,
} from "../../config/defaults.ts";
import type {
	ModelSource,
	OpenRouterRequestOptions,
	SendMessageRequest,
} from "../../providers/backboard/types.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";

export interface RunMessageRequestContext {
	session: Session;
	tools: OpenAITool[];
	systemPrompt: string;
	assistantId?: string;
	model: { provider: string; model: string };
	/**
	 * The billing route captured when the turn or worker started. Every request
	 * built for it carries the same value, so routing never has to guess.
	 */
	source?: ModelSource;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	/** Pins an OpenRouter upstream; undefined ranks upstreams by latency. */
	openRouterProvider?: string;
	/**
	 * Extra metadata merged into the request. The server persists it on the
	 * stored message and returns it on resume, so injected notifications tag
	 * themselves here (see INJECTED_NOTIFICATION_METADATA_KEY) to be prunable
	 * server-side and filterable on resume.
	 */
	metadata?: Record<string, unknown>;
}

export function buildRunMessageRequest(
	content: string,
	context: RunMessageRequestContext,
	thinking?: ThinkingConfig | null,
): SendMessageRequest {
	const metadata = {
		...(context.workspaceId
			? { backboard_workspace_id: context.workspaceId }
			: {}),
		...context.metadata,
	};
	return {
		content,
		thread_id: context.session.threadId ?? undefined,
		assistant_id: context.assistantId,
		llm_provider: context.model.provider,
		model_name: context.model.model,
		...(context.source === undefined ? {} : { source: context.source }),
		system_prompt: context.systemPrompt,
		memory: formatBackboardMemoryMode(context.memory),
		memory_profile: context.memoryProfile,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(thinking === undefined ? {} : { thinking }),
		...(context.model.provider === "openrouter"
			? { openrouter: openRouterRouting(context.openRouterProvider) }
			: {}),
		tools: context.tools,
	};
}

/**
 * How OpenRouter picks the upstream host for a request. A pinned upstream is
 * honoured exactly. Otherwise hosts are ranked by latency: OpenRouter's own
 * default weights them by inverse-square price, which sends almost every
 * request to the cheapest hosts, and those were measured queueing a 24k-token
 * DeepSeek V4.1 Flash prompt for 25-32 s before the first token and then
 * streaming at 11-47 tok/s, against ~2 s and ~230 tok/s on the hosts a
 * latency ranking prefers.
 */
export function openRouterRouting(
	pinnedUpstream?: string,
): OpenRouterRequestOptions {
	return pinnedUpstream
		? { providers: [pinnedUpstream], allow_fallbacks: false }
		: { sort: "latency" };
}

