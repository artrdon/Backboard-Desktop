import { spawn } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { qUserConfigDir } from "../../config/paths.ts";
import { errorMessage } from "../../utils/errors.ts";
import { killProcessTree } from "../../utils/processTree.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { ToolFailureCategory } from "../tools/ToolFailure.ts";
import {
	discoverMetaEditor,
	type MetaEditorInstallation,
	type Mql5DiscoveryOverrides,
} from "./MetaEditorDiscovery.ts";
import { decodeMql5Log, type Mql5Diagnostic, parseMql5Log } from "./Mql5Log.ts";
import {
	isWineArgumentSafe,
	toShortWindowsPath,
	unixToWindowsPath,
	type WineRunContext,
	windowsToUnixPath,
	wineEnvironment,
} from "./WinePaths.ts";

export interface CompileMql5Options {
	/** Source path as supplied by the agent (absolute or relative to cwd). */
	filePath: string;
	cwd: string;
	signal: AbortSignal;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homeDir?: string;
	/** Durable directory for the original compiler log (tests override it). */
	logDir?: string;
	discoveryOverrides?: Mql5DiscoveryOverrides;
	maxDiagnostics?: number;
}

export interface Mql5CompileCompilerInfo {
	path: string;
	runner: "native" | "wine";
	wine?: string;
	winePrefix?: string;
}

export interface Mql5CompileResult {
	success: boolean;
	/** Display path of the source file (relative to the session cwd when possible). */
	file: string;
	/** Absolute source path, retained for the UI and diagnostics. */
	absoluteFile: string;
	/** Display path of the produced .ex5, only when it is fresh. */
	output?: string;
	absoluteOutput?: string;
	errors: Mql5Diagnostic[];
	warnings: Mql5Diagnostic[];
	message: string;
	logPath?: string;
	exitCode?: number;
	timedOut?: boolean;
	durationMs: number;
	compiler?: Mql5CompileCompilerInfo;
	errorsTruncated?: boolean;
	warningsTruncated?: boolean;
	/** Machine-readable reason for tool-level failures (never compile errors). */
	failureCategory?: ToolFailureCategory;
	retryable?: boolean;
}

interface CompileTarget {
	/** Windows path passed to `/compile:`. */
	compileWindowsPath: string;
	/** POSIX path the compiler-side source path corresponds to. */
	compileUnixPath?: string;
	/** Absolute directory where MetaEditor writes the .ex5. */
	outputDirectory: string;
	/** Output basename MetaEditor derives from the compiled source. */
	outputBaseName: string;
	/** Set when an ASCII temporary copy was compiled instead of the source. */
	temporarySourcePath?: string;
}

interface OutputSnapshot {
	path: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
}

interface CompilerRun {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	spawnError?: string;
}

const MAX_CAPTURED_OUTPUT = 16_000;
const LOG_READ_TIMEOUT_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function displayPath(path: string, cwd: string): string {
	const relativePath = relative(cwd, path);
	if (relativePath && !relativePath.startsWith("..")) return relativePath;
	return path;
}

/** Control characters and double quotes cannot be safely passed to MetaEditor. */
function hasUnsafePathCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 0x20 || code === 0x22) return true;
	}
	return false;
}

function statIfExists(path: string): OutputSnapshot | undefined {
	try {
		const info = statSync(path);
		if (!info.isFile()) return undefined;
		return {
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
			ctimeMs: info.ctimeMs,
			ino: info.ino,
		};
	} catch {
		return undefined;
	}
}

/** Finds a directory entry by name ignoring case (Wine writes lower-case .ex5). */
function findEntryCaseInsensitive(
	directory: string,
	name: string,
): string | undefined {
	try {
		const target = name.toLowerCase();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.toLowerCase() === target) {
				return join(directory, entry.name);
			}
		}
	} catch {
		// A missing directory simply has no matching output.
	}
	return undefined;
}

