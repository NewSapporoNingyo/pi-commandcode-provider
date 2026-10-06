import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  commandCodeModelMetadataFromContents,
  diffModelMetadata,
  hasModelMetadataDiff,
  mergeSelectedModelMetadata,
  selectedModelMetadata,
  parseBundleModelCapabilities,
  parseKnownTextOnlyModelIds,
  parseModelsReference,
  parsePackageVersion,
  parsePackedPackage,
  pruneObsoleteEffortOverrides,
  renderCommandCodeCatalog,
  updateReadmeCatalogVersion,
  type CommandCodeModelMetadata,
} from "../.github/scripts/check-commandcode-model-metadata.ts"

const OVERRIDES_SOURCE = `import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"

/**
 * Manual reasoning-effort policy for models the official CLI marks as
 * reasoning-capable without publishing selectable efforts.
 */
export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
  // Meta Muse Spark: the CLI ships no effort levels for these models.
  "meta/muse-spark-1.1": ["minimal", "low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["minimal", "low", "medium", "high", "xhigh"],
}
`

const MODELS_REFERENCE = `
| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`vision-model\` | Vision | 1M | low, high | $1/$2 | Go | images |
| \`text-model\` | Text | 200K | — | $1/$2 | Go | text |
`

const CLI_BUNDLE =
  'const V={id:"vision-model",inputModalities:["text","image"],reasoning:!0,reasoningEfforts:["low","high"],maxOutputTokens:32768},T={id:"text-model",inputModalities:["text"]},catalog=new Set(["text-model"]),__name(isKnownTextOnlyModel,"isKnownTextOnlyModel")'

