/**
 * This fork exposes only the models shown in the reviewed price table and
 * free models that are both marked free in the official catalog and returned
 * by the current Command Code Provider API.
 *
 * Keep this list exact: the live catalog and its cache are filtered through it
 * before models can be registered with pi.
 */
export const COMMAND_CODE_ALLOWED_MODEL_IDS = [
  "gpt-5.6-sol",
  "zai-org/GLM-5.2",
  "tencent/hy3-paid",
  "Qwen/Qwen3.8-27B",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4.1-flash",
  "moonshotai/Kimi-K2.7-Code",
  "MiniMaxAI/MiniMax-M3",
  "z-ai/glm-5.3-flash",
  "poolside/laguna-s-2.1-free",
  "meituan/LongCat-2.0:free",
  "inclusionai/ling-3.0-flash-sante:free",
] as const

const commandCodeAllowedModelIds = new Set<string>(COMMAND_CODE_ALLOWED_MODEL_IDS)

export function isAllowedCommandCodeModelId(modelId: string): boolean {
  return commandCodeAllowedModelIds.has(modelId)
}
