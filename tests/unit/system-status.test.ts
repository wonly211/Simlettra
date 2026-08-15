import { describe, expect, it } from 'vitest'
import { buildSystemStatus } from '../../src/modules/system/public'

describe('系统状态应用服务', () => {
  it('返回稳定且不包含敏感信息的未初始化状态', () => {
    const checkedAt = new Date('2026-08-11T08:00:00.000Z')

    expect(buildSystemStatus(false, 'r2', () => checkedAt)).toEqual({
      data: {
        application: 'Simlettra',
        displayName: '澄笺',
        version: '0.1.0-dev.0',
        health: 'ok',
        initialization: 'not_initialized',
        storageMode: 'r2',
        checkedAt: '2026-08-11T08:00:00.000Z',
      },
    })
  })
})
