import { execFile } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";

/** Describes how a Wine-hosted Windows binary is launched. */
export interface WineRunContext {
	wineBinary: string;
	winePrefix: string;
	env: NodeJS.ProcessEnv;
}

interface DosDeviceMapping {
	drive: string;
	target: string;
}

/** True for `C:\...` and `C:/...` style paths. */
export function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

/** Expands a leading `~` without touching the rest of the path. */
export function expandHomePath(value: string, homeDir: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homeDir, value.slice(2));
	}
	return value;
}

/**
 * MetaEditor receives its arguments through Wine's ANSI command line. Spaces
 * and non-ASCII characters are lost there, so the compiler is given an 8.3
 * short path whenever the long path is not plain printable ASCII.
 */
export function isWineArgumentSafe(value: string): boolean {
	return (
		value.length > 0 && /^[\x21-\x7e]+$/.test(value) && !value.includes('"')
	);
}

/** Reads the drive mappings of a Wine prefix (`dosdevices/c:` -> drive_c). */
function dosDeviceMappings(winePrefix: string): DosDeviceMapping[] {
	const mappingDir = join(winePrefix, "dosdevices");
	const mappings: DosDeviceMapping[] = [];
	try {
		for (const entry of readdirSync(mappingDir)) {
			const match = /^([a-z]):$/i.exec(entry);
			if (!match?.[1]) continue;
			try {
				const target = realpathSync(join(mappingDir, entry));
				mappings.push({ drive: match[1].toLowerCase(), target });
			} catch {
				// A dangling dosdevice entry cannot map anything.
			}
		}
	} catch {
		// Not a Wine prefix (or no drives yet); callers fall back to Z:.
	}
	return mappings.sort(
		(left, right) => right.target.length - left.target.length,
	);
}

/** Converts a POSIX path to the Windows path Wine exposes for it. */
export function unixToWindowsPath(
	unixPath: string,
	winePrefix: string,
): string {
	const absolute = resolve(unixPath);
	for (const mapping of dosDeviceMappings(winePrefix)) {
		if (absolute === mapping.target) {
			return `${mapping.drive.toUpperCase()}:\\`;
		}
		if (absolute.startsWith(`${mapping.target}${sep}`)) {
			const relative = absolute
				.slice(mapping.target.length + 1)
				.split(sep)
				.join("\\");
			return `${mapping.drive.toUpperCase()}:\\${relative}`;
		}
	}
	// Wine maps the host filesystem root to Z: by default.
	return `Z:\\${absolute.replace(/^\/+/, "").split("/").join("\\")}`;
}

/** Converts a Windows path produced by MetaEditor back to a POSIX path. */
export function windowsToUnixPath(
	windowsPath: string,
	winePrefix: string,
): string | undefined {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
	if (!match?.[1]) return undefined;
	const drive = match[1].toLowerCase();
	const relative = (match[2] ?? "").split(/[\\/]+/).filter(Boolean);
	const mapping = dosDeviceMappings(winePrefix).find(
		(candidate) => candidate.drive === drive,
	);
	if (mapping) return join(mapping.target, ...relative);
	if (drive === "z") return join("/", ...relative);
	return undefined;
}

