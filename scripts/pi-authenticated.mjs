#!/usr/bin/env node

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { spawnPi } from "./pi-command.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = resolve(repoRoot, "index.ts")

const env = {
  ...process.env,
  PI_SKIP_VERSION_CHECK: "1",
}
delete env.COMMAND_CODE_API_KEY
delete env.COMMANDCODE_API_KEY

let child
try {
  child = spawnPi(
    spawn,
    [
      "--no-extensions",
      "--extension",
      extensionPath,
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.6-luna",
      "--models",
      "commandcode/*",
      ...process.argv.slice(2),
    ],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  )
} catch (error) {
  console.error(`Could not start pi: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

if (!child) {
  process.exit(1)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}

child.once("error", (error) => {
  console.error(`Could not start pi: ${error.message}`)
  process.exitCode = 1
})

child.once("exit", (status, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exitCode = status ?? 1
})
