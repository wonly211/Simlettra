import { handleIncomingEmail } from './handlers/email'
import { handleBackgroundTaskQueue } from './handlers/queue'
import { handleScheduledMaintenance } from './handlers/scheduled'
import { createHttpApp } from './http/create-http-app'
import type { WorkerBindings } from './bindings'
import type { BackgroundTaskMessage } from '../shared/contracts/background-task'

const httpApp = createHttpApp()

export default {
  fetch: httpApp.fetch,
  email(message, environment) {
    return handleIncomingEmail(message, environment)
  },
  queue(batch, environment) {
    return handleBackgroundTaskQueue(batch, environment)
  },
  scheduled(_controller, environment, context) {
    context.waitUntil(handleScheduledMaintenance(environment))
  },
} satisfies ExportedHandler<WorkerBindings, BackgroundTaskMessage>