/** Finds the Wine prefix containing a POSIX MetaEditor path, if any. */
export function findWinePrefixForPath(
	metaEditorPath: string,
): string | undefined {
	let current = dirname(resolve(metaEditorPath));
	while (true) {
		if (current !== dirname(current) && /^drive_c$/i.test(current.slice(-7))) {
			return dirname(current);
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Common Wine prefix locations for the current user. */
export function listWinePrefixes(
	env: NodeJS.ProcessEnv,
	homeDir: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const candidates = new Set<string>();
	const add = (value: string | undefined): void => {
		const trimmed = value?.trim();
		if (trimmed) candidates.add(resolve(expandHomePath(trimmed, homeDir)));
	};

	add(env.WINEPREFIX);
	add(join(homeDir, ".wine"));
	for (const prefix of [".mt5", ".mt5-stable", ".mt4", ".wine_mt5"]) {
		add(join(homeDir, prefix));
	}

	const addChildren = (directory: string): void => {
		if (!existsSync(directory)) return;
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entry.isDirectory()) add(join(directory, entry.name));
			}
		} catch {
			// Unreadable directories are simply not candidates.
		}
	};

	try {
		for (const entry of readdirSync(homeDir, { withFileTypes: true })) {
			if (
				entry.isDirectory() &&
				(entry.name.startsWith(".wine") ||
					entry.name.startsWith(".mt5") ||
					entry.name.startsWith(".mt4"))
			) {
				add(join(homeDir, entry.name));
			}
		}
	} catch {
		// A missing home directory leaves the fixed candidates only.
	}
	addChildren(join(homeDir, ".local", "share", "wineprefixes"));
	addChildren(join(homeDir, "Games"));
	addChildren(join(homeDir, ".playonlinux", "wineprefix"));
	addChildren(join(homeDir, ".PlayOnLinux", "wineprefix"));

	if (platform === "darwin") {
		for (const base of [
			join(homeDir, "Library", "Application Support", "CrossOver", "Bottles"),
			join(homeDir, ".cxoffice"),
		]) {
			addChildren(base);
		}
	}

	return [...candidates].filter((prefix) => {
		try {
			return statSync(join(prefix, "drive_c")).isDirectory();
		} catch {
			return false;
		}
	});
}

/** Locates a Wine launcher on PATH or in a well-known install directory. */
export function findWineBinary(
	env: NodeJS.ProcessEnv,
	homeDir: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const executableNames = ["wine64", "wine"];
	const isExecutable = (candidate: string): boolean => {
		try {
			accessSync(
				candidate,
				platform === "win32" ? constants.F_OK : constants.X_OK,
			);
			return statSync(candidate).isFile();
		} catch {
			return false;
		}
	};
	const fromPath = (names: readonly string[]): string | undefined => {
		for (const name of names) {
			for (const directory of (env.PATH ?? "").split(delimiter)) {
				if (!directory) continue;
				const candidate = join(directory, name);
				if (isExecutable(candidate)) return candidate;
			}
		}
		return undefined;
	};

	const configured = env.BACKBOARD_WINE_PATH?.trim();
	if (configured) {
		const expanded = expandHomePath(configured, homeDir);
		if (isExecutable(expanded)) return resolve(expanded);
	}
	if (env.WINE?.trim()) {
		const expanded = expandHomePath(env.WINE.trim(), homeDir);
		if (isExecutable(expanded)) return resolve(expanded);
	}

	const fromSystemPath = fromPath(executableNames);
	if (fromSystemPath) return resolve(fromSystemPath);

	const extraDirectories = [
		"/usr/bin",
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/local/bin",
		join(homeDir, ".local", "bin"),
		"/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin",
	];
	for (const directory of extraDirectories) {
		for (const name of executableNames) {
			const candidate = join(directory, name);
			if (isExecutable(candidate)) return resolve(candidate);
		}
	}
	return undefined;
}

/** Runs `winepath` and returns its complete stdout. */
export function runWinepath(
	args: readonly string[],
	context: WineRunContext,
	timeoutMs = 10_000,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			context.wineBinary,
			[...args],
			{
				env: context.env,
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 64 * 1024,
				windowsHide: true,
				...(signal ? { signal } : {}),
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
}

/**
 * Returns a Windows short path for `unixPath`, or undefined when Wine cannot
 * express it in the ANSI command line. `winepath -s` is used instead of a
 * hard-coded 8.3 name because the generated name is prefix-specific.
 */
export async function toShortWindowsPath(
	unixPath: string,
	context: WineRunContext,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const stdout = await runWinepath(
			["-s", resolve(unixPath)],
			context,
			10_000,
			signal,
		);
		const shortUnix = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		if (!shortUnix) return undefined;
		const windowsPath = unixToWindowsPath(shortUnix, context.winePrefix);
		return isWineArgumentSafe(windowsPath) ? windowsPath : undefined;
	} catch {
		return undefined;
	}
}

/** Environment for Wine children: quiet, deterministic, prefix-bound. */
export function wineEnvironment(
	env: NodeJS.ProcessEnv,
	winePrefix: string,
): NodeJS.ProcessEnv {
	return {
		...env,
		WINEPREFIX: winePrefix,
		WINEDEBUG: env.WINEDEBUG ?? "-all",
	};
}
