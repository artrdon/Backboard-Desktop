/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { DQUANT_LANGUAGE_CONFIG_KEY, DQUANT_PROJECT_NAME_CONFIG_KEY, DquantLanguage, dquantLanguageLabel, parseDquantLanguage } from '../../common/dquant/dquantSessionMetadata.js';

/**
 * Upper bound for the whole DQuant block injected into the runtime system
 * prompt. It is a safety net only: the block is the session profile plus the
 * language instructions and normally stays well below the cap.
 */
const MAX_CONTEXT_CHARS = 9000;

interface IDocumentationLinks {
	readonly root: string;
	readonly sections: readonly string[];
}

/**
 * Official online references for each language. There is no bundled
 * documentation: the session prompt points the agent at the official
 * reference and requires it to look signatures up before writing API calls.
 */
const DOCUMENTATION_LINKS: { readonly [K in DquantLanguage]: IDocumentationLinks } = {
	mql4: {
		root: 'https://docs.mql4.com/',
		sections: [
			'https://docs.mql4.com/basis',
			'https://docs.mql4.com/trading',
			'https://docs.mql4.com/indicators',
			'https://docs.mql4.com/series',
			'https://docs.mql4.com/constants',
			'https://docs.mql4.com/predefined',
		],
	},
	mql5: {
		root: 'https://www.mql5.com/en/docs',
		sections: [
			'https://www.mql5.com/en/docs/basis',
			'https://www.mql5.com/en/docs/trade',
			'https://www.mql5.com/en/docs/indicators',
			'https://www.mql5.com/en/docs/series',
			'https://www.mql5.com/en/docs/event_handlers',
			'https://www.mql5.com/en/docs/constants',
			'https://www.mql5.com/en/docs/predefined',
		],
	},
};

const instructionsCache = new Map<DquantLanguage, string>();
const warnedAbout = new Set<string>();

/**
 * Loads (and caches) the language instructions bundled with the application.
 * The file is small and shipped in `out/`, so it is read once per process.
 */
export function getMqlLanguageInstructions(language: DquantLanguage, log: (message: string) => void = () => { }): string | undefined {
	const cached = instructionsCache.get(language);
	if (cached !== undefined) {
		return cached || undefined;
	}

	const resource = `vs/workbench/contrib/dquant/prompts/${language}-system-prompt.md` as const;
	try {
		const text = fs.readFileSync(FileAccess.asFileUri(resource).fsPath, 'utf8').trim();
		instructionsCache.set(language, text);
		return text || undefined;
	} catch (error) {
		if (!warnedAbout.has(`missing-prompt-${language}`)) {
			warnedAbout.add(`missing-prompt-${language}`);
			log(`[dquant] language prompt ${resource} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		instructionsCache.set(language, '');
		return undefined;
	}
}

/**
 * Builds the hidden per-turn guidance for an MQL session.
 *
 * The text is appended to the runtime system prompt through the *existing*
 * `systemContext` channel that the agent host already uses for multitask and
 * access-mode guidance. It contains no documentation excerpts: only the
 * session profile, links to the official reference and the requirement to look
 * signatures up before using them.
 *
 * @param storedConfig live session config values (per session, persisted).
 */
export function buildDquantAgentContext(
	storedConfig: Record<string, unknown> | undefined,
	log: (message: string) => void = () => { },
): string | undefined {
	const language = parseDquantLanguage(storedConfig?.[DQUANT_LANGUAGE_CONFIG_KEY]);
	if (!language) {
		// Legacy sessions (created before the language picker) keep the exact
		// behavior they had: no extra instructions.
		return undefined;
	}

	const label = dquantLanguageLabel(language);
	const projectName = typeof storedConfig?.[DQUANT_PROJECT_NAME_CONFIG_KEY] === 'string'
		? (storedConfig[DQUANT_PROJECT_NAME_CONFIG_KEY] as string).trim()
		: '';
	const links = DOCUMENTATION_LINKS[language];

	const parts: string[] = [];

	parts.push([
		'## DQuant session profile',
		'',
		`- Programming language: ${label} (MetaTrader ${language === 'mql5' ? '5' : '4'}).`,
		`- This profile belongs to this chat only. Use ${label} for every file you create or edit and never switch this session to the other MetaTrader generation.`,
		...(projectName ? [`- Project: ${projectName}.`] : []),
	].join('\n'));

	parts.push([
		`## ${label} documentation lookup (mandatory)`,
		'',
		`The official ${label} reference is online and is the only authority for function names, signatures, argument order, return types, event handler declarations and constant values:`,
		'',
		`- Root: ${links.root}`,
		...links.sections.map(section => `- ${section}`),
		'',
		'Before writing an API call you are not certain about, look it up with the web tools available in this session (WebSearch / FetchUrl), and use the exact signature you read. Do not invent functions, overloads, constants or structure members, and do not copy unverified snippets from blogs or forums.',
		'If no web tool is available or a page cannot be loaded, say so explicitly and limit the code to calls you are certain about instead of guessing.',
	].join('\n'));

	const instructions = getMqlLanguageInstructions(language, log);
	if (instructions) {
		parts.push(instructions);
	}

	return truncate(parts.join('\n\n'), MAX_CONTEXT_CHARS);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const ellipsis = '\n\n…';
	return text.slice(0, maxChars - ellipsis.length) + ellipsis;
}

/** Test helper: drops the in-process prompt cache so a test can observe a fresh read. */
export function resetDquantAgentContextCachesForTests(): void {
	instructionsCache.clear();
	warnedAbout.clear();
}

