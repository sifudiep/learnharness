/**
 * THE CLAUDE CODE CLI STREAM (dev-only; see claude-code-cli.ts): one pi
 * model step = one `claude -p` process. pi keeps the agent loop — the CLI
 * is only asked for the next assistant message:
 *
 * - The history goes in as ONE stream-json user message (owner-approved
 *   format, 2026-10-27): every stdin user line starts its own CLI turn, so
 *   native assistant/tool history cannot be replayed. The transcript is a
 *   tagged text log, one text block per message (a stable prefix for prompt
 *   caching), images kept as real image blocks in place, earlier thinking
 *   dropped (its signatures cannot travel as text).
 * - The system prompt rides --system-prompt-file; the tools are advertised by
 *   claude-code-mcp-stub.mjs as `mcp__lh__<name>`. The CLI never runs them
 *   (its permission check refuses un-allow-listed tools). --max-turns 1
 *   caps the step at one API request; the process is also stopped at the
 *   first message_stop.
 * - Raw Anthropic stream events (--include-partial-messages) map to pi
 *   events; usage counts tokens at $0 cost (plan-paid, owner).
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Api, AssistantMessage, ImageContent, JsonObject, Message, Model, SimpleStreamOptions, StopReason, StreamFunction, TextContent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";
import { PATHS } from "../../config.ts";
import { CLAUDE_CODE_PROVIDER, claudeCodeEnv } from "./claude-code-cli.ts";

const MCP_SERVER = "lh";
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;
const MCP_STUB = path.join(PATHS.root, "src", "agent", "claude-code-mcp-stub.mjs");
/** `claude --effort` values; pi's level names match them one-to-one. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The closing instruction after the transcript (owner-approved wording). */
export const TRANSCRIPT_INSTRUCTION = "The conversation above is the history so far; earlier tool calls are shown as text for reference only. Continue as the assistant. To use a tool, call it directly — never write tool calls as text.";

export type TranscriptBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** Content can't open or close a transcript tag (owner-approved rule): only
 *  these five tag names are rewritten (`</user>` → `&lt;/user>`); code,
 *  HTML and math reach the model unchanged. */
export const neutralizeTags = (text: string) => text.replace(/<(\/?)(conversation|user|assistant|tool_call|tool_result)\b/gi, "&lt;$1$2");

/** Render pi history as the one-message transcript — exported for tests.
 *  System messages are skipped (the current prompt rides the file). */
export function renderTranscript(messages: Message[]): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	let text = "<conversation>\n";
	const flush = () => {
		if (text) blocks.push({ type: "text", text });
		text = "";
	};
	const parts = (content: string | (TextContent | ImageContent)[]) => {
		if (typeof content === "string") {
			text += neutralizeTags(content);
			return;
		}
		for (const part of content) {
			if (part.type === "text") text += neutralizeTags(part.text);
			else {
				flush();
				blocks.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
			}
		}
	};
	for (const message of messages) {
		if (message.role === "user") {
			text += "<user>";
			parts(message.content);
			text += "</user>\n";
		} else if (message.role === "assistant") {
			const body = message.content.flatMap((block) =>
				block.type === "text" ? [neutralizeTags(block.text)]
				: block.type === "toolCall" ? [`<tool_call id="${attr(block.id)}" name="${attr(block.name)}">${neutralizeTags(JSON.stringify(block.arguments ?? {}))}</tool_call>`]
				: []).filter((part) => part.trim().length > 0);
			if (body.length === 0) continue;
			text += `<assistant>${body.join("\n")}</assistant>\n`;
		} else if (message.role === "toolResult") {
			text += `<tool_result id="${attr(message.toolCallId)}" name="${attr(message.toolName)}"${message.isError ? ' error="true"' : ""}>`;
			parts(message.content);
			text += "</tool_result>\n";
		} else continue;
		flush();
	}
	text += `</conversation>\n\n${TRANSCRIPT_INSTRUCTION}`;
	flush();
	return blocks;
}

/** The argv for one step — exported for tests. */
export function claudeCodeArgs(modelId: string, effort: string | undefined, files: { systemPrompt: string; mcpConfig?: string }, thinkingDisplay = true): string[] {
	return [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
		"--tools", "", "--strict-mcp-config", ...(files.mcpConfig ? ["--mcp-config", files.mcpConfig] : []),
		"--system-prompt-file", files.systemPrompt,
		"--model", modelId, ...(effort ? ["--effort", effort] : []),
		// Readable thinking summaries, as pi requests on the API-key path. These
		// models default to "omitted" (empty thinking text). Undocumented in the
		// CLI reference; it is the session-start flag the Agent SDK passes.
		...(thinkingDisplay ? ["--thinking-display", "summarized"] : []),
		// One API request per step, enforced by the CLI itself: after a refused
		// tool_use it would otherwise send a follow-up request (verified).
		"--max-turns", "1",
		"--no-session-persistence", "--setting-sources", "", "--disable-slash-commands",
	];
}

