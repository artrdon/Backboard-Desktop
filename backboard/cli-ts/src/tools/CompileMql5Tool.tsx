import { basename, relative, resolve } from "node:path";
import { z } from "zod";
import {
	compileMql5File,
	type Mql5CompileResult,
} from "../core/mql5/Mql5Compiler.ts";
import type { Mql5Diagnostic } from "../core/mql5/Mql5Log.ts";
import type { PermissionDecision } from "../core/permissions/types.ts";
import { relativizePath } from "../core/tools/inputSummary.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import type { ToolExecutionMetadata } from "../core/tools/ToolFailure.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import { assertInsideIsolatedWorkspace } from "../core/tools/WorkspaceBoundary.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	file_path: z
		.string()
		.min(1)
		.describe(
			"Path to the .mq5 source file to compile. Absolute, or relative to the session working directory.",
		),
	timeout: z
		.number()
		.int()
		.min(10)
		.max(600)
		.optional()
		.describe(
			"Compiler timeout in seconds (default: 120). The first Wine launch can take several seconds.",
		),
});

type Input = z.infer<typeof schema>;

interface AgentDiagnostic {
	file: string;
	line: number;
	column?: number;
	code?: number;
	message: string;
}

interface AgentCompilePayload {
	success: boolean;
	file: string;
	output?: string;
	errors: AgentDiagnostic[];
	warnings: AgentDiagnostic[];
	message: string;
	log_path?: string;
	compiler?: {
		path: string;
		runner: string;
		wine?: string;
		wine_prefix?: string;
	};
	errors_truncated?: boolean;
	warnings_truncated?: boolean;
	timed_out?: boolean;
}

function displayDiagnosticFile(file: string, cwd: string): string {
	const relativePath = relative(cwd, file);
	return relativePath && !relativePath.startsWith("..") ? relativePath : file;
}

function toAgentDiagnostic(
	diagnostic: Mql5Diagnostic,
	cwd: string,
): AgentDiagnostic {
	return {
		file: displayDiagnosticFile(diagnostic.file, cwd),
		line: diagnostic.line,
		...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
		...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
		message: diagnostic.message,
	};
}

function toAgentPayload(
	result: Mql5CompileResult,
	cwd: string,
): AgentCompilePayload {
	return {
		success: result.success,
		file: result.file,
		...(result.output ? { output: result.output } : {}),
		errors: result.errors.map((diagnostic) =>
			toAgentDiagnostic(diagnostic, cwd),
		),
		warnings: result.warnings.map((diagnostic) =>
			toAgentDiagnostic(diagnostic, cwd),
		),
		message: result.message,
		...(result.logPath ? { log_path: result.logPath } : {}),
		...(result.compiler
			? {
					compiler: {
						path: result.compiler.path,
						runner: result.compiler.runner,
						...(result.compiler.wine ? { wine: result.compiler.wine } : {}),
						...(result.compiler.winePrefix
							? { wine_prefix: result.compiler.winePrefix }
							: {}),
					},
				}
			: {}),
		...(result.errorsTruncated ? { errors_truncated: true } : {}),
		...(result.warningsTruncated ? { warnings_truncated: true } : {}),
		...(result.timedOut ? { timed_out: true } : {}),
	};
}

function resultTitle(result: Mql5CompileResult): string {
	const name = basename(result.file);
	if (result.success) return `Compiled ${name}`;
	if (result.failureCategory === "unavailable") return "MetaEditor unavailable";
	if (result.failureCategory === "missing_path") {
		return "Compile failed: file not found";
	}
	const errors = result.errors.length;
	const warnings = result.warnings.length;
	if (errors === 0) return `${name}: ${result.message}`;
	return `${name}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function resultDetail(result: Mql5CompileResult): string {
	const lines = [result.message];
	for (const diagnostic of [...result.errors, ...result.warnings].slice(0, 8)) {
		const position = diagnostic.column
			? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
			: `${diagnostic.file}:${diagnostic.line}`;
		const code = diagnostic.code !== undefined ? ` ${diagnostic.code}` : "";
		lines.push(
			`${position} ${diagnostic.severity}${code}: ${diagnostic.message}`,
		);
	}
	if (result.logPath) lines.push(`log: ${result.logPath}`);
	return lines.join("\n");
}

function executionMetadata(result: Mql5CompileResult): ToolExecutionMetadata {
	return {
		outcome: result.success ? "success" : "failure",
		validation: result.success ? "passed" : "failed",
		mutated: !!result.absoluteOutput,
		retryable: result.retryable ?? false,
		...(result.failureCategory
			? { failureCategory: result.failureCategory }
			: {}),
		...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
		...(result.timedOut ? { timedOut: true } : {}),
	};
}

/**
 * Official MetaTrader 5 compiler tool. It runs the user's installed
 * MetaEditor64.exe (natively on Windows, through Wine elsewhere), reads the
 * real compiler log and returns parsed errors/warnings. No shell is involved;
 * the compiler path comes from settings and the only agent-controlled path is
 * the validated `.mq5` file.
 */
export class CompileMql5Tool extends Tool<Input, Mql5CompileResult> {
	readonly name = "CompileMql5";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override checkPermissions(): PermissionDecision | undefined {
		return {
			behavior: "allow",
			reason: "validated MetaEditor invocation with a fixed executable",
		};
	}

	override summarizeInput(input: Input): string | undefined {
		return input.file_path ? relativizePath(input.file_path) : undefined;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Mql5CompileResult>> {
		const filePath = resolve(ctx.cwd, input.file_path);
		assertInsideIsolatedWorkspace(ctx, [filePath]);
		const result = await compileMql5File({
			filePath,
			cwd: ctx.cwd,
			signal: ctx.signal,
			...(input.timeout ? { timeoutMs: input.timeout * 1000 } : {}),
		});
		const payload = toAgentPayload(result, ctx.cwd);
		return {
			...ok(
				result,
				JSON.stringify(payload, null, 2),
				resultTitle(result),
				resultDetail(result),
			),
			execution: executionMetadata(result),
		};
	}
}
