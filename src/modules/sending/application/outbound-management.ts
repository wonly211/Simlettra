import type {
  OutboundManagementOverviewResponse,
  OutboundProviderSummary,
  OutboundProviderType,
  OutboundRouteSummary,
  OutboundUserDailyQuotaSummary,
  OutboundDomainMonthlyQuotaSummary,
  SaveDomainOutboundRouteRequest,
  SaveOutboundProviderRequest,
} from '../../../shared/contracts/sending'
import { createAuditEventStatement, type AuditContext } from '../../audit/public'

const PROVIDER_CREDENTIAL_ALGORITHM = 'AES-GCM-256'

export class OutboundPermissionError extends Error {}

export class OutboundConfigurationError extends Error {
  constructor(
    readonly field:
      | 'encryptionKey'
      | 'providerId'
      | 'displayName'
      | 'providerType'
      | 'credential'
      | 'callbackUsername'
      | 'callbackSecret'
      | 'domainId'
      | 'providerConfigIds'
      | 'userId'
      | 'limit',
    message: string,
  ) {
    super(message)
  }
}

interface ProviderRow {
  id: string
  configuration_key: string
  configuration_version: number
  display_name: string
  provider_type: string
  credential_ciphertext: ArrayBuffer
  credential_nonce: ArrayBuffer
  configuration_status: string
  last_tested_at: number | null
  last_test_result: string | null
  last_test_summary: string | null
}

interface RouteRow {
  id: string
  mail_domain_id: string
  canonical_name: string
  route_version: number
  route_status: string
}

interface ProviderRouteRow {
  route_id: string
  mail_domain_id: string
  route_version: number
  priority_number: number
  provider_config_id: string
}

export interface OutboundSecrets {
  credential: string
  callbackUsername: string | null
  callbackSecret: string
}

export async function getOutboundManagementOverview(options: {
  database: D1Database
  actorUserId: string
  encryptionKeyBase64?: string
}): Promise<OutboundManagementOverviewResponse['data']> {
  await requireAdministrator(options.database, options.actorUserId)
  const key = await importEncryptionKey(options.encryptionKeyBase64, false)
  const providers = await listCurrentProviders(options.database)
  const routes = await listActiveRoutes(options.database)
  const dailyDefaultRecipientLimit = await loadDailyDefaultLimit(options.database)
  const domainMonthlyDefaultLimit = await loadDomainMonthlyDefaultLimit(options.database)
  const [userDailyQuotas, domainMonthlyQuotas] = await Promise.all([
    listUserDailyQuotas(options.database, dailyDefaultRecipientLimit, Date.now()),
    listDomainMonthlyQuotas(options.database),
  ])
  return {
    encryptionConfigured: key !== null,
    providers: await Promise.all(providers.map((provider) => providerSummary(provider, key))),
    routes: await Promise.all(routes.map((route) => routeSummary(options.database, route))),
    dailyDefaultRecipientLimit,
    domainMonthlyDefaultLimit,
    userDailyQuotas,
    domainMonthlyQuotas,
  }
}

