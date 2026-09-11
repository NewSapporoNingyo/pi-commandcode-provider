import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { COMMAND_CODE_ALLOWED_MODEL_IDS } from "../src/commandcode-allowlist.ts"
import { COMMAND_CODE_CLI_VERSION } from "../src/commandcode-catalog.ts"
import {
  apiForModelId,
  baseUrlForModel,
  commandCodeModelsFromApiResponse,
  commandCodeModelsFromCache,
  DEFAULT_MODELS_TIMEOUT_MS,
  filterAllowedCommandCodeModels,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
  modelSupportsImageInput,
  thinkingLevelMapForEfforts,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "../src/models.ts"

const GPT_API_MODEL = {
  id: "gpt-5.6-sol",
  object: "model",
  created: 1779824324,
  owned_by: "command-code",
  name: "GPT-5.6 Sol",
  context_length: 1_050_000,
}

const API_RESPONSE = {
  object: "list",
  data: [GPT_API_MODEL],
}

const ALLOWLIST_API_RESPONSE = {
  object: "list",
  data: [
    GPT_API_MODEL,
    {
      ...GPT_API_MODEL,
      id: "zai-org/GLM-5.2",
      name: "GLM-5.2",
      context_length: 1_000_000,
    },
    {
      ...GPT_API_MODEL,
      id: "tencent/hy3-paid",
      name: "Tencent Hy3",
      context_length: 262_144,
    },
    {
      ...GPT_API_MODEL,
      id: "Qwen/Qwen3.8-27B",
      name: "Qwen 3.8 27B",
      context_length: 262_144,
    },
    {
      ...GPT_API_MODEL,
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash (latest)",
      context_length: 1_000_000,
    },
    {
      ...GPT_API_MODEL,
      id: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      context_length: 1_000_000,
    },
    {
      ...GPT_API_MODEL,
      id: "moonshotai/Kimi-K2.7-Code",
      name: "Kimi K2.7 Code",
      context_length: 256_000,
    },
    {
      ...GPT_API_MODEL,
      id: "MiniMaxAI/MiniMax-M3",
      name: "MiniMax M3",
      context_length: 1_000_000,
    },
    {
      ...GPT_API_MODEL,
      id: "z-ai/glm-5.3-flash",
      name: "GLM-5.3 Flash",
      context_length: 1_048_576,
    },
    {
      ...GPT_API_MODEL,
      id: "poolside/laguna-s-2.1-free",
      name: "Laguna S 2.1",
      context_length: 256_000,
    },
    {
      ...GPT_API_MODEL,
      id: "meituan/LongCat-2.0:free",
      name: "LongCat 2.0",
      context_length: 1_048_576,
    },
    {
      ...GPT_API_MODEL,
      id: "inclusionai/ling-3.0-flash-sante:free",
      name: "Ling 3.0 Flash Sante",
      context_length: 262_144,
    },
    {
      id: "provider/non-allowlisted-model",
    },
  ],
}

const EXPECTED_MODELS: readonly CommandCodeModel[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol (CC)",
    api: "openai-completions",
    reasoning: true,
    contextWindow: 1_050_000,
    maxTokens: 65_536,
  },
]

const EXPECTED_REASONING: Readonly<
  Record<
    string,
    {
      reasoning: boolean
      efforts: readonly string[]
    }
  >
> = {
  "gpt-5.6-sol": { reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "zai-org/GLM-5.2": { reasoning: true, efforts: ["high", "max"] },
  "tencent/hy3-paid": { reasoning: true, efforts: [] },
  "Qwen/Qwen3.8-27B": { reasoning: true, efforts: ["low", "medium", "xhigh"] },
  "deepseek/deepseek-v4-flash": { reasoning: true, efforts: ["high", "max"] },
  "deepseek/deepseek-v4.1-flash": { reasoning: true, efforts: ["low", "high", "max"] },
  "moonshotai/Kimi-K2.7-Code": { reasoning: true, efforts: [] },
  "MiniMaxAI/MiniMax-M3": { reasoning: true, efforts: ["low", "medium", "high"] },
  "z-ai/glm-5.3-flash": { reasoning: true, efforts: ["low", "high", "max"] },
  "poolside/laguna-s-2.1-free": { reasoning: true, efforts: [] },
  "meituan/LongCat-2.0:free": { reasoning: true, efforts: [] },
  "inclusionai/ling-3.0-flash-sante:free": { reasoning: true, efforts: [] },
}

function successfulFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(API_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
}

function failingFetch(message = "offline"): typeof fetch {
  return () => Promise.reject(new TypeError(message))
}

function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      )
    })
}

