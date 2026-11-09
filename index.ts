/* eslint-disable no-control-regex */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'

const DEFAULT_COMMAND_TIMEOUT = 10_000

export class SSHClient {
  private client?: Client
  private shell?: ClientChannel
  private readonly cliAuth?: CliAuth
  private connecting?: Promise<void>

  // All commands are executed sequentially.
  private commandQueue: Promise<unknown> = Promise.resolve()

  private readonly config: ConnectConfig

  private readonly promptPatterns: RegExp[]

  private readonly defaultCommandTimeout: number

  /**
   * Creates an SSH client configured to connect and recognize CLI prompts.
   *
   * @param params Connection settings, prompt patterns, optional CLI credentials,
   * and the default command timeout.
   */
  constructor(params: SSHClientOptions) {
    this.config = params.config
    this.promptPatterns = params.promptPatterns
    this.cliAuth = params.cliAuth
    this.defaultCommandTimeout = params.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT
  }

  /**
   * Connects to the SSH server, opens an interactive shell, and completes any
   * configured CLI authentication. If a connection is already open, this does
   * nothing; concurrent calls share the in-progress connection.
   *
   * @throws {SSHError} If the connection, shell setup, or CLI authentication fails.
   */
  async connect(): Promise<void> {
    if (this.isConnected()) {
      return
    }

    if (this.connecting) {
      return this.connecting
    }

    const connection = new Promise<void>((resolve, reject) => {
      const client = new Client()

      let settled = false
      let shell: ClientChannel | undefined

      const fail = (error: Error) => {
        if (settled) {
          return
        }

        settled = true

        shell?.close()
        client.end()

        this.resetConnection()

        reject(error)
      }

      client.once('ready', () => {
        client.shell((error, shell) => {
          if (error) {
            fail(error)
            return
          }

          this.client = client
          this.shell = shell

          this.attachShellListeners(shell)

          this.authenticateCli()
            .then(() => {
              settled = true
              resolve()
            })
            .catch(fail)
        })
      })

      client.once('error', (error) => {
        this.resetConnection()
        fail(error)
      })

      client.once('close', () => {
        this.resetConnection()
      })

      client.connect(this.config)
    })

    this.connecting = connection

    try {
      await connection
    } finally {
      if (this.connecting === connection) {
        this.connecting = undefined
      }
    }
  }

  /**
   * Executes a command in the interactive shell and returns its output without
   * the echoed command. Commands are queued and run sequentially.
   *
   * @param command Command text to send to the shell.
   * @param options Optional command timeout and newline behavior.
   * @returns The command output with the echoed command removed.
   * @throws {SSHError} If the command fails or its response times out.
   */
  async execute(command: string, options: SSHCommandOptions = {}): Promise<string> {
    try {
      await this.connect()

      const operation = this.commandQueue.then(async () => {
        return this.executeInternal(command, options)
      })

      // Prevent a failed command from permanently blocking the queue.
      this.commandQueue = operation.catch(() => undefined)

      return operation
    } catch (error) {
      handleError(error)
    }
  }

  /**
   * Sends text to the interactive shell without waiting for a prompt or reading
   * its output. A newline is appended to the value.
   *
   * @param value Text to send to the shell.
   * @throws {SSHError} If the shell is unavailable or the write fails.
   */
  async rawExecute(value: string): Promise<void> {
    try {
      await this.connect()

      if (!this.shell) {
        throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
      }

      this.shell.write(`${value}\n`)
    } catch (error) {
      handleError(error)
    }
  }

  /**
   * Waits until the shell output's last line matches the specified pattern.
   *
   * @param pattern Pattern that identifies the expected shell output.
   * @param timeout Maximum time to wait, in milliseconds.
   * @returns The normalized output received before the pattern matched.
   * @throws {SSHError} If the shell is unavailable or the timeout expires.
   */
  async waitFor(pattern: RegExp, timeout = this.defaultCommandTimeout): Promise<string> {
    try {
      await this.connect()

      if (!this.shell) {
        throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
      }

      return new Promise((resolve, reject) => {
        let output = ''

        const timeoutId = setTimeout(() => {
          cleanup()

          reject(new SSHError(SSH_ERRORS.TIMEOUT_ERROR, { timeout, output, pattern }))
        }, timeout)

        const onData = (data: Buffer) => {
          output += data.toString('utf8')

          if (this.hasPrompt(output, pattern)) {
            cleanup()
            resolve(normalizeTerminalOutput(output))
          }
        }

        const cleanup = () => {
          clearTimeout(timeoutId)

          this.shell?.removeListener('data', onData)
        }

        this.shell?.on('data', onData)
      })
    } catch (error) {
      handleError(error)
    }
  }

