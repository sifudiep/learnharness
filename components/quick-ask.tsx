"use client";

/**
 * Quick ask (owner, 2026-11-04): a side question about the session from a
 * panel on the right (it swaps with the calculator). Answered by the chat's
 * own model through POST /api/chats/[id]/ask — streamed, and NEVER part of
 * the lesson (no record, memory, graph or extraction).
 *
 * - Toggle: the top-bar button, or the PHYSICAL Control key + C on Mac
 *   (⌘C stays Copy); ⌃⇧C elsewhere, where Ctrl+C is Copy.
 * - Marked text, the Cursor → Claude Code way: selecting text in the
 *   conversation or the question dialog fills the "Marked text" chip
 *   (open or not — select, then ⌃C). A new selection replaces it; "+"
 *   saves it so the next selection starts a new chip; × removes one.
 *   Sending clears them.
 * - Screenshots: paste (⌘V), drop, or attach — downscaled client-side.
 * - The thread (follow-ups see earlier Q&A) is kept per chat on this
 *   device (`lh:quick-ask:<chatId>`; images as a count, never the pixels).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlusIcon, MessageCircleQuestionIcon, PlusIcon, SquareIcon, Trash2Icon, XIcon, ArrowUpIcon } from "lucide-react";
import { QUICK_ASK_MAX_IMAGES, QUICK_ASK_MAX_THREAD, type QuickAskImage } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { AnswerPlayButton, ANSWER_ATTR, PART_ATTR, SCOPE_ATTR, type ReadAloud } from "@/components/voice";
import { cn } from "@/lib/utils";

export { MessageCircleQuestionIcon as QuickAskIcon };

/** `id` keys read-aloud's bookkeeping (stable across a "New thread"). */
export type QuickAskEntry = { id?: string; question: string; marked: string[]; images: number; answer: string; error?: string };
type Entry = QuickAskEntry;

/** The answer's read-aloud keys: entries saved before ids existed fall back to their index. */
export const entryKey = (e: QuickAskEntry, i: number) => e.id ?? `i${i}`;
type Attached = QuickAskImage & { url: string };

const MAX_MARK = 4000;
const threadKey = (chatId: string) => `lh:quick-ask:${chatId}`;

function loadThread(chatId: string): Entry[] {
	try {
		const raw = window.localStorage.getItem(threadKey(chatId));
		const v = raw ? (JSON.parse(raw) as Entry[]) : [];
		return Array.isArray(v) ? v.filter((e) => typeof e?.question === "string" && typeof e?.answer === "string") : [];
	} catch {
		return [];
	}
}

function saveThread(chatId: string, thread: Entry[]): void {
	try {
		if (thread.length) window.localStorage.setItem(threadKey(chatId), JSON.stringify(thread.slice(-40)));
		else window.localStorage.removeItem(threadKey(chatId));
	} catch {
		/* storage unavailable: the thread lives for this visit */
	}
}

/** Is this keydown the quick-ask toggle? (physical Ctrl, never ⌘) */
function isToggleKey(e: KeyboardEvent): boolean {
	if (e.code !== "KeyC" || !e.ctrlKey || e.metaKey || e.altKey) return false;
	const mac = /mac/i.test(navigator.platform || navigator.userAgent);
	return mac ? !e.shiftKey : e.shiftKey;
}

/** The selection, when it is marked text from the session (the transcript
 *  or the question dialog — never quick ask itself or a text field). */
function sessionSelection(): string | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed) return null;
	const text = sel.toString().replace(/\s+\n/g, "\n").trim();
	if (!text) return null;
	const el = (n: Node | null) => (n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null);
	for (const node of [sel.anchorNode, sel.focusNode]) {
		const e = el(node);
		if (!e?.closest("[data-session-find-root]") || e.closest("[data-quick-ask]") || e.closest("input, textarea")) return null;
	}
	return text.slice(0, MAX_MARK);
}

