/**
 * POST /api/chats/[id]/ask — the quick-ask side channel (owner,
 * 2026-11-04). Resolves the chat's OWN model (the turn gate's resolution:
 * chat override → strong slot, connection refresh, key presence), builds
 * the compact session context (src/core/quick-ask.ts), and streams the
 * answer as SSE (`data: {"type":"delta","text"}` … `{"type":"done"}`).
 *
 * WRITES NOTHING: no record append, no turn usage, no extraction, no
 * compaction (only an in-flight one is awaited), no jobs, no events — a
 * quick ask never becomes part of the lesson or the learner's memory.
 */

import { normalizeContext, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { piEngineForSpec } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { CLAUDE_CODE_PROVIDER } from "../agent/claude-code-cli.ts";
import { effectivePromptSegments } from "../agent/prompt-segments.ts";
import {
	modelsNotConfigured,
	parseQuickAskRequest,
	providerKeyMissing as providerKeyMissingEnvelope,
	QUICK_ASK_SYSTEM,
	quickAskContext,
	quickAskUserText,
	resolveConversationSpec,
} from "../core/index.ts";
import { getChat } from "./chats.ts";
import { awaitCompaction } from "./compaction.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings } from "./stores.ts";

const FORMATTING_SEGMENT = "shared/40-formatting.md";

/** The house formatting law (LaTeX, \$ currency, ```chart…) — the same
 *  fragment the teacher composes, override-aware, so answers render alike. */
function formattingRules(switches: Record<string, boolean>): string {
	const seg = effectivePromptSegments("teacher", switches).find((s) => s.path === FORMATTING_SEGMENT);
	if (!seg) return "";
	return (seg.enabled && seg.overrideText !== null ? seg.overrideText : seg.sourceText).trim();
}

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };

export async function handleQuickAsk(chatId: string, body: unknown, signal: AbortSignal): Promise<Response> {
	const parsed = parseQuickAskRequest(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const req = parsed.req;

	const record = getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const effective = effectiveSettings();
	const spec = resolveConversationSpec(record.settings, effective.models.strong);
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(spec.provider) || spec.provider === CLAUDE_CODE_PROVIDER) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return Response.json(providerKeyMissingEnvelope(spec.provider, ["strong"]), { status: 503 });

	let engine;
	try {
		engine = piEngineForSpec(spec, false); // a user-initiated call, never background
	} catch {
		return Response.json({ error: "This chat's model is unavailable." }, { status: 503 });
	}
	if (req.images.length && !engine.model.input.includes("image")) {
		return Response.json({ error: `${engine.model.name ?? engine.model.id} can't read images — remove the screenshots or switch this chat's model.` }, { status: 400 });
	}

	// Read the session as it stands (a running compaction finishes first —
	// awaited only, never triggered).
	await awaitCompaction(chatId).catch(() => {});
	const fresh = getChat(chatId) ?? record;
	const context = quickAskContext({ title: fresh.title, messages: fresh.messages, tree: fresh.tree });
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: quickAskUserText(context, req) }];
	for (const img of req.images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	const rules = formattingRules(effective.agent.prompts ?? {});
	const systemPrompt = rules ? `${QUICK_ASK_SYSTEM}\n\n${rules}` : QUICK_ASK_SYSTEM;

	const encoder = new TextEncoder();
	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (frame: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
			try {
				const stream = engine.streamFn(
					engine.model,
					normalizeContext({ systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] }),
					{ reasoning: engine.level && engine.level !== "off" ? engine.level : undefined, signal } as never,
				);
				for await (const event of stream as AsyncIterable<{ type: string; delta?: string; error?: { errorMessage?: string } }>) {
					if (event.type === "text_delta" && event.delta) send({ type: "delta", text: event.delta });
					else if (event.type === "error") {
						send({ type: "error", message: event.error?.errorMessage ?? "The model returned an error." });
						break;
					}
				}
				send({ type: "done" });
			} catch (e) {
				if (!signal.aborted) send({ type: "error", message: e instanceof Error ? e.message : String(e) });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(readable, { headers: SSE_HEADERS });
}
