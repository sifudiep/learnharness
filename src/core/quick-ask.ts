/**
 * Quick ask (owner, 2026-11-04): a side question about the session, asked
 * from a panel beside the chat — answered by the chat's own model, and
 * NEVER part of the lesson: nothing reaches the chat record, the turn
 * usage, extraction, the graph or compaction. PURE, browser-safe: the
 * request shape and the compact session context live here; the server
 * route (src/server/quick-ask.ts) only resolves the model and streams.
 *
 * Context per question (owner-chosen "summary + plan + recent turns"):
 * the latest compaction summary, the plan outline with the current step,
 * the exchanges since that summary as plain Learner/Teacher markdown
 * trimmed to the most recent ~12k chars (~3k tokens), and the open
 * question if one waits. Roughly 2–5k tokens all in.
 */

import type { PlanTree } from "./contracts/plan.ts";
import { activeCompactionOf, keptIndexFor, planTreeToText } from "./compaction.ts";
import { danglingQuestionOf, type LhMessage } from "./native-messages.ts";
import { sessionMarkdown } from "./session-markdown.ts";

export const QUICK_ASK_RECENT_CHARS = 12_000;
export const QUICK_ASK_MAX_MARKED = 12;
export const QUICK_ASK_MAX_MARKED_CHARS = 4_000;
export const QUICK_ASK_MAX_IMAGES = 4;
/** Base64 cap per image (~3 MB decoded) — the client downscales first. */
export const QUICK_ASK_MAX_IMAGE_B64 = 4_000_000;
export const QUICK_ASK_MAX_THREAD = 12;

export interface QuickAskImage {
	/** Base64, no `data:` prefix. */
	data: string;
	mimeType: string;
}

export interface QuickAskTurn {
	question: string;
	answer: string;
}

export interface QuickAskRequest {
	question: string;
	marked: string[];
	images: QuickAskImage[];
	/** The earlier quick-ask exchanges of this thread (follow-ups). */
	thread: QuickAskTurn[];
}

/** Validate a POST body. */
export function parseQuickAskRequest(body: unknown): { ok: true; req: QuickAskRequest } | { ok: false; error: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	const question = typeof b.question === "string" ? b.question.trim() : "";
	if (!question) return { ok: false, error: "Ask a question" };
	const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : []);
	const marked = strings(b.marked).slice(0, QUICK_ASK_MAX_MARKED).map((s) => s.slice(0, QUICK_ASK_MAX_MARKED_CHARS));
	const imagesRaw = Array.isArray(b.images) ? b.images : [];
	if (imagesRaw.length > QUICK_ASK_MAX_IMAGES) return { ok: false, error: `At most ${QUICK_ASK_MAX_IMAGES} screenshots per question` };
	const images: QuickAskImage[] = [];
	for (const raw of imagesRaw) {
		const i = (raw ?? {}) as Record<string, unknown>;
		if (typeof i.data !== "string" || typeof i.mimeType !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(i.mimeType)) {
			return { ok: false, error: "A screenshot is not a PNG, JPEG, WebP or GIF image" };
		}
		if (i.data.length > QUICK_ASK_MAX_IMAGE_B64) return { ok: false, error: "A screenshot is too large" };
		images.push({ data: i.data, mimeType: i.mimeType });
	}
	const thread = (Array.isArray(b.thread) ? b.thread : [])
		.map((t) => (t ?? {}) as Record<string, unknown>)
		.filter((t) => typeof t.question === "string" && typeof t.answer === "string")
		.map((t) => ({ question: t.question as string, answer: t.answer as string }))
		.slice(-QUICK_ASK_MAX_THREAD);
	return { ok: true, req: { question, marked, images, thread } };
}

/** The tail of a transcript, cut at a turn heading so no turn starts mid-way. */
function tail(markdown: string, budget: number): string {
	if (markdown.length <= budget) return markdown;
	const cut = markdown.slice(markdown.length - budget);
	const heading = cut.search(/^### /m);
	return `…(earlier turns omitted)\n\n${heading > 0 ? cut.slice(heading) : cut}`;
}

/** The compact session context for a quick ask. */
export function quickAskContext(
	chat: { title?: string; messages: readonly LhMessage[]; tree?: PlanTree },
	budget = QUICK_ASK_RECENT_CHARS,
): string {
	const parts: string[] = [];
	if (chat.title) parts.push(`# Session: ${chat.title}`);
	const compaction = activeCompactionOf(chat.messages);
	let from = 0;
	if (compaction) {
		const summary = typeof compaction.content === "string" ? compaction.content : "";
		if (summary.trim()) parts.push(`## Summary of the session so far\n\n${summary.trim()}`);
		const kept = keptIndexFor(chat.messages, compaction);
		if (kept >= 0) from = kept;
	}
	const plan = planTreeToText(chat.tree, chat.messages);
	if (plan) parts.push(`## Learning plan (current step marked)\n\n${plan}`);
	const recent = sessionMarkdown(chat.messages.slice(from), { anchors: false }).trim();
	if (recent) parts.push(`## Recent conversation\n\n${tail(recent, budget)}`);
	const open = danglingQuestionOf(chat.messages);
	const q = (open?.input as { question?: unknown; details?: unknown } | undefined) ?? undefined;
	if (q && typeof q.question === "string") {
		parts.push(`## The question the learner is answering right now\n\n${q.question}${typeof q.details === "string" && q.details ? `\n\n${q.details}` : ""}`);
	}
	return parts.join("\n\n");
}

/** The single user message: context, the earlier thread, marked text, the question. */
export function quickAskUserText(context: string, req: QuickAskRequest): string {
	const parts = [`<session_context>\n${context}\n</session_context>`];
	if (req.thread.length) {
		parts.push(
			`<earlier_quick_questions>\n${req.thread.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n\n")}\n</earlier_quick_questions>`,
		);
	}
	if (req.marked.length) {
		parts.push(`<marked_text>\n${req.marked.map((m, i) => `[${i + 1}] ${m}`).join("\n\n")}\n</marked_text>`);
	}
	if (req.images.length) parts.push(`(${req.images.length} screenshot${req.images.length > 1 ? "s" : ""} attached)`);
	parts.push(`Question: ${req.question}`);
	return parts.join("\n\n");
}

export const QUICK_ASK_SYSTEM = `You answer QUICK SIDE QUESTIONS from a learner in the middle of a tutoring session. The session context (a summary, the learning plan, the recent conversation, and any question the learner is currently answering) is background only — you are not the tutor and this exchange is not part of the lesson.

- Answer the question directly and concisely; expand only when the question asks for it.
- "Marked text" is what the learner highlighted in the session — it is usually what the question is about.
- If the learner is in the middle of answering a quiz or check question, help them understand but do NOT hand them the answer to that question; nudge instead.
- Screenshots, when attached, are part of the question.`;
