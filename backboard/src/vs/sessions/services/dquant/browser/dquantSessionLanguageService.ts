/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { DQUANT_LANGUAGE_CONFIG_KEY, DQUANT_PROJECT_NAME_CONFIG_KEY, DQUANT_PROJECT_TITLE_APPLIED_CONFIG_KEY, DquantLanguage, parseDquantLanguage } from '../../../../platform/agentHost/common/dquant/dquantSessionMetadata.js';
import { IAgentHostSessionsProvider, isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsManagementService } from '../../sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';

export const IDquantSessionLanguageService = createDecorator<IDquantSessionLanguageService>('dquantSessionLanguageService');

/**
 * Reads and writes the DQuant language profile of a single session.
 *
 * The profile lives in the session's own config bag on the agent host, so it is
 * persisted and restored with the session and is never stored globally. Both
 * the welcome screen and the session header talk to this service instead of
 * keeping their own copy, which is what keeps sessions isolated from each
 * other.
 */
export interface IDquantSessionLanguageService {
	readonly _serviceBrand: undefined;

	/** Fires with the affected session id when a session's profile may have changed. */
	readonly onDidChange: Event<string>;

	/** Language bound to the session, or `undefined` for legacy/unbound sessions. */
	getLanguage(sessionId: string): DquantLanguage | undefined;
	/** Project name the user chose for the session, when known. */
	getProjectName(sessionId: string): string | undefined;
	/** Whether the project name was already copied into the session title. */
	isProjectTitleApplied(sessionId: string): boolean;
	/** Whether the session belongs to an agent-host provider that can carry a profile. */
	isSupported(sessionId: string): boolean;
	/** Binds the session to a language. */
	setLanguage(sessionId: string, language: DquantLanguage): void;
	/** Stores the project name on the session. */
	setProjectName(sessionId: string, name: string): void;
	/** Marks the project name as already applied to the session title. */
	markProjectTitleApplied(sessionId: string): void;
}

class DquantSessionLanguageService extends Disposable implements IDquantSessionLanguageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly _providerListeners = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
	) {
		super();
		this._attachProviderListeners();
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => this._attachProviderListeners()));
	}

	getLanguage(sessionId: string): DquantLanguage | undefined {
		return parseDquantLanguage(this._providerFor(sessionId)?.getSessionConfig(sessionId)?.values[DQUANT_LANGUAGE_CONFIG_KEY]);
	}

	getProjectName(sessionId: string): string | undefined {
		const value = this._providerFor(sessionId)?.getSessionConfig(sessionId)?.values[DQUANT_PROJECT_NAME_CONFIG_KEY];
		return typeof value === 'string' && value.trim() ? value : undefined;
	}

	isProjectTitleApplied(sessionId: string): boolean {
		return this._providerFor(sessionId)?.getSessionConfig(sessionId)?.values[DQUANT_PROJECT_TITLE_APPLIED_CONFIG_KEY] === 'true';
	}

	isSupported(sessionId: string): boolean {
		return !!this._providerFor(sessionId);
	}

	setLanguage(sessionId: string, language: DquantLanguage): void {
		this._setValue(sessionId, DQUANT_LANGUAGE_CONFIG_KEY, language);
	}

	setProjectName(sessionId: string, name: string): void {
		const trimmed = name.trim();
		if (trimmed) {
			this._setValue(sessionId, DQUANT_PROJECT_NAME_CONFIG_KEY, trimmed);
		}
	}

	markProjectTitleApplied(sessionId: string): void {
		this._setValue(sessionId, DQUANT_PROJECT_TITLE_APPLIED_CONFIG_KEY, 'true');
	}

	private _setValue(sessionId: string, property: string, value: string): void {
		const provider = this._providerFor(sessionId);
		if (!provider) {
			return;
		}
		if (provider.setSessionMetadataValue) {
			provider.setSessionMetadataValue(sessionId, property, value);
		} else {
			// Providers that predate the metadata API can still take the value on
			// a draft; a running session simply keeps its previous profile.
			void provider.setSessionConfigValue(sessionId, property, value);
		}
		this._onDidChange.fire(sessionId);
	}

	private _providerFor(sessionId: string): IAgentHostSessionsProvider | undefined {
		const newSession = this._sessionsManagementService.newSession.get();
		const session = this._sessionsManagementService.getSessions().find(candidate => candidate.sessionId === sessionId)
			?? (newSession?.sessionId === sessionId ? newSession : undefined);
		if (!session) {
			return undefined;
		}
		const provider = this._sessionsProvidersService.getProvider(session.providerId);
		return provider && isAgentHostProvider(provider) ? provider : undefined;
	}

	private _attachProviderListeners(): void {
		const store = new DisposableStore();
		for (const provider of this._sessionsProvidersService.getProviders()) {
			if (isAgentHostProvider(provider)) {
				store.add(provider.onDidChangeSessionConfig(sessionId => this._onDidChange.fire(sessionId)));
			}
		}
		this._providerListeners.value = store;
	}
}

registerSingleton(IDquantSessionLanguageService, DquantSessionLanguageService, InstantiationType.Delayed);
