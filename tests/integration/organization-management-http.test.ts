import { env, exports as workerExports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/shared/contracts/authentication'
import { encodeInitializationKeyHeader } from '../../src/shared/contracts/initialization-key-header'
import type {
  CreateOrganizationResponse,
  OrganizationOverviewResponse,
} from '../../src/shared/contracts/organization-management'
import type { BackgroundTaskMessage } from '../../src/shared/contracts/background-task'
import type { CreateManagedUserResponse } from '../../src/shared/contracts/user-management'
import { processLifecycleCleanupTask } from '../../src/modules/identity/public'
import type { MailObjectStore } from '../../src/modules/mail-receiving/infrastructure/object-storage'
import { ensurePendingOrganizationCleanupTasks } from '../../src/modules/organizations/public'
import {
  enqueueDueBackgroundTasks,
  processBackgroundTaskMessage,
} from '../../src/modules/tasks/public'

const testEnvironment = env as Env & { INIT_KEY: string }
const origin = 'https://simlettra.test'
const administratorEmail = 'owner@example.com'
const administratorPassword = '长河-Glass-47-Quiet'

describe('组织身份与成员协作 HTTP 边界', () => {
  beforeEach(async () => {
    await initializeSystem()
  })

  it('为初始化管理员和新用户建立五个组织的默认额度', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const member = await createActiveUser(administrator, 'member-one', '成员一')

    const administratorOverview = await getOverview(administrator)
    const memberOverview = await getOverview(member.session)
    expect(administratorOverview.data.policy).toEqual({
      organizationLimit: 5,
      ownedOrganizationCount: 0,
      remainingOrganizationCount: 5,
      overLimit: false,
    })
    expect(memberOverview.data.policy.organizationLimit).toBe(5)

    const policyRow = await env.DB.prepare(
      'SELECT organization_limit FROM user_organization_policies WHERE user_id = ?1',
    )
      .bind(member.userId)
      .first<{ organization_limit: number }>()
    expect(policyRow?.organization_limit).toBe(5)
  })

  it('原子建立组织、创建者成员资格和全局唯一共享地址', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const organization = await createOrganization(administrator, '家庭', 'family')

    expect(organization.data.organization).toMatchObject({
      name: '家庭',
      sharedAddress: 'family@example.com',
      status: 'active',
      isCreator: true,
      membersCanSend: false,
      canSendAsOrganization: true,
      memberCount: 1,
    })
    expect(organization.data.organization.members[0]).toMatchObject({
      primaryAddress: administratorEmail,
      role: 'creator',
    })

    const duplicate = await jsonRequest('/api/auth/organizations', {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { name: '重复地址', localPart: 'family', domainId: await getDomainId() },
    })
    expect(duplicate.status).toBe(409)

    const counts = await Promise.all(
      ['organizations', 'organization_memberships', 'email_addresses', 'address_claims'].map(
        async (table) => {
          const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number
          }>()
          return [table, row?.count ?? 0] as const
        },
      ),
    )
    expect(Object.fromEntries(counts)).toMatchObject({
      organizations: 1,
      organization_memberships: 1,
      email_addresses: 2,
      address_claims: 2,
    })
  })

  it('按人工确认策略邀请，并让成员独立接受后查看组织', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const member = await createActiveUser(administrator, 'member-two', '成员二')
    const organization = (await createOrganization(administrator, '协作组', 'team')).data
      .organization

    const invitationResponse = await jsonRequest(
      `/api/auth/organizations/${organization.id}/invitations`,
      {
        method: 'POST',
        headers: mutationHeaders(administrator),
        body: { primaryAddress: member.primaryAddress },
      },
    )
    expect(invitationResponse.status).toBe(201)
    const invitation = await invitationResponse.json<{
      data: { invitation: { id: string }; outcome: string }
    }>()
    expect(invitation.data.outcome).toBe('pending')

    const memberBefore = await getOverview(member.session)
    expect(memberBefore.data.organizations).toHaveLength(0)
    expect(memberBefore.data.pendingInvitations).toHaveLength(1)

    const accepted = await request(
      `/api/auth/organization-invitations/${invitation.data.invitation.id}/accept`,
      { method: 'POST', headers: mutationHeaders(member.session) },
    )
    expect(accepted.status).toBe(200)

    const memberAfter = await getOverview(member.session)
    expect(memberAfter.data.pendingInvitations).toHaveLength(0)
    expect(memberAfter.data.organizations[0]).toMatchObject({
      id: organization.id,
      isCreator: false,
      membersCanSend: false,
      canSendAsOrganization: false,
      memberCount: 2,
    })

    const forbiddenInvite = await jsonRequest(
      `/api/auth/organizations/${organization.id}/invitations`,
      {
        method: 'POST',
        headers: mutationHeaders(member.session),
        body: { primaryAddress: administratorEmail },
      },
    )
    expect(forbiddenInvite.status).toBe(403)

    const permission = await jsonRequest(
      `/api/auth/organizations/${organization.id}/sending-permission`,
      {
        method: 'PATCH',
        headers: mutationHeaders(administrator),
        body: { membersCanSend: true },
      },
    )
    expect(permission.status).toBe(200)
    expect((await getOverview(member.session)).data.organizations[0]?.canSendAsOrganization).toBe(
      true,
    )
  })

  it('尊重拒绝全部和自动接受两种个人邀请策略', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const rejectUser = await createActiveUser(administrator, 'reject-user', '拒绝用户')
    const autoUser = await createActiveUser(administrator, 'auto-user', '自动用户')
    const organization = (await createOrganization(administrator, '邀请策略', 'policy')).data
      .organization

    expect(await setInvitationPolicy(rejectUser.session, 'reject_all')).toBe(200)
    expect(await setInvitationPolicy(autoUser.session, 'auto_accept')).toBe(200)

    const rejected = await invite(administrator, organization.id, rejectUser.primaryAddress)
    const accepted = await invite(administrator, organization.id, autoUser.primaryAddress)
    expect((await rejected.json<{ data: { outcome: string } }>()).data.outcome).toBe('rejected')
    expect((await accepted.json<{ data: { outcome: string } }>()).data.outcome).toBe('accepted')

    expect((await getOverview(rejectUser.session)).data.organizations).toHaveLength(0)
    expect((await getOverview(autoUser.session)).data.organizations[0]?.id).toBe(organization.id)
  })

  it('成员可自行退出，创建者退出时将身份交给选定成员', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const member = await createActiveUser(administrator, 'successor', '继承成员')
    const organization = (await createOrganization(administrator, '继承组', 'handover')).data
      .organization
    await setInvitationPolicy(member.session, 'auto_accept')
    await invite(administrator, organization.id, member.primaryAddress)

    const missingSuccessor = await jsonRequest(`/api/auth/organizations/${organization.id}/leave`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { successorUserId: null, confirmed: true },
    })
    expect(missingSuccessor.status).toBe(422)

    const transferred = await jsonRequest(`/api/auth/organizations/${organization.id}/leave`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { successorUserId: member.userId, confirmed: true },
    })
    expect(transferred.status).toBe(200)
    await expect(transferred.json()).resolves.toMatchObject({
      data: { outcome: 'transferred', successorUserId: member.userId },
    })
    expect((await getOverview(administrator)).data.organizations).toHaveLength(0)
    expect((await getOverview(member.session)).data.organizations[0]).toMatchObject({
      id: organization.id,
      isCreator: true,
      canSendAsOrganization: true,
    })

    const soleOrganization = (await createOrganization(administrator, '临时组', 'temporary')).data
      .organization
    const soleExit = await jsonRequest(`/api/auth/organizations/${soleOrganization.id}/leave`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
      body: { successorUserId: null, confirmed: true },
    })
    expect(soleExit.status).toBe(200)
    expect((await soleExit.json<{ data: { outcome: string } }>()).data.outcome).toBe(
      'deletion_pending',
    )
  })

  it('只允许创建者删除组织，七天恢复期内保留地址并可恢复', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const organization = (await createOrganization(administrator, '恢复组', 'restore')).data
      .organization

    const missingConfirmation = await jsonRequest(`/api/auth/organizations/${organization.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(administrator),
      body: { confirmed: false },
    })
    expect(missingConfirmation.status).toBe(422)

    const deleted = await jsonRequest(`/api/auth/organizations/${organization.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(administrator),
      body: { confirmed: true },
    })
    expect(deleted.status).toBe(200)
    const pending = (await getOverview(administrator)).data.organizations[0]
    expect(pending).toMatchObject({
      status: 'deletion_pending',
      sharedAddress: 'restore@example.com',
    })
    expect(pending?.deletionDueAt).not.toBeNull()

    const duplicateAddress = await createOrganizationRequest(
      administrator,
      '重复恢复地址',
      'restore',
    )
    expect(duplicateAddress.status).toBe(409)

    const restored = await request(`/api/auth/organizations/${organization.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    expect(restored.status).toBe(200)
    expect((await getOverview(administrator)).data.organizations[0]?.status).toBe('active')
  })

  it('升级前已经等待删除但缺少删除账本的组织仍可在冷静期内恢复', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const organization = (await createOrganization(administrator, '旧版恢复组', 'legacy-restore'))
      .data.organization

    const deleted = await jsonRequest(`/api/auth/organizations/${organization.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(administrator),
      body: { confirmed: true },
    })
    expect(deleted.status).toBe(200)
    await removeOrganizationCleanupLedger(organization.id)

    const restored = await request(`/api/auth/organizations/${organization.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders(administrator),
    })
    expect(restored.status).toBe(200)
    expect((await getOverview(administrator)).data.organizations[0]).toMatchObject({
      id: organization.id,
      status: 'active',
      sharedAddress: 'legacy-restore@example.com',
    })
  })

  it('定时维护为旧版待删除组织补建账本并在到期后完成永久清理', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const organization = (await createOrganization(administrator, '旧版清理组', 'legacy-cleanup'))
      .data.organization
    const deleted = await jsonRequest(`/api/auth/organizations/${organization.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(administrator),
      body: { confirmed: true },
    })
    expect(deleted.status).toBe(200)
    const deletionState = await env.DB.prepare(
      `SELECT deletion_requested_at, deletion_due_at FROM organizations WHERE id = ?1`,
    )
      .bind(organization.id)
      .first<{ deletion_requested_at: number; deletion_due_at: number }>()
    if (!deletionState) throw new Error('缺少组织删除时间')
    await removeOrganizationCleanupLedger(organization.id)
    const maintenanceAt = Date.now()
    const legacyRequestedAt = maintenanceAt - 8 * 24 * 60 * 60 * 1000
    const legacyDueAt = maintenanceAt - 24 * 60 * 60 * 1000
    await env.DB.prepare(
      `UPDATE organizations
       SET deletion_requested_at = ?1, deletion_due_at = ?2, updated_at = ?3
       WHERE id = ?4 AND status = 'deletion_pending'`,
    )
      .bind(legacyRequestedAt, legacyDueAt, maintenanceAt, organization.id)
      .run()

    const queued: BackgroundTaskMessage[] = []
    const queue = {
      async sendBatch(messages: Iterable<{ body: BackgroundTaskMessage }>) {
        queued.push(...[...messages].map((message) => message.body))
      },
    } as unknown as Queue<BackgroundTaskMessage>
    await expect(
      ensurePendingOrganizationCleanupTasks({ database: env.DB, now: maintenanceAt }),
    ).resolves.toBe(1)
    await expect(
      enqueueDueBackgroundTasks({ database: env.DB, queue, now: maintenanceAt }),
    ).resolves.toBeGreaterThanOrEqual(1)

    const operation = await env.DB.prepare(
      `SELECT operation.id, operation.policy_version, operation.requested_at,
              operation.recovery_due_at, task.id AS task_id
       FROM deletion_operations AS operation
       JOIN background_tasks AS task
         ON task.task_type = 'organization_cleanup'
        AND task.target_type = 'deletion_operation'
        AND task.target_reference = operation.id
       WHERE operation.operation_kind = 'organization_delete'
         AND operation.target_reference = ?1`,
    )
      .bind(organization.id)
      .first<{
        id: string
        policy_version: number
        requested_at: number
        recovery_due_at: number
        task_id: string
      }>()
    if (!operation) throw new Error('定时维护没有补建组织删除账本')
    expect(operation.requested_at).toBe(legacyRequestedAt)
    expect(operation.recovery_due_at).toBe(legacyDueAt)
    expect(await countOrganizationCleanupSteps(operation.id)).toBe(7)

    const dueMessage = queued.find((message) => message.taskId === operation.task_id)
    expect(dueMessage).toEqual({
      taskId: operation.task_id,
      inputVersion: operation.policy_version,
    })
    if (!dueMessage) throw new Error('到期组织清理任务没有进入队列')
    await expect(
      processBackgroundTaskMessage({
        database: env.DB,
        message: dueMessage,
        workerReference: 'legacy-organization-cleanup',
        now: maintenanceAt,
        executeTask: (context) =>
          processLifecycleCleanupTask({
            database: context.database,
            objectStore: emptyObjectStore,
            deletionOperationId: context.targetReference,
            inputVersion: context.inputVersion,
            now: context.now,
          }),
      }),
    ).resolves.toBe('completed')

    const cleaned = await env.DB.prepare(
      `SELECT organization.status, organization.name, operation.operation_status,
              task.task_status,
              EXISTS (
                SELECT 1 FROM address_claims WHERE canonical_address = 'legacy-cleanup@example.com'
              ) AS address_claim_exists
       FROM organizations AS organization
       JOIN deletion_operations AS operation
         ON operation.target_reference = organization.id
        AND operation.operation_kind = 'organization_delete'
       JOIN background_tasks AS task
         ON task.target_reference = operation.id AND task.task_type = 'organization_cleanup'
       WHERE organization.id = ?1`,
    )
      .bind(organization.id)
      .first<{
        status: string
        name: string
        operation_status: string
        task_status: string
        address_claim_exists: number
      }>()
    expect(cleaned).toEqual({
      status: 'deleting',
      name: '已删除组织',
      operation_status: 'completed',
      task_status: 'succeeded',
      address_claim_exists: 0,
    })
  })

  it('系统管理员可调整每个用户的组织额度，调低额度不会删除已有组织', async () => {
    const administrator = extractAuthenticationCookies(await login())
    const organization = (await createOrganization(administrator, '保留组', 'kept')).data
      .organization
    expect(organization.id).toBeTruthy()

    const administratorId = (await getOverview(administrator)).data.organizations[0]?.creatorUserId
    if (!administratorId) throw new Error('缺少管理员标识')
    const update = await jsonRequest(
      `/api/auth/administrator/users/${administratorId}/organization-policy`,
      {
        method: 'PATCH',
        headers: mutationHeaders(administrator),
        body: { organizationLimit: 0 },
      },
    )
    expect(update.status).toBe(200)
    await expect(update.json()).resolves.toMatchObject({
      data: {
        user: {
          policy: {
            organizationLimit: 0,
            ownedOrganizationCount: 1,
            overLimit: true,
          },
        },
      },
    })
    expect((await getOverview(administrator)).data.organizations).toHaveLength(1)
    expect((await createOrganizationRequest(administrator, '超额组', 'blocked')).status).toBe(409)
  })
})

