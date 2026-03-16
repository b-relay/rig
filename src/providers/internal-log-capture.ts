import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import {
  serializeStructuredServiceLogEntry,
  type StructuredServiceLogEntry,
} from "../schema/service-log.js"

type CaptureStream = "stdout" | "stderr"

type CaptureArgs = {
  readonly service: string
  readonly rawLogPath: string
  readonly structuredLogPath: string
  readonly command: string
}

const parseArgs = (argv: readonly string[]): CaptureArgs => {
  let service: string | undefined
  let rawLogPath: string | undefined
  let structuredLogPath: string | undefined
  let command: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case "--service":
        service = argv[index + 1]
        index += 1
        break
      case "--raw-log-path":
        rawLogPath = argv[index + 1]
        index += 1
        break
      case "--structured-log-path":
        structuredLogPath = argv[index + 1]
        index += 1
        break
      case "--command":
        command = argv[index + 1]
        index += 1
        break
      case "--help":
      case "-h":
        throw new Error(
          "Usage: rig _capture-logs --service <name> --raw-log-path <path> --structured-log-path <path> --command <shell-command>",
        )
      default:
        throw new Error(`Unknown internal flag '${arg}'.`)
    }
  }

  if (!service || !rawLogPath || !structuredLogPath || !command) {
    throw new Error(
      "Usage: rig _capture-logs --service <name> --raw-log-path <path> --structured-log-path <path> --command <shell-command>",
    )
  }

  return {
    service,
    rawLogPath,
    structuredLogPath,
    command,
  }
}

const writeChunk = (
  stream: WriteStream,
  content: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(content, "utf8", (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

const closeStream = (stream: WriteStream): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

const drainReadable = async (
  readable: ReadableStream<Uint8Array>,
  stream: CaptureStream,
  service: string,
  rawWriter: WriteStream,
  structuredWriter: WriteStream,
): Promise<void> => {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  const writeStructuredLine = async (message: string) => {
    const entry: StructuredServiceLogEntry = {
      timestamp: new Date().toISOString(),
      service,
      stream,
      message,
    }

    await writeChunk(structuredWriter, serializeStructuredServiceLogEntry(entry))
  }

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }

      const text = decoder.decode(result.value, { stream: true })
      if (text.length === 0) {
        continue
      }

      await writeChunk(rawWriter, text)

      const normalized = `${pending}${text.replace(/\r\n/g, "\n")}`
      const parts = normalized.split("\n")
      pending = parts.pop() ?? ""

      for (const part of parts) {
        await writeStructuredLine(part)
      }
    }

    const finalText = decoder.decode()
    if (finalText.length > 0) {
      await writeChunk(rawWriter, finalText)

      const normalized = `${pending}${finalText.replace(/\r\n/g, "\n")}`
      const parts = normalized.split("\n")
      pending = parts.pop() ?? ""

      for (const part of parts) {
        await writeStructuredLine(part)
      }
    }

    if (pending.length > 0) {
      await writeStructuredLine(pending)
    }
  } finally {
    reader.releaseLock()
  }
}

export const runInternalLogCapture = async (argv: readonly string[]): Promise<number> => {
  const args = parseArgs(argv)
  await mkdir(dirname(args.rawLogPath), { recursive: true })
  await mkdir(dirname(args.structuredLogPath), { recursive: true })

  const rawWriter = createWriteStream(args.rawLogPath, { flags: "a", encoding: "utf8" })
  const structuredWriter = createWriteStream(args.structuredLogPath, {
    flags: "a",
    encoding: "utf8",
  })

  try {
    const child = Bun.spawn(["sh", "-c", args.command], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    const drainTasks = [
      drainReadable(child.stdout, "stdout", args.service, rawWriter, structuredWriter),
      drainReadable(child.stderr, "stderr", args.service, rawWriter, structuredWriter),
    ]

    const exitCode = await child.exited
    await Promise.all(drainTasks)
    return exitCode
  } finally {
    await Promise.all([
      closeStream(rawWriter),
      closeStream(structuredWriter),
    ])
  }
}