export async function saveOutboundProvider(options: {
  database: D1Database
  actorUserId: string
  encryptionKeyBase64?: string
  input: SaveOutboundProviderRequest
  audit: AuditContext
  now?: number
}): Promise<OutboundProviderSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  const key = await importEncryptionKey(options.encryptionKeyBase64, true)
  const input = normalizeProviderInput(options.input)
  const now = options.now ?? Date.now()
  const previous = input.id
    ? await options.database
        .prepare(
          `SELECT id, configuration_key, configuration_version
           FROM outbound_provider_configs
           WHERE id = ?1 AND configuration_status <> 'retired' LIMIT 1`,
        )
        .bind(input.id)
        .first<{ id: string; configuration_key: string; configuration_version: number }>()
    : null
  if (input.id && !previous) {
    throw new OutboundConfigurationError('providerId', '发信服务配置不存在')
  }

  const id = crypto.randomUUID()
  const configurationKey = previous?.configuration_key ?? crypto.randomUUID()
  const version = (previous?.configuration_version ?? 0) + 1
  const encrypted = await encryptSecrets(key!, configurationKey, version, {
    credential: input.credential,
    callbackUsername: input.callbackUsername,
    callbackSecret: input.callbackSecret,
  })
  const affectedRoutes = previous
    ? await listRoutesUsingProvider(options.database, previous.id)
    : []
  const statements: D1PreparedStatement[] = []
  if (previous) {
    statements.push(
      options.database
        .prepare(
          `UPDATE outbound_provider_configs
           SET configuration_status = 'retired', retired_at = ?1, updated_at = ?1
           WHERE id = ?2 AND configuration_status <> 'retired'`,
        )
        .bind(now, previous.id),
    )
  }
  statements.push(
    options.database
      .prepare(
        `INSERT INTO outbound_provider_configs (
          id, configuration_key, configuration_version, display_name, provider_type,
          public_options_json, credential_ciphertext, credential_nonce,
          credential_algorithm, credential_key_version, credential_updated_at,
          configuration_status, last_tested_at, last_test_result, last_test_summary,
          disabled_at, retired_at, created_at, updated_at
         ) VALUES (
          ?1, ?2, ?3, ?4, ?5, '{}', ?6, ?7,
          ?8, 1, ?9, 'active', NULL, NULL, NULL, NULL, NULL, ?9, ?9
         )`,
      )
      .bind(
        id,
        configurationKey,
        version,
        input.displayName,
        input.providerType,
        encrypted.ciphertext,
        encrypted.nonce,
        PROVIDER_CREDENTIAL_ALGORITHM,
        now,
      ),
  )
  for (const route of groupProviderRoutes(affectedRoutes)) {
    const replacementRouteId = crypto.randomUUID()
    statements.push(
      options.database
        .prepare(
          `INSERT INTO domain_outbound_routes (
            id, mail_domain_id, route_version, route_status,
            created_at, activated_at, superseded_at, disabled_at, updated_at
           ) VALUES (?1, ?2, ?3, 'draft', ?4, NULL, NULL, NULL, ?4)`,
        )
        .bind(replacementRouteId, route.domainId, route.version + 1, now),
      ...route.entries.map((entry) =>
        options.database
          .prepare(
            `INSERT INTO domain_outbound_route_entries (
              id, route_id, priority_number, provider_config_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(
            crypto.randomUUID(),
            replacementRouteId,
            entry.priority,
            entry.providerId === previous?.id ? id : entry.providerId,
            now,
          ),
      ),
      options.database
        .prepare(
          `UPDATE domain_outbound_routes
           SET route_status = 'superseded', superseded_at = ?1, updated_at = ?1
           WHERE id = ?2 AND route_status = 'active'`,
        )
        .bind(now, route.id),
      options.database
        .prepare(
          `UPDATE domain_outbound_routes
           SET route_status = 'active', activated_at = ?1, updated_at = ?1
           WHERE id = ?2 AND route_status = 'draft'`,
        )
        .bind(now, replacementRouteId),
    )
  }
  statements.push(
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: previous ? 'outbound_provider_replaced' : 'outbound_provider_created',
      targetType: 'outbound_provider_config',
      targetReference: id,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new OutboundConfigurationError('providerId', '发信服务配置已发生变化，请刷新后重试')
  }
  const row = await findProvider(options.database, id)
  if (!row) throw new Error('发信服务配置写入后无法读取')
  return providerSummary(row, key)
}

async function listRoutesUsingProvider(
  database: D1Database,
  providerId: string,
): Promise<ProviderRouteRow[]> {
  const rows = await database
    .prepare(
      `SELECT route.id AS route_id, route.mail_domain_id, route.route_version,
              entry.priority_number, entry.provider_config_id
       FROM domain_outbound_routes route
       JOIN domain_outbound_route_entries selected
         ON selected.route_id = route.id AND selected.provider_config_id = ?1
       JOIN domain_outbound_route_entries entry ON entry.route_id = route.id
       WHERE route.route_status = 'active'
       ORDER BY route.id, entry.priority_number`,
    )
    .bind(providerId)
    .all<ProviderRouteRow>()
  return rows.results
}

function groupProviderRoutes(rows: ProviderRouteRow[]): Array<{
  id: string
  domainId: string
  version: number
  entries: Array<{ priority: number; providerId: string }>
}> {
  const routes = new Map<
    string,
    {
      id: string
      domainId: string
      version: number
      entries: Array<{ priority: number; providerId: string }>
    }
  >()
  for (const row of rows) {
    const route = routes.get(row.route_id) ?? {
      id: row.route_id,
      domainId: row.mail_domain_id,
      version: row.route_version,
      entries: [],
    }
    route.entries.push({ priority: row.priority_number, providerId: row.provider_config_id })
    routes.set(row.route_id, route)
  }
  return [...routes.values()]
}

export async function saveDomainOutboundRoute(options: {
  database: D1Database
  actorUserId: string
  domainId: string
  input: SaveDomainOutboundRouteRequest
  audit: AuditContext
  now?: number
}): Promise<OutboundRouteSummary> {
  await requireAdministrator(options.database, options.actorUserId)
  if (!isUuid(options.domainId)) {
    throw new OutboundConfigurationError('domainId', '邮件域名无效')
  }
  const providerIds = normalizeProviderConfigIds(options.input.providerConfigIds)
  const now = options.now ?? Date.now()
  const domain = await options.database
    .prepare(
      `SELECT id, canonical_name FROM mail_domains WHERE id = ?1 AND status = 'active' LIMIT 1`,
    )
    .bind(options.domainId)
    .first<{ id: string; canonical_name: string }>()
  if (!domain) throw new OutboundConfigurationError('domainId', '邮件域名不存在或已经停用')

  const placeholders = providerIds.map((_, index) => `?${index + 1}`).join(', ')
  const providers = await options.database
    .prepare(
      `SELECT id FROM outbound_provider_configs
       WHERE id IN (${placeholders}) AND configuration_status = 'active'`,
    )
    .bind(...providerIds)
    .all<{ id: string }>()
  if (providers.results.length !== providerIds.length) {
    throw new OutboundConfigurationError('providerConfigIds', '路线包含不存在或已停用的发信服务')
  }
  const current = await options.database
    .prepare(
      `SELECT id, route_version FROM domain_outbound_routes
       WHERE mail_domain_id = ?1 AND route_status = 'active' LIMIT 1`,
    )
    .bind(domain.id)
    .first<{ id: string; route_version: number }>()
  const latest = await options.database
    .prepare(
      `SELECT COALESCE(MAX(route_version), 0) AS version
       FROM domain_outbound_routes WHERE mail_domain_id = ?1`,
    )
    .bind(domain.id)
    .first<{ version: number }>()
  const id = crypto.randomUUID()
  const version = (latest?.version ?? 0) + 1
  const statements: D1PreparedStatement[] = [
    options.database
      .prepare(
        `INSERT INTO domain_outbound_routes (
          id, mail_domain_id, route_version, route_status,
          created_at, activated_at, superseded_at, disabled_at, updated_at
         ) VALUES (?1, ?2, ?3, 'draft', ?4, NULL, NULL, NULL, ?4)`,
      )
      .bind(id, domain.id, version, now),
    ...providerIds.map((providerId, index) =>
      options.database
        .prepare(
          `INSERT INTO domain_outbound_route_entries (
            id, route_id, priority_number, provider_config_id, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(crypto.randomUUID(), id, index, providerId, now),
    ),
  ]
  if (current) {
    statements.push(
      options.database
        .prepare(
          `UPDATE domain_outbound_routes
           SET route_status = 'superseded', superseded_at = ?1, updated_at = ?1
           WHERE id = ?2 AND route_status = 'active'`,
        )
        .bind(now, current.id),
    )
  }
  statements.push(
    options.database
      .prepare(
        `UPDATE domain_outbound_routes
         SET route_status = 'active', activated_at = ?1, updated_at = ?1
         WHERE id = ?2 AND route_status = 'draft'`,
      )
      .bind(now, id),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: 'domain_outbound_route_changed',
      targetType: 'mail_domain',
      targetReference: domain.id,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new OutboundConfigurationError('domainId', '域名发信路线已发生变化，请刷新后重试')
  }
  return {
    id,
    domainId: domain.id,
    domainName: domain.canonical_name,
    routeVersion: version,
    status: 'active',
    providerConfigIds: providerIds,
  }
}

export async function saveDailyDefaultQuota(options: {
  database: D1Database
  actorUserId: string
  limit: number | null
  audit: AuditContext
  now?: number
}): Promise<void> {
  await requireAdministrator(options.database, options.actorUserId)
  const limit = normalizeQuotaLimit(options.limit, false)
  await replaceQuotaPolicy({
    ...options,
    quotaKind: 'daily_send_recipients',
    scopeType: 'system_default',
    scopeId: null,
    limit,
    actionName: 'daily_send_default_quota_changed',
  })
}

export async function saveUserDailyQuota(options: {
  database: D1Database
  actorUserId: string
  userId: string
  limit: number | null
  useDefault?: boolean
  audit: AuditContext
  now?: number
}): Promise<void> {
  await requireAdministrator(options.database, options.actorUserId)
  if (!isUuid(options.userId)) throw new OutboundConfigurationError('userId', '用户无效')
  const user = await options.database
    .prepare(`SELECT id FROM users WHERE id = ?1 LIMIT 1`)
    .bind(options.userId)
    .first<{ id: string }>()
  if (!user) throw new OutboundConfigurationError('userId', '用户不存在')
  if (options.useDefault) {
    await retireQuotaOverride({
      ...options,
      quotaKind: 'daily_send_recipients',
      scopeType: 'user',
      scopeId: options.userId,
      actionName: 'user_daily_send_quota_reset',
    })
    return
  }
  const limit = normalizeQuotaLimit(options.limit, false)
  await replaceQuotaPolicy({
    ...options,
    quotaKind: 'daily_send_recipients',
    scopeType: 'user',
    scopeId: options.userId,
    limit,
    actionName: 'user_daily_send_quota_changed',
  })
}

export async function saveDomainMonthlyQuota(options: {
  database: D1Database
  actorUserId: string
  domainId: string
  limit: number | null
  useDefault?: boolean
  audit: AuditContext
  now?: number
}): Promise<void> {
  await requireAdministrator(options.database, options.actorUserId)
  if (!isUuid(options.domainId)) throw new OutboundConfigurationError('domainId', '邮件域名无效')
  const domain = await options.database
    .prepare(`SELECT id FROM mail_domains WHERE id = ?1 LIMIT 1`)
    .bind(options.domainId)
    .first<{ id: string }>()
  if (!domain) throw new OutboundConfigurationError('domainId', '邮件域名不存在')
  if (options.useDefault) {
    await retireQuotaOverride({
      ...options,
      quotaKind: 'domain_monthly_send_recipients',
      scopeType: 'domain',
      scopeId: options.domainId,
      actionName: 'domain_monthly_send_quota_reset',
    })
    return
  }
  const limit = normalizeQuotaLimit(options.limit, true)
  await replaceQuotaPolicy({
    ...options,
    quotaKind: 'domain_monthly_send_recipients',
    scopeType: 'domain',
    scopeId: options.domainId,
    limit,
    actionName: 'domain_monthly_send_quota_changed',
  })
}

export async function saveDomainMonthlyDefaultQuota(options: {
  database: D1Database
  actorUserId: string
  limit: number | null
  audit: AuditContext
  now?: number
}): Promise<void> {
  await requireAdministrator(options.database, options.actorUserId)
  const limit = normalizeQuotaLimit(options.limit, true)
  await replaceQuotaPolicy({
    ...options,
    quotaKind: 'domain_monthly_send_recipients',
    scopeType: 'system_default',
    scopeId: null,
    limit,
    actionName: 'domain_monthly_send_default_quota_changed',
  })
}

async function retireQuotaOverride(options: {
  database: D1Database
  actorUserId: string
  quotaKind: 'daily_send_recipients' | 'domain_monthly_send_recipients'
  scopeType: 'user' | 'domain'
  scopeId: string
  actionName: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  const scopeColumn = options.scopeType === 'user' ? 'user_id' : 'mail_domain_id'
  const current = await options.database
    .prepare(
      `SELECT id FROM quota_policies WHERE quota_kind = ?1 AND scope_type = '${options.scopeType}'
       AND ${scopeColumn} = ?2 AND policy_status = 'active' LIMIT 1`,
    )
    .bind(options.quotaKind, options.scopeId)
    .first<{ id: string }>()
  if (!current) return
  const results = await options.database.batch([
    options.database
      .prepare(
        `UPDATE quota_policies SET policy_status = 'retired', retired_at = ?1, updated_at = ?1
         WHERE id = ?2 AND policy_status = 'active'`,
      )
      .bind(now, current.id),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: options.actionName,
      targetType: options.scopeType === 'domain' ? 'mail_domain' : 'user',
      targetReference: options.scopeId,
      outcome: 'succeeded',
      occurredAt: now,
    }),
  ])
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new OutboundConfigurationError('limit', '发件额度已经发生变化，请刷新后重试')
  }
}