async function initializeSystem() {
  const response = await jsonRequest('/api/initialization/complete', {
    method: 'POST',
    headers: {
      'X-Simlettra-Init-Key': encodeInitializationKeyHeader(testEnvironment.INIT_KEY),
    },
    body: {
      adminDisplayName: '系统管理员',
      domainName: 'example.com',
      localPart: 'owner',
      password: administratorPassword,
      timezone: 'Asia/Shanghai',
    },
  })
  expect(response.status).toBe(201)
}

async function createActiveUser(
  administrator: AuthenticationCookies,
  localPart: string,
  displayName: string,
) {
  const createResponse = await jsonRequest('/api/auth/administrator/users', {
    method: 'POST',
    headers: mutationHeaders(administrator),
    body: {
      displayName,
      localPart,
      domainId: await getDomainId(),
      timezone: 'Asia/Shanghai',
    },
  })
  expect(createResponse.status).toBe(201)
  const created = await createResponse.json<CreateManagedUserResponse>()
  const temporary = extractAuthenticationCookies(
    await login(created.data.user.primaryAddress, created.data.temporaryPassword),
  )
  const newPassword = '星海-Quartz-82-Calm!'
  const changed = await jsonRequest('/api/auth/password/complete-required-change', {
    method: 'POST',
    headers: mutationHeaders(temporary),
    body: { newPassword },
  })
  expect(changed.status).toBe(200)
  return {
    userId: created.data.user.id,
    primaryAddress: created.data.user.primaryAddress,
    session: temporary,
  }
}

