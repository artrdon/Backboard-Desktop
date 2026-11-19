/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-local metadata used by DQuant Lab (MQL4/MQL5).
 *
 * The values live in the agent host's per-session configuration bag
 * (`SessionState.config.values`), which is persisted with the session and
 * restored with it. They are deliberately *not* global settings: every session
 * carries its own language profile and one session's choice never affects
 * another session.
 *
 * Keys are namespaced with {@link DQUANT_CONFIG_PREFIX} so they survive the
 * Backboard runtime's config normalization (see
 * `resolveBackboardSessionConfig` in `cliTs/backboardRuntimeShared.ts`).
 */

/** Programming language a DQuant session is bound to. */
export type DquantLanguage = 'mql4' | 'mql5';

/** All languages a session can be bound to. */
export const DQUANT_LANGUAGES: readonly DquantLanguage[] = ['mql4', 'mql5'];

/** Prefix reserved for DQuant session metadata keys. */
export const DQUANT_CONFIG_PREFIX = 'dquant.';

/** Session config key holding the session's programming language. */
export const DQUANT_LANGUAGE_CONFIG_KEY = 'dquant.language';

/** Session config key holding the project name the user typed on the welcome screen. */
export const DQUANT_PROJECT_NAME_CONFIG_KEY = 'dquant.projectName';

/**
 * Session config key marking that the project name was already applied as the
 * session title. Prevents re-renaming a session the user renamed afterwards.
 */
export const DQUANT_PROJECT_TITLE_APPLIED_CONFIG_KEY = 'dquant.projectTitleApplied';

/**
 * Parses a raw session config value into a {@link DquantLanguage}. Returns
 * `undefined` for legacy sessions (created before the language picker existed)
 * and for any malformed value, so those sessions keep working unchanged.
 */
export function parseDquantLanguage(value: unknown): DquantLanguage | undefined {
	return value === 'mql4' || value === 'mql5' ? value : undefined;
}

/** True when `key` belongs to the DQuant session metadata namespace. */
export function isDquantSessionConfigKey(key: string): boolean {
	return key.startsWith(DQUANT_CONFIG_PREFIX);
}

/** Human-readable label for a language (`MQL4` / `MQL5`). */
export function dquantLanguageLabel(language: DquantLanguage): string {
	return language === 'mql4' ? 'MQL4' : 'MQL5';
}
