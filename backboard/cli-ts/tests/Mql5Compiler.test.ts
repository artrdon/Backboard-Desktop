import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Config } from "../src/config/Config.ts";
import { discoverMetaEditor } from "../src/core/mql5/MetaEditorDiscovery.ts";
import {
	compileMql5File,
	type Mql5CompileResult,
} from "../src/core/mql5/Mql5Compiler.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { CompileMql5Tool } from "../src/tools/CompileMql5Tool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { createDefaultTools } from "../src/tools/index.ts";
import { WriteTool } from "../src/tools/WriteTool.tsx";
import { TEST_BACKBOARD_ENV } from "./helpers/agent.ts";
import { makeContext } from "./helpers.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function abortSignal(): AbortSignal {
	return new AbortController().signal;
}

describe("compile_mql5 registration", () => {
	it("is part of the default agent tool set and advertises file_path", () => {
		const tool = createDefaultTools().find(
			(candidate): candidate is CompileMql5Tool =>
				candidate.agentName === "compile_mql5",
		);
		expect(tool).toBeDefined();
		expect(tool?.checkPermissions()?.behavior).toBe("allow");
		expect(tool?.prompt()).toContain("MetaEditor");
		expect(JSON.stringify(tool?.toJSONSchema())).toContain("file_path");
	});

	it("reaches the provider tool schema for the coding profile", () => {
		const config = new Config({ env: TEST_BACKBOARD_ENV, argv: [] });
		expect(config.isToolEnabled("CompileMql5")).toBe(true);
		const registry = new ToolRegistry(createDefaultTools());
		const names = config.toolPolicy
			.visibleSchemas(registry, [], "default")
			.map((schema) => schema.function.name);
		expect(names).toContain("compile_mql5");
	});

	it("returns a structured failure for a missing source file", async () => {
		const tool = new CompileMql5Tool();
		const result = await tool.execute(
			{ file_path: "missing-expert.mq5" },
			makeContext(abortSignal()),
		);
		const payload = JSON.parse(result.forLLM) as {
			success: boolean;
			message: string;
			errors: unknown[];
		};
		expect(payload.success).toBe(false);
		expect(payload.message).toContain("not found");
		expect(payload.errors).toEqual([]);
		expect(result.execution?.failureCategory).toBe("missing_path");
	});

	it("rejects non-MQL5 files", async () => {
		const result = await compileMql5File({
			filePath: "expert.mq4",
			cwd: process.cwd(),
			signal: abortSignal(),
		});
		expect(result.success).toBe(false);
		expect(result.failureCategory).toBe("invalid_argument");
	});

	it("reports an unavailable compiler without spawning a process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mql5-unavailable-"));
		try {
			const source = join(directory, "Expert.mq5");
			await writeFile(source, "void OnTick() { }\n");
			const result = await compileMql5File({
				filePath: source,
				cwd: directory,
				signal: abortSignal(),
				discoveryOverrides: {
					metaEditorPath: "/definitely/not/installed/MetaEditor64.exe",
					autoDetect: false,
				},
			});
			expect(result.success).toBe(false);
			expect(result.failureCategory).toBe("unavailable");
			expect(result.message).toContain("MetaEditor");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

const discovery = discoverMetaEditor({
	cwd: process.cwd(),
	homeDir: homedir(),
	env: process.env,
});
const realInstallation = discovery.installation;

describe("MetaEditor discovery", () => {
	it("finds a native Windows install through ProgramFiles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mql5-win-detect-"));
		try {
			const install = join(directory, "MetaTrader 5");
			await mkdir(install);
			const executable = join(install, "MetaEditor64.exe");
			await writeFile(executable, "");
			const result = discoverMetaEditor({
				cwd: directory,
				homeDir: directory,
				env: { ProgramFiles: directory },
				platform: "win32",
			});
			expect(result.installation?.runner).toBe("native");
			expect(result.installation?.metaEditorPath).toBe(executable);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("returns a clear macOS error when no usable environment exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mql5-mac-detect-"));
		try {
			const result = discoverMetaEditor({
				cwd: directory,
				homeDir: directory,
				env: {},
				platform: "darwin",
			});
			expect(result.installation).toBeUndefined();
			expect(result.problem).toContain("macOS");
			expect(result.problem).toContain("Wine");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("honors mql5.metaeditorPath and mql5.winePath from project settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mql5-manual-detect-"));
		try {
			const install = join(directory, "custom-mt5");
			await mkdir(install);
			const executable = join(install, "MetaEditor64.exe");
			await writeFile(executable, "");
			await mkdir(join(directory, ".backboard"));
			await writeFile(
				join(directory, ".backboard", "settings.json"),
				JSON.stringify({
					mql5: {
						metaeditorPath: executable,
						winePath: "/usr/bin/wine",
					},
				}),
			);
			const home = join(directory, "home");
			await mkdir(home);
			const result = discoverMetaEditor({
				cwd: directory,
				homeDir: home,
				env: { PATH: "" },
				platform: "linux",
			});
			expect(result.installation?.source).toBe("project-settings");
			expect(result.installation?.wineBinary).toBe("/usr/bin/wine");
			expect(result.installation?.metaEditorPath).toBe(executable);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

/**
 * These tests use the MetaEditor actually installed in the environment. They
 * are skipped when no compiler is present and are never replaced by a mock
 * that pretends to compile.
 */
describe.skipIf(!realInstallation)(
	"compile_mql5 with the installed MetaEditor",
	() => {
		let workdir: string;

		beforeAll(async () => {
			workdir = await mkdtemp(join(tmpdir(), "mql5-compile-real-"));
			await mkdir(join(workdir, "logs"), { recursive: true });
			process.env.DQUANT_MQL5_LOG_DIR = join(workdir, "logs");
		});

		afterAll(async () => {
			delete process.env.DQUANT_MQL5_LOG_DIR;
			await rm(workdir, { recursive: true, force: true });
		});

		async function compile(name: string): Promise<Mql5CompileResult> {
			return compileMql5File({
				filePath: name,
				cwd: workdir,
				signal: abortSignal(),
				timeoutMs: 120_000,
				logDir: join(workdir, "logs"),
			});
		}

		it("returns real syntax errors with line and column numbers", async () => {
			const name = "Bad Expert.mq5";
			await writeFile(
				join(workdir, name),
				[
					"#property strict",
					"void OnTick()",
					"{",
					"\tint value = undeclared_identifier;",
					"}",
					"",
				].join("\n"),
			);

			const result = await compile(name);
			expect(result.success).toBe(false);
			expect(result.message).toBe("Compilation failed");
			const error = result.errors.find((diagnostic) =>
				diagnostic.message.includes("undeclared_identifier"),
			);
			expect(error).toBeDefined();
			expect(error?.line).toBe(4);
			expect(error?.column).toBeGreaterThan(0);
			expect(error?.code).toBeGreaterThan(0);
			expect(error?.file.endsWith(name)).toBe(true);
			expect(result.output).toBeUndefined();
			expect(await exists(join(workdir, "Bad Expert.ex5"))).toBe(false);
			expect(result.logPath).toBeDefined();
			expect(await exists(result.logPath as string)).toBe(true);
		}, 180_000);

		it("keeps warnings and produces a fresh .ex5 on success", async () => {
			const name = "Warning Expert.mq5";
			await writeFile(
				join(workdir, name),
				[
					"#property strict",
					"void OnInit() { }",
					"void OnTick() { double source = 3.5; int converted = source; Print(converted); }",
					"",
				].join("\n"),
			);

			const result = await compile(name);
			expect(result.success).toBe(true);
			expect(result.errors).toEqual([]);
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings[0]?.line).toBe(3);
			expect(result.message).toContain("Compilation successful");
			expect(result.output).toBeDefined();
			expect(result.output?.endsWith(".ex5")).toBe(true);
			expect(await exists(join(workdir, result.output as string))).toBe(true);
		}, 180_000);

		it("compiles a file whose name has spaces and Cyrillic characters", async () => {
			const name = "Советник с пробелом.mq5";
			await writeFile(
				join(workdir, name),
				["#property strict", "void OnInit() { }", "void OnTick() { }", ""].join(
					"\n",
				),
			);

			const result = await compile(name);
			expect(result.success).toBe(true);
			expect(result.output).toBeDefined();
			expect(basename(result.output as string)).toBe("Советник с пробелом.ex5");
			expect(await exists(join(workdir, "Советник с пробелом.ex5"))).toBe(true);
		}, 180_000);

		it("does not accept a stale .ex5 as success and succeeds after a fix", async () => {
			const name = "Cycle Expert.mq5";
			const output = join(workdir, "Cycle Expert.ex5");
			const stale = Buffer.from("stale-artifact-from-an-earlier-build");
			await writeFile(output, stale);
			await utimes(output, new Date(2000, 0, 1), new Date(2000, 0, 1));
			await writeFile(
				join(workdir, name),
				[
					"#property strict",
					"void OnTick()",
					"{",
					"\tint value = still_missing_symbol;",
					"}",
					"",
				].join("\n"),
			);

			const failed = await compile(name);
			expect(failed.success).toBe(false);
			expect(failed.output).toBeUndefined();
			expect(failed.message).toBe("Compilation failed");
			expect(await readFile(output)).toEqual(stale);

			await writeFile(
				join(workdir, name),
				["#property strict", "void OnInit() { }", "void OnTick() { }", ""].join(
					"\n",
				),
			);
			const fixed = await compile(name);
			expect(fixed.success).toBe(true);
			expect(fixed.output).toBeDefined();
			const produced = await readFile(output);
			expect(produced.equals(stale)).toBe(false);
			expect(produced.byteLength).toBeGreaterThan(stale.byteLength);
		}, 240_000);

		it("supports the real Write -> Compile -> Edit -> recompile agent loop", async () => {
			const context = {
				...makeContext(abortSignal()),
				cwd: workdir,
			};
			const name = "Agent Loop.mq5";
			await new WriteTool().execute(
				{
					file_path: name,
					content: [
						"#property strict",
						"void OnTick()",
						"{",
						"\tint value = wrong_symbol;",
						"}",
						"",
					].join("\n"),
				},
				context,
			);

			const first = await new CompileMql5Tool().execute(
				{ file_path: name },
				context,
			);
			const firstPayload = JSON.parse(first.forLLM) as {
				success: boolean;
				errors: Array<{ line: number; message: string }>;
			};
			expect(firstPayload.success).toBe(false);
			expect(
				firstPayload.errors.some((error) =>
					error.message.includes("wrong_symbol"),
				),
			).toBe(true);
			expect(first.execution?.outcome).toBe("failure");

			const edit = new EditTool();
			await edit.execute(
				edit.parseInput({
					file_path: name,
					old_str: "wrong_symbol",
					new_str: "1",
				}),
				context,
			);
			const second = await new CompileMql5Tool().execute(
				{ file_path: name },
				context,
			);
			const secondPayload = JSON.parse(second.forLLM) as {
				success: boolean;
				output?: string;
				errors: unknown[];
			};
			expect(secondPayload.success).toBe(true);
			expect(secondPayload.errors).toEqual([]);
			expect(secondPayload.output).toBe("Agent Loop.ex5");
			expect(second.execution?.outcome).toBe("success");
		}, 240_000);
	},
);