async function replaceQuotaPolicy(options: {
  database: D1Database
  actorUserId: string
  quotaKind: 'daily_send_recipients' | 'domain_monthly_send_recipients'
  scopeType: 'system_default' | 'user' | 'domain'
  scopeId: string | null
  limit: number | null
  actionName: string
  audit: AuditContext
  now?: number
}): Promise<void> {
  const now = options.now ?? Date.now()
  const scopeColumn =
    options.scopeType === 'user'
      ? 'user_id'
      : options.scopeType === 'domain'
        ? 'mail_domain_id'
        : null
  const scopePredicate = scopeColumn
    ? `${scopeColumn} = ?2`
    : 'user_id IS NULL AND mail_domain_id IS NULL'
  const binds = scopeColumn ? [options.quotaKind, options.scopeId] : [options.quotaKind]
  const current = await options.database
    .prepare(
      `SELECT id, policy_version FROM quota_policies
       WHERE quota_kind = ?1 AND scope_type = '${options.scopeType}'
         AND ${scopePredicate} AND policy_status = 'active' LIMIT 1`,
    )
    .bind(...binds)
    .first<{ id: string; policy_version: number }>()
  const latest = await options.database
    .prepare(
      `SELECT COALESCE(MAX(policy_version), 0) AS version FROM quota_policies
       WHERE quota_kind = ?1 AND scope_type = '${options.scopeType}' AND ${scopePredicate}`,
    )
    .bind(...binds)
    .first<{ version: number }>()
  const id = crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  if (current) {
    statements.push(
      options.database
        .prepare(
          `UPDATE quota_policies SET policy_status = 'retired', retired_at = ?1, updated_at = ?1
           WHERE id = ?2 AND policy_status = 'active'`,
        )
        .bind(now, current.id),
    )
  }
  statements.push(
    options.database
      .prepare(
        `INSERT INTO quota_policies (
          id, quota_kind, scope_type, user_id, mail_domain_id, policy_version,
          limit_value, policy_status, effective_at, retired_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, NULL, ?8, ?8)`,
      )
      .bind(
        id,
        options.quotaKind,
        options.scopeType,
        options.scopeType === 'user' ? options.scopeId : null,
        options.scopeType === 'domain' ? options.scopeId : null,
        (latest?.version ?? 0) + 1,
        options.limit,
        now,
      ),
    createAuditEventStatement(options.database, {
      ...options.audit,
      actorType: 'user',
      actorUserId: options.actorUserId,
      actionName: options.actionName,
      targetType:
        options.scopeType === 'domain'
          ? 'mail_domain'
          : options.scopeType === 'user'
            ? 'user'
            : 'system',
      targetReference: options.scopeId ?? 'system',
      outcome: 'succeeded',
      occurredAt: now,
    }),
  )
  const results = await options.database.batch(statements)
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new OutboundConfigurationError('limit', '发件额度已经发生变化，请刷新后重试')
  }
}