describe("Command Code model metadata checker", () => {
  it("parses model ids and reasoning efforts from the generated reference", () => {
    assert.deepEqual(parseModelsReference(MODELS_REFERENCE), {
      modelIds: ["text-model", "vision-model"],
      reasoningEfforts: { "vision-model": ["low", "high"] },
    })
  })

  it("extracts the text-only set from the bundled CLI catalog", () => {
    assert.deepEqual(parseKnownTextOnlyModelIds(CLI_BUNDLE), ["text-model"])
  })

  it("ignores unselected invalid entries in the shared text-only set", () => {
    const bundle = CLI_BUNDLE.replace(
      'new Set(["text-model"])',
      'new Set(["text-model",null,{"id":"disabled-model"}])',
    )
    assert.deepEqual(
      commandCodeModelMetadataFromContents(MODELS_REFERENCE, bundle, new Set(["text-model"])),
      { imageModelIds: [], reasoningModelIds: [], reasoningEfforts: {}, maxOutputTokens: {} },
    )
    assert.throws(() => parseKnownTextOnlyModelIds(bundle), /catalog to be strings/)
  })

  it("accepts one exact npm registry version and rejects stale-looking output shapes", () => {
    assert.equal(parsePackageVersion("1.32.2"), "1.32.2")
    assert.equal(parsePackageVersion("2.0.0-beta.1"), "2.0.0-beta.1")
    assert.equal(parsePackageVersion(["1.32.2"]), "1.32.2")
    assert.throws(() => parsePackageVersion([]), /one semantic version/)
    assert.throws(() => parsePackageVersion(["1.32.1", "1.32.2"]), /one semantic version/)
    assert.throws(() => parsePackageVersion("latest"), /one semantic version/)
  })

  it("derives image, reasoning, effort, and output-limit metadata", () => {
    assert.deepEqual(parseBundleModelCapabilities(CLI_BUNDLE, ["text-model", "vision-model"]), {
      reasoningModelIds: ["vision-model"],
      maxOutputTokens: { "vision-model": 32_768 },
    })
    assert.deepEqual(commandCodeModelMetadataFromContents(MODELS_REFERENCE, CLI_BUNDLE), {
      imageModelIds: ["vision-model"],
      reasoningModelIds: ["vision-model"],
      reasoningEfforts: { "vision-model": ["low", "high"] },
      maxOutputTokens: { "vision-model": 32_768 },
    })
  })

  it("reports additions, removals, and changed reasoning efforts", () => {
    const current: CommandCodeModelMetadata = {
      imageModelIds: ["removed-image", "stable-image"],
      reasoningModelIds: ["removed-reasoning", "stable-reasoning"],
      reasoningEfforts: {
        "changed-effort": ["low"],
        "removed-effort": ["high"],
        "stable-effort": ["low", "high"],
      },
      maxOutputTokens: { "changed-output": 1, "removed-output": 2, "stable-output": 3 },
    }
    const upstream: CommandCodeModelMetadata = {
      imageModelIds: ["added-image", "stable-image"],
      reasoningModelIds: ["added-reasoning", "stable-reasoning"],
      reasoningEfforts: {
        "added-effort": ["max"],
        "changed-effort": ["low", "high"],
        "stable-effort": ["low", "high"],
      },
      maxOutputTokens: { "added-output": 4, "changed-output": 5, "stable-output": 3 },
    }

    const diff = diffModelMetadata(current, upstream)

    assert.deepEqual(diff, {
      versionChanged: false,
      addedImageModelIds: ["added-image"],
      removedImageModelIds: ["removed-image"],
      addedReasoningModelIds: ["added-reasoning"],
      removedReasoningModelIds: ["removed-reasoning"],
      addedEffortModelIds: ["added-effort"],
      removedEffortModelIds: ["removed-effort"],
      changedEffortModelIds: ["changed-effort"],
      addedMaxOutputModelIds: ["added-output"],
      removedMaxOutputModelIds: ["removed-output"],
      changedMaxOutputModelIds: ["changed-output"],
    })
    assert.equal(hasModelMetadataDiff(diff), true)
  })

  it("reports CLI version drift without treating it as a model change", () => {
    const metadata: CommandCodeModelMetadata = {
      imageModelIds: ["vision-model"],
      reasoningModelIds: ["vision-model"],
      reasoningEfforts: { "vision-model": ["low"] },
      maxOutputTokens: { "vision-model": 32_768 },
    }

    const diff = diffModelMetadata(metadata, metadata, "1.32.2", "1.33.0")

    assert.equal(diff.versionChanged, true)
    assert.equal(hasModelMetadataDiff(diff), false)
  })

  it("renders a deterministic generated catalog and updates the README version", () => {
    assert.equal(
      renderCommandCodeCatalog("1.33.0", {
        imageModelIds: ["b-model", "a-model"],
        reasoningModelIds: ["c-model", "a-model"],
        reasoningEfforts: {
          "b-model": ["high", "max"],
          "a-model": ["low"],
        },
        maxOutputTokens: { "b-model": 32_768 },
      }),
      `export const COMMAND_CODE_CLI_VERSION = "1.33.0"

export type CommandCodeInputType = "text" | "image"
export type CommandCodeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/**
 * Generated from command-code@1.33.0 by \`npm run sync:commandcode-catalog\`.
 * Only enabled models are refreshed; disabled or missing entries retain their metadata.
 * Do not edit manually.
 */
export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {
  "a-model": ["text", "image"],
  "b-model": ["text", "image"],
}

export const MODEL_REASONING: Readonly<Record<string, true>> = {
  "a-model": true,
  "c-model": true,
}

export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  "a-model": ["low"],
  "b-model": ["high", "max"],
}

export const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  "b-model": 32_768,
}
`,
    )
    assert.equal(
      updateReadmeCatalogVersion(
        "The capability snapshot currently follows `command-code@1.32.2`.",
        "1.33.0",
      ),
      "The capability snapshot currently follows `command-code@1.33.0`.",
    )
  })

  it("rejects unexpected upstream structures instead of silently passing", () => {
    assert.throws(() => parseModelsReference("# no catalog"), /No model rows/)
    assert.throws(
      () => parseModelsReference(MODELS_REFERENCE.replace("low, high", "low, turbo")),
      /Unexpected reasoning efforts/,
    )
    assert.throws(() => parseKnownTextOnlyModelIds("const unrelated = true"), /Could not find/)
  })

  it("prunes only the overrides that upstream now publishes", () => {
    const pruned = pruneObsoleteEffortOverrides(OVERRIDES_SOURCE, ["meta/muse-spark-1.1"])

    assert.deepEqual(pruned.removedModelIds, ["meta/muse-spark-1.1"])
    assert.ok(!pruned.contents.includes("meta/muse-spark-1.1"))
    assert.ok(pruned.contents.includes("meta/muse-spark-1.2"))
    // Comments and the declaration must survive an entry removal.
    assert.ok(pruned.contents.includes("Meta Muse Spark: the CLI ships no effort levels"))
    assert.ok(pruned.contents.includes("export const MODEL_EFFORT_OVERRIDES"))
  })

  it("preserves neighboring declarations when pruning the effort map", () => {
    const before = 'export const OTHER = {\n  "meta/muse-spark-1.1": ["image"],\n}\n'
    const after = "\nexport const AFTER = { nested: { value: true } }\n"
    const source = before + OVERRIDES_SOURCE + after
    const pruned = pruneObsoleteEffortOverrides(source, [
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
    ])
    assert.ok(pruned.contents.startsWith(before))
    assert.ok(pruned.contents.endsWith(after))
    assert.deepEqual(pruned.removedModelIds, ["meta/muse-spark-1.1", "meta/muse-spark-1.2"])
    assert.equal(
      pruneObsoleteEffortOverrides(pruned.contents, ["meta/muse-spark-1.1"]).contents,
      pruned.contents,
    )
  })

  it("ignores entries inside block comments", () => {
    const source = OVERRIDES_SOURCE.replace(
      '  "meta/muse-spark-1.1":',
      '  /*\n  "not/an-override": ["low"],\n  */\n  "meta/muse-spark-1.1":',
    )
    assert.equal(pruneObsoleteEffortOverrides(source, ["not/an-override"]).contents, source)
  })

  it("leaves the overrides file untouched when nothing is obsolete", () => {
    const pruned = pruneObsoleteEffortOverrides(OVERRIDES_SOURCE, ["some/other-model"])

    assert.deepEqual(pruned.removedModelIds, [])
    assert.equal(pruned.contents, OVERRIDES_SOURCE)
  })

  it("collapses the override map once every entry is obsolete", () => {
    const pruned = pruneObsoleteEffortOverrides(OVERRIDES_SOURCE, [
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.1",
    ])

    assert.deepEqual(pruned.removedModelIds, ["meta/muse-spark-1.1", "meta/muse-spark-1.2"])
    // An empty map must render as `= {}` so the sync workflow's format check passes.
    assert.ok(pruned.contents.includes("= {}"))
    assert.ok(!pruned.contents.includes("\n}\n\n\n"), "no stray blank lines are left behind")
    assert.ok(pruned.contents.endsWith("= {}\n"))
  })

  it("ignores commented-out override entries", () => {
    const commented = OVERRIDES_SOURCE.replace(
      '  "meta/muse-spark-1.1"',
      '  // "meta/muse-spark-1.1"',
    )
    const pruned = pruneObsoleteEffortOverrides(commented, ["meta/muse-spark-1.1"])

    assert.deepEqual(pruned.removedModelIds, [])
    assert.equal(pruned.contents, commented)
  })

  it("prunes entries written with single quotes or spaced colons", () => {
    const styled = OVERRIDES_SOURCE.replace(
      '  "meta/muse-spark-1.1": ["minimal", "low", "medium", "high", "xhigh"],',
      "  'meta/muse-spark-1.1' : ['minimal', 'low', 'medium', 'high', 'xhigh'],",
    )
    const pruned = pruneObsoleteEffortOverrides(styled, ["meta/muse-spark-1.1"])

    assert.deepEqual(pruned.removedModelIds, ["meta/muse-spark-1.1"])
    assert.ok(!pruned.contents.includes("muse-spark-1.1"))
  })

  it("collapses the map even when a comment above it contains '= {'", () => {
    const withComment = OVERRIDES_SOURCE.replace(
      'import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"',
      'import type { CommandCodeReasoningEffort } from "./commandcode-catalog.ts"\n\n// Illustrative only: const other = { }',
    )
    const pruned = pruneObsoleteEffortOverrides(withComment, [
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
    ])

    assert.ok(pruned.contents.includes("const other = { }"), "the comment is preserved")
    assert.ok(pruned.contents.includes("MODEL_EFFORT_OVERRIDES"))
    assert.ok(pruned.contents.includes("= {}"))
  })

  it("removes a wrapped entry without leaving its array behind", () => {
    // Prettier wraps an entry whose id exceeds the print width, so the effort
    // array spans several lines. Only removing the first line would leave
    // orphaned level lines and break the file's syntax.
    const wrapped = `export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
  "vendor/a-very-long-model-identifier-that-exceeds-the-print-width": [
    "minimal",
    "low",
  ],
  "short": ["low"],
}
`
    const longId = "vendor/a-very-long-model-identifier-that-exceeds-the-print-width"
    const pruned = pruneObsoleteEffortOverrides(wrapped, [longId])

    assert.deepEqual(pruned.removedModelIds, [longId])
    assert.equal(
      pruned.contents,
      `export const MODEL_EFFORT_OVERRIDES: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
  "short": ["low"],
}
`,
    )
  })
})

