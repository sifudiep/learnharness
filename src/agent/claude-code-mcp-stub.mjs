// The Claude Code CLI provider's tool advertiser (dev-only; see
// src/agent/claude-code-cli.ts). A stdio MCP server that ONLY lists
// LearnHarness's tool schemas so `claude -p` can emit real tool_use blocks.
// It never runs a tool: the CLI's permission check refuses the call (the
// tools are not allow-listed) and claude-code-stream.ts stops the process at
// message_stop, handing the call back to pi's loop. argv[2] is a JSON file
// holding [{ name, description, inputSchema }].
import fs from "node:fs";
import readline from "node:readline";

const tools = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.id === undefined) return; // notifications need no reply
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "learnharness", version: "0" } } });
	} else if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
	} else if (message.method === "tools/call") {
		send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "LearnHarness runs its tools itself." }] } });
	} else {
		send({ jsonrpc: "2.0", id: message.id, result: {} });
	}
});
