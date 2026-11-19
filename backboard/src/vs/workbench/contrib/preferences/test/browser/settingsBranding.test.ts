/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sanitizeSettingsText } from '../../common/settingsBranding.js';

suite('settingsBranding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sanitizeSettingsText scrubs VS Code links and text', () => {
		assert.deepStrictEqual({
			docsLink: sanitizeSettingsText('See [the docs](https://code.visualstudio.com/docs/editor/codebasics#_find) for more.', 'DQuant Lab'),
			apiDocsLink: sanitizeSettingsText('See [API](https://code.visualstudio.com/api/references/vscode-api).', 'DQuant Lab'),
			marketingLink: sanitizeSettingsText('Get it from [our website](https://code.visualstudio.com).', 'DQuant Lab'),
			akaLink: sanitizeSettingsText('Read the [privacy statement](https://aka.ms/privacy).', 'DQuant Lab'),
			bareDocsLink: sanitizeSettingsText('More at https://code.visualstudio.com/docs/terminal/basics today.', 'DQuant Lab'),
			bareOtherLink: sanitizeSettingsText('More at https://marketplace.visualstudio.com/items today.', 'DQuant Lab'),
			brandText: sanitizeSettingsText('Controls whether VS Code restarts automatically.', 'DQuant Lab'),
			brandLong: sanitizeSettingsText('Visual Studio Code will reload.', 'DQuant Lab'),
			untouched: sanitizeSettingsText('Controls the [editor](#editor.fontSize) font.', 'DQuant Lab'),
		}, {
			docsLink: 'See [the docs](https://docs.backboard.io) for more.',
			apiDocsLink: 'See [API](https://docs.backboard.io).',
			marketingLink: 'Get it from our website.',
			akaLink: 'Read the privacy statement.',
			bareDocsLink: 'More at https://docs.backboard.io today.',
			bareOtherLink: 'More at  today.',
			brandText: 'Controls whether DQuant Lab restarts automatically.',
			brandLong: 'DQuant Lab will reload.',
			untouched: 'Controls the [editor](#editor.fontSize) font.',
		});
	});
});
