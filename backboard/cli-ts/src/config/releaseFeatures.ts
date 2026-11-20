/** Windows releases support DQuant Lab and provider API keys, not BYOS. */
export function supportsSubscriptions(platform: string = process.platform): boolean {
	return platform !== "win32";
}