async function loadDailyDefaultLimit(database: D1Database): Promise<number> {
  const row = await database
    .prepare(
      `SELECT limit_value FROM quota_policies
       WHERE quota_kind = 'daily_send_recipients' AND scope_type = 'system_default'
         AND policy_status = 'active' LIMIT 1`,
    )
    .first<{ limit_value: number }>()
  if (!row) throw new Error('系统每日发件默认额度不存在')
  return row.limit_value
}

async function loadDomainMonthlyDefaultLimit(database: D1Database): Promise<number | null> {
  const row = await database
    .prepare(
      `SELECT limit_value FROM quota_policies
       WHERE quota_kind = 'domain_monthly_send_recipients' AND scope_type = 'system_default'
         AND policy_status = 'active' LIMIT 1`,
    )
    .first<{ limit_value: number | null }>()
  if (!row) throw new Error('系统域名月度发件默认额度不存在')
  return row.limit_value
}

async function listUserDailyQuotas(
  database: D1Database,
  defaultLimit: number,
  now: number,
): Promise<OutboundUserDailyQuotaSummary[]> {
  const rows = await database
    .prepare(
      `SELECT user.id, user.display_name, address.canonical_address,
              policy.limit_value AS user_limit,
              COALESCE((SELECT SUM(operation.quota_recipient_units)
                        FROM send_operations operation
                        WHERE operation.operator_user_id = user.id
                          AND operation.accepted_at > ?1), 0) AS used_units
       FROM users user
       JOIN address_bindings binding
         ON binding.user_id = user.id AND binding.address_role = 'primary' AND binding.ended_at IS NULL
       JOIN email_addresses address ON address.id = binding.address_id
       LEFT JOIN quota_policies policy
         ON policy.quota_kind = 'daily_send_recipients' AND policy.scope_type = 'user'
        AND policy.user_id = user.id AND policy.policy_status = 'active'
       ORDER BY user.created_at, user.id`,
    )
    .bind(now - 86_400_000)
    .all<{
      id: string
      display_name: string
      canonical_address: string
      user_limit: number | null
      used_units: number
    }>()
  return rows.results.map((row) => ({
    userId: row.id,
    displayName: row.display_name,
    primaryAddress: row.canonical_address,
    limit: row.user_limit ?? defaultLimit,
    usesDefault: row.user_limit === null,
    usedInPast24Hours: row.used_units,
  }))
}

