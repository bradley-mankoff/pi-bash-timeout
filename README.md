# pi-bash-timeout

A bash call that names no timeout gets one, so a command that never returns cannot hold a session forever.

pi's bash tool has no default timeout: its `timeout` parameter is optional, and a call that leaves it out runs until the command ends. Archon pauses a node's idle timeout while any tool call is open, on purpose, so long test suites survive. Together, one command that never returns holds a Run forever: on 2026-11-15 Factory research Run f7880f17 started an interactive pi under `pty.fork` with no timeout and hung 18 hours until it was cancelled.

This package gives every such call a timeout of 1800 seconds (30 minutes). `PI_BASH_TIMEOUT_SECONDS` replaces that default when it names a positive number; set it before starting pi:

```sh
PI_BASH_TIMEOUT_SECONDS=60 pi
```

A call that names its own timeout is left exactly as it is. A call that runs past its timeout ends with pi's own result, `Command timed out after N seconds`. Nothing else changes: no other tool is touched, no call is blocked, and no output is rewritten.

Install: `pi install git:github.com/bradley-mankoff/pi-bash-timeout`
