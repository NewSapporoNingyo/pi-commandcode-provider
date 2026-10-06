import type { CommandCodeModel, LoadCommandCodeModelsResult } from "./models.ts"
import { filterSelectedModels } from "./model-selection.ts"

export interface CommandCodeUi {
  notify(message: string, type?: "info" | "warning" | "error"): void
}

export interface CommandCodeCommandContext {
  ui: CommandCodeUi
  model?: { provider: string; id: string }
  waitForIdle?: () => Promise<void>
}

export interface CommandCodeRuntimeApi<
  TProviderConfig,
  TContext extends CommandCodeCommandContext,
> {
  registerProvider(name: string, config: TProviderConfig): void
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: TContext) => Promise<void>
    },
  ): void
}

export interface CommandCodeRuntimeOptions<TProviderConfig> {
  endpoint: string
  cachePath: string
  configPath: string
  loadSelection: () => Promise<ReadonlySet<string>>
  loadModels: (
    signal: AbortSignal,
    enabledModelIds: ReadonlySet<string>,
  ) => Promise<LoadCommandCodeModelsResult>
  /** Cached catalog only; resolves to an empty list when no valid cache exists. */
  loadCachedModels: (enabledModelIds: ReadonlySet<string>) => Promise<readonly CommandCodeModel[]>
  createProviderConfig: (models: readonly CommandCodeModel[]) => TProviderConfig
  getTransport?: () => "unknown" | "provider" | "generate"
  now?: () => number
  logWarning?: (message: string) => void
}

export interface CommandCodeRuntimeStatus {
  transport: "unknown" | "provider" | "generate"
  source: LoadCommandCodeModelsResult["source"]
  modelCount: number
  lastSuccess?: number
  lastAttempt?: number
  cachePath: string
  configPath: string
  enabledCount: number
  unavailableModelIds: readonly string[]
  endpoint: string
  warning?: string
  refreshing: boolean
}

export interface CommandCodeRefreshResult {
  refreshed: boolean
  source: CommandCodeRuntimeStatus["source"]
  modelCount: number
  warning?: string
}

const REDACTED = "[redacted]"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return REDACTED
  }
}

export function redactDiagnosticText(value: string): string {
  const redactedUrls = value.replace(/https?:\/\/[^\s)]+/gi, (match) => redactUrl(match))
  return redactedUrls
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[=:]\s*[^\s,;)]+/gi, (match) => {
      const separator = match.match(/\s*[=:]\s*/)?.[0] ?? "="
      return `${match.slice(0, match.indexOf(separator))}${separator}${REDACTED}`
    })
}

export function redactEndpoint(value: string): string {
  return redactUrl(value)
}

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "never" : new Date(timestamp).toISOString()
}

export function formatCommandCodeStatus(status: CommandCodeRuntimeStatus): string {
  const lines = [
    `transport: ${status.transport}`,
    `source: ${status.source}`,
    `model count: ${status.modelCount}`,
    `last success: ${formatTimestamp(status.lastSuccess)}`,
    `last attempt: ${formatTimestamp(status.lastAttempt)}`,
    `cache path: ${status.cachePath}`,
    `config path: ${status.configPath}`,
    `enabled count: ${status.enabledCount}`,
    `unavailable model IDs: ${status.unavailableModelIds.join(", ") || "none"}`,
    `endpoint: ${redactEndpoint(status.endpoint)}`,
    `refresh: ${status.refreshing ? "in progress" : "idle"}`,
  ]

  lines.push(`warning: ${status.warning ? redactDiagnosticText(status.warning) : "none"}`)
  return lines.join("\n")
}

export class CommandCodeRuntime<TProviderConfig, TContext extends CommandCodeCommandContext> {
  private readonly now: () => number
  private readonly logWarning: (message: string) => void
  private status: CommandCodeRuntimeStatus
  private providerRegistered = false
  private models: readonly CommandCodeModel[] = []
  private enabledModelIds: ReadonlySet<string> = new Set()
  private context: CommandCodeCommandContext | undefined
  private diagnosticWarning: string | undefined
  private notifiedWarning: string | undefined
  private notifiedUnavailable: string | undefined
  private notifiedSelection: string | undefined
  private refreshPromise: Promise<CommandCodeRefreshResult> | undefined
  private readonly shutdown = new AbortController()