async function listDomainMonthlyQuotas(
  database: D1Database,
): Promise<OutboundDomainMonthlyQuotaSummary[]> {
  const now = Date.now()
  const rows = await database
    .prepare(
      `SELECT domain.id, domain.canonical_name, policy.id AS policy_id,
              policy.limit_value AS domain_limit,
              default_policy.limit_value AS default_limit,
              COALESCE(period.committed_units, 0) AS committed_units,
              COALESCE(period.reserved_units, 0) AS reserved_units,
              COALESCE(period.unknown_held_units, 0) AS unknown_held_units
       FROM mail_domains domain
       LEFT JOIN quota_policies policy
         ON policy.quota_kind = 'domain_monthly_send_recipients' AND policy.scope_type = 'domain'
        AND policy.mail_domain_id = domain.id AND policy.policy_status = 'active'
       JOIN quota_policies default_policy
         ON default_policy.quota_kind = 'domain_monthly_send_recipients'
        AND default_policy.scope_type = 'system_default' AND default_policy.policy_status = 'active'
       LEFT JOIN domain_monthly_usage_periods period
         ON period.mail_domain_id = domain.id AND period.period_start_at <= ?1
        AND period.period_end_at > ?1 AND period.period_status = 'open'
       WHERE domain.status <> 'deleted'
       ORDER BY domain.canonical_name`,
    )
    .bind(now)
    .all<{
      id: string
      canonical_name: string
      policy_id: string | null
      domain_limit: number | null
      default_limit: number | null
      committed_units: number
      reserved_units: number
      unknown_held_units: number
    }>()
  return rows.results.map((row) => ({
    domainId: row.id,
    domainName: row.canonical_name,
    limit: row.policy_id ? row.domain_limit : row.default_limit,
    usesDefault: row.policy_id === null,
    committed: row.committed_units,
    reserved: row.reserved_units,
    unknownHeld: row.unknown_held_units,
  }))
}

