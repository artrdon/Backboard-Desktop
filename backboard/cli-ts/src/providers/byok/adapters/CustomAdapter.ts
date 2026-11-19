import type { ModelCatalogItem, ProviderEvent } from "../../backboard/types.ts";
import { ToolCallDeltaAccumulator } from "../../ToolCallDeltaAccumulator.ts";
import {
	ByokError,
	providerErrorMessage,
	unexpectedStreamEndMessage,
} from "../ByokError.ts";
import type { ByokStreamRequest, ProviderAdapter } from "../ByokTypes.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	assertCredentialCurrent,
	credentialKey,
	type ProviderCredential,
	type ProviderTransport,
} from "../ProviderCredential.ts";
import { scrubSecret } from "../scrubSecret.ts";
import { toOpenAIMessages } from "./OpenAIAdapter.ts";

/** Upper bound accepted from a `/models` response; protects the picker from a runaway server. */
const MAX_CUSTOM_MODELS = 5000;

interface CustomModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		display_name?: string;
		created?: number;
	}>;
	models?: Array<
		| { id?: string; name?: string; display_name?: string; created?: number }
		| string
	>;
}

/**
 * Normalizes a user-supplied OpenAI-compatible base URL. Returns null for
 * anything that is not a plain http(s) origin + path, so a credential-bearing
 * URL or a pasted `/chat/completions` endpoint never reaches storage.
 */
export function normalizeCustomBaseUrl(
	value: string | undefined,
): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	const pathname = url.pathname.replace(/\/+$/, "");
	if (/\/chat\/completions$/i.test(pathname)) return null;
	return `${url.origin}${pathname}`;
}

function credentialBaseUrl(credential: ProviderCredential): string {
	const baseUrl =
		typeof credential === "string" ? undefined : credential.baseUrl;
	const normalized = normalizeCustomBaseUrl(baseUrl);
	if (!normalized) {
		throw new Error(
			"Custom API has no usable base URL. Reconnect Custom API with the endpoint URL.",
		);
	}
	return normalized;
}

function credentialModel(credential: ProviderCredential): string | undefined {
	return typeof credential === "string"
		? undefined
		: credential.model?.trim() || undefined;
}

function headers(credential: ProviderCredential): Record<string, string> {
	return { Authorization: `Bearer ${credentialKey(credential).trim()}` };
}

function modelItem(name: string): ModelCatalogItem {
	return {
		name,
		provider: "custom",
		model_type: "llm",
		display_name: name,
		context_limit: null,
		supports_tools: true,
		source: "byok",
	};
}

function modelNames(response: CustomModelsResponse): string[] {
	const rows = response.data ?? response.models ?? [];
	const names: string[] = [];
	for (const row of rows) {
		const name = typeof row === "string" ? row : (row.id ?? row.name);
		if (name?.trim()) names.push(name.trim());
	}
	return names;
}

/** True when an endpoint does not implement the optional `/models` catalog. */
function isMissingModelsEndpoint(error: unknown): boolean {
	if (!(error instanceof ByokError)) return false;
	if (error.status === 404 || error.status === 405) return true;
	return (
		error.status === 400 &&
		/model/i.test(providerErrorMessage(error.body) ?? "")
	);
}

/**
 * Some OpenAI-compatible servers only implement `/chat/completions`. A
 * minimal one-token request is the only way left to prove that the URL, key,
 * and model work together.
 */
async function validateWithChatCompletion(
	baseUrl: string,
	credential: ProviderCredential,
	signal: AbortSignal | undefined,
	transport: ProviderTransport = fetch,
): Promise<void> {
	const model = credentialModel(credential);
	if (!model) {
		throw new Error(
			"Add the Custom API model ID before testing the connection.",
		);
	}
	if (signal) assertCredentialCurrent(credential);
	const send = (body: Record<string, unknown>): Promise<Response> =>
		transport(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers(credential) },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
	let response = await send({
		model,
		messages: [{ role: "user", content: "ping" }],
		max_tokens: 1,
		stream: false,
	});
	let raw = response.ok ? "" : await response.text().catch(() => "");
	// Reasoning endpoints reject the legacy `max_tokens` name; retry with the
	// newer spelling before reporting a failure.
	if (
		!response.ok &&
		response.status === 400 &&
		/max_(?:completion_)?tokens/i.test(raw)
	) {
		response = await send({
			model,
			messages: [{ role: "user", content: "ping" }],
			max_completion_tokens: 1,
			stream: false,
		});
		raw = response.ok ? "" : await response.text().catch(() => "");
	}
	if (response.ok) return;
	const text = scrubSecret(raw, credentialKey(credential));
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		/* keep text */
	}
	throw new ByokError(
		providerErrorMessage(body)
			? `Custom API request failed (HTTP ${response.status}): ${providerErrorMessage(body)}`
			: `Custom API request failed: HTTP ${response.status}`,
		"custom",
		response.status,
		body,
	);
}

