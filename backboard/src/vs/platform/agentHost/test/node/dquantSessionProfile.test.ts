/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DQUANT_LANGUAGE_CONFIG_KEY, DQUANT_PROJECT_NAME_CONFIG_KEY, parseDquantLanguage } from '../../common/dquant/dquantSessionMetadata.js';
import { resolveBackboardSessionConfig } from '../../node/cliTs/backboardRuntimeShared.js';
import { buildDquantAgentContext } from '../../node/dquant/dquantAgentContext.js';

suite('DQuant session profile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses only mql4/mql5', () => {
		assert.strictEqual(parseDquantLanguage('mql4'), 'mql4');
		assert.strictEqual(parseDquantLanguage('mql5'), 'mql5');
		assert.strictEqual(parseDquantLanguage('rust'), undefined);
		assert.strictEqual(parseDquantLanguage(undefined), undefined);
	});

	test('resolveBackboardSessionConfig keeps dquant.* values', () => {
		const resolved = resolveBackboardSessionConfig({
			[DQUANT_LANGUAGE_CONFIG_KEY]: 'mql5',
			[DQUANT_PROJECT_NAME_CONFIG_KEY]: 'BTC Scalping EA',
			unknownKey: 'dropped',
		});

		assert.strictEqual(resolved.values[DQUANT_LANGUAGE_CONFIG_KEY], 'mql5');
		assert.strictEqual(resolved.values[DQUANT_PROJECT_NAME_CONFIG_KEY], 'BTC Scalping EA');
		assert.strictEqual(resolved.values['unknownKey'], undefined);
		// The profile must never become a composer picker.
		assert.strictEqual(resolved.schema.properties?.[DQUANT_LANGUAGE_CONFIG_KEY], undefined);
	});

	test('the language survives a restore round-trip', () => {
		const first = resolveBackboardSessionConfig({ [DQUANT_LANGUAGE_CONFIG_KEY]: 'mql4' });
		const restored = resolveBackboardSessionConfig(first.values);
		assert.strictEqual(restored.values[DQUANT_LANGUAGE_CONFIG_KEY], 'mql4');
	});

	test('legacy sessions (no language) get no agent guidance', () => {
		assert.strictEqual(buildDquantAgentContext(undefined), undefined);
		assert.strictEqual(buildDquantAgentContext({}), undefined);
		assert.strictEqual(buildDquantAgentContext({ [DQUANT_PROJECT_NAME_CONFIG_KEY]: 'Old project' }), undefined);
	});
});