async function listCurrentProviders(database: D1Database): Promise<ProviderRow[]> {
  const result = await database
    .prepare(
      `SELECT config.* FROM outbound_provider_configs config
       WHERE config.configuration_status <> 'retired'
         AND NOT EXISTS (
           SELECT 1 FROM outbound_provider_configs newer
           WHERE newer.configuration_key = config.configuration_key
             AND newer.configuration_version > config.configuration_version
         )
       ORDER BY config.display_name, config.id`,
    )
    .all<ProviderRow>()
  return result.results
}

async function findProvider(database: D1Database, id: string): Promise<ProviderRow | null> {
  return database
    .prepare(`SELECT * FROM outbound_provider_configs WHERE id = ?1 LIMIT 1`)
    .bind(id)
    .first<ProviderRow>()
}

async function listActiveRoutes(database: D1Database): Promise<RouteRow[]> {
  const result = await database
    .prepare(
      `SELECT route.id, route.mail_domain_id, domain.canonical_name,
              route.route_version, route.route_status
       FROM domain_outbound_routes route
       JOIN mail_domains domain ON domain.id = route.mail_domain_id
       WHERE route.route_status IN ('active', 'disabled')
       ORDER BY domain.canonical_name, route.route_version DESC`,
    )
    .all<RouteRow>()
  return result.results
}

