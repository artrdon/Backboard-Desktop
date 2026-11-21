/** One compiler diagnostic reported by MetaEditor. */
export interface Mql5Diagnostic {
	/** File the diagnostic belongs to (mapped back to a native path). */
	file: string;
	line: number;
	column?: number;
	code?: number;
	severity: "error" | "warning";
	message: string;
}

export interface ParsedMql5Log {
	errors: Mql5Diagnostic[];
	warnings: Mql5Diagnostic[];
	/** Counts from the trailing `Result:` line, when present. */
	reportedErrors?: number;
	reportedWarnings?: number;
	hasResultLine: boolean;
	errorsTruncated: boolean;
	warningsTruncated: boolean;
}

export interface ParseMql5LogOptions {
	/** Maps a compiler-side path (for example a Wine short path) to a real one. */
	mapFile?: (file: string) => string;
	/** Used for messages MetaEditor prints without a file name. */
	defaultFile?: string;
	maxDiagnostics?: number;
}

const RESULT_LINE = /^Result:\s*(\d+)\s+errors?,\s*(\d+)\s+warnings?(?:,|$)/i;
const POSITIONED_DIAGNOSTIC =
	/^(.*)\((\d+)\s*,\s*(\d+)\)\s*:\s*(fatal error|error|warning)\s*(\d+)?\s*:?\s*(.*)$/i;
const UNPOSITIONED_DIAGNOSTIC =
	/^(.*?)\s*:\s*(fatal error|error|warning)\s*(\d+)?\s*:?\s*(.*)$/i;

/**
 * Decodes a MetaEditor log. Current builds write UTF-16LE with a BOM; older
 * builds and non-English Windows installations can write the system ANSI
 * codepage instead, so UTF-8 and Windows-1251 are tried before Latin-1.
 */
export function decodeMql5Log(bytes: Uint8Array): string {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let text: string;
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		text = buffer.subarray(2).toString("utf16le");
	} else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const body = buffer.subarray(2, buffer.length - (buffer.length % 2));
		const copy = Buffer.from(body);
		copy.swap16();
		text = copy.toString("utf16le");
	} else if (looksLikeUtf16Le(buffer)) {
		text = buffer.toString("utf16le");
	} else {
		text = decodeWithFallbacks(buffer);
	}
	return text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\0+$/g, "");
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
	const sampleLength = Math.min(buffer.length, 512);
	if (sampleLength < 4) return false;
	let zerosAtOdd = 0;
	let zerosAtEven = 0;
	for (let index = 0; index < sampleLength; index++) {
		if (buffer[index] !== 0) continue;
		if (index % 2 === 0) zerosAtEven++;
		else zerosAtOdd++;
	}
	return zerosAtOdd > sampleLength / 8 && zerosAtEven < zerosAtOdd / 4;
}

function decodeWithFallbacks(buffer: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		// Not UTF-8: try the common Windows Cyrillic codepage.
	}
	try {
		return new TextDecoder("windows-1251").decode(buffer);
	} catch {
		// TextDecoder may be built without legacy encodings.
	}
	return buffer.toString("latin1");
}

/** Parses MetaEditor diagnostics and the trailing result summary. */
export function parseMql5Log(
	text: string,
	options: ParseMql5LogOptions = {},
): ParsedMql5Log {
	const maxDiagnostics = options.maxDiagnostics ?? 500;
	const errors: Mql5Diagnostic[] = [];
	const warnings: Mql5Diagnostic[] = [];
	const seen = new Set<string>();
	let reportedErrors: number | undefined;
	let reportedWarnings: number | undefined;
	let hasResultLine = false;
	let errorsTruncated = false;
	let warningsTruncated = false;

	const push = (
		severity: "error" | "warning",
		file: string,
		line: number,
		column: number | undefined,
		code: number | undefined,
		message: string,
	): void => {
		const diagnostic: Mql5Diagnostic = {
			file: options.mapFile?.(file) ?? file,
			line,
			...(column !== undefined ? { column } : {}),
			...(code !== undefined ? { code } : {}),
			severity,
			message: message.trim(),
		};
		const key = JSON.stringify(diagnostic);
		if (seen.has(key)) return;
		seen.add(key);
		const target = severity === "error" ? errors : warnings;
		if (target.length >= maxDiagnostics) {
			if (severity === "error") errorsTruncated = true;
			else warningsTruncated = true;
			return;
		}
		target.push(diagnostic);
	};

	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trimEnd();
		if (!line) continue;

		const result = RESULT_LINE.exec(line);
		if (result?.[1] && result[2] !== undefined) {
			reportedErrors = Number.parseInt(result[1], 10);
			reportedWarnings = Number.parseInt(result[2], 10);
			hasResultLine = true;
			continue;
		}

		const positioned = POSITIONED_DIAGNOSTIC.exec(line);
		if (positioned) {
			const severity =
				positioned[4]?.toLowerCase() === "warning" ? "warning" : "error";
			const code =
				positioned[5] !== undefined
					? Number.parseInt(positioned[5], 10)
					: undefined;
			push(
				severity,
				positioned[1] ?? options.defaultFile ?? "",
				Number.parseInt(positioned[2] ?? "0", 10),
				Number.parseInt(positioned[3] ?? "0", 10),
				code,
				positioned[6] ?? "",
			);
			continue;
		}

		const unpositioned = UNPOSITIONED_DIAGNOSTIC.exec(line);
		if (unpositioned) {
			const severity =
				unpositioned[2]?.toLowerCase() === "warning" ? "warning" : "error";
			const file = (unpositioned[1] ?? "").trim();
			// Ignore informational progress lines such as ` : information: ...`.
			if (!file && !/^\s*:/.test(line)) continue;
			if (/information\s*:/i.test(line)) continue;
			const code =
				unpositioned[3] !== undefined
					? Number.parseInt(unpositioned[3], 10)
					: undefined;
			push(
				severity,
				file || options.defaultFile || "",
				0,
				undefined,
				code,
				unpositioned[4] ?? "",
			);
		}
	}

	return {
		errors,
		warnings,
		...(reportedErrors !== undefined ? { reportedErrors } : {}),
		...(reportedWarnings !== undefined ? { reportedWarnings } : {}),
		hasResultLine,
		errorsTruncated,
		warningsTruncated,
	};
}
