/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir, tmpdir } from 'os';
import { NativeParsedArgs } from '../common/argv.js';
import { IDebugParams } from '../common/environment.js';
import { AbstractNativeEnvironmentService, parseDebugParams } from '../common/environmentService.js';
import { getUserDataPath, migrateLegacyDataFolder } from './userDataPath.js';
import { IProductService } from '../../product/common/productService.js';

export class NativeEnvironmentService extends AbstractNativeEnvironmentService {

	constructor(args: NativeParsedArgs, productService: IProductService) {
		const homeDir = homedir();

		// The application was renamed after the DQuant Lab rebrand: move the
		// pre-rebrand data directories once so settings, extensions and history
		// survive the update. Both calls are no-ops when the directories are
		// absent or already migrated.
		migrateLegacyDataFolder(productService.dataFolderName, homeDir);
		migrateLegacyDataFolder(productService.sharedDataFolderName, homeDir);

		super(args, {
			homeDir,
			tmpDir: tmpdir(),
			userDataDir: getUserDataPath(args, productService.nameShort),
		}, productService);
	}
}

export function parsePtyHostDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-ptyhost'], args['inspect-brk-ptyhost'], 5877, isBuilt, args.extensionEnvironment);
}

export function parseAgentHostDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-agenthost'], args['inspect-brk-agenthost'], 5878, isBuilt, args.extensionEnvironment);
}

export function parseSharedProcessDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-sharedprocess'], args['inspect-brk-sharedprocess'], 5879, isBuilt, args.extensionEnvironment);
}
