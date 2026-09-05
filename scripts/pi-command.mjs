import { accessSync, constants } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"

const PI_ENTRYPOINT_RELATIVE_PATH = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
]

function isReadableFile(path) {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function pathCandidates() {
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"]
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => resolve(directory, name)))
}

function directCommandForWindowsCandidate(candidate) {
  if (candidate.toLowerCase().endsWith(".exe")) {
    return { command: candidate, prefixArgs: [] }
  }

  if (candidate.toLowerCase().endsWith(".cmd")) {
    const entrypoint = join(dirname(candidate), ...PI_ENTRYPOINT_RELATIVE_PATH)
    if (isReadableFile(entrypoint)) {
      return { command: process.execPath, prefixArgs: [entrypoint] }
    }
  }

  return undefined
}

export function commandForPi() {
  if (process.platform !== "win32") return { command: "pi", prefixArgs: [] }

  for (const candidate of pathCandidates()) {
    const command = directCommandForWindowsCandidate(candidate)
    if (command) return command
  }

  throw new Error(
    "Could not find a directly executable pi installation on Windows. Expected the npm pi.cmd wrapper and its bundled cli.js.",
  )
}

export function spawnPi(spawn, args, options) {
  const { command, prefixArgs } = commandForPi()
  return spawn(command, [...prefixArgs, ...args], options)
}
