/**
 * The Deepgram token seam shared by dictation (STT) and read-aloud (TTS):
 * /api/stt/token mints a short-lived grant with the server-held key; both
 * WebSockets authenticate with it (`["bearer", token]` subprotocol). Moved
 * out of dictation.tsx in the voice wave (owner, 2026-10-28) unchanged.
 */

/** The route's ONLY 503 is the keyless one (no DEEPGRAM_API_KEY). Each
 *  surface maps it to its own short client-authored line. */
export class DeepgramKeylessError extends Error {}

/** Mint a fresh short-lived token (the route holds the real key). */
export async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new DeepgramKeylessError(data.message ?? "keyless");
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

/** The one app-wide warm cache — a grant token works for both sockets. */
export const warmTokens = createWarmMinter(mintFreshToken);
