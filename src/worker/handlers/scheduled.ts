import { processExpiredMailboxTrash } from '../../modules/mailbox/public'
import { ensurePendingConversationRebuildTasks } from '../../modules/mail-conversations/public'
import { ensurePendingMessageIndexTasks } from '../../modules/mail-search/public'
import { ensurePendingOrganizationCleanupTasks } from '../../modules/organizations/public'
import {
  completeScheduledMaintenanceRun,
  failScheduledMaintenanceRun,
  startScheduledMaintenanceRun,
} from '../../modules/operations-health/public'
import {
  expirePlatformCapacityReservations,
  refreshConfiguredPlatformResources,
} from '../../modules/platform-resources/public'
import { expireLogicalStorageReservations } from '../../modules/storage-quotas/public'
import { enqueueDueBackgroundTasks } from '../../modules/tasks/public'
import { parseStorageMode, type WorkerBindings } from '../bindings'

export async function handleScheduledMaintenance(environment: WorkerBindings): Promise<void> {
  const run = await startScheduledMaintenanceRun({ database: environment.DB })
  let currentStep = 'expired_mailbox_trash'
  try {
    await processExpiredMailboxTrash({ database: environment.DB })
    currentStep = 'pending_search_tasks'
    await ensurePendingMessageIndexTasks({
      database: environment.DB,
      queue: environment.TASK_QUEUE,
    })
    currentStep = 'pending_conversation_tasks'
    await ensurePendingConversationRebuildTasks({
      database: environment.DB,
      queue: environment.TASK_QUEUE,
    })
    currentStep = 'pending_organization_cleanup'
    await ensurePendingOrganizationCleanupTasks({ database: environment.DB })
    currentStep = 'due_background_tasks'
    await enqueueDueBackgroundTasks({
      database: environment.DB,
      queue: environment.TASK_QUEUE,
    })
    currentStep = 'platform_resources'
    await refreshConfiguredPlatformResources({
      database: environment.DB,
      storageMode: parseStorageMode(environment.STORAGE_MODE),
      ...(environment.CONFIG_KEY ? { encryptionKeyBase64: environment.CONFIG_KEY } : {}),
    })
    currentStep = 'platform_capacity_reservations'
    await expirePlatformCapacityReservations(environment.DB)
    currentStep = 'logical_storage_reservations'
    await expireLogicalStorageReservations(environment.DB)
    await completeScheduledMaintenanceRun({ database: environment.DB, run })
  } catch (error) {
    try {
      await failScheduledMaintenanceRun({ database: environment.DB, run, step: currentStep })
    } catch {
      // 保留原始维护错误；心跳写入失败由 Worker 平台错误记录暴露。
    }
    throw error
  }
}
