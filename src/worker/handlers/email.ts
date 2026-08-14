import { createMailObjectStore, receiveIncomingMail } from '../../modules/mail-receiving/public'
import { parseStorageMode, type WorkerBindings } from '../bindings'

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  environment: WorkerBindings,
): Promise<void> {
  await receiveIncomingMail({
    database: environment.DB,
    queue: environment.TASK_QUEUE,
    store: createMailObjectStore(environment, parseStorageMode(environment.STORAGE_MODE)),
    message,
  })
}
