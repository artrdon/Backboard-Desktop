import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "../../providers/backboard/streamRetry.ts";
import type { ProviderEvent } from "../../providers/backboard/types.ts";
import { ToolCallProtocolGuard } from "../../providers/ToolCallProtocolGuard.ts";
import { RetryableToolProtocolError } from "../../providers/ToolProtocolError.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import { emitPerformanceTiming } from "../performance/PerformanceTiming.ts";
import type { Session } from "../session/Session.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { EarlyToolSink } from "../tools/ToolScheduler.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";
import {
	isModelAvailabilityError,
	isThinkingCompatibilityError,
} from "./RuntimeRecovery.ts";

export interface PendingAction {
	runId: string | null;
	calls: ToolCallRef[];
}

export interface ProviderStreamConsumerOptions {
	/** Abort and retry a provider attempt that emits no events for this long. */
	idleTimeoutMs?: number;
	/** Override the shared provider retry count for latency-sensitive callers. */
	maxRetries?: number;
}

class ProviderStreamFailure extends Error {
	constructor(
		message: string,
		readonly retryable?: boolean,
	) {
		super(message);
		this.name = "ProviderStreamFailure";
	}
}

export class ProviderStreamConsumer {
	constructor(
		private readonly bus: EventBus,
		private readonly session: Session,
		private readonly options: ProviderStreamConsumerOptions = {},
	) {}

	async consumeWithRetry(
		createStream: (signal: AbortSignal) => AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		signal: AbortSignal,
		earlyTools?: EarlyToolSink,
		onTerminalFailure?: () => Promise<string | null>,
		onRetry?: (error: unknown) => Promise<void> | void,
	): Promise<PendingAction | null> {
		const maxRetries = this.options.maxRetries ?? streamServerErrorRetries();
		let protocolRetryUsed = false;
		for (let attempt = 0; ; attempt++) {
			if (signal.aborted) throw new AbortError();
			const attemptController = new AbortController();
			const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
			try {
				return await this.consume(
					createStream(attemptSignal),
					assistant,
					earlyTools,
					attemptController,
					signal,
				);
			} catch (err) {
				// Any stream failure resets the early round: it retracts announced
				// rows and aborts early runs. On a retry the round is reused for
				// the next attempt; on a terminal throw this is the only cleanup -
				// the caller never reaches process(), whose finally is the usual
				// one, and a stranded pending row would pin the live region
				// forever.
				earlyTools?.reset();
				const safeProtocolRetry = err instanceof RetryableToolProtocolError;
				if (safeProtocolRetry) assistant.discardPartial();
				const terminal =
					err instanceof AbortError ||
					signal.aborted ||
					protocolRetryUsed ||
					(!safeProtocolRetry &&
						(!isRetryableProviderStreamFailure(err) || attempt >= maxRetries));
				if (terminal) {
					// Do not leave the coalescing timer able to publish reasoning after
					// the turn has already failed or been cancelled.
					assistant.flushReasoning();
					if (!(err instanceof AbortError) && !signal.aborted) {
						await preserveProviderContext(
							this.bus,
							onTerminalFailure,
							"cancelled provider context",
						);
					}
					throw signal.aborted ? new AbortError() : err;
				}
				if (safeProtocolRetry) {
					// Only an adapter that withheld its final tool batch may opt in.
					// Keep this single replay independent of transport retry budgets,
					// and do not change model/thinking settings for a protocol fault.
					protocolRetryUsed = true;
					this.bus.emit({
						type: "system:warning",
						message:
							"Retrying inconsistent tool response once. Unfinished reads were cancelled.",
					});
					continue;
				}
				await onRetry?.(err);
				assistant.discardPartial();
				try {
					await waitForRetry(streamRetryDelayMs(attempt + 1), signal);
				} catch (waitError) {
					await preserveProviderContext(
						this.bus,
						onTerminalFailure,
						"cancelled provider context",
					);
					throw waitError;
				}
			} finally {
				attemptController.abort();
			}
		}
	}