function isFreshOutput(
	before: OutputSnapshot | undefined,
	after: OutputSnapshot | undefined,
): boolean {
	if (!after) return false;
	if (!before) return true;
	return (
		before.ino !== after.ino ||
		before.size !== after.size ||
		after.mtimeMs > before.mtimeMs ||
		after.ctimeMs > before.ctimeMs
	);
}

function wineRunContext(
	installation: MetaEditorInstallation,
	env: NodeJS.ProcessEnv,
	homeDir: string,
): WineRunContext {
	const wineBinary = installation.wineBinary;
	if (!wineBinary) {
		throw new Error(
			"Wine launcher is missing from the MetaEditor installation",
		);
	}
	const winePrefix = installation.winePrefix ?? join(homeDir, ".wine");
	return {
		wineBinary,
		winePrefix,
		env: wineEnvironment(env, winePrefix),
	};
}

function outputBaseName(sourcePath: string): string {
	return `${basename(sourcePath, extname(sourcePath))}.ex5`;
}

function temporaryName(extension: string): string {
	const random = Math.random().toString(36).slice(2, 8);
	return `.dquant-mql5-${process.pid}-${Date.now().toString(36)}-${random}${extension}`;
}

/**
 * Picks the Windows path handed to MetaEditor. Wine's ANSI command line loses
 * spaces and non-ASCII characters, so the 8.3 name is used first and an ASCII
 * copy is compiled only when Wine has no short alias for the long path.
 */
async function prepareCompileTarget(options: {
	sourcePath: string;
	installation: MetaEditorInstallation;
	env: NodeJS.ProcessEnv;
	homeDir: string;
	platform: NodeJS.Platform;
	signal: AbortSignal;
}): Promise<CompileTarget | { error: string }> {
	const { sourcePath, installation, env, homeDir, platform, signal } = options;
	const sourceDirectory = dirname(sourcePath);
	if (platform === "win32") {
		return {
			compileWindowsPath: sourcePath,
			outputDirectory: sourceDirectory,
			outputBaseName: outputBaseName(sourcePath),
		};
	}

	const context = wineRunContext(installation, env, homeDir);
	const direct = unixToWindowsPath(sourcePath, context.winePrefix);
	if (isWineArgumentSafe(direct)) {
		return {
			compileWindowsPath: direct,
			compileUnixPath: sourcePath,
			outputDirectory: sourceDirectory,
			outputBaseName: outputBaseName(sourcePath),
		};
	}

	const shortPath = await toShortWindowsPath(sourcePath, context, signal);
	if (signal.aborted) throw new AbortError();
	if (shortPath) {
		return {
			compileWindowsPath: shortPath,
			compileUnixPath: windowsToUnixPath(shortPath, context.winePrefix),
			outputDirectory: sourceDirectory,
			outputBaseName: `${basename(shortPath, extname(shortPath))}.ex5`,
		};
	}

	const temporarySourcePath = join(
		sourceDirectory,
		temporaryName(extname(sourcePath)),
	);
	try {
		copyFileSync(sourcePath, temporarySourcePath);
	} catch (error) {
		return {
			error: `Could not prepare an ASCII compile copy of ${sourcePath}: ${errorMessage(error)}`,
		};
	}

	const directoryDirect = unixToWindowsPath(
		sourceDirectory,
		context.winePrefix,
	);
	const directoryWindows = isWineArgumentSafe(directoryDirect)
		? directoryDirect
		: await toShortWindowsPath(sourceDirectory, context, signal);
	if (!directoryWindows) {
		rmSync(temporarySourcePath, { force: true });
		return {
			error: `The source directory ${sourceDirectory} cannot be represented as a Wine command-line path. Move the file to an ASCII path or set mql5.winePrefix correctly.`,
		};
	}

	return {
		compileWindowsPath: `${directoryWindows}\\${basename(temporarySourcePath)}`,
		outputDirectory: sourceDirectory,
		outputBaseName: `${basename(temporarySourcePath, extname(temporarySourcePath))}.ex5`,
		temporarySourcePath,
	};
}

