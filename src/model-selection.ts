import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function getCommandCodeModelsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMMANDCODE_MODELS_CONFIG
    ? resolve(env.COMMANDCODE_MODELS_CONFIG)
    : fileURLToPath(new URL("../commandcode-models.ini", import.meta.url))
}

/** Exact model IDs are keys, including their slashes, dots, colons, and case. */
export function parseModelSelection(
  contents: string,
  path = "commandcode-models.ini",
): ReadonlySet<string> {
  const enabled = new Set<string>()
  const seen = new Set<string>()
  let inModels = false
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/)
  const fail = (line: number, message: string): never => {
    throw new Error(`${path}:${line}: ${message}`)
  }
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith(";") || line.startsWith("#")) continue
    if (line === "[models]") {
      if (inModels) fail(index + 1, "Duplicate [models] section")
      inModels = true
      continue
    }
    if (!inModels || line.startsWith("[")) fail(index + 1, "Expected a single [models] section")
    const entry = /^([^\s=\[\]]+)\s*=\s*(true|false)$/.exec(line)
    if (!entry) fail(index + 1, "Expected exact-model-id = true or false")
    const [, id, value] = entry!
    if (seen.has(id!)) fail(index + 1, `Duplicate model ID: ${id}`)
    seen.add(id!)
    if (value === "true") enabled.add(id!)
  }
  if (!inModels) fail(1, "Missing [models] section")
  return enabled
}

export async function loadModelSelection(path: string): Promise<ReadonlySet<string>> {
  let contents: string
  try {
    contents = await readFile(path, "utf-8")
  } catch (error) {
    throw new Error(
      `Could not read model selection ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseModelSelection(contents, path)
}

export function filterSelectedModels<T extends { id: string }>(
  models: readonly T[],
  enabledModelIds: ReadonlySet<string>,
): T[] {
  return models
    .filter((model) => enabledModelIds.has(model.id))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Filter before validating details so disabled/unknown entries cannot break discovery. */
export function selectModelEntries(
  values: readonly unknown[],
  enabledModelIds?: ReadonlySet<string>,
): readonly unknown[] {
  if (!enabledModelIds) return values
  return values.filter(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      enabledModelIds.has(value.id),
  )
}