describe("selected model metadata synchronization", () => {
  const enabled = new Set(["vision-model", "missing-model"])
  const current: CommandCodeModelMetadata = {
    imageModelIds: ["disabled-model", "missing-model", "vision-model"],
    reasoningModelIds: ["disabled-model", "missing-model", "vision-model"],
    reasoningEfforts: {
      "disabled-model": ["low"],
      "missing-model": ["high"],
      "vision-model": ["low", "high"],
    },
    maxOutputTokens: { "disabled-model": 42, "missing-model": 100, "vision-model": 32768 },
  }

  it("ignores disabled additions, removals, malformed efforts and bundle objects", () => {
    const reference = MODELS_REFERENCE.replace("| `text-model`", "| `disabled-model`").replace(
      "| Text | 200K | — |",
      "| Text | 200K | turbo |",
    )
    const upstream = commandCodeModelMetadataFromContents(reference, CLI_BUNDLE, enabled)
    const present = new Set(parseModelsReference(reference, enabled).modelIds)
    assert.deepEqual([...present], ["vision-model"])
    const merged = mergeSelectedModelMetadata(current, upstream, present)
    assert.deepEqual(merged, current)
    assert.equal(hasModelMetadataDiff(diffModelMetadata(current, merged, "1.0.0", "2.0.0")), false)
    assert.deepEqual(selectedModelMetadata(current, enabled).imageModelIds, [
      "missing-model",
      "vision-model",
    ])
  })

  it("separates the CLI off switch from pi's selectable reasoning depths", () => {
    const parsed = parseModelsReference(MODELS_REFERENCE.replace("low, high", "off, low, high"))
    assert.deepEqual(parsed.reasoningEfforts, { "vision-model": ["low", "high"] })
    assert.deepEqual(
      parseModelsReference(MODELS_REFERENCE.replace("low, high", "off")).reasoningEfforts,
      {},
    )
  })

  it("accepts single-package npm pack arrays and name-keyed objects, rejecting ambiguous results", () => {
    const pkg = { filename: "command-code-1.74.3.tgz" }
    assert.deepEqual(parsePackedPackage([pkg]), pkg)
    assert.deepEqual(parsePackedPackage({ "command-code": pkg }), pkg)
    assert.throws(() => parsePackedPackage([pkg, pkg]), /one package/)
    assert.throws(() => parsePackedPackage({ "command-code": pkg, other: pkg }), /one package/)
    assert.throws(() => parsePackedPackage({ "command-code": {} }), /filename/)
  })

  it("updates only present enabled models, including removal of previously supported capabilities", () => {
    const upstream = {
      imageModelIds: [],
      reasoningModelIds: [],
      reasoningEfforts: {},
      maxOutputTokens: {},
    }
    const merged = mergeSelectedModelMetadata(current, upstream, new Set(["vision-model"]))
    assert.deepEqual(merged.imageModelIds, ["disabled-model", "missing-model"])
    assert.deepEqual(merged.reasoningEfforts, {
      "disabled-model": ["low"],
      "missing-model": ["high"],
    })
    assert.equal(merged.maxOutputTokens["missing-model"], 100)
    assert.equal(hasModelMetadataDiff(diffModelMetadata(current, merged)), true)
  })

  it("preserves all metadata when every enabled model is missing upstream", () => {
    const selection = new Set(["missing-model"])
    const upstream = commandCodeModelMetadataFromContents(
      MODELS_REFERENCE,
      "unrelated bundle format",
      selection,
    )
    assert.deepEqual(parseModelsReference(MODELS_REFERENCE, selection).modelIds, [])
    assert.deepEqual(mergeSelectedModelMetadata(current, upstream, new Set()), current)
  })

  it("still validates capability errors for selected models", () => {
    assert.throws(
      () =>
        commandCodeModelMetadataFromContents(
          MODELS_REFERENCE.replace("low, high", "turbo"),
          CLI_BUNDLE,
          enabled,
        ),
      /Unexpected reasoning efforts/,
    )
    assert.throws(
      () =>
        commandCodeModelMetadataFromContents(
          MODELS_REFERENCE,
          CLI_BUNDLE.replace("32768", "-1"),
          enabled,
        ),
      /Unexpected max output/,
    )
  })
})
