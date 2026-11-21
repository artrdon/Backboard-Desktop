import {
	accessSync,
	constants,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { qProjectConfigDir, qUserConfigDir } from "../../config/paths.ts";
import {
	expandHomePath,
	findWineBinary,
	findWinePrefixForPath,
	isWindowsAbsolutePath,
	listWinePrefixes,
	windowsToUnixPath,
} from "./WinePaths.ts";

export type MetaEditorRunner = "native" | "wine";

/** A detected or explicitly configured MetaTrader 5 compiler installation. */
export interface MetaEditorInstallation {
	/** Native filesystem path to MetaEditor64.exe. */
	metaEditorPath: string;
	runner: MetaEditorRunner;
	/** Wine launcher used on Linux and macOS. */
	wineBinary?: string;
	/** WINEPREFIX bound to the installation. */
	winePrefix?: string;
	source: "project-settings" | "user-settings" | "environment" | "auto";
	platform: NodeJS.Platform;
}

export interface Mql5DiscoveryOverrides {
	metaEditorPath?: string;
	winePath?: string;
	winePrefix?: string;
	/** Tests use `false` to prove the unavailable-compiler path. */
	autoDetect?: boolean;
}

export interface MetaEditorDiscoveryOptions {
	cwd: string;
	homeDir: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	overrides?: Mql5DiscoveryOverrides;
}

export interface MetaEditorDiscoveryResult {
	installation?: MetaEditorInstallation;
	/** Human-readable reason when no usable installation exists. */
	problem?: string;
	searched: string[];
}

interface ConfiguredMql5Paths {
	metaEditorPath?: string;
	winePath?: string;
	winePrefix?: string;
	source: MetaEditorInstallation["source"];
}

const META_EDITOR_FILE_NAMES = ["MetaEditor64.exe", "MetaEditor.exe"];

/** Reads the optional `mql5` block from a settings/config JSON file. */
function readMql5Block(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const block = (parsed as Record<string, unknown>).mql5;
		return block && typeof block === "object" && !Array.isArray(block)
			? (block as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stringSetting(
	block: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	if (!block) return undefined;
	for (const key of keys) {
		const value = block[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * Precedence: project `.backboard/settings.json`, then user configuration,
 * then environment variables. Explicit settings always beat auto-detection.
 */
function readConfiguredPaths(
	cwd: string,
	homeDir: string,
	env: NodeJS.ProcessEnv,
	overrides: Mql5DiscoveryOverrides | undefined,
): ConfiguredMql5Paths {
	const project = readMql5Block(join(qProjectConfigDir(cwd), "settings.json"));
	const userDir = qUserConfigDir(homeDir);
	const userConfig = readMql5Block(join(userDir, "config.json"));
	const userSettings = readMql5Block(join(userDir, "settings.json"));

	const pick = (
		key: "metaeditorPath" | "winePath" | "winePrefix",
	): { value?: string; source?: MetaEditorInstallation["source"] } => {
		for (const [block, source] of [
			[project, "project-settings"],
			[userConfig, "user-settings"],
			[userSettings, "user-settings"],
		] as const) {
			const value =
				key === "metaeditorPath"
					? stringSetting(block, "metaeditorPath", "metaEditorPath")
					: key === "winePath"
						? stringSetting(block, "winePath", "wineBinary")
						: stringSetting(block, "winePrefix", "WINEPREFIX");
			if (value) return { value, source };
		}
		return {};
	};

	const meta = pick("metaeditorPath");
	const wine = pick("winePath");
	const prefix = pick("winePrefix");

	const envMeta = env.DQUANT_METAEDITOR_PATH?.trim();
	const envWine = (env.DQUANT_WINE_PATH ?? env.BACKBOARD_WINE_PATH)?.trim();
	const envPrefix = env.DQUANT_WINE_PREFIX?.trim();

	return {
		metaEditorPath:
			overrides?.metaEditorPath?.trim() ??
			meta?.value ??
			(envMeta || undefined),
		winePath:
			overrides?.winePath?.trim() ?? wine?.value ?? (envWine || undefined),
		winePrefix:
			overrides?.winePrefix?.trim() ??
			prefix?.value ??
			(envPrefix || undefined),
		source: meta?.source ?? (envMeta ? "environment" : "auto"),
	};
}

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isDirectory(directory: string): boolean {
	try {
		return statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/** Finds a child by name without depending on the filesystem's case rules. */
function caseInsensitiveChild(
	directory: string,
	expected: string,
): string | undefined {
	const direct = join(directory, expected);
	if (isFile(direct)) return direct;
	try {
		const target = expected.toLowerCase();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.toLowerCase() === target) {
				return join(directory, entry.name);
			}
		}
	} catch {
		// Missing or unreadable directory: no child.
	}
	return undefined;
}

/** Finds MetaEditor inside one install directory. */
function metaEditorInDirectory(directory: string): string | undefined {
	for (const name of META_EDITOR_FILE_NAMES) {
		const found = caseInsensitiveChild(directory, name);
		if (found) return found;
	}
	return undefined;
}

/**
 * Searches a Wine prefix. MetaTrader installs keep MetaEditor in the install
 * root; the top-level directory name depends on the broker (MetaTrader 5,
 * FxPro Markets MT5, ...), so every program directory is inspected.
 */
function findMetaEditorInWinePrefix(
	prefix: string,
	searched: string[],
): string | undefined {
	for (const rootName of ["Program Files", "Program Files (x86)"]) {
		const root = join(prefix, "drive_c", rootName);
		searched.push(root);
		if (!isDirectory(root)) continue;

		const preferred: string[] = [];
		const others: string[] = [];
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const lower = entry.name.toLowerCase();
				const path = join(root, entry.name);
				if (lower.includes("metatrader") || lower.includes("mt5")) {
					preferred.push(path);
				} else {
					others.push(path);
				}
			}
		} catch {
			continue;
		}

		for (const directory of [...preferred, ...others]) {
			const found = metaEditorInDirectory(directory);
			if (found) return found;
			// Some brokers nest the terminal one level deeper.
			try {
				for (const child of readdirSync(directory, {
					withFileTypes: true,
				})) {
					if (!child.isDirectory()) continue;
					const nested = metaEditorInDirectory(join(directory, child.name));
					if (nested) return nested;
				}
			} catch {
				// Unreadable install directory: keep searching.
			}
		}
	}
	return undefined;
}

/** Recursively looks for a file by name, bounded to avoid huge trees. */
function findFileRecursively(
	directory: string,
	matches: (name: string) => boolean,
	maxDepth: number,
): string | undefined {
	if (maxDepth < 0) return undefined;
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isFile() && matches(entry.name.toLowerCase())) return path;
			if (entry.isDirectory()) {
				const nested = findFileRecursively(path, matches, maxDepth - 1);
				if (nested) return nested;
			}
		}
	} catch {
		// Permission errors and unreadable bundles are not matches.
	}
	return undefined;
}

/**
 * macOS MetaTrader bundles wrap Wine. When no system Wine exists, the bundle's
 * own launcher is still a valid way to run MetaEditor.
 */
function findWineInMacAppBundles(
	homeDir: string,
	searched: string[],
): string | undefined {
	for (const applications of ["/Applications", join(homeDir, "Applications")]) {
		let entries: string[];
		try {
			entries = readdirSync(applications);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const lower = entry.toLowerCase();
			if (
				!entry.endsWith(".app") ||
				(!lower.includes("metatrader") && !lower.includes("mt5"))
			) {
				continue;
			}
			const bundle = join(applications, entry);
			searched.push(bundle);
			const wine = findFileRecursively(
				bundle,
				(name) => name === "wine64" || name === "wine",
				7,
			);
			if (wine) return wine;
		}
	}
	return undefined;
}

function windowsProgramRoots(env: NodeJS.ProcessEnv): string[] {
	const roots = [
		env.ProgramFiles,
		env["ProgramFiles(x86)"],
		env.ProgramW6432,
		env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined,
		"C:\\Program Files",
		"C:\\Program Files (x86)",
	].filter((root): root is string => !!root?.trim());
	return [...new Set(roots)].filter(isDirectory);
}

/** Windows installs are found in the program-files roots; no Wine involved. */
function findMetaEditorOnWindows(
	env: NodeJS.ProcessEnv,
	searched: string[],
): string | undefined {
	for (const root of windowsProgramRoots(env)) {
		searched.push(root);
		const direct = metaEditorInDirectory(join(root, "MetaTrader 5"));
		if (direct) return direct;

		const preferred: string[] = [];
		const others: string[] = [];
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const lower = entry.name.toLowerCase();
				const path = join(root, entry.name);
				if (lower.includes("metatrader") || lower.includes("mt5")) {
					preferred.push(path);
				} else {
					others.push(path);
				}
			}
		} catch {
			continue;
		}
		for (const directory of [...preferred, ...others]) {
			const found = metaEditorInDirectory(directory);
			if (found) return found;
		}
	}
	return undefined;
}

