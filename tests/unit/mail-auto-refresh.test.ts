import { describe, expect, it, vi } from 'vitest'
import {
  MAIL_AUTO_REFRESH_INTERVAL_MS,
  autoRefreshDelay,
  createMailAutoRefreshScheduler,
} from '../../src/web/mail-auto-refresh'

describe('邮件自动刷新调度器', () => {
  it('正常情况下每 60 秒检查一次，并在恢复时立即检查', async () => {
    const harness = createHarness([true, true])

    harness.scheduler.start()
    expect(harness.latestDelay()).toBe(MAIL_AUTO_REFRESH_INTERVAL_MS)

    await harness.runLatest()
    expect(harness.refresh).toHaveBeenCalledTimes(1)
    expect(harness.latestDelay()).toBe(MAIL_AUTO_REFRESH_INTERVAL_MS)

    harness.scheduler.pause()
    expect(harness.cancel).toHaveBeenCalledTimes(1)

    harness.scheduler.start({ immediate: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.refresh).toHaveBeenCalledTimes(2)
    expect(harness.latestDelay()).toBe(MAIL_AUTO_REFRESH_INTERVAL_MS)
  })

  it('连续失败时逐步延长到十分钟，并在成功后恢复 60 秒', async () => {
    const harness = createHarness([false, false, false, false, true])

    harness.scheduler.start()
    await harness.runLatest()
    expect(harness.latestDelay()).toBe(120_000)
    await harness.runLatest()
    expect(harness.latestDelay()).toBe(300_000)
    await harness.runLatest()
    expect(harness.latestDelay()).toBe(600_000)
    await harness.runLatest()
    expect(harness.latestDelay()).toBe(600_000)
    await harness.runLatest()
    expect(harness.latestDelay()).toBe(MAIL_AUTO_REFRESH_INTERVAL_MS)
  })

  it('暂停或停止后不再执行已经安排的检查', async () => {
    const harness = createHarness([true])

    harness.scheduler.start()
    const scheduled = harness.latestCallback()
    harness.scheduler.stop()
    await scheduled()

    expect(harness.refresh).not.toHaveBeenCalled()
    expect(harness.cancel).toHaveBeenCalledTimes(1)
  })
})

function createHarness(results: boolean[]) {
  const callbacks: Array<() => void> = []
  const delays: number[] = []
  let nextHandle = 0
  const refresh = vi.fn(async () => results.shift() ?? true)
  const cancel = vi.fn()
  const scheduler = createMailAutoRefreshScheduler({
    refresh,
    schedule(callback, delayMs) {
      callbacks.push(callback)
      delays.push(delayMs)
      nextHandle += 1
      return nextHandle
    },
    cancel,
  })

  return {
    scheduler,
    refresh,
    cancel,
    latestDelay: () => delays.at(-1),
    latestCallback: () => callbacks.at(-1) ?? (() => undefined),
    async runLatest() {
      const callback = callbacks.at(-1)
      if (!callback) throw new Error('没有待执行的自动刷新')
      callback()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('自动刷新退避间隔', () => {
  it('使用 60 秒、2 分钟、5 分钟和 10 分钟上限', () => {
    expect(autoRefreshDelay(0)).toBe(60_000)
    expect(autoRefreshDelay(1)).toBe(120_000)
    expect(autoRefreshDelay(2)).toBe(300_000)
    expect(autoRefreshDelay(3)).toBe(600_000)
    expect(autoRefreshDelay(20)).toBe(600_000)
  })
})
