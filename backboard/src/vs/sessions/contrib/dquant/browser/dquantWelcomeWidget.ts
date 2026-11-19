/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dquant.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { DquantLanguage } from '../../../../platform/agentHost/common/dquant/dquantSessionMetadata.js';
import { DQUANT_LANGUAGE_PRESENTATION, suggestDquantProjectName } from '../../../common/dquant/dquantPresentation.js';

const LANGUAGE_ORDER: readonly DquantLanguage[] = ['mql4', 'mql5'];

export interface IDquantWelcomeResult {
	readonly language: DquantLanguage;
	readonly name: string;
}

/** Creates the session for the chosen profile. Resolves `false` when it could not (yet) be created. */
export type DquantWelcomeCreateHandler = (result: IDquantWelcomeResult) => Promise<boolean>;

/**
 * Two-step welcome flow shown in the new-session composer:
 *
 * 1. language selection (MQL4 / MQL5),
 * 2. project name + "Создать сессию" (with a way back to step 1).
 *
 * The widget is pure UI: it never creates sessions itself. The host composer
 * owns the workspace/provider plumbing and hands the final selection back
 * through {@link DquantWelcomeCreateHandler}.
 */
export class DquantWelcomeWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _languageStep: HTMLElement;
	private readonly _nameStep: HTMLElement;
	private readonly _languageCards = new Map<DquantLanguage, HTMLButtonElement>();
	private readonly _summaryLabel: HTMLElement;
	private readonly _nameInput: HTMLInputElement;
	private readonly _createButton: HTMLButtonElement;
	private readonly _status: HTMLElement;

	private _language: DquantLanguage | undefined;
	private _busy = false;

	constructor(private readonly _onCreate: DquantWelcomeCreateHandler) {
		super();

		this.element = $('.dquant-welcome');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('dquant.welcome.aria', "DQuant Lab: создание проекта"));

		const inner = $('.dquant-welcome-inner');
		this.element.appendChild(inner);

		// -- Step 1: language selection ----------------------------------------
		this._languageStep = $('.dquant-welcome-step.dquant-welcome-step-language');
		inner.appendChild(this._languageStep);

		const brand = $('.dquant-welcome-brand');
		brand.textContent = localize('dquant.welcome.brand', "DQuant Lab");
		this._languageStep.appendChild(brand);

		const title = $('h1.dquant-welcome-title');
		title.textContent = localize('dquant.welcome.title', "Привет, с чего начнём сегодня?");
		this._languageStep.appendChild(title);

		const subtitle = $('p.dquant-welcome-subtitle');
		subtitle.textContent = localize('dquant.welcome.subtitle', "AI-powered environment for MQL4 and MQL5 development.");
		this._languageStep.appendChild(subtitle);

		const hint = $('p.dquant-welcome-hint');
		hint.textContent = localize('dquant.welcome.hint', "Выберите язык — DQuant Lab настроит агента и официальную документацию под него.");
		this._languageStep.appendChild(hint);

		const grid = $('.dquant-language-grid');
		grid.setAttribute('role', 'radiogroup');
		grid.setAttribute('aria-label', localize('dquant.welcome.languageGroup', "Язык программирования"));
		this._languageStep.appendChild(grid);

		for (const language of LANGUAGE_ORDER) {
			const presentation = DQUANT_LANGUAGE_PRESENTATION[language];
			const card = $('button.dquant-language-card') as HTMLButtonElement;
			card.type = 'button';
			card.setAttribute('role', 'radio');
			card.setAttribute('aria-checked', 'false');
			card.dataset['language'] = language;
			card.title = presentation.description;

			const icon = $('.dquant-language-card-icon');
			icon.appendChild(renderIcon(presentation.icon));
			card.appendChild(icon);

			const body = $('.dquant-language-card-body');
			const label = $('span.dquant-language-card-title');
			label.textContent = presentation.label;
			body.appendChild(label);
			const description = $('span.dquant-language-card-description');
			description.textContent = presentation.description;
			body.appendChild(description);
			card.appendChild(body);

			const check = $('.dquant-language-card-check');
			check.appendChild(renderIcon(Codicon.check));
			card.appendChild(check);

			this._register(addDisposableListener(card, EventType.CLICK, () => this._selectLanguage(language)));
			grid.appendChild(card);
			this._languageCards.set(language, card);
		}

		// -- Step 2: project name ---------------------------------------------
		this._nameStep = $('.dquant-welcome-step.dquant-welcome-step-name');
		this._nameStep.style.display = 'none';
		inner.appendChild(this._nameStep);

		const nameTitle = $('h1.dquant-welcome-title');
		nameTitle.textContent = localize('dquant.welcome.nameTitle', "Как назовём проект?");
		this._nameStep.appendChild(nameTitle);

		const summary = $('.dquant-welcome-summary');
		this._summaryLabel = $('span.dquant-welcome-summary-language');
		summary.appendChild(this._summaryLabel);
		const change = $('button.dquant-welcome-summary-change') as HTMLButtonElement;
		change.type = 'button';
		change.textContent = localize('dquant.welcome.changeLanguage', "Изменить язык");
		this._register(addDisposableListener(change, EventType.CLICK, () => this._showLanguageStep(true)));
		summary.appendChild(change);
		this._nameStep.appendChild(summary);

		const field = $('.dquant-welcome-field');
		this._nameInput = $('input.dquant-session-name') as HTMLInputElement;
		this._nameInput.type = 'text';
		this._nameInput.spellcheck = false;
		this._nameInput.placeholder = localize('dquant.welcome.namePlaceholder', "Например, BTC Scalping EA");
		this._nameInput.setAttribute('aria-label', localize('dquant.welcome.nameAria', "Название проекта"));
		this._register(addDisposableListener(this._nameInput, EventType.INPUT, () => this._updateCreateEnabled()));
		this._register(addDisposableListener(this._nameInput, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this._showLanguageStep(true);
			}
		}));
		field.appendChild(this._nameInput);

		const regenerate = $('button.dquant-session-name-regenerate') as HTMLButtonElement;
		regenerate.type = 'button';
		regenerate.title = localize('dquant.welcome.regenerate', "Предложить другое название");
		regenerate.setAttribute('aria-label', regenerate.title);
		regenerate.appendChild(renderIcon(Codicon.refresh));
		this._register(addDisposableListener(regenerate, EventType.CLICK, () => {
			if (this._language) {
				this._nameInput.value = suggestDquantProjectName(this._language);
				this._updateCreateEnabled();
				this._nameInput.focus();
				this._nameInput.select();
			}
		}));
		field.appendChild(regenerate);
		this._nameStep.appendChild(field);

		const actions = $('.dquant-welcome-actions');
		const back = $('button.dquant-welcome-back') as HTMLButtonElement;
		back.type = 'button';
		back.appendChild(renderIcon(Codicon.arrowLeft));
		const backLabel = $('span');
		backLabel.textContent = localize('dquant.welcome.back', "Назад");
		back.appendChild(backLabel);
		this._register(addDisposableListener(back, EventType.CLICK, () => this._showLanguageStep(true)));
		actions.appendChild(back);

		this._createButton = $('button.dquant-welcome-create') as HTMLButtonElement;
		this._createButton.type = 'button';
		this._createButton.textContent = localize('dquant.welcome.create', "Создать сессию");
		this._createButton.disabled = true;
		this._register(addDisposableListener(this._createButton, EventType.CLICK, () => void this._create()));
		actions.appendChild(this._createButton);
		this._nameStep.appendChild(actions);

		this._status = $('.dquant-welcome-status');
		this._status.setAttribute('role', 'status');
		this._nameStep.appendChild(this._status);
	}

	focus(): void {
		if (this._language && this._nameStep.style.display !== 'none') {
			this._nameInput.focus();
			this._nameInput.select();
			return;
		}
		this._languageCards.get(this._language ?? 'mql5')?.focus();
	}

	/** Shows a neutral status line (e.g. "готовим рабочую папку"). */
	setStatus(message: string | undefined, kind: 'info' | 'error' = 'info'): void {
		this._status.textContent = message ?? '';
		this._status.classList.toggle('error', kind === 'error' && !!message);
	}

	setBusy(busy: boolean): void {
		this._busy = busy;
		this._createButton.disabled = busy || !this._currentName();
		for (const card of this._languageCards.values()) {
			card.disabled = busy;
		}
	}

	private _currentName(): string {
		return this._nameInput.value.trim();
	}

	private _selectLanguage(language: DquantLanguage): void {
		this._language = language;
		for (const [candidate, card] of this._languageCards) {
			const selected = candidate === language;
			card.classList.toggle('selected', selected);
			card.setAttribute('aria-checked', String(selected));
		}
		this._showNameStep();
	}

	private _showNameStep(): void {
		const language = this._language;
		if (!language) {
			return;
		}
		this._languageStep.style.display = 'none';
		this._nameStep.style.display = '';
		this._summaryLabel.textContent = DQUANT_LANGUAGE_PRESENTATION[language].label;
		if (!this._currentName()) {
			this._nameInput.value = suggestDquantProjectName(language);
		}
		this._updateCreateEnabled();
		this.setStatus(undefined);
		this._nameInput.focus();
		this._nameInput.select();
	}

	private _showLanguageStep(clearStatus: boolean): void {
		this._nameStep.style.display = 'none';
		this._languageStep.style.display = '';
		if (clearStatus) {
			this.setStatus(undefined);
		}
		this._languageCards.get(this._language ?? 'mql5')?.focus();
	}

	private _updateCreateEnabled(): void {
		this._createButton.disabled = this._busy || !this._currentName();
	}

	private async _create(): Promise<void> {
		const language = this._language;
		const name = this._currentName();
		if (!language || !name || this._busy) {
			this._updateCreateEnabled();
			return;
		}

		this.setBusy(true);
		this.setStatus(localize('dquant.welcome.creating', "Создаём сессию…"));
		try {
			const created = await this._onCreate({ language, name });
			if (!created) {
				this.setStatus(localize('dquant.welcome.createFailed', "Не удалось создать сессию. Проверьте, что выбранная рабочая папка доступна, и попробуйте ещё раз."), 'error');
			}
		} finally {
			this.setBusy(false);
		}
	}
}