function stopReasonOf(raw: string | undefined): Extract<StopReason, "stop" | "length" | "toolUse" | "error"> {
	if (raw === "tool_use") return "toolUse";
	if (raw === "max_tokens" || raw === "model_context_window_exceeded") return "length";
	if (raw === "refusal") return "error";
	return "stop";
}

function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

interface RawUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
function applyUsage(message: AssistantMessage, raw: RawUsage | undefined) {
	if (!raw) return;
	const usage = message.usage;
	if (typeof raw.input_tokens === "number") usage.input = raw.input_tokens;
	if (typeof raw.output_tokens === "number") usage.output = raw.output_tokens;
	if (typeof raw.cache_read_input_tokens === "number") usage.cacheRead = raw.cache_read_input_tokens;
	if (typeof raw.cache_creation_input_tokens === "number") usage.cacheWrite = raw.cache_creation_input_tokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Whether the installed CLI accepts --thinking-display; flips to false (for
 *  the process) the first time it rejects the flag. Exported for tests. */
export let thinkingDisplaySupported = true;
export function resetThinkingDisplaySupport(): void { thinkingDisplaySupported = true; }
const UNKNOWN_THINKING_DISPLAY = /unknown option '?--thinking-display/;

/** The spawn seam — tests inject a fake child; production runs `claude`. */
export type ClaudeCodeSpawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

export function claudeCodeStream(spawn: ClaudeCodeSpawn = nodeSpawn): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const partial = empty(model);
		let started = false, finished = false;
		let child: ChildProcessWithoutNullStreams | undefined;
		let dir: string | undefined;
		const start = () => {
			if (started) return;
			started = true;
			output.push({ type: "start", partial });
		};
		const fail = (reason: "error" | "aborted", message: string) => {
			if (finished) return;
			finished = true;
			partial.stopReason = reason;
			partial.errorMessage = message;
			output.push({ type: "error", reason, error: partial });
		};
		const onAbort = () => {
			child?.kill("SIGTERM");
			fail("aborted", "Claude Code CLI request cancelled.");
		};
		void (async () => {
			try {
				if (model.provider !== CLAUDE_CODE_PROVIDER) throw new Error(`not a ${CLAUDE_CODE_PROVIDER} model`);
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				if (options?.signal?.aborted) return onAbort();
				const tools = getCurrentTools(context.messages);
				dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-claude-code-"));
				const systemPrompt = path.join(dir, "system-prompt.md");
				await fs.writeFile(systemPrompt, getCurrentSystemPrompt(context.messages));
				let mcpConfig: string | undefined;
				if (tools.length > 0) {
					const toolsFile = path.join(dir, "tools.json");
					await fs.writeFile(toolsFile, JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) }))));
					mcpConfig = path.join(dir, "mcp.json");
					await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [MCP_STUB, toolsFile] } } }));
				}
				if (finished) return;
				const effort = options?.reasoning && EFFORTS.has(options.reasoning) ? options.reasoning : undefined;
				const input = `${JSON.stringify({ type: "user", message: { role: "user", content: renderTranscript(transformMessages(context.messages, model)) } })}\n`;

				/** One CLI run; resolves the failure detail when it ended without a response. */
				const attempt = async (thinkingDisplay: boolean): Promise<string | undefined> => {
					const proc = spawn("claude", claudeCodeArgs(model.id, effort, { systemPrompt, mcpConfig }, thinkingDisplay), { cwd: dir!, env: claudeCodeEnv() });
					child = proc;
					let stderr = "", resultError: string | undefined, spawnError: NodeJS.ErrnoException | undefined;
					const closed = new Promise<void>((resolve) => {
						proc.on("close", () => resolve());
						proc.on("error", (error) => { spawnError = error; resolve(); });
					});
					proc.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
					proc.stdin.on("error", () => {}); // EPIPE when the CLI exits early — reported via close
					proc.stdin.end(input);

					// Anthropic content-block index → this message's content index (-1 =
					// thinking not emitted yet; its signature waits in `signature`), plus
					// the tool call's JSON so far.
					const blocks = new Map<number, { index: number; json: string; signature: string }>();
					let rawStop: string | undefined;
					for await (const line of readline.createInterface({ input: proc.stdout })) {
						if (finished) break;
						let event: { type?: string; is_error?: boolean; result?: unknown; subtype?: string; event?: Record<string, any> };
						try { event = JSON.parse(line); } catch { continue; }
						if (event.type === "result" && event.is_error) resultError = typeof event.result === "string" ? event.result : event.subtype;
						if (event.type !== "stream_event" || !event.event) continue;
						const raw = event.event;
						void Promise.resolve(options?.onProviderStreamEvent?.(raw, model)).catch(() => {});
						if (raw.type === "message_start") {
							partial.responseId = raw.message?.id;
							partial.responseModel = raw.message?.model;
							applyUsage(partial, raw.message?.usage);
							start();
						} else if (raw.type === "content_block_start") {
							start();
							const block = raw.content_block ?? {};
							const index = partial.content.length;
							if (block.type === "thinking") {
								// Emitted lazily, on its first non-empty text (owner): a block that
								// never gets text (an "omitted" display) would render as an empty row.
								blocks.set(raw.index, { index: -1, json: "", signature: "" });
								continue;
							}
							if (block.type === "text") {
								partial.content.push({ type: "text", text: "" });
								output.push({ type: "text_start", contentIndex: index, partial });
							} else if (block.type === "tool_use") {
								const name = String(block.name ?? "");
								partial.content.push({ type: "toolCall", id: String(block.id), name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, arguments: {} });
								output.push({ type: "toolcall_start", contentIndex: index, partial });
							} else continue;
							blocks.set(raw.index, { index, json: "", signature: "" });
						} else if (raw.type === "content_block_delta") {
							const entry = blocks.get(raw.index);
							const delta = raw.delta ?? {};
							if (!entry) continue;
							if (delta.type === "thinking_delta" && delta.thinking && entry.index < 0) {
								entry.index = partial.content.length;
								partial.content.push({ type: "thinking", thinking: "", thinkingSignature: entry.signature });
								output.push({ type: "thinking_start", contentIndex: entry.index, partial });
							}
							const block = entry.index >= 0 ? partial.content[entry.index] : undefined;
							if (delta.type === "signature_delta") {
								if (block?.type === "thinking") block.thinkingSignature = `${block.thinkingSignature ?? ""}${delta.signature}`;
								else entry.signature += delta.signature;
							} else if (!block) {
								continue;
							} else if (delta.type === "text_delta" && block.type === "text") {
								block.text += delta.text;
								output.push({ type: "text_delta", contentIndex: entry.index, delta: delta.text, partial });
							} else if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking) {
								block.thinking += delta.thinking;
								output.push({ type: "thinking_delta", contentIndex: entry.index, delta: delta.thinking, partial });
							} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
								entry.json += delta.partial_json;
								block.arguments = parseStreamingJson<JsonObject>(entry.json);
								output.push({ type: "toolcall_delta", contentIndex: entry.index, delta: delta.partial_json, partial });
							}
						} else if (raw.type === "content_block_stop") {
							const entry = blocks.get(raw.index);
							// A thinking block that never received text was never emitted.
							const block = entry && entry.index >= 0 ? partial.content[entry.index] : undefined;
							if (!entry || !block) continue;
							if (block.type === "text") output.push({ type: "text_end", contentIndex: entry.index, content: block.text, partial });
							else if (block.type === "thinking") output.push({ type: "thinking_end", contentIndex: entry.index, content: block.thinking, partial });
							else {
								const parsed = parseToolCallArguments(entry.json);
								block.arguments = parsed.arguments;
								if (parsed.argumentsError) block.argumentsError = parsed.argumentsError;
								output.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: block, partial });
							}
						} else if (raw.type === "message_delta") {
							rawStop = raw.delta?.stop_reason ?? rawStop;
							applyUsage(partial, raw.usage);
						} else if (raw.type === "message_stop") {
							// Stop HERE: after a tool_use the CLI would refuse the call and
							// send a second request on the plan's quota.
							proc.kill("SIGTERM");
							const reason = stopReasonOf(rawStop);
							partial.rawStopReason = rawStop;
							if (reason === "error") fail("error", "Claude declined to respond (refusal).");
							else {
								finished = true;
								partial.stopReason = reason;
								output.push({ type: "done", reason, message: partial });
							}
						}
					}
					await closed;
					if (finished) return undefined;
					return spawnError?.code === "ENOENT" ? "the `claude` command was not found on PATH" : resultError ?? (stderr.trim() || "the CLI exited before responding");
				};

				let detail = await attempt(thinkingDisplaySupported);
				// An older (or newer) CLI without --thinking-display rejects it before
				// any output: remember that and retry this step once without it.
				if (detail !== undefined && !started && !finished && thinkingDisplaySupported && UNKNOWN_THINKING_DISPLAY.test(detail)) {
					thinkingDisplaySupported = false;
					detail = await attempt(false);
				}
				if (detail !== undefined) fail("error", `Claude Code CLI request failed: ${detail}`);
			} catch (error) {
				fail("error", `Claude Code CLI request failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
				if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
				if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
				output.end();
			}
		})();
		return output;
	};
}