  /**
   * Sends a command and waits for the shell output's last line to match one of
   * the specified patterns.
   *
   * @param command Command text to send to the shell.
   * @param pattern Patterns that identify the expected output.
   * @param timeout Maximum time to wait, in milliseconds.
   * @returns The normalized output received before a pattern matched.
   * @throws {SSHError} If the shell is unavailable or the timeout expires.
   */
  async executeAfter(command: string, pattern: RegExp[], timeout = this.defaultCommandTimeout): Promise<string> {
    try {
      await this.connect()

      if (!this.shell) {
        throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
      }

      const outputPromise = this.waitForPrompt(timeout, pattern)

      this.shell.write(`${command}\n`)

      return await outputPromise
    } catch (error) {
      handleError(error)
    }
  }

  /**
   * Closes the interactive shell and SSH connection, if open.
   *
   * @throws {SSHError} If closing the connection fails.
   */
  disconnect(): void {
    try {
      this.shell?.close()
      this.client?.end()

      this.resetConnection()
    } catch (error) {
      handleError(error)
    }
  }

  // Indicates whether the interactive SSH shell is ready.
  private isConnected(): boolean {
    return Boolean(this.client && this.shell)
  }

  private async authenticateCli(): Promise<void> {
    if (!this.shell) {
      throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
    }

    if (!this.cliAuth) {
      await this.waitForPrompt()

      return
    }

    const loginPatterns = this.cliAuth.loginPatterns ?? [/^login:\s*$/i, /^username:\s*$/i]
    const passwordPatterns = this.cliAuth.passwordPatterns ?? [/^password:\s*$/i]

    const initialOutput = await this.waitForPrompt(this.defaultCommandTimeout, [
      ...loginPatterns,
      ...passwordPatterns,
      ...this.promptPatterns,
    ])

    // The device did not require an additional CLI login.
    if (this.matchesAny(initialOutput, this.promptPatterns)) {
      return
    }

    // Device is asking for username.
    if (this.matchesAny(initialOutput, loginPatterns)) {
      this.shell.write(`${this.cliAuth.username ?? this.config.username}\n`)

      const passwordOutput = await this.waitForPrompt(this.defaultCommandTimeout, [
        ...passwordPatterns,
        ...this.promptPatterns,
      ])

      // Already authenticated after username.
      if (this.matchesAny(passwordOutput, this.promptPatterns)) {
        return
      }

      if (!this.matchesAny(passwordOutput, passwordPatterns)) {
        throw new SSHError(SSH_ERRORS.CLI_AUTHENTICATION_FAILED)
      }

      this.shell.write(`${this.cliAuth.password}\n`)

      await this.waitForPrompt()

      return
    }

    // Device directly asks for password.
    if (this.matchesAny(initialOutput, passwordPatterns)) {
      this.shell.write(`${this.cliAuth.password}\n`)

      await this.waitForPrompt()

      return
    }

    throw new SSHError(SSH_ERRORS.CLI_AUTHENTICATION_FAILED)
  }

  private async executeInternal(command: string, options: SSHCommandOptions): Promise<string> {
    try {
      return await this.executeOnce(command, options)
    } catch (error) {
      this.resetConnection()

      return this.executeOnce(command, options)
    }
  }

  private async executeOnce(command: string, options: SSHCommandOptions): Promise<string> {
    const timeout = options.timeout ?? this.defaultCommandTimeout
    const newline = options.newline ?? true

    if (!this.shell) {
      throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
    }

    const outputPromise = this.waitForPrompt(timeout)

    this.shell.write(newline ? `${command}\n` : command)

    const output = await outputPromise

    return this.removeCommandFromOutput(command, output)
  }

