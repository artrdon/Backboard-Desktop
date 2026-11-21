import { describe, expect, it } from "bun:test";
import { decodeMql5Log, parseMql5Log } from "../src/core/mql5/Mql5Log.ts";

const sampleLog = [
	"Z:\\tmp\\Expert.mq5 : information: compiling Z:\\tmp\\Expert.mq5",
	"Z:\\tmp\\Expert.mq5(4,10) : error 256: undeclared identifier 'foo'",
	"Z:\\tmp\\Expert.mq5(6,3) : warning 43: possible loss of data due to type conversion",
	"Z:\\tmp\\Expert.mq5(6,3) : warning 43: possible loss of data due to type conversion",
	"Result: 1 errors, 1 warnings, 12 ms elapsed, cpu='X64 Regular'",
].join("\r\n");

function utf16leWithBom(text: string): Buffer {
	return Buffer.concat([
		Buffer.from([0xff, 0xfe]),
		Buffer.from(text, "utf16le"),
	]);
}

describe("decodeMql5Log", () => {
	it("decodes the UTF-16LE BOM log current MetaEditor builds write", () => {
		const decoded = decodeMql5Log(utf16leWithBom(sampleLog));
		expect(decoded).toContain("error 256: undeclared identifier 'foo'");
		expect(decoded).not.toContain("\r");
		expect(decoded).not.toContain("\uFEFF");
	});

	it("decodes plain UTF-8 logs without a BOM", () => {
		expect(decodeMql5Log(Buffer.from(sampleLog, "utf8"))).toContain(
			"warning 43",
		);
	});

	it("falls back to Windows-1251 for ANSI logs", () => {
		// "Привет" in Windows-1251; no valid UTF-8 sequence is present.
		const decoded = decodeMql5Log(
			Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
		);
		expect(decoded).toBe("Привет");
	});

	it("detects UTF-16LE without a BOM", () => {
		const decoded = decodeMql5Log(Buffer.from(sampleLog, "utf16le"));
		expect(decoded).toContain("Result: 1 errors, 1 warnings");
	});
});

describe("parseMql5Log", () => {
	it("extracts positioned errors and warnings and the result counts", () => {
		const parsed = parseMql5Log(sampleLog);
		expect(parsed.hasResultLine).toBe(true);
		expect(parsed.reportedErrors).toBe(1);
		expect(parsed.reportedWarnings).toBe(1);
		expect(parsed.errors).toHaveLength(1);
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.errors[0]).toMatchObject({
			file: "Z:\\tmp\\Expert.mq5",
			line: 4,
			column: 10,
			code: 256,
			severity: "error",
			message: "undeclared identifier 'foo'",
		});
		expect(parsed.warnings[0]?.line).toBe(6);
	});

	it("drops byte-identical duplicates without dropping distinct warnings", () => {
		const parsed = parseMql5Log(
			[
				"A.mq5(1,1) : warning 43: first",
				"A.mq5(1,1) : warning 43: first",
				"A.mq5(2,1) : warning 44: second",
			].join("\n"),
		);
		expect(parsed.warnings.map((warning) => warning.message)).toEqual([
			"first",
			"second",
		]);
	});

	it("maps compiler-side paths back to native paths", () => {
		const parsed = parseMql5Log(sampleLog, {
			mapFile: (file) => file.replace("Z:\\tmp\\", "/home/user/"),
		});
		expect(parsed.errors[0]?.file).toBe("/home/user/Expert.mq5");
	});

	it("keeps errors that have no line position", () => {
		const parsed = parseMql5Log(" : error 100: cannot open include file", {
			defaultFile: "/work/Expert.mq5",
		});
		expect(parsed.errors).toEqual([
			{
				file: "/work/Expert.mq5",
				line: 0,
				code: 100,
				severity: "error",
				message: "cannot open include file",
			},
		]);
	});

	it("ignores information and progress lines", () => {
		const parsed = parseMql5Log(
			[
				"Z:\\Expert.mq5 : information: compiling Z:\\Expert.mq5",
				" : information: generating code 50%",
				"Result: 0 errors, 0 warnings",
			].join("\n"),
		);
		expect(parsed.errors).toHaveLength(0);
		expect(parsed.warnings).toHaveLength(0);
		expect(parsed.hasResultLine).toBe(true);
	});

	it("bounds diagnostics and reports truncation", () => {
		const lines = Array.from(
			{ length: 5 },
			(_, index) => `A.mq5(${index + 1},1) : error 1: failure ${index}`,
		);
		const parsed = parseMql5Log(lines.join("\n"), { maxDiagnostics: 2 });
		expect(parsed.errors).toHaveLength(2);
		expect(parsed.errorsTruncated).toBe(true);
	});
});