  constructor(
    private readonly pi: CommandCodeRuntimeApi<TProviderConfig, TContext>,
    private readonly options: CommandCodeRuntimeOptions<TProviderConfig>,
  ) {
    this.now = options.now ?? Date.now
    // Direct console output corrupts the host TUI; attachContext supplies its UI later.
    this.logWarning = options.logWarning ?? (() => {})
    const initialStatus: CommandCodeRuntimeStatus = {
      transport: "unknown",
      source: "empty",
      modelCount: 0,
      cachePath: options.cachePath,
      configPath: options.configPath,
      enabledCount: 0,
      unavailableModelIds: [],
      endpoint: options.endpoint,
      refreshing: false,
    }
    this.status = { ...initialStatus }
  }

  getStatus(): CommandCodeRuntimeStatus {
    return {
      ...this.status,
      unavailableModelIds: [...this.status.unavailableModelIds],
      transport: this.options.getTransport?.() ?? "unknown",
    }
  }

  /**
   * Registers the cached catalog immediately and refreshes it in the
   * background so host startup does not wait for the network. Without a
   * valid cache the live refresh is awaited so models are available at once.
   */
  async initialize(): Promise<void> {
    this.registerCommands()
    if (!(await this.reloadSelection())) return
    if (this.enabledModelIds.size === 0) {
      this.registerModels([])
      return
    }
    const cached = await this.options.loadCachedModels(this.enabledModelIds)
    if (cached.length === 0) {
      await this.refresh()
      return
    }

    this.registerModels(cached)
    this.status = {
      ...this.status,
      source: "cache",
      lastSuccess: this.now(),
    }
    void this.refresh()
  }

  /** Session startup may happen after discovery; deliver its pending warning once UI exists. */
  attachContext(context: CommandCodeCommandContext): void {
    this.context = context
    this.notifyWarning()
    this.notifyRemovedSelection()
  }

  private registerModels(models: readonly CommandCodeModel[]): boolean {
    const selected = filterSelectedModels(models, this.enabledModelIds)
    if (this.providerRegistered && JSON.stringify(selected) === JSON.stringify(this.models))
      return false
    this.pi.registerProvider("commandcode", this.options.createProviderConfig(selected))
    this.models = selected
    this.providerRegistered = true
    this.status = { ...this.status, modelCount: selected.length }
    this.notifyRemovedSelection()
    return true
  }

  private notifyRemovedSelection(): void {
    const model = this.context?.model
    if (
      !this.providerRegistered ||
      model?.provider !== "commandcode" ||
      this.models.some((entry) => entry.id === model.id)
    ) {
      this.notifiedSelection = undefined
      return
    }
    if (this.notifiedSelection === model.id) return
    this.context?.ui.notify(
      `The selected Command Code model ${model.id} is disabled or unavailable. Select another model with /model.`,
      "warning",
    )
    this.notifiedSelection = model.id
  }

  private async reloadSelection(): Promise<boolean> {
    try {
      this.enabledModelIds = new Set(await this.options.loadSelection())
      this.status = {
        ...this.status,
        enabledCount: this.enabledModelIds.size,
        unavailableModelIds: this.status.unavailableModelIds.filter((id) =>
          this.enabledModelIds.has(id),
        ),
      }
      // Even an offline refresh must remove newly disabled models immediately.
      if (this.providerRegistered) this.registerModels(this.models)
      return true
    } catch (error) {
      if (!this.providerRegistered) this.registerModels([])
      this.setWarning(errorMessage(error))
      return false
    }
  }

  /** Aborts any background refresh so a stopping host does not wait for the network. */
  dispose(): void {
    this.shutdown.abort(new Error("Command Code provider shut down"))
  }