async function getOverview(session: AuthenticationCookies) {
  const response = await request('/api/auth/organizations', { headers: session.headers })
  expect(response.status).toBe(200)
  return response.json<OrganizationOverviewResponse>()
}

async function createOrganization(session: AuthenticationCookies, name: string, localPart: string) {
  const response = await createOrganizationRequest(session, name, localPart)
  expect(response.status).toBe(201)
  return response.json<CreateOrganizationResponse>()
}

async function createOrganizationRequest(
  session: AuthenticationCookies,
  name: string,
  localPart: string,
) {
  return jsonRequest('/api/auth/organizations', {
    method: 'POST',
    headers: mutationHeaders(session),
    body: { name, localPart, domainId: await getDomainId() },
  })
}

function invite(session: AuthenticationCookies, organizationId: string, primaryAddress: string) {
  return jsonRequest(`/api/auth/organizations/${organizationId}/invitations`, {
    method: 'POST',
    headers: mutationHeaders(session),
    body: { primaryAddress },
  })
}

async function setInvitationPolicy(
  session: AuthenticationCookies,
  invitationPolicy: 'reject_all' | 'manual' | 'auto_accept',
) {
  return (
    await jsonRequest('/api/auth/organization-invitation-policy', {
      method: 'PATCH',
      headers: mutationHeaders(session),
      body: { invitationPolicy },
    })
  ).status
}