async function routeSummary(database: D1Database, row: RouteRow): Promise<OutboundRouteSummary> {
  const entries = await database
    .prepare(
      `SELECT provider_config_id FROM domain_outbound_route_entries
       WHERE route_id = ?1 ORDER BY priority_number`,
    )
    .bind(row.id)
    .all<{ provider_config_id: string }>()
  return {
    id: row.id,
    domainId: row.mail_domain_id,
    domainName: row.canonical_name,
    routeVersion: row.route_version,
    status: row.route_status as 'active' | 'disabled',
    providerConfigIds: entries.results.map((entry) => entry.provider_config_id),
  }
}

async function providerSummary(
  row: ProviderRow,
  key: CryptoKey | null,
): Promise<OutboundProviderSummary> {
  const secrets = key
    ? await decryptSecrets(
        key,
        row.configuration_key,
        row.configuration_version,
        row.credential_ciphertext,
        row.credential_nonce,
      )
    : null
  return {
    id: row.id,
    configurationKey: row.configuration_key,
    configurationVersion: row.configuration_version,
    displayName: row.display_name,
    providerType: row.provider_type as OutboundProviderType,
    status: row.configuration_status as 'active' | 'disabled' | 'retired',
    credential: secrets?.credential ?? '',
    callbackUsername: secrets?.callbackUsername ?? null,
    callbackSecret: secrets?.callbackSecret ?? '',
    lastTestedAt: row.last_tested_at,
    lastTestResult: row.last_test_result as 'success' | 'failed' | null,
    lastTestSummary: row.last_test_summary,
  }
}

async function requireAdministrator(database: D1Database, userId: string): Promise<void> {
  const row = await database
    .prepare(
      `SELECT 1 AS allowed FROM system_instances WHERE singleton_id = 1 AND current_admin_user_id = ?1`,
    )
    .bind(userId)
    .first<{ allowed: number }>()
  if (!row) throw new OutboundPermissionError('只有系统管理员可以管理域外发信服务')
}

async function importEncryptionKey(
  value: string | undefined,
  required: boolean,
): Promise<CryptoKey | null> {
  if (!value?.trim()) {
    if (required)
      throw new OutboundConfigurationError('encryptionKey', '部署配置尚未设置 CONFIG_KEY')
    return null
  }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(value.trim()), (character) => character.charCodeAt(0))
  } catch {
    throw new OutboundConfigurationError('encryptionKey', 'CONFIG_KEY 不是有效的 Base64')
  }
  if (bytes.byteLength !== 32) {
    throw new OutboundConfigurationError('encryptionKey', 'CONFIG_KEY 必须解码为 32 字节')
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptSecrets(
  key: CryptoKey,
  configurationKey: string,
  version: number,
  secrets: OutboundSecrets,
): Promise<{ ciphertext: ArrayBuffer; nonce: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode(`${configurationKey}:${version}`)
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData },
    key,
    plaintext,
  )
  return { ciphertext, nonce }
}