  private async waitForPrompt(timeout = this.defaultCommandTimeout, patterns?: RegExp[]): Promise<string> {
    if (!this.shell) {
      throw new SSHError(SSH_ERRORS.SHELL_NOT_AVAILABLE)
    }

    return new Promise((resolve, reject) => {
      let output = ''

      const timeoutId = setTimeout(() => {
        cleanup()

        reject(new SSHError(SSH_ERRORS.TIMEOUT_ERROR, { timeout, output, patterns }))
      }, timeout)

      const onData = (data: Buffer) => {
        output += data.toString('utf8')

        if (this.hasPrompt(output) || (patterns?.some((pattern) => this.hasPrompt(output, pattern)) ?? false)) {
          cleanup()

          resolve(normalizeTerminalOutput(output))
        }
      }

      const cleanup = () => {
        clearTimeout(timeoutId)

        this.shell?.removeListener('data', onData)
      }

      this.shell?.on('data', onData)
    })
  }

  private matchesAny(output: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => this.hasPrompt(output, pattern))
  }

  private hasPrompt(output: string, pattern?: RegExp): boolean {
    const normalized = normalizeTerminalOutput(output)

    const lastLine = normalized.split('\n').at(-1)?.trim()

    if (!lastLine) {
      return false
    }

    if (pattern) {
      pattern.lastIndex = 0

      return pattern.test(lastLine)
    }

    return this.promptPatterns.some((pattern) => {
      pattern.lastIndex = 0

      return pattern.test(lastLine)
    })
  }

  private removeCommandFromOutput(command: string, output: string): string {
    const lines = output.split(/\r?\n/)

    const commandIndex = lines.findIndex((line) => {
      return line.trim() === command.trim()
    })

    if (commandIndex === -1) {
      return output.trim()
    }

    return lines
      .slice(commandIndex + 1)
      .join('\n')
      .trim()
  }

  private attachShellListeners(shell: ClientChannel): void {
    shell.on('close', () => {
      this.resetConnection()
    })

    shell.on('error', () => {
      this.resetConnection()
    })
  }

  private resetConnection(): void {
    this.client = undefined
    this.shell = undefined
  }
}

export class SSHError extends Error {
  metadata?: unknown

  constructor(message: SSHErrorCode, metadata?: unknown, cause?: unknown) {
    super(message)
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = 'SSHError'
    this.metadata = metadata
    this.cause = cause
  }
}

export const SSH_ERRORS = {
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  SHELL_NOT_AVAILABLE: 'SHELL_NOT_AVAILABLE',
  CLI_AUTHENTICATION_FAILED: 'CLI_AUTHENTICATION_FAILED',
} as const

export type SSHErrorCode = (typeof SSH_ERRORS)[keyof typeof SSH_ERRORS]

// Util function to handle all errors.
function handleError(error: unknown): never {
  if (error instanceof SSHError) {
    throw error
  }

  throw new SSHError(SSH_ERRORS.UNKNOWN_ERROR, undefined, error)
}

// Util function to normalize outputs removing ANSI escape sequences.
function normalizeTerminalOutput(value: string): string {
  return value
    .replace(/\x1B\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
}

export interface CliAuth {
  /** Username used when the device requests CLI authentication. */
  username: string
  /** Password used when the device requests CLI authentication. */
  password: string
  /** Patterns matching username prompts; defaults to `login:` and `username:`. */
  loginPatterns?: RegExp[]
  /** Patterns matching password prompts; defaults to `password:`. */
  passwordPatterns?: RegExp[]
}

/** Options for creating an SSHClient instance. */
export interface SSHClientOptions {
  /** SSH transport configuration, as accepted by ssh2. */
  config: ConnectConfig
  /** Patterns matching the ready prompt of the interactive CLI. */
  promptPatterns: RegExp[]
  /** Optional credentials for an additional login prompt inside the shell. */
  cliAuth?: CliAuth
  /** Default command and prompt wait timeout in milliseconds. Defaults to 10000. */
  commandTimeout?: number
}

export interface SSHCommandOptions {
  /**
   * Maximum time to wait for the command response.
   *
   * @default 10000
   */
  timeout?: number

  /**
   * If true, the command is sent with a newline.
   *
   * @default true
   */
  newline?: boolean
}