export function useQuickAsk(chatId: string) {
	const [open, setOpen] = useState(false);
	const [focusTick, setFocusTick] = useState(0);
	const [thread, setThread] = useState<Entry[]>([]);
	const [marked, setMarked] = useState<string | null>(null);
	const [saved, setSaved] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => setThread(loadThread(chatId)), [chatId]); // after mount: hydration stays clean

	const toggle = useCallback(() => {
		setOpen((o) => {
			if (!o) setFocusTick((t) => t + 1);
			return !o;
		});
	}, []);
	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isToggleKey(e)) return;
			e.preventDefault();
			e.stopPropagation();
			toggle();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [toggle]);

	// Marked text follows the selection (debounced: a drag fires many events).
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onChange = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				const text = sessionSelection();
				if (text) setMarked(text);
			}, 180);
		};
		document.addEventListener("selectionchange", onChange);
		return () => {
			document.removeEventListener("selectionchange", onChange);
			if (timer) clearTimeout(timer);
		};
	}, []);

	const saveMarked = () => {
		if (!marked) return;
		setSaved((s) => (s.includes(marked) ? s : [...s, marked]));
		setMarked(null);
	};

	const update = useCallback(
		(fn: (t: Entry[]) => Entry[]) =>
			setThread((t) => {
				const next = fn(t);
				saveThread(chatId, next);
				return next;
			}),
		[chatId],
	);

	const send = async (question: string, images: Attached[]) => {
		const q = question.trim();
		if (!q || busy) return false;
		const marks = [...saved, ...(marked && !saved.includes(marked) ? [marked] : [])];
		const history = thread
			.filter((e) => e.answer && !e.error)
			.slice(-QUICK_ASK_MAX_THREAD)
			.map((e) => ({ question: e.question, answer: e.answer }));
		update((t) => [...t, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, question: q, marked: marks, images: images.length, answer: "" }]);
		setSaved([]);
		setMarked(null);
		setBusy(true);
		const ac = new AbortController();
		abortRef.current = ac;
		const patchLast = (fn: (e: Entry) => Entry) => update((t) => (t.length ? [...t.slice(0, -1), fn(t[t.length - 1]!)] : t));
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: q, marked: marks, images: images.map(({ data, mimeType }) => ({ data, mimeType })), thread: history }),
				signal: ac.signal,
			});
			if (!res.ok || !res.body) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				patchLast((e) => ({ ...e, error: err.error ?? `Quick ask failed (${res.status})` }));
				return true;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, i).replace(/^data: /, "");
					buf = buf.slice(i + 2);
					const ev = JSON.parse(frame) as { type: string; text?: string; message?: string };
					if (ev.type === "delta" && ev.text) patchLast((e) => ({ ...e, answer: e.answer + ev.text }));
					else if (ev.type === "error") patchLast((e) => ({ ...e, error: ev.message ?? "The model returned an error." }));
				}
			}
		} catch (e) {
			if (!ac.signal.aborted) patchLast((x) => ({ ...x, error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(false);
			abortRef.current = null;
		}
		return true;
	};

	return {
		open,
		focusTick,
		toggle,
		close,
		thread,
		marked,
		saved,
		busy,
		saveMarked,
		dropMarked: () => setMarked(null),
		dropSaved: (i: number) => setSaved((s) => s.filter((_, j) => j !== i)),
		send,
		stop: () => abortRef.current?.abort(),
		newThread: () => update(() => []),
	};
}

export type QuickAsk = ReturnType<typeof useQuickAsk>;

/** Read + downscale an image file to ≤1600px; PNG keeps screenshots crisp,
 *  JPEG when the PNG would be heavy. */
async function toAttachment(file: Blob): Promise<Attached | null> {
	if (!file.type.startsWith("image/")) return null;
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = reject;
			i.src = url;
		});
		const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(img.naturalWidth * scale);
		canvas.height = Math.round(img.naturalHeight * scale);
		canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
		let dataUrl = canvas.toDataURL("image/png");
		if (dataUrl.length > 2_500_000) dataUrl = canvas.toDataURL("image/jpeg", 0.85);
		const [head, data] = dataUrl.split(",");
		return { data: data!, mimeType: /image\/(png|jpeg)/.exec(head!)![0], url: dataUrl };
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function Chip({ text, saved, onSave, onDrop }: { text: string; saved: boolean; onSave?: () => void; onDrop: () => void }) {
	const preview = text.replace(/\s+/g, " ");
	return (
		<div
			data-testid={saved ? "quick-ask-saved-chip" : "quick-ask-marked-chip"}
			title={text}
			className={cn(
				"flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
				saved ? "border-border bg-accent/60 text-foreground" : "border-dashed border-muted-foreground/50 text-muted-foreground",
			)}
		>
			<span className="shrink-0 font-medium">{saved ? "Saved" : "Marked text"}</span>
			<span className="min-w-0 truncate">“{preview.length > 48 ? `${preview.slice(0, 48)}…` : preview}”</span>
			<span className="shrink-0 opacity-60">{text.length} ch</span>
			{onSave && (
				<button type="button" onClick={onSave} aria-label="Keep this marked text" title="Keep it — the next selection starts a new chip" className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground">
					<PlusIcon className="size-3" />
				</button>
			)}
			<button type="button" onClick={onDrop} aria-label="Remove" className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground">
				<XIcon className="size-3" />
			</button>
		</div>
	);
}