async function prepareLogPath(options: {
	sourceDirectory: string;
	installation: MetaEditorInstallation;
	env: NodeJS.ProcessEnv;
	homeDir: string;
	platform: NodeJS.Platform;
	signal: AbortSignal;
}): Promise<{ unixPath: string; windowsPath: string } | { error: string }> {
	const { sourceDirectory, installation, env, homeDir, platform, signal } =
		options;
	const logName = temporaryName(".log");
	const unixPath = join(sourceDirectory, logName);
	if (platform === "win32") {
		return { unixPath, windowsPath: unixPath };
	}
	const context = wineRunContext(installation, env, homeDir);
	const direct = unixToWindowsPath(sourceDirectory, context.winePrefix);
	const directoryWindows = isWineArgumentSafe(direct)
		? direct
		: await toShortWindowsPath(sourceDirectory, context, signal);
	if (!directoryWindows) {
		return {
			error: `The log directory ${sourceDirectory} cannot be represented as a Wine path. Set mql5.winePrefix or compile a file from an ASCII directory.`,
		};
	}
	return { unixPath, windowsPath: `${directoryWindows}\\${logName}` };
}

function runMetaEditor(options: {
	installation: MetaEditorInstallation;
	sourcePath: string;
	compileWindowsPath: string;
	logWindowsPath: string;
	env: NodeJS.ProcessEnv;
	homeDir: string;
	platform: NodeJS.Platform;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<CompilerRun> {
	const {
		installation,
		sourcePath,
		compileWindowsPath,
		logWindowsPath,
		env,
		homeDir,
		platform,
		timeoutMs,
		signal,
	} = options;
	const compileArguments = [
		`/compile:${compileWindowsPath}`,
		`/log:${logWindowsPath}`,
	];
	const command =
		installation.runner === "wine"
			? (installation.wineBinary as string)
			: installation.metaEditorPath;
	const args =
		installation.runner === "wine"
			? [installation.metaEditorPath, ...compileArguments]
			: compileArguments;
	const childEnv =
		installation.runner === "wine"
			? wineEnvironment(env, installation.winePrefix ?? join(homeDir, ".wine"))
			: env;

	return new Promise<CompilerRun>((resolvePromise, reject) => {
		if (signal.aborted) {
			reject(new AbortError());
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let cancelled = false;
		let spawnError: string | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let forceFinishTimer: NodeJS.Timeout | undefined;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);

		const cleanup = (): void => {
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			if (forceFinishTimer) clearTimeout(forceFinishTimer);
			signal.removeEventListener("abort", onAbort);
		};
		const settle = (exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (cancelled) {
				reject(new AbortError());
				return;
			}
			resolvePromise({
				exitCode,
				timedOut,
				stdout,
				stderr,
				...(spawnError ? { spawnError } : {}),
			});
		};
		const terminate = (): void => {
			try {
				killProcessTree(child, "SIGTERM");
			} catch {
				// The process may have exited between timer scheduling and firing.
			}
			killTimer = setTimeout(() => {
				try {
					killProcessTree(child, "SIGKILL");
				} catch {
					// Already gone.
				}
			}, 1_500);
			forceFinishTimer = setTimeout(() => settle(null), 4_000);
		};
		const onAbort = (): void => {
			cancelled = true;
			terminate();
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: dirname(sourcePath),
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
				detached: platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			clearTimeout(timeoutTimer);
			signal.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: "",
				spawnError: errorMessage(error),
			});
			return;
		}

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_CAPTURED_OUTPUT) {
				stdout += chunk.toString("utf8");
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_CAPTURED_OUTPUT) {
				stderr += chunk.toString("utf8");
			}
		});
		child.on("error", (error) => {
			spawnError = errorMessage(error);
			settle(null);
		});
		child.on("close", (code) => settle(code));
	});
}