/** macOS app bundles are searched after the regular Wine prefixes. */
function findMetaEditorInMacApps(
	homeDir: string,
	searched: string[],
): string | undefined {
	for (const applications of ["/Applications", join(homeDir, "Applications")]) {
		let entries: string[];
		try {
			entries = readdirSync(applications);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const lower = entry.toLowerCase();
			if (
				!entry.endsWith(".app") ||
				(!lower.includes("metatrader") && !lower.includes("mt5"))
			) {
				continue;
			}
			const bundle = join(applications, entry);
			searched.push(bundle);
			const found = findFileRecursively(
				bundle,
				(name) => name === "metaeditor64.exe" || name === "metaeditor.exe",
				10,
			);
			if (found) return found;
		}
	}
	return undefined;
}

function findMetaEditorOnPosix(
	env: NodeJS.ProcessEnv,
	homeDir: string,
	platform: NodeJS.Platform,
	searched: string[],
): string | undefined {
	for (const prefix of listWinePrefixes(env, homeDir, platform)) {
		searched.push(prefix);
		const found = findMetaEditorInWinePrefix(prefix, searched);
		if (found) return found;
	}
	return platform === "darwin"
		? findMetaEditorInMacApps(homeDir, searched)
		: undefined;
}

/** Maps a configured Windows path (`C:\...`) through a Wine prefix. */
function resolveConfiguredMetaEditorPath(
	value: string,
	configuredWinePrefix: string | undefined,
	env: NodeJS.ProcessEnv,
	homeDir: string,
	cwd: string,
	platform: NodeJS.Platform,
	searched: string[],
): string {
	if (platform === "win32") {
		return resolve(cwd, expandHomePath(value, homeDir));
	}
	if (!isWindowsAbsolutePath(value)) {
		return resolve(cwd, expandHomePath(value, homeDir));
	}
	const prefixes = [
		configuredWinePrefix
			? resolve(expandHomePath(configuredWinePrefix, homeDir))
			: undefined,
		env.WINEPREFIX?.trim()
			? resolve(expandHomePath(env.WINEPREFIX.trim(), homeDir))
			: undefined,
		...listWinePrefixes(env, homeDir, platform),
	].filter((prefix): prefix is string => !!prefix);
	for (const prefix of [...new Set(prefixes)]) {
		const translated = windowsToUnixPath(value, prefix);
		if (!translated) continue;
		searched.push(translated);
		if (isFile(translated)) return translated;
	}
	// Keep the raw path so the caller can report the exact configured value.
	return value;
}

