import type { BackgroundTaskMessage } from '../../shared/contracts/background-task'
import {
  createMailObjectStore,
  processReceiveParsingTask,
  processReceiveRouteCommitTask,
} from '../../modules/mail-receiving/public'
import { processMessageIndexTask } from '../../modules/mail-search/public'
import { processMessageConversationTask } from '../../modules/mail-conversations/public'
import { isBackgroundTaskMessage, processBackgroundTaskMessage } from '../../modules/tasks/public'
import { processMailboxDeletionTask } from '../../modules/mailbox/public'
import { processNotificationTask } from '../../modules/notifications/public'
import { processMailForwardTask } from '../../modules/forwarding/public'
import { processOutboundSendTask } from '../../modules/sending/public'
import { processMailExportCleanupTask, processMailExportTask } from '../../modules/exports/public'
import { processSystemBackupTask } from '../../modules/backups/public'
import { processLifecycleCleanupTask } from '../../modules/identity/public'
import { parseStorageMode, type WorkerBindings } from '../bindings'

export async function handleBackgroundTaskQueue(
  batch: MessageBatch<BackgroundTaskMessage>,
  environment: WorkerBindings,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isBackgroundTaskMessage(message.body)) {
      message.ack()
      continue
    }
    try {
      let retryAt: number | null = null
      await processBackgroundTaskMessage({
        database: environment.DB,
        message: message.body,
        workerReference: `queue:${message.id}`,
        onRetryScheduled: (nextAttemptAt) => {
          retryAt = nextAttemptAt
        },
        executeTask: async (task) => {
          const objectStore = createMailObjectStore(
            environment,
            parseStorageMode(environment.STORAGE_MODE),
          )
          if (task.taskType === 'receive_parse' && task.targetType === 'receive_operation') {
            return processReceiveParsingTask({
              database: environment.DB,
              store: objectStore,
              queue: environment.TASK_QUEUE,
              operationId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'receive_route_commit' && task.targetType === 'receive_route') {
            return processReceiveRouteCommitTask({
              database: environment.DB,
              store: objectStore,
              queue: environment.TASK_QUEUE,
              routeId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'index_message' && task.targetType === 'message_search') {
            return processMessageIndexTask({
              database: environment.DB,
              objectStore,
              messageId: task.targetReference,
              inputVersion: task.inputVersion,
              now: task.now,
            })
          }
          if (
            task.taskType === 'rebuild_conversation' &&
            task.targetType === 'message_conversation'
          ) {
            return processMessageConversationTask({
              database: environment.DB,
              messageId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'mailbox_delete' && task.targetType === 'deletion_operation') {
            return processMailboxDeletionTask({
              database: environment.DB,
              objectStore,
              deletionOperationId: task.targetReference,
              inputVersion: task.inputVersion,
              now: task.now,
            })
          }
          if (task.taskType === 'submit_outbound_send' && task.targetType === 'send_operation') {
            return processOutboundSendTask({
              database: environment.DB,
              objectStore,
              ...(environment.CONFIG_KEY ? { encryptionKeyBase64: environment.CONFIG_KEY } : {}),
              sendOperationId: task.targetReference,
              now: task.now,
            })
          }
          if (
            task.taskType === 'send_notification' &&
            task.targetType === 'notification_operation'
          ) {
            return processNotificationTask({
              database: environment.DB,
              objectStore,
              ...(environment.CONFIG_KEY ? { encryptionKeyBase64: environment.CONFIG_KEY } : {}),
              taskId: task.taskId,
              operationId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'forward_mail' && task.targetType === 'mail_forward_operation') {
            return processMailForwardTask({
              database: environment.DB,
              objectStore,
              ...(environment.CONFIG_KEY ? { encryptionKeyBase64: environment.CONFIG_KEY } : {}),
              operationId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'generate_mail_export' && task.targetType === 'export_run') {
            return processMailExportTask({
              database: environment.DB,
              objectStore,
              storageMode: parseStorageMode(environment.STORAGE_MODE),
              queue: environment.TASK_QUEUE,
              taskId: task.taskId,
              exportRunId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'cleanup_mail_export' && task.targetType === 'export_run') {
            return processMailExportCleanupTask({
              database: environment.DB,
              objectStore,
              exportRunId: task.targetReference,
              now: task.now,
            })
          }
          if (task.taskType === 'generate_system_backup' && task.targetType === 'backup_run') {
            return processSystemBackupTask({
              database: environment.DB,
              objectStore,
              storageMode: parseStorageMode(environment.STORAGE_MODE),
              queue: environment.TASK_QUEUE,
              backupRunId: task.targetReference,
              now: task.now,
            })
          }
          if (
            (task.taskType === 'user_cleanup' || task.taskType === 'organization_cleanup') &&
            task.targetType === 'deletion_operation'
          ) {
            return processLifecycleCleanupTask({
              database: environment.DB,
              objectStore,
              deletionOperationId: task.targetReference,
              inputVersion: task.inputVersion,
              now: task.now,
            })
          }
          return { status: 'needs_attention', errorCode: 'unsupported_task_type' }
        },
      })
      if (retryAt === null) {
        message.ack()
      } else {
        const delaySeconds = Math.min(43_200, Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)))
        message.retry({ delaySeconds })
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'background_task_queue_error',
          taskId: message.body.taskId,
          inputVersion: message.body.inputVersion,
          errorName: error instanceof Error ? error.name : 'unknown_error',
        }),
      )
      message.retry()
    }
  }
}
