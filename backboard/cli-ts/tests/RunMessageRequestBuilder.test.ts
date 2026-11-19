import { describe, expect, it } from "bun:test";
import { buildRunMessageRequest } from "../src/core/agent/RunMessageRequestBuilder.ts";
import { Session } from "../src/core/session/Session.ts";

describe("buildRunMessageRequest", () => {
	it("includes the local workspace id in message metadata", () => {
		const request = buildRunMessageRequest("hello", {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			assistantId: "asst_test",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "auto",
			memoryProfile: "code",
			workspaceId: "workspace_test",
		});

		expect(request.metadata).toEqual({
			backboard_workspace_id: "workspace_test",
		});
	});

	it("carries the captured billing route and omits it when there is none", () => {
		const context = {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "off" as const,
			memoryProfile: "code" as const,
		};

		expect(
			buildRunMessageRequest("hello", { ...context, source: "byok" }).source,
		).toBe("byok");
		expect("source" in buildRunMessageRequest("hello", context)).toBe(false);
	});

	it("pins a selected OpenRouter upstream and otherwise ranks upstreams by latency", () => {
		const context = {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			model: { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
			memory: "off" as const,
			memoryProfile: "code" as const,
		};

		// OpenRouter's own price-weighted default queues on the cheapest hosts.
		expect(buildRunMessageRequest("hello", context).openrouter).toEqual({
			sort: "latency",
		});
		expect(
			buildRunMessageRequest("hello", {
				...context,
				openRouterProvider: "DeepInfra",
			}).openrouter,
		).toEqual({
			providers: ["DeepInfra"],
			allow_fallbacks: false,
		});
		expect(
			buildRunMessageRequest("hello", {
				...context,
				model: { provider: "openai", model: "gpt-5.5" },
				openRouterProvider: "DeepInfra",
			}).openrouter,
		).toBeUndefined();
	});
});
