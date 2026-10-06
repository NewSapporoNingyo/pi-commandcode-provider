import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  getCommandCodeModelsConfigPath,
  loadModelSelection,
  parseModelSelection,
} from "../src/model-selection.ts"
import {
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
} from "../src/models.ts"

export const DEFAULT_ENABLED_IDS = [
  "gpt-5.6-sol",
  "zai-org/GLM-5.2",
  "tencent/hy3-paid",
  "Qwen/Qwen3.8-27B",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-fast",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K3",
  "z-ai/glm-5.3-flash",
  "meituan/LongCat-2.0",
  "MiniMaxAI/MiniMax-M3",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-sante:free",
  "inclusionai/ling-3.1-flash:free",
].sort()

describe("model selection INI", () => {
  it("preserves exact IDs and accepts Windows UTF-8 files and whole-line comments", () => {
    const contents =
      "\uFEFF; comment\r\n# comment\r\n\r\n[models]\r\n Qwen/Qwen3.8-27B = true\r\ninclusionai/ling-3.1-flash:free = true\r\nqwen/Qwen3.8-27B = false\r\n"
    assert.deepEqual(
      [...parseModelSelection(contents)],
      ["Qwen/Qwen3.8-27B", "inclusionai/ling-3.1-flash:free"],
    )
    assert.equal(parseModelSelection("[models]\na = false").has("a"), false)
    assert.equal(parseModelSelection("[models]").size, 0)
  })

  for (const [contents, line] of [
    ["[models]\na = true\na = false", 3],
    ["[models]\na = yes", 2],
    ["a = true", 1],
    ["[models]\n[models]", 2],
    ["[models]\n[other]", 2],
    ["", 1],
    ["[models]\na: true", 2],
  ] as const) {
    it(`reports a file and line for ${JSON.stringify(contents)}`, () => {
      assert.throws(
        () => parseModelSelection(contents, "C:/plugin/models.ini"),
        (error) => {
          assert.ok(error instanceof Error)
          assert.ok(error.message.startsWith(`C:/plugin/models.ini:${line}:`))
          return true
        },
      )
    })
  }

  it("ships the agreed GOAT selection and resolves its path from the plugin", async () => {
    const path = getCommandCodeModelsConfigPath({})
    assert.ok(
      path.endsWith("pi-commandcode-provider\\commandcode-models.ini") ||
        path.endsWith("pi-commandcode-provider/commandcode-models.ini"),
    )
    assert.deepEqual([...(await loadModelSelection(path))].sort(), DEFAULT_ENABLED_IDS)
    const contents = await readFile(path, "utf8")
    assert.match(contents, /2026-10-07/)
    assert.match(contents, /xiaomi\/mimo-v2.6-pro = false/)
    assert.equal(getCommandCodeModelsConfigPath({ COMMANDCODE_MODELS_CONFIG: path }), path)
  })

  it("reports missing files and reloads edits without rewriting the INI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-selection-"))
    const path = join(directory, "models.ini")
    try {
      await assert.rejects(loadModelSelection(path), /Could not read model selection.*models.ini/)
      await writeFile(path, "[models]\na = true\n")
      assert.deepEqual([...(await loadModelSelection(path))], ["a"])
      const changed = "; keep my comment\n[models]\na = false\nb = true\n"
      await writeFile(path, changed)
      assert.deepEqual([...(await loadModelSelection(path))], ["b"])
      assert.equal(await readFile(path, "utf8"), changed)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("selection-aware discovery", () => {
  const id = "gpt-5.6-sol"
  const enabledModelIds = new Set([id])
  const entry = { id, name: "GPT-5.6 Sol", context_length: 1_050_000 }

  it("ignores disabled entries before validating API or cache metadata", () => {
    const models = commandCodeModelsFromApiResponse(
      { object: "list", data: [null, { id: "disabled", context_length: -1 }, entry] },
      enabledModelIds,
    )
    assert.deepEqual(
      models.map((model) => model.id),
      [id],
    )
    assert.deepEqual(
      commandCodeModelsFromCache(
        { version: 2, models: [false, { id: "disabled" }, ...models] },
        enabledModelIds,
      ),
      models,
    )
    assert.throws(
      () => commandCodeModelsFromApiResponse({ object: "list", data: [{ id }] }, enabledModelIds),
      /name/,
    )
    assert.deepEqual(commandCodeModelsFromCache({ version: 2, models: [] }, enabledModelIds), [])
  })

  it("persists a successful empty selection so offline loading cannot resurrect removed models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cc-selection-cache-"))
    const cachePath = join(directory, "models.json")
    let entries: unknown[] = [entry, { id: "disabled", context_length: -1 }]
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ object: "list", data: entries }))
    try {
      const options = { cachePath, enabledModelIds, fetchImpl }
      assert.equal((await loadCommandCodeModels(options)).models.length, 1)
      entries = [{ id: "disabled" }]
      const removed = await loadCommandCodeModels(options)
      assert.equal(removed.source, "live")
      assert.deepEqual(removed.models, [])
      assert.equal(removed.warning, undefined)
      const offline = await loadCommandCodeModels({
        ...options,
        fetchImpl: async () => {
          throw new Error("offline")
        },
      })
      assert.equal(offline.source, "cache")
      assert.deepEqual(offline.models, [])
      entries = [entry]
      assert.equal((await loadCommandCodeModels(options)).models.length, 1)
      assert.deepEqual(await loadCachedCommandCodeModels(cachePath, new Set()), [])
      const malformed = await loadCommandCodeModels({
        ...options,
        fetchImpl: async () => new Response("{}"),
      })
      assert.equal(malformed.source, "cache")
      assert.deepEqual(
        malformed.models.map((model) => model.id),
        [id],
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