export const customAdapter: ProviderAdapter = {
	id: "custom",
	label: "Custom API",
	consoleUrl: "",
	keyHint: "Your API key",

	looksLikeKey(key) {
		return credentialKey(key).trim().length > 0;
	},

	async validateKey(key, signal, transport) {
		const baseUrl = credentialBaseUrl(key);
		const configured = credentialModel(key);
		let names: string[] | undefined;
		try {
			const response = await getJson<CustomModelsResponse>(
				`${baseUrl}/models`,
				headers(key),
				"custom",
				signal,
				key,
				transport,
			);
			names = modelNames(response);
		} catch (error) {
			if (!isMissingModelsEndpoint(error)) throw error;
		}
		// A catalog that omits the configured id (or returns an empty list)
		// does not prove the model works; verify it with a minimal turn.
		if (
			names === undefined ||
			(configured && (names.length === 0 || !names.includes(configured)))
		) {
			await validateWithChatCompletion(baseUrl, key, signal, transport);
		}
	},

	async listModels(key, signal, transport) {
		const baseUrl = credentialBaseUrl(key);
		const configured = credentialModel(key);
		let names: string[] = [];
		try {
			const response = await getJson<CustomModelsResponse>(
				`${baseUrl}/models`,
				headers(key),
				"custom",
				signal,
				key,
				transport,
			);
			names = modelNames(response);
		} catch (error) {
			// A server without `/models` still works for chat; its configured
			// model is the only one we can safely advertise.
			if (!isMissingModelsEndpoint(error) || !configured) throw error;
		}
		if (configured && !names.includes(configured)) names.unshift(configured);
		return [...new Set(names)].slice(0, MAX_CUSTOM_MODELS).map(modelItem);
	},

	supportsThinking() {
		return false;
	},

	stream(request, key) {
		return streamCustom(request, key);
	},
};

async function* streamCustom(
	request: ByokStreamRequest,
	credential: ProviderCredential,
): AsyncIterable<ProviderEvent> {
	let baseUrl: string;
	try {
		baseUrl = credentialBaseUrl(credential);
	} catch (error) {
		yield {
			kind: "failed",
			error: error instanceof Error ? error.message : String(error),
			retryable: false,
		};
		return;
	}

	const body: Record<string, unknown> = {
		model: request.model,
		messages: toOpenAIMessages(request),
		stream: true,
	};
	if (request.tools.length > 0) {
		body.tools = request.tools;
	}

	// Custom endpoints expose no uniform reasoning control. Omit every
	// vendor-specific parameter instead of guessing and failing the request.
	yield {
		kind: "thinking_resolved",
		requested: request.thinking,
		effective: { reasoning_effort: "provider-default" },
		provider: "custom",
		model: request.model,
		reason: "custom-endpoint-default",
	};

	const pending = new ToolCallDeltaAccumulator(
		request.tools.map((tool) => tool.function.name),
	);
	let finishReason: string | null = null;
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
	};

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${baseUrl}/chat/completions`,
		headers: headers(credential),
		credential,
		transport: request.transport,
		body,
		provider: "custom",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		let emitted = false;
		if (chunk.error) {
			yield {
				kind: "failed",
				error:
					providerErrorMessage(chunk) ?? "Custom API returned an error event",
				retryable: false,
			};
			return;
		}

		const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
		if (chunkUsage) {
			const details = chunkUsage.prompt_tokens_details as
				| Record<string, unknown>
				| undefined;
			usage = {
				inputTokens: numberOf(chunkUsage.prompt_tokens),
				outputTokens: numberOf(chunkUsage.completion_tokens),
				totalTokens: numberOf(chunkUsage.total_tokens),
				cachedTokens: numberOf(details?.cached_tokens),
			};
		}

		const choice = (chunk.choices as unknown[] | undefined)?.[0] as
			| {
					delta?: {
						content?: string | null;
						reasoning?: string | null;
						reasoning_content?: string | null;
						tool_calls?: Array<{
							index?: number;
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
					finish_reason?: string | null;
			  }
			| undefined;
		if (!choice) {
			yield { kind: "activity" };
			continue;
		}
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (delta?.content) {
			emitted = true;
			yield { kind: "assistant_delta", text: delta.content };
		}
		const reasoningText = delta?.reasoning || delta?.reasoning_content;
		if (reasoningText) {
			emitted = true;
			yield { kind: "reasoning_delta", text: reasoningText };
		}
		for (const event of pending.add(delta?.tool_calls ?? [])) {
			emitted = true;
			yield event;
			if (event.kind === "failed") return;
		}
		if (!emitted) yield { kind: "activity" };
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("custom"),
			retryable: true,
		};
		return;
	}

	if (finishReason === "length" && pending.size > 0) {
		yield {
			kind: "failed",
			error:
				"The model hit its output limit while writing a tool call, so the call was incomplete.",
			retryable: true,
		};
		return;
	}

	const finalCalls = pending.finish();
	if ("error" in finalCalls) {
		yield { kind: "failed", error: finalCalls.error, retryable: false };
		return;
	}
	const calls = finalCalls.calls;
	for (const call of calls) yield { kind: "tool_ready", call };

	const finalUsage = {
		...usage,
		provider: "custom",
		model: request.model,
	};
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield { kind: "requires_action", runId: null, calls };
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