function buildInstallation(
	metaEditorPath: string,
	source: MetaEditorInstallation["source"],
	options: {
		env: NodeJS.ProcessEnv;
		homeDir: string;
		platform: NodeJS.Platform;
		configuredWinePath?: string;
		configuredWinePrefix?: string;
		wineFallback?: string;
		searched: string[];
	},
): MetaEditorDiscoveryResult {
	const { env, homeDir, platform, searched } = options;
	if (platform === "win32") {
		return {
			installation: {
				metaEditorPath,
				runner: "native",
				source,
				platform,
			},
			searched,
		};
	}

	let wineBinary: string | undefined;
	if (options.configuredWinePath) {
		const configured = resolve(
			expandHomePath(options.configuredWinePath, homeDir),
		);
		if (isExecutable(configured)) {
			wineBinary = configured;
		} else {
			searched.push(`configured wine: ${configured}`);
		}
	}
	wineBinary ??= findWineBinary(env, homeDir, platform);
	if (
		!wineBinary &&
		options.wineFallback &&
		isExecutable(options.wineFallback)
	) {
		wineBinary = options.wineFallback;
	}
	if (!wineBinary) {
		return {
			problem: `Found MetaEditor at ${metaEditorPath}, but no Wine launcher was found. Install Wine (or CrossOver on macOS) or set "mql5": { "winePath": "/path/to/wine" } in .backboard/settings.json.`,
			searched,
		};
	}

	let winePrefix = options.configuredWinePrefix
		? resolve(expandHomePath(options.configuredWinePrefix, homeDir))
		: undefined;
	if (!winePrefix) winePrefix = findWinePrefixForPath(metaEditorPath);
	if (!winePrefix && env.WINEPREFIX?.trim()) {
		winePrefix = resolve(expandHomePath(env.WINEPREFIX.trim(), homeDir));
	}
	if (!winePrefix) {
		const defaultPrefix = join(homeDir, ".wine");
		winePrefix = isDirectory(defaultPrefix)
			? defaultPrefix
			: listWinePrefixes(env, homeDir, platform)[0];
	}

	return {
		installation: {
			metaEditorPath,
			runner: "wine",
			wineBinary,
			...(winePrefix ? { winePrefix } : {}),
			source,
			platform,
		},
		searched,
	};
}

