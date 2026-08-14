export const MAIL_AUTO_REFRESH_INTERVAL_MS = 60_000

const FAILURE_DELAYS_MS = [120_000, 300_000, 600_000] as const
const MAX_FAILURE_DELAY_MS = 600_000

export interface MailAutoRefreshScheduler {
  start(options?: { immediate?: boolean }): void
  pause(): void
  stop(): void
}

export function autoRefreshDelay(failureCount: number): number {
  if (failureCount <= 0) return MAIL_AUTO_REFRESH_INTERVAL_MS
  return (
    FAILURE_DELAYS_MS[Math.min(failureCount - 1, FAILURE_DELAYS_MS.length - 1)] ??
    MAX_FAILURE_DELAY_MS
  )
}

export function createMailAutoRefreshScheduler<TimerHandle>(options: {
  refresh: () => Promise<boolean>
  schedule: (callback: () => void, delayMs: number) => TimerHandle
  cancel: (handle: TimerHandle) => void
}): MailAutoRefreshScheduler {
  let active = false
  let running = false
  let failureCount = 0
  let timer: TimerHandle | null = null

  function clearScheduledRefresh() {
    if (timer === null) return
    options.cancel(timer)
    timer = null
  }

  function scheduleNextRefresh() {
    if (!active) return
    clearScheduledRefresh()
    timer = options.schedule(() => {
      timer = null
      void runRefresh()
    }, autoRefreshDelay(failureCount))
  }

  async function runRefresh() {
    if (!active || running) return
    running = true
    try {
      const succeeded = await options.refresh()
      failureCount = succeeded ? 0 : failureCount + 1
    } catch {
      failureCount += 1
    } finally {
      running = false
      scheduleNextRefresh()
    }
  }

  return {
    start({ immediate = false } = {}) {
      active = true
      failureCount = 0
      clearScheduledRefresh()
      if (immediate) void runRefresh()
      else scheduleNextRefresh()
    },
    pause() {
      active = false
      clearScheduledRefresh()
    },
    stop() {
      active = false
      failureCount = 0
      clearScheduledRefresh()
    },
  }
}