	private async consume(
		stream: AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		earlyTools?: EarlyToolSink,
		attemptController?: AbortController,
		signal?: AbortSignal,
	): Promise<PendingAction | null> {
		const toolProtocol = new ToolCallProtocolGuard();
		const providerRoundStartedAt = performance.now();
		let firstEvent = true;
		let firstVisible = true;
		let toolBatchStartedAt: number | undefined;
		const markToolAnnouncement = (): number => {
			if (toolBatchStartedAt !== undefined) return toolBatchStartedAt;
			toolBatchStartedAt = performance.now();
			emitPerformanceTiming(
				this.bus,
				"provider_tool_announcement",
				providerRoundStartedAt,
			);
			return toolBatchStartedAt;
		};
		const iterator = stream[Symbol.asyncIterator]();
		let reachedEnd = false;
		try {
			while (true) {
				const next = await this.nextEvent(iterator, attemptController, signal);
				if (next.done) {
					reachedEnd = true;
					break;
				}
				const event = toolProtocol.accept(next.value);
				if (
					firstEvent &&
					event.kind !== "thinking_resolved" &&
					event.kind !== "provider_diagnostic"
				) {
					firstEvent = false;
					emitPerformanceTiming(
						this.bus,
						"provider_first_event",
						providerRoundStartedAt,
					);
				}
				if (
					firstVisible &&
					(event.kind === "assistant_delta" ||
						event.kind === "reasoning_delta" ||
						event.kind === "tool_started" ||
						event.kind === "tool_ready")
				) {
					firstVisible = false;
					emitPerformanceTiming(
						this.bus,
						"provider_first_visible",
						providerRoundStartedAt,
					);
				}
				switch (event.kind) {
					case "activity":
						break;
					case "provider_diagnostic": {
						const { kind: _kind, ...diagnostic } = event;
						this.bus.emit({ type: "provider:diagnostic", ...diagnostic });
						break;
					}
					case "thinking_resolved": {
						const { kind: _kind, ...setting } = event;
						this.bus.emit({ type: "thinking:wire", ...setting });
						break;
					}
					case "thread":
						this.session.threadId = event.threadId;
						break;
					case "assistant_delta":
						if (event.text) {
							assistant.appendDelta(event.text);
						}
						break;
					case "reasoning_delta":
						if (event.text) assistant.appendReasoning(event.text);
						break;
					case "tool_started":
						assistant.flushAnswer();
						assistant.flushReasoning();
						markToolAnnouncement();
						earlyTools?.announce(event.id, event.name);
						break;
					case "tool_ready":
						assistant.flushAnswer();
						assistant.flushReasoning();
						markToolAnnouncement();
						earlyTools?.offer({
							id: event.call.id,
							name: event.call.name,
							input: event.call.input,
						});
						break;
					case "usage":
						this.session.addUsage(event.usage);
						this.bus.emit({ type: "usage", usage: event.usage });
						break;
					case "warning":
						this.bus.emit({ type: "system:warning", message: event.message });
						break;
					case "requires_action": {
						// Some providers still omit the advisory start/ready frames. Record
						// that entire silent generation interval instead of reporting only
						// the final few milliseconds after a late tool announcement.
						const finalizedBatchStartedAt = markToolAnnouncement();
						emitPerformanceTiming(
							this.bus,
							"provider_tool_batch_finalize",
							finalizedBatchStartedAt,
						);
						const calls = event.calls.map((call) => ({
							id: call.id,
							name: call.name,
							input: call.input,
						}));
						assistant.finalize(calls);
						return { runId: event.runId, calls };
					}
					case "failed":
						throw new ProviderStreamFailure(event.error, event.retryable);
					case "completed": {
						assistant.finalize([], event.finalText);
						return null;
					}
				}
			}
		} finally {
			emitPerformanceTiming(
				this.bus,
				"provider_stream_total",
				providerRoundStartedAt,
			);
			if (!reachedEnd) {
				attemptController?.abort();
				// Cleanup is best-effort after abort. An uncooperative iterator can
				// leave both next() and return() pending forever; awaiting return here
				// would defeat the idle watchdog and prevent the retry from starting.
				try {
					const cleanup = iterator.return?.();
					if (cleanup) void cleanup.catch(() => undefined);
				} catch {
					// A custom iterator may throw before returning a cleanup promise.
				}
			}
		}
		throw new ProviderStreamFailure(
			"Provider stream closed unexpectedly before a terminal event.",
			true,
		);
	}

	private async nextEvent(
		iterator: AsyncIterator<ProviderEvent>,
		attemptController: AbortController | undefined,
		signal: AbortSignal | undefined,
	): Promise<IteratorResult<ProviderEvent>> {
		const timeoutMs = this.options.idleTimeoutMs;
		if (signal?.aborted) throw new AbortError();
		if ((timeoutMs === undefined || timeoutMs <= 0) && !signal) {
			return iterator.next();
		}

		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const races: PromiseLike<IteratorResult<ProviderEvent>>[] = [
				iterator.next(),
			];
			if (timeoutMs !== undefined && timeoutMs > 0) {
				races.push(
					new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
						timeout = setTimeout(() => {
							reject(
								new ProviderStreamFailure(
									`Provider stream made no progress for ${timeoutMs}ms.`,
									true,
								),
							);
							attemptController?.abort();
						}, timeoutMs);
						timeout.unref?.();
					}),
				);
			}
			if (signal) {
				races.push(
					new Promise<IteratorResult<ProviderEvent>>((_, reject) => {
						onAbort = () => reject(new AbortError());
						signal.addEventListener("abort", onAbort, { once: true });
						if (signal.aborted) onAbort();
					}),
				);
			}
			return await Promise.race(races);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

}

export async function preserveProviderContext(
	bus: EventBus,
	callback: (() => Promise<string | null>) | undefined,
	label: string,
): Promise<void> {
	if (!callback) return;
	try {
		const warning = await callback();
		if (warning) bus.emit({ type: "system:warning", message: warning });
	} catch (error) {
		bus.emit({
			type: "system:warning",
			message: `Failed to preserve ${label}: ${errorMessage(error)}`,
		});
	}
}

function isRetryableProviderStreamFailure(error: unknown): boolean {
	if (
		error &&
		typeof error === "object" &&
		"category" in error &&
		error.category === "protocol"
	)
		return false;
	if (isModelAvailabilityError(error) || isThinkingCompatibilityError(error)) {
		return true;
	}
	if (error instanceof ProviderStreamFailure) {
		return error.retryable ?? isRetryableStreamServerError(error);
	}
	return isRetryableStreamServerError(error);
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw new AbortError();
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new AbortError());
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

