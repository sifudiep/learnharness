/**
 * THE CLAUDE CODE CLI CONNECTION — catalog + status (owner, 2026-10-27).
 *
 * DEV-ONLY by owner decision: Anthropic's terms do not let a distributed
 * third-party app route requests through a user's Claude Pro/Max login, so
 * this provider exists only when LH_CLAUDE_CODE_CLI=1 and is never offered
 * in the shipped app. With the flag unset every export here is inert.
 *
 * The provider ("claude-code") is a KEYLESS provider, not a subscription
 * connection: no admission/lease cycle, no background-use gate (owner).
 * Presence = the user's installed `claude` reports a login. Model steps run
 * through claude-code-stream.ts; this module owns what the picker sees and
 * whether the CLI is logged in.
 */

import { execFile } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeStatus } from "../core/contracts/models.ts";

export { CLAUDE_CODE_PROVIDER };

/** Exact ids (owner): a session always runs the model it was stamped with;
 *  adding a model is an edit here. Metadata comes from pi-ai's Anthropic
 *  catalog. */
export const CLAUDE_CODE_MODEL_IDS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** Re-checks `claude auth status` at most this often (a login/logout in a
 *  terminal shows up within one window). */
const STATUS_TTL_MS = 30_000;

export function claudeCodeEnabled(): boolean {
	return process.env.LH_CLAUDE_CODE_CLI === "1";
}

/** Env vars that would change WHICH credential or endpoint the CLI uses
 *  (owner-approved list): an inherited key/token would bill it instead of
 *  the subscription login (the keys seam reflects saved keys into
 *  process.env); a base URL or 3P switch would route elsewhere.
 *  CLAUDE_CONFIG_DIR stays — it is how the CLI finds its own login. */
const FOREIGN_AUTH_ENV = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];

/** The child env for every `claude` spawn: the CLI's own login on
 *  Anthropic's first-party API, nothing else. */
export function claudeCodeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of FOREIGN_AUTH_ENV) delete env[name];
	return env;
}

let catalog: Model<Api>[] | undefined;

/** The four models, re-homed under "claude-code": $0 cost like ChatGPT
 *  (plan-paid, owner) and only the thinking levels `claude --effort` can
 *  honor — minimal/off nulled so pi offers low–max (owner). */
export function claudeCodeModels(): Model<Api>[] {
	if (!claudeCodeEnabled()) return [];
	if (!catalog) {
		const anthropic = builtinProviders().find((p) => p.id === "anthropic")?.getModels() ?? [];
		catalog = CLAUDE_CODE_MODEL_IDS.flatMap((id) => {
			const model = anthropic.find((m) => m.id === id);
			return model ? [{
				...model,
				provider: CLAUDE_CODE_PROVIDER,
				headers: undefined,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				thinkingLevelMap: { ...model.thinkingLevelMap, off: null, minimal: null },
			}] : [];
		});
	}
	return catalog;
}

export function claudeCodeModel(id: string): Model<Api> | undefined {
	return claudeCodeModels().find((m) => m.id === id);
}

interface StatusState {
	status: ClaudeCodeStatus;
	checkedAt: number;
	inflight?: Promise<ClaudeCodeStatus>;
}
// globalThis anchor: HMR re-imports must not drop the cached status.
const KEY = Symbol.for("lh.claudeCode.status");
function state(): StatusState {
	const g = globalThis as typeof globalThis & { [KEY]?: StatusState };
	return g[KEY] ??= { status: unchecked(), checkedAt: 0 };
}
function unchecked(): ClaudeCodeStatus {
	return { enabled: claudeCodeEnabled(), loggedIn: false, authMethod: null, subscriptionType: null, error: null };
}

/** Project `claude auth status --json` stdout — exported for tests. Only
 *  the three safe fields survive; email/org never leave this function. */
export function parseClaudeCodeAuthStatus(stdout: string): ClaudeCodeStatus {
	try {
		const raw = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
		return {
			enabled: true,
			loggedIn: raw.loggedIn === true,
			authMethod: typeof raw.authMethod === "string" ? raw.authMethod : null,
			subscriptionType: typeof raw.subscriptionType === "string" ? raw.subscriptionType : null,
			error: null,
		};
	} catch {
		return { enabled: true, loggedIn: false, authMethod: null, subscriptionType: null, error: "Could not read `claude auth status` output." };
	}
}

function runAuthStatus(): Promise<ClaudeCodeStatus> {
	return new Promise((resolve) => {
		// Exit code 1 means "not logged in" and still prints JSON — parse stdout either way.
		execFile("claude", ["auth", "status", "--json"], { env: claudeCodeEnv(), timeout: 10_000 }, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				resolve({ enabled: true, loggedIn: false, authMethod: null, subscriptionType: null, error: "The `claude` command was not found on PATH." });
				return;
			}
			resolve(parseClaudeCodeAuthStatus(stdout));
		});
	});
}

/** Re-run `claude auth status` when the cached result is stale (or always,
 *  with force). Concurrent callers share one child process. */
export async function refreshClaudeCodeStatus(force = false): Promise<ClaudeCodeStatus> {
	const s = state();
	if (!claudeCodeEnabled()) {
		s.status = unchecked();
		return s.status;
	}
	if (!force && s.checkedAt > 0 && Date.now() - s.checkedAt < STATUS_TTL_MS) return s.status;
	s.inflight ??= runAuthStatus().then((status) => {
		s.status = status;
		s.checkedAt = Date.now();
		s.inflight = undefined;
		return status;
	});
	return s.inflight;
}

/** The cached status (sync — the key gates are sync). A stale cache kicks
 *  a background refresh; callers that must be exact await
 *  refreshClaudeCodeStatus first. */
export function claudeCodeStatus(): ClaudeCodeStatus {
	if (!claudeCodeEnabled()) return unchecked();
	const s = state();
	if (Date.now() - s.checkedAt >= STATUS_TTL_MS) void refreshClaudeCodeStatus();
	return s.status;
}

export function claudeCodeConnected(): boolean {
	return claudeCodeEnabled() && claudeCodeStatus().loggedIn;
}

// Check the login at server boot: the job-runner and extraction key gates
// read the cached status synchronously and never await a refresh.
if (claudeCodeEnabled()) void refreshClaudeCodeStatus();