async function decryptSecrets(
  key: CryptoKey,
  configurationKey: string,
  version: number,
  ciphertext: ArrayBuffer,
  nonce: ArrayBuffer,
): Promise<OutboundSecrets> {
  const additionalData = new TextEncoder().encode(`${configurationKey}:${version}`)
  const copiedNonce = new Uint8Array(nonce).slice()
  const copiedCiphertext = new Uint8Array(ciphertext).slice()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copiedNonce, additionalData },
    key,
    copiedCiphertext,
  )
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext))
  if (
    !isRecord(value) ||
    typeof value.credential !== 'string' ||
    (value.callbackUsername !== null && typeof value.callbackUsername !== 'string') ||
    typeof value.callbackSecret !== 'string'
  ) {
    throw new Error('发信服务凭据格式无效')
  }
  return {
    credential: value.credential,
    callbackUsername: value.callbackUsername,
    callbackSecret: value.callbackSecret,
  }
}

export async function decryptOutboundSecrets(options: {
  encryptionKeyBase64?: string
  configurationKey: string
  configurationVersion: number
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
}): Promise<OutboundSecrets> {
  const key = await importEncryptionKey(options.encryptionKeyBase64, true)
  return decryptSecrets(
    key!,
    options.configurationKey,
    options.configurationVersion,
    options.ciphertext,
    options.nonce,
  )
}

export async function decryptOutboundCredential(options: {
  encryptionKeyBase64?: string
  configurationKey: string
  configurationVersion: number
  ciphertext: ArrayBuffer
  nonce: ArrayBuffer
}): Promise<string> {
  return (await decryptOutboundSecrets(options)).credential
}

function normalizeProviderInput(input: SaveOutboundProviderRequest) {
  if (input.id !== undefined && !isUuid(input.id)) {
    throw new OutboundConfigurationError('providerId', '发信服务配置无效')
  }
  const displayName = input.displayName?.trim()
  if (!displayName || displayName.length > 120) {
    throw new OutboundConfigurationError('displayName', '配置名称必须包含 1 至 120 个字符')
  }
  if (input.providerType !== 'resend' && input.providerType !== 'smtp2go') {
    throw new OutboundConfigurationError('providerType', '首发只支持 Resend 和 SMTP2GO')
  }
  const credential = input.credential?.trim()
  if (!credential || credential.length > 4096) {
    throw new OutboundConfigurationError('credential', '请填写有效的服务 API Key')
  }
  const callbackSecret = input.callbackSecret?.trim()
  if (!callbackSecret || callbackSecret.length > 4096) {
    throw new OutboundConfigurationError('callbackSecret', '请填写有效的回调验证密钥')
  }
  const callbackUsername = input.callbackUsername?.trim() || null
  if (
    input.providerType === 'smtp2go' &&
    (!callbackUsername ||
      callbackUsername.length > 200 ||
      !/^[\x21-\x7e]+$/u.test(callbackUsername))
  ) {
    throw new OutboundConfigurationError(
      'callbackUsername',
      'SMTP2GO 回调需要填写 Basic Auth 用户名',
    )
  }
  if (input.providerType === 'smtp2go' && !/^[\x21-\x7e]+$/u.test(callbackSecret)) {
    throw new OutboundConfigurationError(
      'callbackSecret',
      'SMTP2GO 回调密码只能使用可见 ASCII 字符',
    )
  }
  if (input.providerType === 'resend' && !callbackSecret.startsWith('whsec_')) {
    throw new OutboundConfigurationError('callbackSecret', 'Resend 回调签名密钥应以 whsec_ 开头')
  }
  return {
    id: input.id,
    displayName,
    providerType: input.providerType,
    credential,
    callbackUsername: input.providerType === 'smtp2go' ? callbackUsername : null,
    callbackSecret,
  }
}

function normalizeProviderConfigIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new OutboundConfigurationError('providerConfigIds', '每条域名路线需要 1 至 5 家发信服务')
  }
  if (!value.every((item): item is string => typeof item === 'string' && isUuid(item))) {
    throw new OutboundConfigurationError('providerConfigIds', '域名发信路线无效')
  }
  if (new Set(value).size !== value.length) {
    throw new OutboundConfigurationError('providerConfigIds', '同一家发信服务不能在路线中重复')
  }
  return value
}

function normalizeQuotaLimit(value: number | null, allowUnlimited: boolean): number | null {
  if (allowUnlimited && value === null) return null
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1 || (value ?? 0) > 10_000_000) {
    throw new OutboundConfigurationError('limit', '发件额度必须是 1 至 10,000,000 的整数')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