function buildProblem(
	platform: NodeJS.Platform,
	searched: string[],
	configuredMetaEditorPath: string | undefined,
): string {
	const paths = [...new Set(searched)].slice(0, 12);
	const configuredHint = configuredMetaEditorPath
		? `Configured MetaEditor path "${configuredMetaEditorPath}" does not exist. `
		: "";
	const settingsHint =
		'Set "mql5": { "metaeditorPath": "...", "winePath": "..." } in .backboard/settings.json to override detection.';
	const body =
		platform === "win32"
			? "Install MetaTrader 5 (MetaEditor64.exe) or point mql5.metaeditorPath at it."
			: platform === "darwin"
				? "Install MetaTrader 5 for macOS together with Wine or CrossOver; macOS cannot run MetaEditor without a Wine-compatible launcher. If the bundle is present but detection missed it, set mql5.metaeditorPath and mql5.winePath explicitly."
				: "Install MetaTrader 5 in a Wine prefix (metaeditor64.exe) together with Wine, or set an explicit compiler path.";
	return `${configuredHint}MetaTrader 5 MetaEditor was not found. ${body} ${settingsHint} Searched: ${paths.length > 0 ? paths.join(", ") : "no candidate directories"}.`;
}

/** Resolves and returns the usable MetaEditor installation, if any. */
export function discoverMetaEditor(
	options: MetaEditorDiscoveryOptions,
): MetaEditorDiscoveryResult {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const homeDir = options.homeDir;
	const searched: string[] = [];
	const configured = readConfiguredPaths(
		options.cwd,
		homeDir,
		env,
		options.overrides,
	);

	let configuredPath: string | undefined;
	if (configured.metaEditorPath) {
		configuredPath = resolveConfiguredMetaEditorPath(
			configured.metaEditorPath,
			configured.winePrefix,
			env,
			homeDir,
			options.cwd,
			platform,
			searched,
		);
		if (isFile(configuredPath)) {
			return buildInstallation(configuredPath, configured.source, {
				env,
				homeDir,
				platform,
				configuredWinePath: configured.winePath,
				configuredWinePrefix: configured.winePrefix,
				searched,
			});
		}
		searched.push(configuredPath);
	}

	if (options.overrides?.autoDetect === false) {
		return {
			problem: `Automatic MetaEditor detection was disabled. ${
				configuredPath
					? `Configured path "${configuredPath}" does not exist.`
					: 'Set "mql5.metaeditorPath" in .backboard/settings.json.'
			}`,
			searched,
		};
	}

	const wineFallback =
		platform === "darwin"
			? findWineInMacAppBundles(homeDir, searched)
			: undefined;
	const autoPath =
		platform === "win32"
			? findMetaEditorOnWindows(env, searched)
			: findMetaEditorOnPosix(env, homeDir, platform, searched);

	if (autoPath) {
		const installation = buildInstallation(autoPath, "auto", {
			env,
			homeDir,
			platform,
			configuredWinePath: configured.winePath,
			configuredWinePrefix: configured.winePrefix,
			wineFallback,
			searched,
		});
		if (installation.installation) return installation;
		return {
			...installation,
			problem: `${installation.problem ?? ""} ${
				configuredPath
					? "The configured mql5.metaeditorPath was not usable. "
					: ""
			}Searched: ${[...new Set(searched)].slice(0, 12).join(", ")}.`,
		};
	}

	return {
		problem: buildProblem(
			platform,
			searched,
			configuredPath ?? configured.metaEditorPath,
		),
		searched,
	};
}
