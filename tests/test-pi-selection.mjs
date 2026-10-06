/** Real pi RPC model-selection tests. Only the local mock API is contacted. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const project = resolve(
  process.env.COMMANDCODE_TEST_PACKAGE_DIR ?? fileURLToPath(new URL("..", import.meta.url)),
)
const defaultConfig = join(project, "commandcode-models.ini")
const ini = readFileSync(defaultConfig, "utf8")
const expectedIds = [...ini.matchAll(/^([^;#\s]+)\s*=\s*true\s*$/gm)]
  .map((match) => match[1])
  .sort()
assert.equal(expectedIds.length, 17)

function findPiCli() {
  if (process.env.PI_SELECTION_CLI) return resolve(process.env.PI_SELECTION_CLI)
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidates = [
      join(directory, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      join(directory, "../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    ]
    const executable = join(directory, "pi")
    if (existsSync(executable)) candidates.push(realpathSync(executable))
    for (const candidate of candidates) {
      if (
        existsSync(candidate) &&
        (candidate.endsWith(".js") ||
          /^#!.*\bnode\b/.test(readFileSync(candidate, "utf8").split("\n")[0]))
      )
        return candidate
    }
  }
  return undefined
}

const cli = findPiCli()
if (!cli) {
  if (process.env.PI_LOCAL_REQUIRED === "1")
    throw new Error("pi CLI required; set PI_SELECTION_CLI to its JavaScript entrypoint")
  console.log(
    "[pi-selection] SKIP: pi not installed; set PI_SELECTION_CLI to its JavaScript entrypoint",
  )
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-pi-selection-")))
assert.equal(dirname(root), realpathSync(tmpdir()))
const configPath = join(root, "selection.ini")
writeFileSync(configPath, ini)
let servedIds = [...expectedIds]
let offline = false
let inferenceRequests = 0
let catalogRequests = 0
const server = createServer((request, response) => {
  if (request.url !== "/provider/v1/models") {
    inferenceRequests++
    response.writeHead(500).end("No inference is allowed in model-selection tests")
    return
  }
  catalogRequests++
  if (offline) {
    response.writeHead(503).end("offline")
    return
  }
  response.setHeader("content-type", "application/json")
  response.end(
    JSON.stringify({
      object: "list",
      data: [
        ...servedIds.map((id) => ({
          id,
          name: id,
          context_length: 1_000_000,
          supported_endpoints: ["/chat/completions"],
        })),
        { id: "disabled-malformed-model", name: null, context_length: -1 },
      ],
    }),
  )
})
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
const apiBase = `http://127.0.0.1:${server.address().port}/provider/v1`

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(10)
  }
}

function startRpc(override) {
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_SKIP_VERSION_CHECK: "1",
    COMMAND_CODE_API_KEY: "mock-key",
    COMMANDCODE_API_BASE: apiBase,
    COMMANDCODE_MODELS_URL: `${apiBase}/models`,
    COMMANDCODE_MODELS_CACHE: join(root, "catalog.json"),
  }
  delete env.COMMANDCODE_MODELS_CONFIG
  if (override) env.COMMANDCODE_MODELS_CONFIG = configPath
  const child = spawn(
    process.execPath,
    [
      cli,
      "--no-extensions",
      "-e",
      join(project, "index.ts"),
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "commandcode",
      "--model",
      "gpt-5.6-sol",
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  )
  const events = []
  let buffer = ""
  let stderr = ""
  let sequence = 0
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      try {
        events.push(JSON.parse(line))
      } catch {
        /* ignore non-RPC startup text */
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const closed = new Promise((resolveClose) => child.once("close", resolveClose))
  return {
    events,
    async call(command) {
      const id = `selection-${++sequence}`
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
      await until(
        () =>
          child.exitCode !== null ||
          events.some((event) => event.type === "response" && event.id === id),
        `RPC ${command.type}: ${stderr}`,
      )
      const result = events.find((event) => event.type === "response" && event.id === id)
      assert.ok(result?.success, JSON.stringify(result) + " " + stderr)
      return result.data
    },
    async stop() {
      child.kill()
      await closed
    },
  }
}

const notifications = (rpc) =>
  rpc.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
async function modelIds(rpc) {
  const data = await rpc.call({ type: "get_available_models" })
  return data.models
    .filter((model) => model.provider === "commandcode")
    .map((model) => model.id)
    .sort()
}
async function refresh(rpc) {
  const start = rpc.events.length
  await rpc.call({ type: "prompt", message: "/commandcode-refresh" })
  await until(
    () =>
      rpc.events
        .slice(start)
        .some((event) =>
          /Command Code model catalog (refreshed|unchanged)/.test(event.message ?? ""),
        ),
    "refresh notification",
  )
}
function select(ids) {
  writeFileSync(configPath, `[models]\n${ids.map((id) => `${id} = true`).join("\n")}\n`)
}

let rpc
try {
  rpc = startRpc(false)
  assert.deepEqual(await modelIds(rpc), expectedIds)
  await rpc.call({ type: "prompt", message: "/commandcode-status" })
  await until(
    () =>
      notifications(rpc).some((event) => event.message.includes(`config path: ${defaultConfig}`)),
    "default INI path",
  )
  await rpc.stop()
  rpc = startRpc(true)
  assert.deepEqual(await modelIds(rpc), expectedIds)
  const first = "gpt-5.6-sol"
  const second = "google/gemini-3.8-flash"
  select([first, second])
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [second, first].sort())
  offline = true
  select([second])
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [second])
  offline = false
  select([first, second])
  servedIds = [first]
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [first])
  const missingWarnings = () =>
    notifications(rpc).filter(
      (event) =>
        event.message.includes("latest successful Provider API catalog") &&
        event.message.includes(second),
    )
  assert.equal(missingWarnings().length, 1)
  await refresh(rpc)
  assert.equal(missingWarnings().length, 1)
  offline = true
  await refresh(rpc)
  assert.equal(missingWarnings().length, 1)
  offline = false
  await refresh(rpc)
  assert.equal(missingWarnings().length, 1)
  servedIds = [first, second]
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [second, first].sort())
  servedIds = []
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [])
  offline = true
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [])
  select([])
  const requestsBeforeEmpty = catalogRequests
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [])
  assert.equal(catalogRequests, requestsBeforeEmpty)
  offline = false
  servedIds = [first]
  select([first])
  await refresh(rpc)
  writeFileSync(configPath, "[models]\ngpt-5.6-sol = invalid\n")
  await refresh(rpc)
  assert.deepEqual(await modelIds(rpc), [first])
  assert.ok(notifications(rpc).some((event) => event.message.includes("selection.ini:2:")))
  assert.equal(inferenceRequests, 0)
  assert.equal(readFileSync(defaultConfig, "utf8"), ini, "plugin INI remains unchanged")
  console.log(
    "[pi-selection] PASS: 17 defaults, INI reload, offline disable, removal/recovery, warning deduplication, empty list, invalid config, and package-relative path; no inference requests",
  )
} finally {
  if (rpc) await rpc.stop()
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
