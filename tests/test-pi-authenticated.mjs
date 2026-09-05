import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const launcher = join(repoRoot, "scripts", "pi-authenticated.mjs")

function runLauncher() {
  const fakeBin = mkdtempSync(join(tmpdir(), "pi-commandcode-fake-bin-"))
  const logPath = join(fakeBin, "call.json")
  const fakePi = join(fakeBin, process.platform === "win32" ? "pi.cmd" : "pi")
  const fakePiEntrypoint = join(
    fakeBin,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  )
  const fakePiSource = `import { writeFileSync } from "node:fs"
writeFileSync(process.env.FAKE_PI_LOG, JSON.stringify({
  args: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
  apiKey: process.env.COMMAND_CODE_API_KEY ?? process.env.COMMANDCODE_API_KEY ?? null,
  skipVersionCheck: process.env.PI_SKIP_VERSION_CHECK,
}))
`
  mkdirSync(join(fakeBin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), {
    recursive: true,
  })
  writeFileSync(fakePiEntrypoint, fakePiSource)
  if (process.platform === "win32") {
    writeFileSync(fakePi, "@echo off\r\nexit /b 0\r\n")
  } else {
    writeFileSync(fakePi, `#!/bin/sh\nexec "${process.execPath}" "${fakePiEntrypoint}" "$@"\n`, {
      mode: 0o700,
    })
  }

  try {
    const result = spawnSync(process.execPath, [launcher, "--thinking", "high"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        FAKE_PI_LOG: logPath,
        PI_CODING_AGENT_DIR: "/existing/pi-agent",
        COMMAND_CODE_API_KEY: "official-existing-key",
        COMMANDCODE_API_KEY: "legacy-existing-key",
      },
      encoding: "utf8",
    })
    return { result, call: JSON.parse(readFileSync(logPath, "utf8")) }
  } finally {
    rmSync(fakeBin, { recursive: true, force: true })
  }
}

describe("authenticated pi launcher", () => {
  it("loads only the checkout extension and leaves auth resolution to existing files", () => {
    const { result, call } = runLauncher()

    assert.equal(result.status, 0)
    assert.deepEqual(call.args, [
      "--no-extensions",
      "--extension",
      join(repoRoot, "index.ts"),
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.6-luna",
      "--models",
      "commandcode/*",
      "--thinking",
      "high",
    ])
    assert.equal(call.agentDir, "/existing/pi-agent")
    assert.equal(call.apiKey, null)
    assert.equal(call.skipVersionCheck, "1")
  })
})