  refresh(): Promise<CommandCodeRefreshResult> {
    if (this.refreshPromise) return this.refreshPromise

    const refreshPromise = this.refreshCatalog().finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined
    })
    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  private async refreshCatalog(): Promise<CommandCodeRefreshResult> {
    this.status = {
      ...this.status,
      lastAttempt: this.now(),
      refreshing: true,
    }

    try {
      if (!(await this.reloadSelection())) return this.result(false)
      if (this.shutdown.signal.aborted) return this.result(false)
      if (this.enabledModelIds.size === 0) {
        this.registerModels([])
        this.status = { ...this.status, source: "empty", unavailableModelIds: [] }
        this.setWarning(undefined)
        return this.result(true)
      }
      const loaded = await this.options.loadModels(this.shutdown.signal, this.enabledModelIds)
      if (this.shutdown.signal.aborted) return this.result(false)
      if (loaded.source === "live") {
        this.registerModels(loaded.models)
        const available = new Set(this.models.map((model) => model.id))
        this.status = {
          ...this.status,
          source: "live",
          lastSuccess: this.now(),
          unavailableModelIds: [...this.enabledModelIds].filter((id) => !available.has(id)).sort(),
        }
        this.setWarning(loaded.warning)
        return this.result(true)
      }
      // Preserve newer in-memory entries and known removals if the cache write failed.
      const fallback = new Map(
        loaded.models
          .filter((model) => !this.status.unavailableModelIds.includes(model.id))
          .map((model) => [model.id, model]),
      )
      for (const model of this.models) fallback.set(model.id, model)
      const changed = this.registerModels([...fallback.values()])
      if (this.status.source !== "live" && loaded.source === "cache") {
        this.status = { ...this.status, source: "cache" }
      }
      this.setWarning(loaded.warning)
      return this.result(changed && this.models.length > 0)
    } catch (error) {
      if (!this.shutdown.signal.aborted) {
        if (!this.providerRegistered) this.registerModels([])
        this.setWarning(`Could not refresh the Command Code model catalog: ${errorMessage(error)}`)
      }
      return this.result(false)
    } finally {
      this.status = { ...this.status, refreshing: false }
    }
  }

  private unavailableWarning(): string | undefined {
    return this.status.unavailableModelIds.length > 0
      ? `Enabled Command Code models unavailable in the latest successful Provider API catalog: ${this.status.unavailableModelIds.join(", ")}.`
      : undefined
  }

  private result(refreshed: boolean): CommandCodeRefreshResult {
    return {
      refreshed,
      source: this.status.source,
      modelCount: this.status.modelCount,
      warning: this.status.warning,
    }
  }

  private setWarning(message: string | undefined): void {
    this.diagnosticWarning = message ? redactDiagnosticText(message) : undefined
    const unavailable = this.unavailableWarning()
    const warning = [this.diagnosticWarning, unavailable].filter(Boolean).join(" ") || undefined
    const changed = warning !== this.status.warning
    this.status = { ...this.status, warning }
    if (!this.diagnosticWarning) this.notifiedWarning = undefined
    if (!unavailable) this.notifiedUnavailable = undefined
    try {
      if (warning && changed) this.logWarning(warning)
      this.notifyWarning()
    } catch {
      // Diagnostics must never make a catalog refresh fail.
    }
  }

  private notifyWarning(): void {
    if (!this.context) return
    if (this.diagnosticWarning && this.diagnosticWarning !== this.notifiedWarning) {
      this.context.ui.notify(this.diagnosticWarning, "warning")
      this.notifiedWarning = this.diagnosticWarning
    }
    const unavailable = this.unavailableWarning()
    if (unavailable && unavailable !== this.notifiedUnavailable) {
      this.context.ui.notify(unavailable, "warning")
      this.notifiedUnavailable = unavailable
    }
  }

  private registerCommands(): void {
    this.pi.registerCommand("commandcode-refresh", {
      description: "Refresh the Command Code model catalog",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle?.()
        this.attachContext(ctx)
        // A manual refresh re-reads the INI after an older background refresh finishes.
        // Other overlapping refreshes still share their existing request.
        if (this.refreshPromise) await this.refreshPromise
        const result = await this.refresh()
        if (result.refreshed) {
          ctx.ui.notify(
            `Command Code model catalog refreshed (${result.modelCount} models from ${result.source}).`,
            "info",
          )
        } else {
          ctx.ui.notify(
            `Command Code model catalog unchanged (${result.modelCount} models remain available).`,
            result.warning ? "warning" : "info",
          )
        }
      },
    })

    this.pi.registerCommand("commandcode-status", {
      description: "Show redacted Command Code provider diagnostics",
      handler: async (_args, ctx) => {
        const status = this.getStatus()
        ctx.ui.notify(formatCommandCodeStatus(status), status.warning ? "warning" : "info")
      },
    })
  }
}

export function createCommandCodeRuntime<
  TProviderConfig,
  TContext extends CommandCodeCommandContext,
>(
  pi: CommandCodeRuntimeApi<TProviderConfig, TContext>,
  options: CommandCodeRuntimeOptions<TProviderConfig>,
): CommandCodeRuntime<TProviderConfig, TContext> {
  return new CommandCodeRuntime(pi, options)
}