const WIDTH_KEY = "lh:quick-ask-width";
const DEFAULT_WIDTH = 416;
const MIN_WIDTH = 300;

function clampWidth(w: number): number {
	const max = Math.max(MIN_WIDTH, Math.min(1000, window.innerWidth * 0.65));
	return Math.round(Math.min(max, Math.max(MIN_WIDTH, w)));
}

export function QuickAskPanel({
	ask,
	readAloud,
	onSend,
}: {
	ask: QuickAsk;
	/** Voice-over on the answers — the main chat's machinery (▶/■,
	 *  right-click a word, the green highlight, the reading cursor). */
	readAloud?: ReadAloud;
	/** A question went out (the page interrupts old speech). */
	onSend?: () => void;
}) {
	/* RESIZABLE (owner, 2026-11-04): drag the left edge; the width is kept
	 * on this device; double-click the edge resets it. */
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	useEffect(() => {
		try {
			const w = Number(window.localStorage.getItem(WIDTH_KEY));
			if (w) setWidth(clampWidth(w));
		} catch {
			/* storage unavailable: default width */
		}
	}, []);
	const persistWidth = (w: number) => {
		try {
			window.localStorage.setItem(WIDTH_KEY, String(w));
		} catch {
			/* storage unavailable */
		}
	};
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		let latest = startW;
		const onMove = (ev: PointerEvent) => {
			latest = clampWidth(startW + (startX - ev.clientX));
			setWidth(latest);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			persistWidth(latest);
		};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const [question, setQuestion] = useState("");
	const [images, setImages] = useState<Attached[]>([]);
	const [dragging, setDragging] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (ask.focusTick > 0) inputRef.current?.focus({ preventScroll: true });
	}, [ask.focusTick]);
	const last = ask.thread.at(-1);
	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [ask.thread.length, last?.answer.length]);

	const addFiles = async (files: Iterable<Blob>) => {
		setImageError(null);
		const room = QUICK_ASK_MAX_IMAGES - images.length;
		const picked = [...files].filter((f) => f.type.startsWith("image/"));
		if (picked.length > room) setImageError(`At most ${QUICK_ASK_MAX_IMAGES} screenshots per question`);
		const added = (await Promise.all(picked.slice(0, Math.max(0, room)).map(toAttachment))).filter((a): a is Attached => a !== null);
		setImages((cur) => [...cur, ...added].slice(0, QUICK_ASK_MAX_IMAGES));
	};

	// The input clears the moment a question is sent (owner, 2026-11-04) —
	// not after the answer finishes streaming.
	const submit = () => {
		if (!question.trim() || ask.busy) return;
		const q = question;
		const imgs = images;
		setQuestion("");
		setImages([]);
		onSend?.();
		void ask.send(q, imgs);
	};

	return (
		<aside
			data-testid="quick-ask"
			data-quick-ask=""
			aria-label="Quick ask"
			style={{ width }}
			className={cn("relative flex h-full shrink-0 flex-col border-l border-border/60", dragging && "bg-accent/30")}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					if (ask.busy) ask.stop();
					else ask.close();
				}
			}}
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				void addFiles(e.dataTransfer.files);
			}}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize quick ask"
				title="Drag to resize · double-click to reset"
				data-testid="quick-ask-resize"
				onPointerDown={startResize}
				onDoubleClick={() => {
					setWidth(DEFAULT_WIDTH);
					persistWidth(DEFAULT_WIDTH);
				}}
				className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-border/60"
			/>
			<div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
				<div>
					<div className="text-xs uppercase tracking-widest text-muted-foreground">Quick ask</div>
					<div className="text-[11px] text-muted-foreground/70">Side questions — never part of the lesson</div>
				</div>
				<div className="flex items-center gap-0.5">
					{ask.thread.length > 0 && (
						<button type="button" onClick={ask.newThread} disabled={ask.busy} title="New thread (clears this chat's quick-ask history)" aria-label="New thread" className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40">
							<Trash2Icon className="size-3.5" />
						</button>
					)}
					<button type="button" onClick={ask.close} aria-label="Close quick ask" className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						<XIcon className="size-4" />
					</button>
				</div>
			</div>

			<div
				ref={listRef}
				data-testid="quick-ask-thread"
				{...{ [SCOPE_ATTR]: "" }}
				onContextMenu={readAloud?.onContextMenu}
				onMouseDown={readAloud?.onMouseDown}
				onMouseUp={readAloud?.onMouseUp}
				className="min-h-0 flex-1 overflow-y-auto py-3 pr-4 pl-8"
			>
				{ask.thread.length === 0 ? (
					<div className="mt-8 text-center text-xs leading-relaxed text-muted-foreground/70">
						Ask anything about this session.
						<br />
						Select text in the chat to mark it · paste or drop screenshots.
					</div>
				) : (
					ask.thread.map((e, i) => (
						<div key={i} className="mb-4">
							<div className="mb-1.5 ml-6 rounded-lg bg-accent/60 px-3 py-2 text-sm">
								{e.marked.length > 0 && (
									<div className="mb-1 text-xs text-muted-foreground">
										{e.marked.length} marked text{e.marked.length > 1 ? "s" : ""}
									</div>
								)}
								{e.images > 0 && <div className="mb-1 text-xs text-muted-foreground">[{e.images} screenshot{e.images > 1 ? "s" : ""}]</div>}
								<div className="whitespace-pre-wrap">{e.question}</div>
							</div>
							{e.answer && (
								<div {...{ [ANSWER_ATTR]: `qa-${entryKey(e, i)}` }} className="group relative">
									{readAloud && <AnswerPlayButton answerId={`qa-${entryKey(e, i)}`} readAloud={readAloud} />}
									<div className="lh-source-passage" {...{ [PART_ATTR]: `qa:${entryKey(e, i)}` }}>
										<MessageResponse className="text-sm">{e.answer}</MessageResponse>
									</div>
								</div>
							)}
							{e.error && <div className="mt-1 text-xs text-destructive">{e.error}</div>}
							{!e.answer && !e.error && i === ask.thread.length - 1 && ask.busy && (
								<span className="inline-block size-3.5 animate-spin rounded-full border border-current border-b-2 text-muted-foreground" />
							)}
						</div>
					))
				)}
			</div>

			<div className="border-t border-border/60 p-3">
				{(ask.saved.length > 0 || ask.marked) && (
					<div className="mb-2 flex flex-col gap-1">
						{ask.saved.map((t, i) => (
							<Chip key={`s${i}`} text={t} saved onDrop={() => ask.dropSaved(i)} />
						))}
						{ask.marked && <Chip text={ask.marked} saved={false} onSave={ask.saveMarked} onDrop={ask.dropMarked} />}
					</div>
				)}
				{images.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-1.5">
						{images.map((img, i) => (
							<div key={i} className="relative">
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img src={img.url} alt={`Screenshot ${i + 1}`} className="h-14 w-20 rounded border object-cover" />
								<button type="button" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} aria-label="Remove screenshot" className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border bg-card text-muted-foreground hover:text-foreground">
									<XIcon className="size-2.5" />
								</button>
							</div>
						))}
					</div>
				)}
				{imageError && <div className="mb-1 text-xs text-destructive">{imageError}</div>}
				<div className="rounded-xl border bg-background/60 focus-within:border-muted-foreground/50">
					<textarea
						ref={inputRef}
						data-testid="quick-ask-input"
						value={question}
						onChange={(e) => setQuestion(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								e.stopPropagation();
								void submit();
							}
						}}
						onPaste={(e) => {
							const files = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => !!f);
							if (files.length) {
								e.preventDefault();
								void addFiles(files);
							}
						}}
						rows={2}
						placeholder="Ask a question…"
						className="field-sizing-content lh-input max-h-40 min-h-12 w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70"
					/>
					<div className="flex items-center justify-between p-1.5">
						<button type="button" onClick={() => fileRef.current?.click()} title="Attach screenshots (or paste / drop them)" aria-label="Attach screenshots" className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
							<ImagePlusIcon className="size-4" />
						</button>
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files) void addFiles(e.target.files);
								e.target.value = "";
							}}
						/>
						<span className="text-[11px] text-muted-foreground/70">↵ asks · ⇧↵ newline · Esc closes</span>
						{ask.busy ? (
							<button type="button" onClick={ask.stop} aria-label="Stop" className="flex size-7 items-center justify-center rounded-md bg-accent text-foreground">
								<SquareIcon className="size-3" />
							</button>
						) : (
							<button type="button" data-testid="quick-ask-send" onClick={() => void submit()} disabled={!question.trim()} aria-label="Ask" className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30">
								<ArrowUpIcon className="size-4" />
							</button>
						)}
					</div>
				</div>
			</div>
		</aside>
	);
}
