import type {
  InitializeSystemRequest,
  InitializeSystemResponse,
} from '../../../shared/contracts/initialization'
import type { StorageMode } from '../../../shared/contracts/storage-mode'
import { AddressValidationError, normalizeEmailAddress } from '../../addresses/domain/email-address'
import {
  hashPassword,
  PasswordValidationError,
  validatePassword,
} from '../../identity/domain/password'
import { isSystemInitialized } from './get-system-status'

export class InitializationInputError extends Error {
  constructor(
    readonly field: keyof InitializeSystemRequest,
    message: string,
  ) {
    super(message)
  }
}

export class SystemAlreadyInitializedError extends Error {}
export class InitializationConflictError extends Error {}

export async function initializeSystem(options: {
  database: D1Database
  storageMode: StorageMode
  input: InitializeSystemRequest
  now?: number
}): Promise<InitializeSystemResponse> {
  if (await isSystemInitialized(options.database)) {
    throw new SystemAlreadyInitializedError('系统已经完成初始化')
  }

  const normalized = normalizeInitializationInput(options.input)
  const passwordRecord = await hashPassword(normalized.password)
  const now = options.now ?? Date.now()
  const userId = crypto.randomUUID()
  const domainId = crypto.randomUUID()
  const addressId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()

  const statements = [
    options.database
      .prepare(
        `INSERT INTO users (
          id, status, display_name, timezone, invitation_policy, created_at, updated_at
         ) VALUES (?1, 'active', ?2, ?3, 'manual', ?4, ?4)`,
      )
      .bind(userId, normalized.adminDisplayName, normalized.timezone, now),
    options.database
      .prepare(
        `INSERT INTO password_credentials (
          user_id, format_version, algorithm, iterations, salt, derived_key,
          must_change, temporary_expires_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7)`,
      )
      .bind(
        userId,
        passwordRecord.formatVersion,
        passwordRecord.algorithm,
        passwordRecord.iterations,
        passwordRecord.salt,
        passwordRecord.derivedKey,
        now,
      ),
    options.database
      .prepare(
        `INSERT INTO user_alias_policies (
          user_id, alias_limit, self_creation_enabled,
          updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 20, 1, ?1, ?2, ?2)`,
      )
      .bind(userId, now),
    options.database
      .prepare(
        `INSERT INTO user_organization_policies (
          user_id, organization_limit, updated_by_user_id, created_at, updated_at
         ) VALUES (?1, 5, ?1, ?2, ?2)`,
      )
      .bind(userId, now),
    options.database
      .prepare(
        `INSERT INTO mail_domains (
          id, canonical_name, display_name, status, catch_all_mode, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'active', 'reject', ?4, ?4)`,
      )
      .bind(domainId, normalized.address.canonicalDomain, normalized.address.displayDomain, now),
    options.database
      .prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address, created_at
         ) VALUES (?1, ?2, ?3, ?3, ?4)`,
      )
      .bind(addressId, domainId, normalized.address.canonicalAddress, now),
    options.database
      .prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES (?1, ?2, 'active', NULL, ?3, ?3)`,
      )
      .bind(normalized.address.canonicalAddress, addressId, now),
    options.database
      .prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (?1, ?2, 'user', ?3, NULL, 'primary', ?4, NULL, NULL)`,
      )
      .bind(bindingId, addressId, userId, now),
    options.database
      .prepare(
        `INSERT INTO user_address_preferences (
          user_id, address_id, is_pinned, sort_order, is_default_sender,
          sender_display_name, created_at, updated_at
         ) VALUES (?1, ?2, 1, 0, 1, ?3, ?4, ?4)`,
      )
      .bind(userId, addressId, normalized.adminDisplayName, now),
    options.database
      .prepare(
        `INSERT INTO system_instances (
          singleton_id, storage_mode, current_admin_user_id, initialized_at, created_at, updated_at
         ) VALUES (1, ?1, ?2, ?3, ?3, ?3)`,
      )
      .bind(options.storageMode, userId, now),
  ]

  try {
    await options.database.batch(statements)
  } catch (error) {
    if (await isSystemInitialized(options.database)) {
      throw new SystemAlreadyInitializedError('系统已经完成初始化')
    }

    throw new InitializationConflictError(
      error instanceof Error ? error.message : '初始化数据写入失败',
    )
  }

  return {
    data: {
      initialization: 'initialized',
      administrator: {
        displayName: normalized.adminDisplayName,
        primaryAddress: normalized.address.canonicalAddress,
      },
      domain: {
        displayName: normalized.address.displayDomain,
        canonicalName: normalized.address.canonicalDomain,
      },
      storageMode: options.storageMode,
    },
  }
}

function normalizeInitializationInput(input: InitializeSystemRequest) {
  const adminDisplayName = input.adminDisplayName.trim()
  const displayNameLength = [...adminDisplayName].length
  if (
    displayNameLength < 1 ||
    displayNameLength > 80 ||
    containsControlCharacter(adminDisplayName)
  ) {
    throw new InitializationInputError(
      'adminDisplayName',
      '管理员显示名称必须包含 1 至 80 个有效字符',
    )
  }

  const timezone = input.timezone.trim()
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format()
  } catch {
    throw new InitializationInputError('timezone', '浏览器提供的时区无效，请重新选择')
  }

  let address
  try {
    address = normalizeEmailAddress(input.localPart, input.domainName)
  } catch (error) {
    if (error instanceof AddressValidationError) {
      throw new InitializationInputError(error.field, error.message)
    }
    throw error
  }

  try {
    validatePassword(input.password, {
      displayName: adminDisplayName,
      localPart: address.localPart,
      canonicalDomain: address.canonicalDomain,
    })
  } catch (error) {
    if (error instanceof PasswordValidationError) {
      throw new InitializationInputError('password', error.message)
    }
    throw error
  }

  return {
    adminDisplayName,
    timezone,
    password: input.password,
    address,
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}
