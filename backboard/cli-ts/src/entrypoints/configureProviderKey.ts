/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderKeyController } from "../core/keys/ProviderKeyController.ts";
import {
	isByokProviderId,
	type ProviderKeyConfig,
} from "../core/keys/ProviderKeyTypes.ts";

/** Credential setup runs before Config so a fresh install needs no DQuant Lab auth. */
export async function configureProviderKey(input: string): Promise<void> {
	const request = JSON.parse(input) as {
		provider?: string;
		key?: string;
		baseUrl?: string;
		model?: string;
	};
	if (
		!request ||
		typeof request.provider !== "string" ||
		!isByokProviderId(request.provider) ||
		typeof request.key !== "string"
	) {
		throw new Error("Choose a supported provider and enter an API key.");
	}
	const config: ProviderKeyConfig | undefined =
		typeof request.baseUrl === "string" && typeof request.model === "string"
			? { baseUrl: request.baseUrl, model: request.model }
			: undefined;
	await new ProviderKeyController().add(
		request.provider,
		request.key,
		AbortSignal.timeout(30000),
		config,
	);
}