async function withTemporaryCache(
  run: (paths: { directory: string; cachePath: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-models-"))
  try {
    await run({ directory, cachePath: join(directory, "models.json") })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function allowlistFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(ALLOWLIST_API_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
}

describe("commandCodeModelsFromApiResponse()", () => {
  it("converts the Provider API model list to pi models", () => {
    assert.deepEqual(commandCodeModelsFromApiResponse(API_RESPONSE), EXPECTED_MODELS)
  })

  it("keeps exactly the reviewed allowlist when live API data has extra models", () => {
    const models = commandCodeModelsFromApiResponse(ALLOWLIST_API_RESPONSE)

    assert.deepEqual(
      models.map((model) => model.id),
      COMMAND_CODE_ALLOWED_MODEL_IDS,
    )
    assert.deepEqual(
      models.map(({ id, name }) => ({ id, name })),
      [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (CC)" },
        { id: "zai-org/GLM-5.2", name: "GLM-5.2 (CC)" },
        { id: "tencent/hy3-paid", name: "Tencent Hy3 (CC)" },
        { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B (CC)" },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest) (CC)" },
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (CC)" },
        { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code (CC)" },
        { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3 (CC)" },
        { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash (CC)" },
        { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1 (CC)" },
        { id: "meituan/LongCat-2.0:free", name: "LongCat 2.0 (CC)" },
        {
          id: "inclusionai/ling-3.0-flash-sante:free",
          name: "Ling 3.0 Flash Sante (CC)",
        },
      ],
    )
    assert.equal(
      models.some((model) => model.id === "provider/non-allowlisted-model"),
      false,
    )
    assert.deepEqual(filterAllowedCommandCodeModels([...models]), models)
  })

  it("routes Claude models to Anthropic Messages and all others to Chat Completions", () => {
    assert.equal(apiForModelId("claude-sonnet-4-6"), "anthropic-messages")
    assert.equal(apiForModelId("gpt-5.6-sol"), "openai-completions")
    assert.equal(
      baseUrlForModel("https://api.commandcode.ai/provider/v1/", "openai-completions"),
      "https://api.commandcode.ai/provider/v1",
    )
    assert.equal(
      baseUrlForModel("https://api.commandcode.ai/provider/v1/", "anthropic-messages"),
      "https://api.commandcode.ai/provider",
    )
  })

  it(`uses the command-code@${COMMAND_CODE_CLI_VERSION} image capability catalog`, () => {
    assert.deepEqual(inputModalitiesForModel("gpt-5.6-luna"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("meta/muse-spark-1.2"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("deepseek/deepseek-v4-flash-vision-exp"), [
      "text",
      "image",
    ])
    assert.deepEqual(inputModalitiesForModel("deepseek/deepseek-v4.1-flash"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("Qwen/Qwen3.8-27B"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("google/gemini-3.7-flash"), ["text", "image"])
    assert.deepEqual(inputModalitiesForModel("meituan/LongCat-2.0:free"), ["text"])
    assert.deepEqual(inputModalitiesForModel("inclusionai/ling-3.0-flash-sante:free"), ["text"])
    assert.deepEqual(inputModalitiesForModel("deepseek/deepseek-v4-pro"), ["text"])
    assert.deepEqual(inputModalitiesForModel("zai-org/GLM-5.3"), ["text"])
    assert.deepEqual(inputModalitiesForModel("unknown-new-model"), ["text"])
    assert.equal(modelSupportsImageInput("gpt-5.6-luna"), true)
    assert.equal(modelSupportsImageInput("deepseek/deepseek-v4-flash-vision-exp"), true)
    assert.equal(modelSupportsImageInput("deepseek/deepseek-v4.1-flash"), true)
    assert.equal(modelSupportsImageInput("meituan/LongCat-2.0:free"), false)
    assert.equal(modelSupportsImageInput("inclusionai/ling-3.0-flash-sante:free"), false)
    assert.equal(modelSupportsImageInput("deepseek/deepseek-v4-pro"), false)
    assert.ok(Object.keys(MODEL_INPUT_MODALITIES).length > 0)
    for (const modalities of Object.values(MODEL_INPUT_MODALITIES)) {
      assert.deepEqual(modalities, ["text", "image"])
    }
  })

  it("tracks reasoning independently from selectable effort levels", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { ...API_RESPONSE.data[0], id: "deepseek/deepseek-v4.1-flash" },
        { ...API_RESPONSE.data[0], id: "moonshotai/Kimi-K2.7-Code" },
        { ...API_RESPONSE.data[0], id: "inclusionai/ling-3.0-flash-sante:free" },
      ],
    })

    assert.equal(models[0]?.reasoning, true)
    assert.equal(models[1]?.reasoning, true)
    assert.deepEqual(thinkingMetadataForModel("moonshotai/Kimi-K2.7-Code"), {
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    })
    assert.equal(models[2]?.reasoning, true)
    assert.equal(MODEL_REASONING["inclusionai/ling-3.0-flash-sante:free"], true)
    assert.equal(MODEL_EFFORTS["inclusionai/ling-3.0-flash-sante:free"], undefined)
  })

  it("uses model-specific output limits from the CLI catalog", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { ...API_RESPONSE.data[0], id: "Qwen/Qwen3.8-27B", context_length: 262_144 },
        { ...API_RESPONSE.data[0], id: "z-ai/glm-5.3-flash", context_length: 1_048_576 },
        {
          ...API_RESPONSE.data[0],
          id: "poolside/laguna-s-2.1-free",
          context_length: 256_000,
        },
        {
          ...API_RESPONSE.data[0],
          id: "inclusionai/ling-3.0-flash-sante:free",
          context_length: 262_144,
        },
      ],
    })

    assert.deepEqual(
      models.map(({ id, maxTokens }) => ({ id, maxTokens })),
      [
        { id: "Qwen/Qwen3.8-27B", maxTokens: 32_768 },
        { id: "z-ai/glm-5.3-flash", maxTokens: 131_072 },
        { id: "poolside/laguna-s-2.1-free", maxTokens: 32_768 },
        { id: "inclusionai/ling-3.0-flash-sante:free", maxTokens: 32_768 },
      ],
    )
    assert.equal(Object.keys(MODEL_MAX_OUTPUT_TOKENS).length, 4)
  })

  it(`uses the command-code@${COMMAND_CODE_CLI_VERSION} reasoning effort catalog`, () => {
    const validEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"])
    assert.ok(Object.keys(MODEL_EFFORTS).length > 0)
    for (const efforts of Object.values(MODEL_EFFORTS)) {
      assert.ok(efforts.length > 0)
      assert.equal(new Set(efforts).size, efforts.length)
      assert.ok(efforts.every((effort) => validEfforts.has(effort)))
    }
  })

  it("builds separate canonical pi and OMP metadata", () => {
    for (const [modelId, efforts] of Object.entries(MODEL_EFFORTS)) {
      const metadata = thinkingMetadataForModel(modelId)
      assert.ok(metadata, `${modelId} should have reasoning metadata`)
      assert.ok(metadata.thinking)
      assert.equal(metadata.thinking.mode, "effort")
      assert.deepEqual(metadata.thinking.efforts, efforts)
      assert.deepEqual(
        metadata.thinking.effortMap,
        Object.fromEntries(efforts.map((effort) => [effort, effort])),
      )
      assert.equal("defaultLevel" in metadata.thinking, false)
      for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const expected = efforts.includes(level)
        assert.equal(
          metadata.thinkingLevelMap[level],
          expected ? level : null,
          `${modelId} should map ${level} according to its catalog entry`,
        )
      }
    }

    assert.deepEqual(thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4-flash"]), {
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    })
    assert.deepEqual(thinkingLevelMapForEfforts(MODEL_EFFORTS["deepseek/deepseek-v4.1-flash"]), {
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    })
    assert.deepEqual(thinkingMetadataForModel("new-model-without-metadata"), undefined)
  })

  it("matches the reasoning and unsupported-level matrix for all allowlisted models", () => {
    const models = new Map(
      commandCodeModelsFromApiResponse(ALLOWLIST_API_RESPONSE).map((model) => [model.id, model]),
    )
    const unsupportedLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

    for (const modelId of COMMAND_CODE_ALLOWED_MODEL_IDS) {
      const expected = EXPECTED_REASONING[modelId]
      assert.ok(expected, `missing expected reasoning metadata for ${modelId}`)
      assert.equal(models.get(modelId)?.reasoning, expected.reasoning)
      assert.deepEqual(MODEL_EFFORTS[modelId] ?? [], expected.efforts)

      const metadata = thinkingMetadataForModel(modelId)
      if (!expected.reasoning) {
        assert.equal(metadata, undefined)
        continue
      }

      assert.ok(metadata)
      for (const level of unsupportedLevels) {
        assert.equal(
          metadata.thinkingLevelMap[level],
          expected.efforts.includes(level) ? level : null,
          `${modelId} should map ${level} according to its catalog entry`,
        )
      }
      if (expected.efforts.length === 0) assert.equal(metadata.thinking, undefined)
      else assert.deepEqual(metadata.thinking?.efforts, expected.efforts)
    }
  })

  it("rejects unexpected API shapes", () => {
    assert.deepEqual(
      commandCodeModelsFromApiResponse({
        object: "list",
        data: [{ id: "provider/non-allowlisted-model" }],
      }),
      [],
    )
    assert.throws(() =>
      commandCodeModelsFromApiResponse({ object: "list", data: [{ id: "gpt-5.6-sol" }] }),
    )
  })
})

describe("commandCodeModelsFromCache()", () => {
  it("accepts the current cache format", () => {
    assert.deepEqual(
      commandCodeModelsFromCache({ version: 1, models: EXPECTED_MODELS }),
      EXPECTED_MODELS,
    )
  })

  it("filters extra entries from an older cache before registration", () => {
    assert.deepEqual(
      commandCodeModelsFromCache({
        version: 1,
        models: [
          ...EXPECTED_MODELS,
          {
            ...EXPECTED_MODELS[0],
            id: "provider/non-allowlisted-model",
            name: "Non-allowlisted model (CC)",
            reasoning: false,
            contextWindow: undefined,
            maxTokens: undefined,
          },
        ],
      }),
      EXPECTED_MODELS,
    )
  })

  it("normalizes cached reasoning metadata from the model id", () => {
    const cached = commandCodeModelsFromCache({
      version: 1,
      models: [
        {
          ...EXPECTED_MODELS[0],
          id: "deepseek/deepseek-v4-flash",
          reasoning: false,
        },
      ],
    })
    assert.equal(cached[0]?.reasoning, true)
  })

  it("rejects empty, invalid, and unsupported caches", () => {
    assert.throws(() => commandCodeModelsFromCache({ version: 1, models: [] }))
    assert.throws(() => commandCodeModelsFromCache({ version: 2, models: EXPECTED_MODELS }))
    assert.throws(() =>
      commandCodeModelsFromCache({
        version: 1,
        models: [{ ...EXPECTED_MODELS[0], contextWindow: -1 }],
      }),
    )
  })
})

describe("model discovery configuration", () => {
  it("uses a safe default timeout and ignores invalid environment values", () => {
    assert.equal(getModelsTimeoutMs({}), DEFAULT_MODELS_TIMEOUT_MS)
    assert.equal(
      getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "0" }),
      DEFAULT_MODELS_TIMEOUT_MS,
    )
    assert.equal(
      getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "invalid" }),
      DEFAULT_MODELS_TIMEOUT_MS,
    )
    assert.equal(getModelsTimeoutMs({ COMMANDCODE_MODELS_TIMEOUT_MS: "25" }), 25)
  })
})

