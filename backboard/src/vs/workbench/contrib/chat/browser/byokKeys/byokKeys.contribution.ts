/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ADD_PROVIDER_KEY_COMMAND_ID, OPEN_API_KEYS_COMMAND_ID, TEST_PROVIDER_KEY_COMMAND_ID } from './byokKeys.js';
import { isByokProviderId, ICustomProviderConfig, validateProviderConfig } from '../../../../../platform/agentHost/common/byokProviders.js';
import { IByokKeysService } from '../agentSessions/agentHost/byokKeysService.js';
import { ByokKeysEditor } from './byokKeysEditor.js';
import { ByokKeysEditorInput } from './byokKeysEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ByokKeysEditor,
		ByokKeysEditor.ID,
		localize('byokKeysEditor', "API Keys Editor"),
	),
	[new SyncDescriptor(ByokKeysEditorInput)],
);

class ByokKeysEditorInputSerializer implements IEditorSerializer {

	canSerialize(_editorInput: EditorInput): boolean {
		return true;
	}

	serialize(_input: ByokKeysEditorInput): string {
		return '';
	}

	deserialize(_instantiationService: IInstantiationService): ByokKeysEditorInput {
		return ByokKeysEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(ByokKeysEditorInput.ID, ByokKeysEditorInputSerializer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_API_KEYS_COMMAND_ID,
			title: localize2('backboard.openApiKeys', "API Keys"),
			category: localize2('backboard.category', "DQuant Lab"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(ByokKeysEditorInput.getOrCreate(), { pinned: true });
	}
});

/**
 * Inline key entry (model picker and sign-in card) saves through the same
 * keychain-backed service as the API Keys page, so the runtime bills to it.
 */
function readProviderKeyArguments(provider: unknown, key: unknown, config: unknown): { provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'xai' | 'custom'; key: string; config?: ICustomProviderConfig } {
	if (!isByokProviderId(provider) || typeof key !== 'string' || !key.trim()) {
		throw new Error(localize('backboard.addProviderKey.invalid', "Choose a provider and enter an API key."));
	}
	if (config === undefined) {
		return { provider, key: key.trim() };
	}
	const settings = validateProviderConfig(provider, config as Partial<ICustomProviderConfig>);
	if (settings.error || !settings.config) {
		throw new Error(settings.error ?? localize('backboard.addProviderKey.invalidEndpoint', "Enter the API base URL and model ID."));
	}
	return { provider, key: key.trim(), config: settings.config };
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ADD_PROVIDER_KEY_COMMAND_ID, title: localize2('backboard.addProviderKey', "Add Provider Key"), f1: false });
	}

	async run(accessor: ServicesAccessor, provider: unknown, key: unknown, config?: unknown): Promise<void> {
		const args = readProviderKeyArguments(provider, key, config);
		await accessor.get(IByokKeysService).add(args.provider, args.key, args.config);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: TEST_PROVIDER_KEY_COMMAND_ID, title: localize2('backboard.testProviderKey', "Test Provider Key"), f1: false });
	}

	async run(accessor: ServicesAccessor, provider: unknown, key: unknown, config?: unknown): Promise<void> {
		const args = readProviderKeyArguments(provider, key, config);
		await accessor.get(IByokKeysService).validate(args.provider, args.key, args.config);
	}
});
