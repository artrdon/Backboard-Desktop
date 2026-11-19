import { describe, expect, it } from "bun:test";
import {
	customAdapter,
	normalizeCustomBaseUrl,
} from "../src/providers/byok/adapters/CustomAdapter.ts";
import type { ByokStreamRequest } from "../src/providers/byok/ByokTypes.ts";
import type { ProviderCredential } from "../src/providers/byok/ProviderCredential.ts";

const KEY = "sk-custom-secret-1234567890";
const BASE = "https://api.example.test/v1";

function credential(
	baseUrl = BASE,
	model = "deepseek-chat",
): ProviderCredential {
	return {
		key: KEY,
		generation: 0,
		baseUrl,
		model,
		assertCurrent: () => undefined,
	};
}

function sse(events: readonly unknown[]): Response {
	const body = events
		.map(
			(event) =>
				`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
		)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("normalizeCustomBaseUrl", () => {
	it("accepts plain http(s) base URLs and strips trailing slashes", () => {
		expect(normalizeCustomBaseUrl(" https://api.deepseek.com/v1/ ")).toBe(
			"https://api.deepseek.com/v1",
		);
		expect(normalizeCustomBaseUrl("http://localhost:1234/v1")).toBe(
			"http://localhost:1234/v1",
		);
	});

	it("rejects credentials, query strings, non-http protocols, and pasted endpoints", () => {
		expect(normalizeCustomBaseUrl("ftp://example.test/v1")).toBeNull();
		expect(
			normalizeCustomBaseUrl("https://user:pass@example.test/v1"),
		).toBeNull();
		expect(normalizeCustomBaseUrl("https://example.test/v1?x=1")).toBeNull();
		expect(
			normalizeCustomBaseUrl("https://example.test/v1/chat/completions"),
		).toBeNull();
	});
});

describe("customAdapter", () => {
	it("validates through /models with bearer auth and lists the configured model", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const transport = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		await customAdapter.validateKey(credential(), undefined, transport);
		const models = await customAdapter.listModels(
			credential(),
			undefined,
			transport,
		);

		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/models`,
			`${BASE}/models`,
		]);
		expect(
			(calls[0]?.init?.headers as Record<string, string>).Authorization,
		).toBe(`Bearer ${KEY}`);
		expect(models.map((model) => model.name)).toEqual([
			"deepseek-chat",
			"deepseek-reasoner",
		]);
		expect(
			models.every(
				(model) => model.provider === "custom" && model.supports_tools === true,
			),
		).toBe(true);
	});

	it("keeps the configured model when the endpoint has no /models route", async () => {
		const transport = async () =>
			new Response(JSON.stringify({ error: { message: "not found" } }), {
				status: 404,
			});

		const models = await customAdapter.listModels(
			credential(BASE, "my-model"),
			undefined,
			transport,
		);
		expect(models.map((model) => model.name)).toEqual(["my-model"]);
	});

	it("falls back to a minimal chat turn when /models is unavailable", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const transport = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/models")) {
				return new Response(
					JSON.stringify({ error: { message: "not found" } }),
					{ status: 404 },
				);
			}
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		};

		await customAdapter.validateKey(
			credential(BASE, "my-model"),
			undefined,
			transport,
		);

		expect(calls.map((call) => call.url)).toEqual([
			`${BASE}/models`,
			`${BASE}/chat/completions`,
		]);
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
			model: "my-model",
			stream: false,
		});
	});

	it("reports a missing base URL instead of guessing an endpoint", async () => {
		await expect(customAdapter.validateKey(` ${KEY} `)).rejects.toThrow(
			"base URL",
		);
	});
});

describe("customAdapter.stream", () => {
	it("streams text, tool calls, usage, and requires_action", async () => {
		let request: { url: string; body: Record<string, unknown> } | undefined;
		const transport = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			request = { url: String(input), body: JSON.parse(String(init?.body)) };
			return sse([
				{ choices: [{ delta: { content: "Hi" } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										function: {
											name: "read_file",
											arguments: '{"path":"a.ts"}',
										},
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				{ usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
				"[DONE]",
			]);
		};
		const streamRequest: ByokStreamRequest = {
			model: "deepseek-chat",
			systemPrompt: "You are Backboard.",
			tools: [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "read",
						parameters: { type: "object", properties: {} },
					},
				},
			],
			messages: [
				{ role: "user", content: "read a" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call_0", name: "read_file", input: { path: "b.ts" } },
					],
				},
				{
					role: "tool",
					results: [{ id: "call_0", name: "read_file", output: "ok" }],
				},
			],
			transport,
		};

		const events = [];
		for await (const event of customAdapter.stream(
			streamRequest,
			credential(),
		)) {
			events.push(event);
		}

		expect(request?.url).toBe(`${BASE}/chat/completions`);
		expect(request?.body).toMatchObject({
			model: "deepseek-chat",
			stream: true,
			messages: [
				{ role: "system", content: "You are Backboard." },
				{ role: "user", content: "read a" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_0" }] },
				{ role: "tool", tool_call_id: "call_0", content: "ok" },
			],
		});
		expect(events).toContainEqual({ kind: "assistant_delta", text: "Hi" });
		expect(events).toContainEqual({
			kind: "tool_ready",
			call: { id: "call_1", name: "read_file", input: { path: "a.ts" } },
		});
		expect(events).toContainEqual({
			kind: "requires_action",
			runId: null,
			calls: [{ id: "call_1", name: "read_file", input: { path: "a.ts" } }],
		});
		expect(events).toContainEqual({
			kind: "usage",
			usage: {
				inputTokens: 4,
				outputTokens: 2,
				totalTokens: 6,
				cachedTokens: 0,
				provider: "custom",
				model: "deepseek-chat",
			},
		});
	});
});

describe("customAdapter errors", () => {
	it("scrubs the API key from authentication errors", async () => {
		const transport = async () =>
			new Response(
				JSON.stringify({ error: { message: `Incorrect key ${KEY}` } }),
				{ status: 401 },
			);

		const error = await customAdapter
			.validateKey(credential(), undefined, transport)
			.catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain("401");
		expect(String((error as Error).message)).not.toContain(KEY);
	});
});