describe("loadCommandCodeModels()", () => {
  it("falls back to cache when live discovery times out", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      const startedAt = Date.now()
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: hangingFetch(),
        timeoutMs: 25,
      })

      assert.ok(Date.now() - startedAt < 500)
      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "cache")
      assert.match(result.warning ?? "", /timed out after 25ms/)
      assert.match(result.warning ?? "", /Using the cached catalog/)
    })
  })

  it("preserves an external abort instead of falling back to cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })
      const controller = new AbortController()
      const promise = loadCommandCodeModels({
        cachePath,
        fetchImpl: hangingFetch(),
        timeoutMs: 1_000,
        signal: controller.signal,
      })

      controller.abort(new Error("caller cancelled discovery"))

      await assert.rejects(promise, /caller cancelled discovery/)
    })
  })

  it("returns live models and writes a validated cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("filters live results before cache writes and on refresh", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const first = await loadCommandCodeModels({
        cachePath,
        fetchImpl: allowlistFetch(),
      })
      assert.equal(first.source, "live")
      assert.deepEqual(
        first.models.map((model) => model.id),
        COMMAND_CODE_ALLOWED_MODEL_IDS,
      )

      const cached = JSON.parse(await readFile(cachePath, "utf-8")) as {
        models: readonly { id: string }[]
      }
      assert.deepEqual(
        cached.models.map((model) => model.id),
        COMMAND_CODE_ALLOWED_MODEL_IDS,
      )

      const refreshed = await loadCommandCodeModels({
        cachePath,
        fetchImpl: allowlistFetch(),
      })
      assert.equal(refreshed.source, "live")
      assert.deepEqual(
        refreshed.models.map((model) => model.id),
        COMMAND_CODE_ALLOWED_MODEL_IDS,
      )
      assert.equal(
        refreshed.models.some((model) => model.id === "provider/non-allowlisted-model"),
        false,
      )
    })
  })

  it("uses the last valid catalog when the refresh fails", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "cache")
      assert.match(result.warning ?? "", /offline/)
      assert.match(result.warning ?? "", /Using the cached catalog/)
    })
  })

  it("filters extra models from an old cache during offline fallback", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await writeFile(
        cachePath,
        `${JSON.stringify({
          version: 1,
          models: [
            ...EXPECTED_MODELS,
            {
              ...EXPECTED_MODELS[0],
              id: "provider/non-allowlisted-model",
              name: "Non-allowlisted model (CC)",
              reasoning: false,
            },
          ],
        })}\n`,
        "utf-8",
      )

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.equal(result.source, "cache")
      assert.deepEqual(result.models, EXPECTED_MODELS)
    })
  })

  it("starts with an empty catalog when offline without a valid cache", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /no valid cached catalog/)
      assert.match(result.warning ?? "", /until \/commandcode-refresh succeeds/)
    })
  })

  it("recovers live models after an empty offline start", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const empty = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.equal(empty.source, "empty")
      assert.deepEqual(empty.models, [])

      const recovered = await loadCommandCodeModels({
        cachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(recovered, { models: EXPECTED_MODELS, source: "live" })
      assert.deepEqual(
        commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, "utf-8"))),
        EXPECTED_MODELS,
      )
    })
  })

  it("ignores a corrupt cache after a failed refresh", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await writeFile(cachePath, "not json", "utf-8")

      const result = await loadCommandCodeModels({
        cachePath,
        fetchImpl: failingFetch(),
      })

      assert.deepEqual(result.models, [])
      assert.equal(result.source, "empty")
      assert.match(result.warning ?? "", /Unexpected token|JSON/)
    })
  })

  it("keeps live models usable when the cache cannot be written", async () => {
    await withTemporaryCache(async ({ directory }) => {
      const unwritableCachePath = join(directory, "cache-directory")
      await mkdir(unwritableCachePath)

      const result = await loadCommandCodeModels({
        cachePath: unwritableCachePath,
        fetchImpl: successfulFetch(),
      })

      assert.deepEqual(result.models, EXPECTED_MODELS)
      assert.equal(result.source, "live")
      assert.match(result.warning ?? "", /could not update/)
    })
  })

  it("falls back to cache for HTTP and response parsing failures", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadCommandCodeModels({ cachePath, fetchImpl: successfulFetch() })

      for (const fetchImpl of [
        (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
        (() =>
          Promise.resolve(
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )) as typeof fetch,
      ]) {
        const result = await loadCommandCodeModels({ cachePath, fetchImpl })
        assert.deepEqual(result.models, EXPECTED_MODELS)
        assert.equal(result.source, "cache")
      }
    })
  })
})
