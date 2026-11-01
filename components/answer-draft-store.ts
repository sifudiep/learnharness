/**
 * Answer drafts survive a reload (owner, 2026-11-01): the pending
 * question's form — selection, thinking, "Other", text answer, confidence —
 * and the check's reading-thinking are mirrored to localStorage PER CHAT
 * (`lh:answer-draft:<chatId>`), tagged with the question call's id so a
 * draft never restores onto a different question. "Submit answer" (and a
 * dismissal) clears it. The in-memory session draft (session-core's
 * questionDrafts — the failed-submission restore) stays the first source;
 * this is the across-restarts backstop.
 */

import { DEFAULT_CONFIDENCE_INDEX, type QuestionDraft, type QuestionFormDraft } from "@/src/core";

type StoredForm = Omit<QuestionFormDraft, "selection"> & {
	selection: { selected: number[]; otherSelected: boolean; dontKnow: boolean };
};

type Stored = {
	toolCallId: string;
	form?: StoredForm;
	readingThinking?: string;
	savedAt: string;
};

const key = (chatId: string) => `lh:answer-draft:${chatId}`;

function read(chatId: string): Stored | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(key(chatId));
		const parsed = raw ? (JSON.parse(raw) as Stored) : null;
		return parsed && typeof parsed.toolCallId === "string" ? parsed : null;
	} catch {
		return null; // corrupt/unavailable store = no draft
	}
}

function toForm(f: StoredForm): QuestionFormDraft {
	return {
		selection: {
			selected: new Set(Array.isArray(f.selection?.selected) ? f.selection.selected.filter((n) => Number.isInteger(n)) : []),
			otherSelected: f.selection?.otherSelected === true,
			dontKnow: f.selection?.dontKnow === true,
		},
		thinking: typeof f.thinking === "string" ? f.thinking : "",
		other: typeof f.other === "string" ? f.other : "",
		text: typeof f.text === "string" ? f.text : "",
		confidenceIndex: Number.isInteger(f.confidenceIndex) ? f.confidenceIndex : DEFAULT_CONFIDENCE_INDEX,
	};
}

/** The stored draft for this chat's pending question, if it is THAT question's. */
export function loadAnswerDraft(chatId: string, toolCallId: string): QuestionDraft | undefined {
	const s = read(chatId);
	if (!s || s.toolCallId !== toolCallId) return undefined;
	const out: QuestionDraft = {};
	if (s.form) out.form = toForm(s.form);
	if (typeof s.readingThinking === "string") out.readingThinking = s.readingThinking;
	return out.form || out.readingThinking ? out : undefined;
}

/** Merge a patch into this chat's draft (a different question's draft is replaced). */
export function saveAnswerDraft(chatId: string, toolCallId: string, patch: QuestionDraft): void {
	if (typeof window === "undefined") return;
	const prev = read(chatId);
	const next: Stored = { ...(prev?.toolCallId === toolCallId ? prev : {}), toolCallId, savedAt: new Date().toISOString() };
	if (patch.form) {
		const f = patch.form;
		next.form = {
			...f,
			selection: { selected: [...f.selection.selected], otherSelected: f.selection.otherSelected, dontKnow: f.selection.dontKnow },
		};
	}
	if (patch.readingThinking !== undefined) next.readingThinking = patch.readingThinking;
	try {
		window.localStorage.setItem(key(chatId), JSON.stringify(next));
	} catch {
		/* storage full/unavailable: the in-memory draft still holds */
	}
}

/** "Submit answer" (or a dismissal): the draft has done its job. */
export function clearAnswerDraft(chatId: string): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(key(chatId));
	} catch {
		/* nothing to clear */
	}
}
