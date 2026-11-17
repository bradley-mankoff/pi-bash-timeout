/**
 * A bash call that names no timeout gets the package's default, so a command that never
 * returns cannot hold a session forever. These tests drive the extension's seam: pi in RPC
 * mode with the Bash timeout extension, a temp agent directory, and a scripted test
 * provider whose agent calls the real built-in bash tool. `PI_BASH_TIMEOUT_SECONDS` is a
 * few seconds so a timeout test finishes quickly.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bashTimeoutExtension = path.join(repoRoot, "extensions", "bash-timeout.ts");
const testProvider = path.join(repoRoot, "tests", "fixtures", "bash-timeout-test-provider.ts");

type Step = { text: string } | { tool: string; arguments: Record<string, unknown> };
type ProtocolRecord = { type: string; [key: string]: unknown };
type Message = Record<string, unknown>;

/** What the scripted agent does on each model request. */
const bashCall = (arguments_: Record<string, unknown>): Step => ({ tool: "bash", arguments: arguments_ });

/** A pi session in RPC mode, whose agent runs `script` one step per model request. */
function startPi(options: { defaultSeconds: number; script: Step[] }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-timeout-"));
	const home = path.join(dir, "home");
	const agentDir = path.join(dir, "pi-agent");
	const scriptPath = path.join(dir, "script.json");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(scriptPath, JSON.stringify(options.script));

	const child: ChildProcess = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"-ns",
			"-ne",
			"-e",
			bashTimeoutExtension,
			"-e",
			testProvider,
			"--model",
			"bash-timeout-test/reply",
		],
		{
			cwd: dir,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_SKIP_VERSION_CHECK: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_BASH_TIMEOUT_SECONDS: String(options.defaultSeconds),
				BASH_TIMEOUT_TEST_SCRIPT: scriptPath,
			},
		},
	);

	const events: ProtocolRecord[] = [];
	const waiters = new Set<() => void>();
	const pending = new Map<string, (response: ProtocolRecord) => void>();
	let buffer = "";
	let stderr = "";
	let nextId = 0;

	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			const record = JSON.parse(line) as ProtocolRecord;
			const id = typeof record.id === "string" ? record.id : undefined;
			if (record.type === "response" && id && pending.has(id)) {
				const resolve = pending.get(id)!;
				pending.delete(id);
				resolve(record);
				continue;
			}
			events.push(record);
			for (const wake of [...waiters]) wake();
		}
	});
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const request = (command: Record<string, unknown>): Promise<ProtocolRecord> => {
		const id = `req-${++nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`pi did not answer ${String(command.type)}\n${stderr}\n${JSON.stringify(events)}`));
			}, 15000);
			pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	};

	/** Wait for an event matching `pick`, looking only at events after index `after`. */
	const waitFor = <T>(pick: (event: ProtocolRecord) => T | undefined, what: string, after: number): Promise<T> => {
		const check = () => {
			for (const event of events.slice(after)) {
				const value = pick(event);
				if (value !== undefined) return value;
			}
			return undefined;
		};
		const found = check();
		if (found !== undefined) return Promise.resolve(found);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`timed out waiting for ${what}\n${stderr}\n${JSON.stringify(events.slice(after))}`));
			}, 15000);
			const wake = () => {
				const value = check();
				if (value === undefined) return;
				cleanup();
				resolve(value);
			};
			const cleanup = () => {
				clearTimeout(timer);
				waiters.delete(wake);
			};
			waiters.add(wake);
		});
	};

	/** Wait for the turn that begins after event index `after` to end. */
	const waitForSettled = (after: number): Promise<ProtocolRecord> =>
		waitFor((event) => (event.type === "agent_settled" ? event : undefined), "the turn to end", after);

	/** The conversation pi holds. */
	const messages = async (): Promise<Message[]> => {
		const { data } = await request({ type: "get_messages" });
		return (data as { messages: Message[] }).messages;
	};

	const stop = async (): Promise<void> => {
		child.stdin!.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		fs.rmSync(dir, { recursive: true, force: true });
	};

	return { events, request, waitForSettled, messages, stop };
}

/** The one bash tool result in `messages`. */
function bashResult(messages: Message[]): Message {
	const results = messages.filter((message) => message.role === "toolResult" && message.toolName === "bash");
	assert.equal(results.length, 1, "the agent's one bash call has a result");
	return results[0];
}

/** The text a message carries. */
const textOf = (message: Message): string => {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};

test("a bash call that names no timeout ends with pi's timeout at PI_BASH_TIMEOUT_SECONDS", async () => {
	const pi = startPi({
		defaultSeconds: 2,
		script: [bashCall({ command: "sleep 10" }), { text: "done" }],
	});
	try {
		await pi.request({ type: "get_state" });
		const after = pi.events.length;
		await pi.request({ type: "prompt", message: "run the command" });
		await pi.waitForSettled(after);

		assert.equal(textOf(bashResult(await pi.messages())), "Command timed out after 2 seconds");
	} finally {
		await pi.stop();
	}
});

test("a bash call that names its own timeout keeps it", async () => {
	const pi = startPi({
		defaultSeconds: 2,
		script: [bashCall({ command: "sleep 3 && echo kept-its-timeout", timeout: 5 }), { text: "done" }],
	});
	try {
		await pi.request({ type: "get_state" });
		const after = pi.events.length;
		await pi.request({ type: "prompt", message: "run the command" });
		await pi.waitForSettled(after);

		const result = textOf(bashResult(await pi.messages()));
		assert.match(result, /kept-its-timeout/, `the call ran to the end of its own 5 seconds: ${JSON.stringify(result)}`);
	} finally {
		await pi.stop();
	}
});
