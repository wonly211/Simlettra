import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test'
import { beforeEach } from 'vitest'

interface TestEnvironment extends Env {
  TEST_MIGRATIONS: D1Migration[]
}

const testEnvironment = env as TestEnvironment

beforeEach(async () => {
  await reset()
  await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS)
})
