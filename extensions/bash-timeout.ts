/**
 * bash-timeout: a bash call that names no timeout gets one.
 *
 * pi's bash tool has no default timeout, and Archon pauses a node's idle timeout while any
 * tool call is open on purpose, so long test suites survive. Together, one command that
 * never returns holds a Run forever. This extension gives such a call the default,
 * PI_BASH_TIMEOUT_SECONDS when that names a positive number and 1800 seconds otherwise.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 1800;

/** The timeout a bash call that names none is given. */
const defaultTimeoutSeconds = (): number => {
	const configured = Number(process.env.PI_BASH_TIMEOUT_SECONDS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_SECONDS;
};

export default function bashTimeout(pi: ExtensionAPI): void {
	const timeout = defaultTimeoutSeconds();
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		if (event.input.timeout !== undefined) return;
		event.input.timeout = timeout;
	});
}