/** Waits briefly for MetaEditor to flush the log, then returns its bytes. */
async function readCompilerLog(logPath: string): Promise<Buffer | undefined> {
	const deadline = Date.now() + LOG_READ_TIMEOUT_MS;
	let lastSize = -1;
	let stableReads = 0;
	while (Date.now() < deadline) {
		try {
			const info = await stat(logPath);
			if (info.size > 0) {
				if (info.size === lastSize) {
					stableReads++;
					if (stableReads >= 2) break;
				} else {
					lastSize = info.size;
					stableReads = 0;
				}
			}
		} catch {
			// The compiler may still be creating the file.
		}
		await new Promise((settle) => setTimeout(settle, 100));
	}
	try {
		return readFileSync(logPath);
	} catch {
		return undefined;
	}
}

function sanitizeLogName(value: string): string {
	const ascii = value.replace(/[^\x20-\x7e]/g, "_");
	const safe = ascii.replace(/[\\/:*?"<>|]+/g, "_").trim();
	return (safe || "mql5-compile").slice(0, 80);
}

/**
 * Copies the original UTF-16/ANSI log to a durable location so the user can
 * inspect it later. If that copy fails the temporary log is kept instead.
 */
function persistCompilerLog(
	temporaryLogPath: string,
	logDirectory: string,
	sourcePath: string,
): string {
	try {
		mkdirSync(logDirectory, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const destination = join(
			logDirectory,
			`${sanitizeLogName(basename(sourcePath, extname(sourcePath)))}-${stamp}.log`,
		);
		copyFileSync(temporaryLogPath, destination);
		rmSync(temporaryLogPath, { force: true });
		return destination;
	} catch {
		return temporaryLogPath;
	}
}

function sameFile(left: string, right: string): boolean {
	if (left === right) return true;
	try {
		return (
			statSync(left).ino === statSync(right).ino &&
			statSync(left).dev === statSync(right).dev
		);
	} catch {
		return false;
	}
}

/**
 * Compiles one MQL5 file with the user's installed MetaEditor.
 *
 * Resolution is deliberately independent of the process exit code: success
 * requires a `Result: 0 errors` line in the log and a freshly written .ex5.
 */
export async function compileMql5File(
	options: CompileMql5Options,
): Promise<Mql5CompileResult> {
	const startedAt = Date.now();
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? homedir();
	const cwd = resolve(options.cwd);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sourcePath = resolve(cwd, options.filePath);
	const file = displayPath(sourcePath, cwd);
	const fail = (
		message: string,
		extra: Partial<Mql5CompileResult> = {},
	): Mql5CompileResult => ({
		success: false,
		file,
		absoluteFile: sourcePath,
		errors: [],
		warnings: [],
		message,
		durationMs: Date.now() - startedAt,
		...extra,
	});

	if (options.signal.aborted) throw new AbortError();
	if (!options.filePath.trim()) {
		return fail("file_path is required.", {
			failureCategory: "invalid_argument",
		});
	}
	if (extname(sourcePath).toLowerCase() !== ".mq5") {
		return fail(`Expected an .mq5 source file, received ${file}.`, {
			failureCategory: "invalid_argument",
		});
	}
	if (hasUnsafePathCharacters(sourcePath)) {
		return fail(
			"The file path contains characters that cannot be passed to MetaEditor safely (control characters or double quotes).",
			{ failureCategory: "invalid_argument" },
		);
	}
	try {
		const info = await stat(sourcePath);
		if (!info.isFile()) {
			return fail(`Source path is not a file: ${file}.`, {
				failureCategory: "invalid_argument",
			});
		}
	} catch {
		return fail(`Source file not found: ${file}.`, {
			failureCategory: "missing_path",
		});
	}

	const discovery = discoverMetaEditor({
		cwd,
		homeDir,
		env,
		platform,
		overrides: options.discoveryOverrides,
	});
	const installation = discovery.installation;
	if (!installation) {
		return fail(
			discovery.problem ??
				"MetaTrader 5 MetaEditor was not found on this machine.",
			{ failureCategory: "unavailable" },
		);
	}
	const compiler: Mql5CompileCompilerInfo = {
		path: installation.metaEditorPath,
		runner: installation.runner,
		...(installation.wineBinary ? { wine: installation.wineBinary } : {}),
		...(installation.winePrefix ? { winePrefix: installation.winePrefix } : {}),
	};

	const target = await prepareCompileTarget({
		sourcePath,
		installation,
		env,
		homeDir,
		platform,
		signal: options.signal,
	});
	if ("error" in target) {
		return fail(target.error, {
			compiler,
			failureCategory: "invalid_argument",
		});
	}

	const logTarget = await prepareLogPath({
		sourceDirectory: dirname(sourcePath),
		installation,
		env,
		homeDir,
		platform,
		signal: options.signal,
	});
	if ("error" in logTarget) {
		if (target.temporarySourcePath) {
			rmSync(target.temporarySourcePath, { force: true });
		}
		return fail(logTarget.error, { compiler, failureCategory: "execution" });
	}
	if (options.signal.aborted) {
		if (target.temporarySourcePath) {
			rmSync(target.temporarySourcePath, { force: true });
		}
		throw new AbortError();
	}

	const originalOutputPath = join(
		dirname(sourcePath),
		outputBaseName(sourcePath),
	);
	const candidateBeforePath = findEntryCaseInsensitive(
		target.outputDirectory,
		target.outputBaseName,
	);
	const candidateBefore = candidateBeforePath
		? statIfExists(candidateBeforePath)
		: undefined;

	let temporarySourcePath = target.temporarySourcePath;
	let temporaryLogPath: string | undefined = logTarget.unixPath;
	let logRetained = false;

	try {
		const run = await runMetaEditor({
			installation,
			sourcePath,
			compileWindowsPath: target.compileWindowsPath,
			logWindowsPath: logTarget.windowsPath,
			env,
			homeDir,
			platform,
			timeoutMs,
			signal: options.signal,
		});
		if (options.signal.aborted) throw new AbortError();

		const logBytes = await readCompilerLog(logTarget.unixPath);
		const logPath = logBytes
			? persistCompilerLog(
					logTarget.unixPath,
					options.logDir ??
						env.DQUANT_MQL5_LOG_DIR?.trim() ??
						join(qUserConfigDir(homeDir), "logs", "mql5"),
					sourcePath,
				)
			: undefined;
		logRetained = logPath === temporaryLogPath;
		const shared = {
			...(logPath ? { logPath } : {}),
			exitCode: run.exitCode ?? undefined,
			compiler,
		};

		const parsed = logBytes
			? parseMql5Log(decodeMql5Log(logBytes), {
					defaultFile: sourcePath,
					mapFile: (compilerFile) =>
						mapCompilerFilePath(
							compilerFile,
							sourcePath,
							target,
							installation,
							platform,
							homeDir,
						),
					maxDiagnostics: options.maxDiagnostics,
				})
			: undefined;
		const errors = parsed?.errors ?? [];
		const warnings = parsed?.warnings ?? [];
		const reportedErrors = parsed?.reportedErrors ?? errors.length;
		const reportedWarnings = parsed?.reportedWarnings ?? warnings.length;
		const diagnostics = {
			errors,
			warnings,
			...(parsed?.errorsTruncated ? { errorsTruncated: true } : {}),
			...(parsed?.warningsTruncated ? { warningsTruncated: true } : {}),
		};

		const candidatePath = findEntryCaseInsensitive(
			target.outputDirectory,
			target.outputBaseName,
		);
		const candidateAfter = candidatePath
			? statIfExists(candidatePath)
			: undefined;
		const freshOutput = isFreshOutput(candidateBefore, candidateAfter);

		if (run.timedOut) {
			return fail(
				`Compilation timed out after ${Math.round(timeoutMs / 1000)}s. The compiler process was stopped; ${freshOutput ? "a partial .ex5 was written and left in place" : "no .ex5 was produced"}.`,
				{
					...shared,
					...diagnostics,
					timedOut: true,
					failureCategory: "timeout",
					retryable: true,
				},
			);
		}
		if (run.spawnError) {
			return fail(
				`Could not start MetaEditor (${installation.metaEditorPath}): ${run.spawnError}.`,
				{ ...shared, ...diagnostics, failureCategory: "execution" },
			);
		}
		if (!logBytes || !parsed) {
			const stderr = run.stderr.trim();
			return fail(
				`MetaEditor finished (exit code ${run.exitCode ?? "null"}) but did not write a compile log at ${logTarget.unixPath}; the result cannot be verified.${stderr ? ` Compiler output: ${stderr.slice(-800)}` : ""}`,
				{ ...shared, ...diagnostics, failureCategory: "protocol" },
			);
		}
		if (errors.length > 0 || reportedErrors > 0) {
			return fail("Compilation failed", { ...shared, ...diagnostics });
		}
		if (!parsed.hasResultLine) {
			return fail(
				"MetaEditor wrote a log without a Result line; the compile result is unknown.",
				{ ...shared, ...diagnostics, failureCategory: "protocol" },
			);
		}
		if (!candidatePath || !candidateAfter) {
			return fail(
				"MetaEditor reported 0 errors but did not produce an .ex5 file.",
				{ ...shared, ...diagnostics, failureCategory: "execution" },
			);
		}
		if (!freshOutput) {
			return fail(
				"MetaEditor reported 0 errors but the .ex5 was not updated by this run; it is a stale artifact from an earlier build.",
				{ ...shared, ...diagnostics, failureCategory: "execution" },
			);
		}

		let finalOutputPath: string = candidatePath;
		if (!sameFile(candidatePath, originalOutputPath)) {
			try {
				copyFileSync(candidatePath, originalOutputPath);
				rmSync(candidatePath, { force: true });
				finalOutputPath = originalOutputPath;
			} catch (error) {
				return fail(
					`Compilation succeeded, but the .ex5 could not be moved to ${originalOutputPath}: ${errorMessage(error)}.`,
					{ ...shared, ...diagnostics },
				);
			}
		}
		if (!statIfExists(finalOutputPath)) {
			return fail(
				`Compilation succeeded, but the expected output ${finalOutputPath} is missing.`,
				{ ...shared, ...diagnostics },
			);
		}

		return {
			success: true,
			file,
			absoluteFile: sourcePath,
			output: displayPath(finalOutputPath, cwd),
			absoluteOutput: finalOutputPath,
			message:
				reportedWarnings > 0
					? `Compilation successful with ${reportedWarnings} warning${reportedWarnings === 1 ? "" : "s"}`
					: "Compilation successful",
			...shared,
			...diagnostics,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (temporarySourcePath) {
			rmSync(temporarySourcePath, { force: true });
			temporarySourcePath = undefined;
		}
		if (temporaryLogPath && !logRetained) {
			rmSync(temporaryLogPath, { force: true });
			temporaryLogPath = undefined;
		}
	}
}

function mapCompilerFilePath(
	compilerFile: string,
	sourcePath: string,
	target: CompileTarget,
	installation: MetaEditorInstallation,
	platform: NodeJS.Platform,
	homeDir: string,
): string {
	const trimmed = compilerFile.trim();
	if (!trimmed) return sourcePath;
	const fileName = basename(trimmed.replace(/\\/g, "/")).toLowerCase();
	const compiledName = basename(
		target.compileWindowsPath.replace(/\\/g, "/"),
	).toLowerCase();
	if (fileName === compiledName) return sourcePath;
	if (
		target.temporarySourcePath &&
		fileName === basename(target.temporarySourcePath).toLowerCase()
	) {
		return sourcePath;
	}
	if (platform === "win32") return trimmed;
	const unixPath = windowsToUnixPath(
		trimmed,
		installation.winePrefix ?? join(homeDir, ".wine"),
	);
	if (!unixPath) return trimmed;
	if (
		target.compileUnixPath &&
		unixPath.toLowerCase() === target.compileUnixPath.toLowerCase()
	) {
		return sourcePath;
	}
	return unixPath;
}
