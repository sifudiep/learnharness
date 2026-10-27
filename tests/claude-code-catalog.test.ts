import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ClaudeCodeStatus } from "../src/core/contracts/models.ts";
import { CLAUDE_CODE_MODEL_IDS, claudeCodeConnected, claudeCodeEnv, claudeCodeModels, parseClaudeCodeAuthStatus } from "../src/agent/claude-code-cli.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { providerKeyPresent } from "../src/server/keys.ts";
import { catalogProviders, modelCatalog, validateModelsSettings } from "../src/server/model-catalog.ts";
import { isProviderKeyRefusal, providerKeyMissing } from "../src/core/settings.ts";

// The dev-only Claude Code CLI catalog + gates (owner, 2026-10-27). The
// login status is seeded through its globalThis anchor — tests never run
// the real `claude auth status`.

const flag = process.env.LH_CLAUDE_CODE_CLI;
const STATUS = Symbol.for("lh.claudeCode.status");
function seed(status: Partial<ClaudeCodeStatus>) {
	(globalThis as Record<symbol, unknown>)[STATUS] = {
		status: { enabled: true, loggedIn: false, authMethod: null, subscriptionType: null, error: null, ...status },
		checkedAt: Date.now(),
	};
}
afterEach(() => {
	if (flag === undefined) delete process.env.LH_CLAUDE_CODE_CLI; else process.env.LH_CLAUDE_CODE_CLI = flag;
	delete (globalThis as Record<symbol, unknown>)[STATUS];
});

test("flag off: the provider does not exist anywhere", () => {
	delete process.env.LH_CLAUDE_CODE_CLI;
	seed({ loggedIn: true });
	assert.deepEqual(claudeCodeModels(), []);
	assert.equal(claudeCodeConnected(), false);
	assert.equal(providerKeyPresent("claude-code"), false);
	assert(!catalogProviders().some((p) => p.id === "claude-code"));
	assert(!modelCatalog().models.some((m) => m.provider === "claude-code"));
	assert.equal(validateModelsSettings({ strong: { model: { provider: "claude-code", id: "claude-opus-5-5" } } }).ok, false);
});

test("flag on: exactly the four models, $0 cost, thinking levels low–max only", () => {
	process.env.LH_CLAUDE_CODE_CLI = "1";
	const models = claudeCodeModels();
	assert.deepEqual(models.map((m) => m.id), [...CLAUDE_CODE_MODEL_IDS]);
	for (const model of models) {
		assert.equal(model.provider, "claude-code");
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
	}
});

test("logged out: listed as a provider but no key, no picker models; logged in: federated", () => {
	process.env.LH_CLAUDE_CODE_CLI = "1";
	seed({ loggedIn: false });
	assert.deepEqual(catalogProviders().find((p) => p.id === "claude-code"), { id: "claude-code", envVar: "", keyPresent: false });
	assert.equal(providerKeyPresent("claude-code"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "claude-code"));
	seed({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
	assert.equal(providerKeyPresent("claude-code"), true);
	assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "claude-code").map((m) => m.id), [...CLAUDE_CODE_MODEL_IDS]);
	assert.equal(validateModelsSettings({ cheap: { model: { provider: "claude-code", id: "claude-haiku-5-5" } } }).ok, true);
});

test("engine: claude-code specs resolve to the CLI catalog and clamp minimal/off up to low", () => {
	process.env.LH_CLAUDE_CODE_CLI = "1";
	const engine = piEngineForSpec({ provider: "claude-code", id: "claude-fable-5-1", thinkingLevel: "minimal" });
	assert.equal(engine.model.provider, "claude-code");
	assert.equal(engine.level, "low");
	assert.equal(piEngineForSpec({ provider: "claude-code", id: "claude-haiku-5-5", thinkingLevel: "off" }).level, "low");
});

test("auth status projection keeps only safe fields", () => {
	const status = parseClaudeCodeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com", orgId: "org", orgName: "Org" }));
	assert.deepEqual(status, { enabled: true, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", error: null });
	assert.equal(parseClaudeCodeAuthStatus("not json").loggedIn, false);
	assert.match(parseClaudeCodeAuthStatus("not json").error!, /auth status/);
});

test("child env drops foreign credentials and routing so the CLI uses its own login", () => {
	const stripped = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
	const names = [...stripped, "CLAUDE_CONFIG_DIR"];
	const saved = names.map((name) => process.env[name]);
	for (const name of names) process.env[name] = "fixture";
	const env = claudeCodeEnv();
	for (const name of stripped) assert.equal(env[name], undefined, name);
	assert.equal(env.CLAUDE_CONFIG_DIR, "fixture");
	assert.equal(process.env.ANTHROPIC_API_KEY, "fixture");
	names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
});

test("logged-out refusal names the real fix and still reads as a quiet key refusal", () => {
	const refusal = providerKeyMissing("claude-code", ["strong"]);
	assert.equal(refusal.error, "Claude Code CLI is not logged in — run `claude auth login` in a terminal.");
	assert.equal(refusal.code, "provider_key_missing");
	assert.equal(isProviderKeyRefusal(refusal.error), true);
	assert.equal(isProviderKeyRefusal(providerKeyMissing("openai", ["cheap"]).error), true);
});