async function getDomainId(): Promise<string> {
  const domain = await env.DB.prepare(
    "SELECT id FROM mail_domains WHERE canonical_name = 'example.com'",
  ).first<{ id: string }>()
  if (!domain) throw new Error('测试域名不存在')
  return domain.id
}

function login(
  email = administratorEmail,
  password = administratorPassword,
  source = '203.0.113.180',
) {
  return jsonRequest('/api/auth/login', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': source,
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
    },
    body: { email, password },
  })
}

function request(path: string, init?: RequestInit) {
  return workerExports.default.fetch(new Request(`${origin}${path}`, init))
}

function jsonRequest(
  path: string,
  options: Omit<RequestInit, 'body'> & { body?: Record<string, unknown> },
) {
  const { body, ...requestOptions } = options
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (!headers.has('Origin')) headers.set('Origin', origin)
  return request(path, {
    ...requestOptions,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

interface AuthenticationCookies {
  cookie: string
  csrfToken: string
  headers: { Cookie: string }
}

function extractAuthenticationCookies(response: Response): AuthenticationCookies {
  const header = response.headers.get('set-cookie') ?? ''
  const sessionToken = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  const csrfToken = header.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;,]+)`, 'u'))?.[1]
  if (!sessionToken || !csrfToken) throw new Error('登录响应缺少认证 Cookie')
  const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`
  return { cookie, csrfToken, headers: { Cookie: cookie } }
}

function mutationHeaders(session: AuthenticationCookies) {
  return {
    Cookie: session.cookie,
    Origin: origin,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'CF-Connecting-IP': '203.0.113.180',
    'User-Agent': 'Mozilla/5.0 Chrome/140 Windows',
  }
}

const emptyObjectStore: MailObjectStore = {
  mode: 'r2',
  async put() {
    return null
  },
  async get() {
    return null
  },
  async delete() {},
}

async function removeOrganizationCleanupLedger(organizationId: string) {
  const operation = await env.DB.prepare(
    `SELECT id FROM deletion_operations
     WHERE operation_kind = 'organization_delete' AND target_reference = ?1`,
  )
    .bind(organizationId)
    .first<{ id: string }>()
  if (!operation) throw new Error('缺少待移除的组织删除账本')
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM background_tasks
       WHERE task_type = 'organization_cleanup' AND target_reference = ?1`,
    ).bind(operation.id),
    env.DB.prepare('DELETE FROM deletion_operations WHERE id = ?1').bind(operation.id),
  ])
}

async function countOrganizationCleanupSteps(operationId: string) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM deletion_operation_steps WHERE deletion_operation_id = ?1',
  )
    .bind(operationId)
    .first<{ count: number }>()
  return row?.count ?? 0
}
