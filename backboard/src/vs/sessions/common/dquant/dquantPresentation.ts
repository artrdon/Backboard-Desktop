/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { localize } from '../../../nls.js';
import { DquantLanguage } from '../../../platform/agentHost/common/dquant/dquantSessionMetadata.js';

/**
 * Presentation metadata for the two DQuant language profiles. Kept in one
 * place so the welcome screen, the composer badge and the session header
 * describe a language the same way.
 */
export interface IDquantLanguagePresentation {
	readonly language: DquantLanguage;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon;
	readonly documentationUrl: string;
}

export const DQUANT_LANGUAGE_PRESENTATION: { readonly [K in DquantLanguage]: IDquantLanguagePresentation } = {
	mql4: {
		language: 'mql4',
		label: 'MQL4',
		description: localize('dquant.language.mql4.description', "Разработка торговых роботов и индикаторов для MetaTrader 4."),
		icon: Codicon.graph,
		documentationUrl: 'https://docs.mql4.com/',
	},
	mql5: {
		language: 'mql5',
		label: 'MQL5',
		description: localize('dquant.language.mql5.description', "Разработка торговых роботов и индикаторов для MetaTrader 5."),
		icon: Codicon.graphLine,
		documentationUrl: 'https://www.mql5.com/en/docs',
	},
};

/** Starter names shown in the project-name field; the user can always type their own. */
const PROJECT_NAME_SUGGESTIONS: { readonly [K in DquantLanguage]: readonly string[] } = {
	mql4: [
		'MT4 Trend Follower',
		'MACD Divergence EA',
		'Pip Hunter EA',
		'London Breakout EA',
		'Renko Signal Indicator',
	],
	mql5: [
		'BTC Scalping EA',
		'RSI Reversal Strategy',
		'Grid Trading System',
		'EURUSD Trend EA',
		'ATR Breakout Expert Advisor',
	],
};

/** Picks a starter project name for `language`. */
export function suggestDquantProjectName(language: DquantLanguage): string {
	const suggestions = PROJECT_NAME_SUGGESTIONS[language];
	return suggestions[Math.floor(Math.random() * suggestions.length)];
}
