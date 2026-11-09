# @francolloveras/shh-client

A TypeScript SSH client for running commands in interactive SSH shells, including
devices that display a CLI login prompt after the SSH connection is established.

## Requirements

- Node.js 18 or later
- An SSH server that provides an interactive shell

## Installation

```sh
npm install @francolloveras/shh-client
```

## Usage

```ts
import { SSHClient } from '@francolloveras/shh-client'

const ssh = new SSHClient({
  config: {
    host: '192.0.2.10',
    port: 22,
    username: process.env.SSH_USERNAME!,
    password: process.env.SSH_PASSWORD!,
  },
  // Match the final line displayed by the remote CLI when it is ready.
  promptPatterns: [/[\w.-]+[>#]\s*$/],
  commandTimeout: 10_000,
})

try {
  await ssh.connect()
  const output = await ssh.execute('show version')
  console.log(output)
} finally {
  ssh.disconnect()
}
```

The SSH connection options use the `ssh2` `ConnectConfig` format. For servers
that ask for a separate username or password inside the interactive shell, pass
`cliAuth` with the credentials and, if needed, custom `loginPatterns` and
`passwordPatterns`.

Commands sent with `execute` are queued and run sequentially. Use its optional
second argument to set a per-command `timeout` or disable the appended newline.
`rawExecute` sends input without waiting for a prompt, while `waitFor` and
`executeAfter` wait for output matching specified prompt patterns.

## API

### `new SSHClient(options)`

Creates a client. The constructor does not connect; `connect()` or another
method that needs the shell opens the connection.

`SSHClientOptions` fields:

- `config` (`ssh2` `ConnectConfig`, required) — SSH connection details, such as
  host, port, username, and a password, private key, or other supported
  authentication method. See the [`ssh2` connection configuration
  documentation](https://github.com/mscdex/ssh2#client-methods).
- `promptPatterns` (`RegExp[]`, required) — expressions that identify the
  interactive CLI's ready prompt. The pattern is tested against the trimmed
  final line of output.
- `cliAuth` (`CliAuth`, optional) — credentials for a second login prompt
  displayed inside the shell after SSH authentication.
- `commandTimeout` (`number`, optional) — default timeout in milliseconds for
  command and prompt waits. Defaults to `10000`.

### Methods

#### `connect(): Promise<void>`

Connects to the SSH server, opens an interactive shell, and waits until the CLI
is ready. Performs `cliAuth` if the device requests it. Calling it while already
connected is a no-op; concurrent connection attempts share the same operation.

#### `execute(command: string, options?: SSHCommandOptions): Promise<string>`

Sends a command and waits for the configured ready prompt. Calls to `execute`
are queued and run one at a time. Resolves with normalized output with the
echoed command removed.

`SSHCommandOptions`:

- `timeout` (`number`) — maximum wait in milliseconds; defaults to the
  constructor's `commandTimeout` (or `10000`).
- `newline` (`boolean`) — append a newline to the command; defaults to `true`.

#### `rawExecute(value: string): Promise<void>`

Writes `value` followed by a newline without waiting for a prompt or returning
the shell output. Use this for interactive input when you intend to wait or read
the response separately.

#### `waitFor(pattern: RegExp, timeout?: number): Promise<string>`

Waits for new shell output whose final line matches `pattern`. Resolves with
the normalized output received during the wait. `timeout` is in milliseconds
and defaults to `commandTimeout` (or `10000`).

#### `executeAfter(command: string, patterns: RegExp[], timeout?: number): Promise<string>`

Writes `command` followed by a newline and waits until the final output line
matches any pattern in `patterns` or the configured ready prompt. Resolves with
the normalized output received during the wait. Unlike `execute`, this method
does not remove the echoed command. `timeout` is in milliseconds and defaults
to `commandTimeout` (or `10000`).

#### `disconnect(): void`

Closes the shell and SSH connection if open. Call this when finished, including
in a `finally` block to make sure connections are closed if command execution
fails.

### CLI authentication

`CliAuth` configures a login prompt handled inside the interactive shell:

- `username` and `password` — credentials to send when requested.
- `loginPatterns` (`RegExp[]`, optional) — patterns for username prompts.
  Defaults to `/^login:\s*$/i` and `/^username:\s*$/i`.
- `passwordPatterns` (`RegExp[]`, optional) — patterns for password prompts.
  Defaults to `/^password:\s*$/i`.

If `loginPatterns` matches, the username is sent first; if a password prompt
then appears, the password is sent. Devices that ask directly for a password
are also supported. The `username` may be omitted at runtime to fall back to
`config.username`, though it is required by the `CliAuth` TypeScript interface.

### Errors

Operations that fail reject with `SSHError`, which extends `Error`. Its
`message` is an `SSHErrorCode`, `metadata` may contain additional failure
details (such as timeout output and the expected pattern), and `cause` retains
the underlying error when available.

`SSH_ERRORS` provides the supported codes:

- `UNKNOWN_ERROR` — an unexpected error.
- `TIMEOUT_ERROR` — the expected prompt did not arrive before the timeout.
- `SHELL_NOT_AVAILABLE` — no interactive shell is available.
- `CLI_AUTHENTICATION_FAILED` — the CLI login exchange did not match the
  configured prompt patterns.

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
