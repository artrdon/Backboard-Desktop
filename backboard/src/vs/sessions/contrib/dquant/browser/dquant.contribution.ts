/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dquant.css';
import { autorun } from '../../../../base/common/observable.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { isAgentHostProviderId } from '../../../common/agentHostSessionsProvider.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IDquantSessionLanguageService } from '../../../services/dquant/browser/dquantSessionLanguageService.js';

/** Setting that decides whether the app opens on the DQuant welcome screen. */
export const DQUANT_START_ON_WELCOME_SETTING = 'dquant.startup.showWelcome';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'dquant',
	order: 21,
	title: localize('dquant.configuration.title', "DQuant Lab"),
	type: 'object',
	properties: {
		[DQUANT_START_ON_WELCOME_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('dquant.startup.showWelcome.description', "Открывать приветственный экран выбора MQL4/MQL5 при запуске приложения вместо восстановления последней сессии."),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});

/**
 * Opens the new-session view (which hosts the DQuant welcome screen) once the
 * sessions window finished restoring. Existing sessions stay in place and can
 * be opened from the sessions list; nothing is deleted or migrated.
 */
class DquantWelcomeOnStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dquantWelcomeOnStartup';

	private readonly _watch = this._register(new MutableDisposable());

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		super();

		if (environmentService.isOptimusWindow) {
			// The Optimus window is a card grid over sessions; it has its own
			// start surface and must not be pushed into the composer.
			return;
		}
		if (!configurationService.getValue<boolean>(DQUANT_START_ON_WELCOME_SETTING)) {
			return;
		}

		// Wait for the restore pass to publish something (a session or the empty
		// slot) and then switch to the new-session view once, so the welcome
		// screen wins over the restored active session.
		this._watch.value = autorun(reader => {
			const active = this._sessionsService.activeSession.read(reader);
			const visible = this._sessionsService.visibleSessions.read(reader);
			if (!active && visible.every(session => !session)) {
				return;
			}
			queueMicrotask(() => {
				if (this._sessionsService.activeSession.get() === undefined) {
					return; // the user (or restore) already landed on the composer
				}
				this._watch.clear();
				this._sessionsService.openNewSession();
			});
		});
	}
}

/**
 * Re-applies the project name the user typed on the welcome screen as the
 * session title once the session graduates into a running chat. Done once per
 * session: the flag is stored next to the name in the session's config bag, so
 * a later manual rename is never overwritten.
 */
class DquantProjectTitleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.dquantProjectTitle';

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IDquantSessionLanguageService private readonly _dquantLanguageService: IDquantSessionLanguageService,
	) {
		super();

		this._register(this._sessionsProvidersService.onDidChangeProviders(() => this._apply(this._sessionsManagementService.getSessions())));
		this._register(this._sessionsManagementService.onDidChangeSessions(event => this._apply([...event.added, ...event.changed])));
		this._apply(this._sessionsManagementService.getSessions());
	}

	private _apply(sessions: readonly ISession[]): void {
		for (const session of sessions) {
			if (!isAgentHostProviderId(session.providerId)) {
				continue;
			}
			if (session.status.get() === SessionStatus.Untitled) {
				continue; // the name is applied when the first message commits the session
			}
			const name = this._dquantLanguageService.getProjectName(session.sessionId);
			if (!name || this._dquantLanguageService.isProjectTitleApplied(session.sessionId) || session.title.get() === name) {
				continue;
			}
			void this._sessionsManagementService.renameChat(session, session.mainChat.get().resource, name).then(() => {
				// Only remember the rename when it actually landed; an uncached
				// session no-ops, and the next session change retries.
				if (session.title.get() === name) {
					this._dquantLanguageService.markProjectTitleApplied(session.sessionId);
				}
			});
		}
	}
}

registerWorkbenchContribution2(DquantWelcomeOnStartupContribution.ID, DquantWelcomeOnStartupContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(DquantProjectTitleContribution.ID, DquantProjectTitleContribution, WorkbenchPhase.AfterRestored);
