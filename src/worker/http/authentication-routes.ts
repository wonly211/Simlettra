import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  type AdministratorPasswordResetRequest,
  type AdministratorPasswordResetResponse,
  type AdministratorRecoveryAuthorizationResponse,
  type AdministratorRecoveryRequest,
  type AdministratorRecoveryResponse,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  type AuthenticationResponse,
  type LoginRequest,
  type LogoutResponse,
  type RevokeSessionResponse,
  type SessionListResponse,
} from '../../shared/contracts/authentication'
import {
  type AccountLifecycleOverviewResponse,
  type AccountRecoveryLoginRequest,
  type AccountRecoveryLoginResponse,
  type AccountRecoverySessionResponse,
  type CancelAccountDeletionResponse,
  RECOVERY_CSRF_COOKIE_NAME,
  RECOVERY_CSRF_HEADER_NAME,
  RECOVERY_SESSION_COOKIE_NAME,
  type RequestAccountDeletionRequest,
  type RequestAccountDeletionResponse,
  type TransferAdministratorRequest,
  type TransferAdministratorResponse,
} from '../../shared/contracts/user-lifecycle'
import { INITIALIZATION_KEY_HEADER } from '../../shared/contracts/initialization'
import { decodeInitializationKeyHeader } from '../../shared/contracts/initialization-key-header'
import type {
  ChangeMailDomainStatusResponse,
  CreateMailDomainRequest,
  CreateMailDomainResponse,
  DeleteMailDomainRequest,
  DeleteMailDomainResponse,
  DomainManagementOverviewResponse,
} from '../../shared/contracts/domain-management'
import type {
  ChangeInboundReceiveStatusRequest,
  ChangeInboundReceiveStatusResponse,
  ChangeInboundRejectionRuleStatusRequest,
  ChangeInboundRejectionRuleStatusResponse,
  CreateInboundRejectionRuleRequest,
  CreateInboundRejectionRuleResponse,
  DeleteInboundRejectionRuleResponse,
  InboundControlOverviewResponse,
  InboundControlScopeType,
  ChangeDomainCatchAllModeResponse,
  ChangeUnallocatedAccessGrantResponse,
} from '../../shared/contracts/inbound-control'
import type {
  ClaimUnallocatedAddressResponse,
  UnallocatedMailDetailResponse,
  UnallocatedMailListResponse,
} from '../../shared/contracts/unallocated-mail'
import type {
  ChangeManagedUserStatusResponse,
  CreateManagedUserRequest,
  CreateManagedUserResponse,
  UserManagementOverviewResponse,
} from '../../shared/contracts/user-management'
import type {
  AccountRegistrationInvitationOverviewResponse,
  CreateAccountRegistrationInvitationRequest,
  CreateAccountRegistrationInvitationResponse,
  RegisterAccountWithInvitationRequest,
  RegisterAccountWithInvitationResponse,
  RevokeAccountRegistrationInvitationResponse,
  VerifyAccountRegistrationInvitationRequest,
  VerifyAccountRegistrationInvitationResponse,
} from '../../shared/contracts/account-registration'
import type {
  AddressPolicyResponse,
  UpdateAddressPolicyRequest,
  UpdateAddressPolicyResponse,
} from '../../shared/contracts/address-policy-management'
import type {
  AdministratorAliasPolicyOverviewResponse,
  CreatePersonalAliasRequest,
  CreatePersonalAliasResponse,
  DeletePersonalAliasRequest,
  DeletePersonalAliasResponse,
  MovePersonalAddressRequest,
  MovePersonalAddressResponse,
  PersonalAddressOverviewResponse,
  SetDefaultSenderResponse,
  UpdatePersonalAddressPreferenceRequest,
  UpdatePersonalAddressPreferenceResponse,
  UpdateUserAliasPolicyRequest,
  UpdateUserAliasPolicyResponse,
} from '../../shared/contracts/personal-address-management'
import type {
  AdministratorOrganizationPolicyOverviewResponse,
  CreateOrganizationInvitationRequest,
  CreateOrganizationInvitationResponse,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  DeleteOrganizationRequest,
  DeleteOrganizationResponse,
  LeaveOrganizationRequest,
  LeaveOrganizationResponse,
  OrganizationOverviewResponse,
  ResolveOrganizationInvitationResponse,
  RestoreOrganizationResponse,
  UpdateOrganizationInvitationPolicyRequest,
  UpdateOrganizationInvitationPolicyResponse,
  UpdateOrganizationSendingPermissionRequest,
  UpdateOrganizationSendingPermissionResponse,
  UpdateUserOrganizationPolicyRequest,
  UpdateUserOrganizationPolicyResponse,
} from '../../shared/contracts/organization-management'
import type {
  MailboxListResponse,
  MailboxMessageDetailResponse,
  MailboxOrganizeAction,
  OrganizeMailboxEntriesResponse,
  PermanentlyDeleteMailboxEntryResponse,
  RemoteImagePermissionMode,
  UpdateMailboxReadStateResponse,
  UpdateRemoteImagePermissionResponse,
} from '../../shared/contracts/mailbox'
import type {
  ChangeDraftStatusResponse,
  CreateDraftRequest,
  DraftDetailResponse,
  DraftRecipient,
  DraftWorkspaceResponse,
  SaveDraftRequest,
  SaveDraftResponse,
  UploadDraftAttachmentResponse,
} from '../../shared/contracts/drafts'
import type {
  OutboundManagementOverviewResponse,
  SaveDomainOutboundRouteRequest,
  SaveDomainOutboundRouteResponse,
  SaveOutboundProviderRequest,
  SaveOutboundProviderResponse,
  SaveOutboundQuotaRequest,
  SaveOutboundQuotaResponse,
  SendDraftRequest,
  SendDraftResponse,
  SendOperationResponse,
} from '../../shared/contracts/sending'
import type {
  ChangeNotificationSubscriptionStatusRequest,
  ChangeNotificationSubscriptionStatusResponse,
  CreateNotificationSubscriptionRequest,
  CreateNotificationSubscriptionResponse,
  DeleteNotificationSubscriptionResponse,
  NotificationChannelType,
  NotificationOverviewResponse,
  NotificationScopeInput,
} from '../../shared/contracts/notifications'
import type {
  ChangeForwardingRuleStatusRequest,
  ChangeForwardingRuleStatusResponse,
  CreateExternalEmailTargetRequest,
  CreateExternalEmailTargetResponse,
  DeleteExternalEmailTargetResponse,
  DeleteForwardingRuleResponse,
  ForwardingOverviewResponse,
  SaveForwardingRuleRequest,
  SaveForwardingRuleResponse,
  VerifyExternalEmailTargetRequest,
  VerifyExternalEmailTargetResponse,
} from '../../shared/contracts/forwarding'
import type {
  DeletePlatformResourceConfigurationResponse,
  PlatformResourceOverviewResponse,
  RefreshPlatformResourcesResponse,
  SavePlatformResourceConfigurationRequest,
  SavePlatformResourceConfigurationResponse,
  SavePlatformResourceThresholdRequest,
  SavePlatformResourceThresholdResponse,
} from '../../shared/contracts/platform-resources'
import type { OperationsHealthOverviewResponse } from '../../shared/contracts/operations-health'
import type {
  SaveStorageQuotaDefaultRequest,
  SaveStorageQuotaDefaultResponse,
  SaveStorageQuotaOverrideRequest,
  SaveStorageQuotaOverrideResponse,
  StorageQuotaOverviewResponse,
} from '../../shared/contracts/storage-quotas'
import type {
  CreateMailExportResponse,
  DeleteMailExportResponse,
  MailExportOverviewResponse,
} from '../../shared/contracts/mail-exports'
import type {
  CreateSystemBackupResponse,
  SystemBackupOverviewResponse,
} from '../../shared/contracts/system-backups'
import {
  AddressPolicyConflictError,
  AddressPolicyInputError,
  AddressPolicyPermissionError,
  changeManagedMailDomainStatus,
  createPersonalAlias,
  createManagedMailDomain,
  deletePersonalAlias,
  deleteManagedMailDomain,
  DomainManagementInputError,
  DomainManagementPermissionError,
  listManagedMailDomains,
  MailDomainConflictError,
  MailDomainTargetError,
  getAdministratorAliasPolicyOverview,
  getAddressPolicy,
  getPersonalAddressOverview,
  movePersonalAddress,
  PersonalAddressInputError,
  PersonalAddressPermissionError,
  PersonalAddressTargetError,
  PersonalAliasCreationError,
  setPersonalDefaultSender,
  updatePersonalAddressPreference,
  updateAddressPolicy,
  updateUserAliasPolicy,
} from '../../modules/addresses/public'
import {
  AccountLifecycleAccessError,
  AccountLifecycleInputError,
  AdministratorPermissionError,
  authenticateRecoverySession,
  authenticateSession,
  AuthenticationFailedError,
  changeManagedUserStatus,
  changeOwnPassword,
  createManagedUser,
  CurrentPasswordIncorrectError,
  cancelAccountDeletion,
  getAccountLifecycleOverview,
  getAdministratorRecoverySubject,
  getUserManagementOverview,
  listUserSessions,
  loginForAccountRecovery,
  loginWithPassword,
  LoginRateLimitedError,
  PasswordManagementInputError,
  PasswordResetTargetError,
  PasswordUpdateConflictError,
  recoverAdministratorPassword,
  requestAccountDeletion,
  resetUserPasswordAsAdministrator,
  revokeUserSession,
  SessionNotFoundError,
  TemporaryPasswordExpiredError,
  transferSystemAdministrator,
  ManagedUserTargetError,
  UserCreationConflictError,
  UserManagementInputError,
  verifyRecoverySessionCsrf,
  verifySessionCsrf,
  type AuthenticatedRecoverySession,
  type AuthenticatedSession,
} from '../../modules/identity/public'
import {
  AccountRegistrationAccessError,
  AccountRegistrationInputError,
  AccountRegistrationPermissionError,
  AccountRegistrationRateLimitedError,
  createAccountRegistrationInvitation,
  getAccountRegistrationInvitationOverview,
  InvitationCodeConfigurationError,
  registerAccountWithInvitation,
  revokeAccountRegistrationInvitation,
  verifyAccountRegistrationInvitation,
} from '../../modules/registration-invitations/public'
import {
  getAttachmentDownload,
  getMessageConversation,
  getMessageDetail,
  listInbox,
  MailboxAccessError,
  MailboxInputError,
  organizeMailboxEntries,
  permanentlyDeleteMailboxEntry,
  removeTrustedSender,
  updateReadState,
  updateRemoteImagePermission,
} from '../../modules/mailbox/public'
import {
  changeDraftTrashStatus,
  createDraft,
  DraftAccessError,
  DraftInputError,
  DraftMutationConflictError,
  getDraftAttachmentDownload,
  getDraftDetail,
  listDraftWorkspace,
  saveDraft,
  uploadDraftAttachment,
} from '../../modules/drafts/public'
import {
  changeInboundReceiveStatus,
  changeDomainCatchAllMode,
  changeUnallocatedAccessGrant,
  changeInboundRejectionRuleStatus,
  claimUnallocatedAddress,
  createInboundRejectionRule,
  createMailObjectStore,
  deleteInboundRejectionRule,
  getUnallocatedAttachmentDownload,
  getUnallocatedMailDetail,
  getInboundControlOverview,
  InboundControlInputError,
  InboundControlPermissionError,
  InboundControlTargetError,
  listUnallocatedMail,
  UnallocatedMailAccessError,
  UnallocatedMailInputError,
} from '../../modules/mail-receiving/public'
import {
  changeNotificationSubscriptionStatus,
  createNotificationSubscription,
  deleteNotificationSubscription,
  getNotificationOverview,
  NotificationAccessError,
  NotificationInputError,
} from '../../modules/notifications/public'
import {
  changeForwardingRuleStatus,
  createExternalEmailTarget,
  deleteExternalEmailTarget,
  deleteForwardingRule,
  ForwardingAccessError,
  ForwardingInputError,
  getForwardingOverview,
  saveForwardingRule,
  verifyExternalEmailTarget,
} from '../../modules/forwarding/public'
import {
  createOrganization,
  createOrganizationInvitation,
  deleteOrganization,
  getAdministratorOrganizationPolicyOverview,
  getOrganizationOverview,
  leaveOrganization,
  OrganizationCreationError,
  OrganizationInputError,
  OrganizationInvitationError,
  OrganizationPermissionError,
  OrganizationTargetError,
  resolveOrganizationInvitation,
  restoreOrganization,
  revokeOrganizationInvitation,
  updateInvitationPolicy,
  updateOrganizationSendingPermission,
  updateUserOrganizationPolicy,
} from '../../modules/organizations/public'
import {
  getOutboundManagementOverview,
  getSendOperation,
  OutboundConfigurationError,
  OutboundPermissionError,
  saveDomainOutboundRoute,
  saveDailyDefaultQuota,
  saveDomainMonthlyDefaultQuota,
  saveDomainMonthlyQuota,
  saveOutboundProvider,
  saveUserDailyQuota,
  SendAccessError,
  SendInputError,
  SendMutationConflictError,
  sendDraft,
} from '../../modules/sending/public'
import {
  deletePlatformResourceConfiguration,
  getPlatformResourceOverview,
  PlatformResourceInputError,
  PlatformResourcePermissionError,
  PlatformResourceRefreshError,
  refreshPlatformResourceSnapshots,
  savePlatformResourceConfiguration,
  savePlatformResourceThreshold,
} from '../../modules/platform-resources/public'
import {
  getOperationsHealthOverview,
  OperationsHealthPermissionError,
} from '../../modules/operations-health/public'
import {
  getStorageQuotaOverview,
  saveStorageQuotaDefault,
  saveStorageQuotaOverride,
  StorageQuotaInputError,
  StorageQuotaPermissionError,
} from '../../modules/storage-quotas/public'
import {
  createMailExport,
  deleteMailExport,
  getMailExportArtifact,
  getMailExportOverview,
  MailExportAccessError,
  MailExportInputError,
} from '../../modules/exports/public'
import {
  createSystemBackup,
  getSystemBackupManifest,
  getSystemBackupOverview,
  getSystemBackupPart,
  SystemBackupAccessError,
  SystemBackupPermissionError,
} from '../../modules/backups/public'
import {
  authorizeInitializationKey,
  InitializationKeyError,
  isSystemInitialized,
} from '../../modules/system/public'
import { parseStorageMode, type WorkerBindings } from '../bindings'

const MAX_LOGIN_BODY_BYTES = 4_096
const MAX_PASSWORD_BODY_BYTES = 4_096
const MAX_DRAFT_JSON_BYTES = 20_100_000
const MAX_DRAFT_ATTACHMENT_BYTES = 20_000_000
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const RECOVERY_COOKIE_MAX_AGE_SECONDS = 30 * 60
type AuthenticationContext = Context<{ Bindings: WorkerBindings }>

export function createAuthenticationRoutes() {
  const app = new Hono<{ Bindings: WorkerBindings }>()

  app.post('/account-registration/invitation/verify', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }
    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }
    try {
      const input = await readVerifyAccountRegistrationInvitationBody(context.req.raw)
      const result = await verifyAccountRegistrationInvitation({
        database: context.env.DB,
        code: input.code,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<VerifyAccountRegistrationInvitationResponse>({
        data: { valid: true, domainName: result.domainName },
      })
    } catch (error) {
      return handleAccountRegistrationError(context, error)
    }
  })

  app.post('/account-registration/register', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }
    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }
    try {
      const input = await readRegisterAccountWithInvitationBody(context.req.raw)
      const result = await registerAccountWithInvitation({
        database: context.env.DB,
        input,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        clientLabel: describeClient(context.req.header('User-Agent') ?? ''),
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        audit: auditContext(context),
      })
      setAuthenticationCookies(context, result.sessionToken, result.csrfToken)
      return context.json<RegisterAccountWithInvitationResponse>(
        {
          data: {
            authenticated: true,
            user: result.user,
            session: result.session,
          },
        },
        201,
      )
    } catch (error) {
      return handleAccountRegistrationError(context, error)
    }
  })

  app.post('/login', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }

    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }

    try {
      const input = await readLoginBody(context.req.raw)
      const result = await loginWithPassword({
        database: context.env.DB,
        email: input.email,
        password: input.password,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        clientLabel: describeClient(context.req.header('User-Agent') ?? ''),
        audit: auditContext(context),
      })

      setAuthenticationCookies(context, result.sessionToken, result.csrfToken)

      return context.json<AuthenticationResponse>({
        data: {
          authenticated: true,
          user: result.user,
          session: result.session,
        },
      })
    } catch (error) {
      if (error instanceof LoginInputError) {
        return errorResponse(context, 422, 'invalid_input', error.message, error.field)
      }

      if (error instanceof LoginRateLimitedError) {
        context.header('Retry-After', String(error.retryAfterSeconds))
        return errorResponse(context, 429, 'rate_limited', error.message)
      }

      if (error instanceof AuthenticationFailedError) {
        return errorResponse(context, 401, 'invalid_credentials', error.message)
      }

      throw error
    }
  })

  app.get('/session', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session

    return context.json<AuthenticationResponse>({
      data: {
        authenticated: true,
        user: session.user,
        session: session.summary,
      },
    })
  })

  app.get('/account-lifecycle', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    const overview = await getAccountLifecycleOverview({ database: context.env.DB, session })
    return context.json<AccountLifecycleOverviewResponse>({ data: overview })
  })

  app.post('/administrator/transfer', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readTransferAdministratorBody(context.req.raw)
      const result = await transferSystemAdministrator({
        database: context.env.DB,
        session,
        successorUserId: input.successorUserId,
        audit: auditContext(context),
      })
      return context.json<TransferAdministratorResponse>({
        data: { transferred: true, ...result },
      })
    } catch (error) {
      return handleAccountLifecycleError(context, error)
    }
  })

  app.post('/account-deletion', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readAccountDeletionBody(context.req.raw)
      const result = await requestAccountDeletion({
        database: context.env.DB,
        session,
        currentPassword: input.currentPassword,
        confirmation: input.confirmation,
        audit: auditContext(context),
      })
      clearAuthenticationCookies(context)
      return context.json<RequestAccountDeletionResponse>({
        data: { deletionRequested: true, ...result },
      })
    } catch (error) {
      return handleAccountLifecycleError(context, error)
    }
  })

  app.post('/account-recovery/login', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }
    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }

    try {
      const input = await readAccountRecoveryLoginBody(context.req.raw)
      const result = await loginForAccountRecovery({
        database: context.env.DB,
        email: input.email,
        password: input.password,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        clientLabel: describeClient(context.req.header('User-Agent') ?? ''),
      })
      setRecoveryCookies(context, result.sessionToken, result.csrfToken)
      return context.json<AccountRecoveryLoginResponse>({
        data: { recoveryRequired: true, session: result.summary },
      })
    } catch (error) {
      return handleAccountLifecycleError(context, error)
    }
  })

  app.get('/account-recovery/session', async (context) => {
    const session = await requireRecoverySession(context)
    if (session instanceof Response) return session
    return context.json<AccountRecoverySessionResponse>({
      data: { recoveryRequired: true, session: session.summary },
    })
  })

  app.post('/account-recovery/cancel', async (context) => {
    const session = await requireRecoveryMutationSession(context)
    if (session instanceof Response) return session

    try {
      const result = await cancelAccountDeletion({
        database: context.env.DB,
        session,
        audit: auditContext(context),
      })
      clearRecoveryCookies(context)
      return context.json<CancelAccountDeletionResponse>({
        data: { deletionCancelled: true, ...result },
      })
    } catch (error) {
      return handleAccountLifecycleError(context, error)
    }
  })

  app.get('/mailbox/inbox', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const result = await listInbox({
        database: context.env.DB,
        userId: session.userId,
        scope: context.req.query('scope'),
        view: context.req.query('view'),
        organizationId: context.req.query('organizationId'),
        cursor: context.req.query('cursor'),
        limit: context.req.query('limit'),
        body: context.req.query('body'),
        subject: context.req.query('subject'),
        sender: context.req.query('sender'),
        recipient: context.req.query('recipient'),
        mailboxAddress: context.req.query('mailboxAddress'),
        dateFrom: context.req.query('dateFrom'),
        dateTo: context.req.query('dateTo'),
        attachment: context.req.query('attachment'),
        read: context.req.query('read'),
        starred: context.req.query('starred'),
        archived: context.req.query('archived'),
        sort: context.req.query('sort'),
      })
      return context.json<MailboxListResponse>({ data: result })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.get('/mailbox/unallocated', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const cursor = context.req.query('cursor')
      const limit = context.req.query('limit')
      const query = context.req.query('query')
      const result = await listUnallocatedMail({
        database: context.env.DB,
        userId: session.userId,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(query !== undefined ? { query } : {}),
      })
      return context.json<UnallocatedMailListResponse>({ data: result })
    } catch (error) {
      return handleUnallocatedMailError(context, error)
    }
  })

  app.get('/mailbox/unallocated/:deliveryId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const message = await getUnallocatedMailDetail({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        deliveryId: context.req.param('deliveryId') ?? '',
      })
      return context.json<UnallocatedMailDetailResponse>({ data: { message } })
    } catch (error) {
      return handleUnallocatedMailError(context, error)
    }
  })

  app.get('/mailbox/unallocated/:deliveryId/attachments/:objectId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const attachment = await getUnallocatedAttachmentDownload({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        deliveryId: context.req.param('deliveryId') ?? '',
        objectId: context.req.param('objectId') ?? '',
      })
      const preview = context.req.query('preview') === '1' && attachment.previewable
      return new Response(attachment.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader(
            preview ? 'inline' : 'attachment',
            attachment.fileName,
          ),
          'Content-Length': String(attachment.bytes.byteLength),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': preview ? attachment.mediaType : 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleUnallocatedMailError(context, error)
    }
  })

  app.post('/mailbox/unallocated/periods/:periodId/claim', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readUnallocatedMailJsonBody(context.req.raw)
      if (input.confirmed !== true) {
        throw new UnallocatedMailInputError('confirmed', '请再次确认认领该地址及当前历史来信')
      }
      const result = await claimUnallocatedAddress({
        database: context.env.DB,
        queue: context.env.TASK_QUEUE,
        userId: session.userId,
        periodId: context.req.param('periodId') ?? '',
        audit: auditContext(context),
      })
      return context.json<ClaimUnallocatedAddressResponse>({ data: result })
    } catch (error) {
      return handleUnallocatedMailError(context, error)
    }
  })

  app.get('/mailbox/entries/:entryId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const entryId = context.req.param('entryId') ?? ''
      const [message, conversation] = await Promise.all([
        getMessageDetail({
          database: context.env.DB,
          objectStore: createMailObjectStore(
            context.env,
            parseStorageMode(context.env.STORAGE_MODE),
          ),
          userId: session.userId,
          entryId,
        }),
        getMessageConversation({
          database: context.env.DB,
          userId: session.userId,
          entryId,
        }),
      ])
      return context.json<MailboxMessageDetailResponse>({ data: { message, conversation } })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.post('/mailbox/entries/:entryId/read', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMailboxJsonBody(context.req.raw)
      if (typeof input.isRead !== 'boolean') {
        throw new MailboxInputError('isRead', '请选择已读或未读状态')
      }
      const entryId = context.req.param('entryId') ?? ''
      const isRead = await updateReadState({
        database: context.env.DB,
        userId: session.userId,
        entryId,
        isRead: input.isRead,
      })
      return context.json<UpdateMailboxReadStateResponse>({ data: { entryId, isRead } })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.post('/mailbox/actions', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMailboxJsonBody(context.req.raw)
      const result = await organizeMailboxEntries({
        database: context.env.DB,
        userId: session.userId,
        entryIds: input.entryIds,
        action: input.action,
      })
      return context.json<OrganizeMailboxEntriesResponse>({
        data: { entryIds: result.entryIds, action: result.action as MailboxOrganizeAction },
      })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.delete('/mailbox/entries/:entryId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMailboxJsonBody(context.req.raw)
      if (input.confirmed !== true) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认永久删除邮件')
      }
      const result = await permanentlyDeleteMailboxEntry({
        database: context.env.DB,
        actorUserId: session.userId,
        entryId: context.req.param('entryId') ?? '',
        audit: auditContext(context),
      })
      return context.json<PermanentlyDeleteMailboxEntryResponse>({ data: result })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.post('/mailbox/entries/:entryId/remote-images', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMailboxJsonBody(context.req.raw)
      if (input.mode !== 'message' && input.mode !== 'sender' && input.mode !== 'block') {
        throw new MailboxInputError('mode', '请选择有效的远程图片设置')
      }
      const entryId = context.req.param('entryId') ?? ''
      const result = await updateRemoteImagePermission({
        database: context.env.DB,
        userId: session.userId,
        entryId,
        mode: input.mode as RemoteImagePermissionMode,
      })
      return context.json<UpdateRemoteImagePermissionResponse>({ data: { entryId, ...result } })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.delete('/mailbox/trusted-senders/:address', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      await removeTrustedSender({
        database: context.env.DB,
        userId: session.userId,
        canonicalSenderAddress: context.req.param('address') ?? '',
      })
      return context.json({ data: { removed: true as const } })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.get('/mailbox/entries/:entryId/attachments/:objectId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const attachment = await getAttachmentDownload({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        entryId: context.req.param('entryId') ?? '',
        objectId: context.req.param('objectId') ?? '',
      })
      const preview = context.req.query('preview') === '1' && attachment.previewable
      return new Response(attachment.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader(
            preview ? 'inline' : 'attachment',
            attachment.fileName,
          ),
          'Content-Length': String(attachment.bytes.byteLength),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': preview ? attachment.mediaType : 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleMailboxError(context, error)
    }
  })

  app.get('/mail-exports', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const result = await getMailExportOverview({
        database: context.env.DB,
        userId: session.userId,
      })
      return context.json<MailExportOverviewResponse>({ data: result })
    } catch (error) {
      return handleMailExportError(context, error)
    }
  })

  app.post('/mail-exports', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMailExportJsonBody(context.req.raw)
      const run = await createMailExport({
        database: context.env.DB,
        queue: context.env.TASK_QUEUE,
        userId: session.userId,
        scopeType: input.scopeType,
        organizationId: input.organizationId,
        audit: auditContext(context),
      })
      return context.json<CreateMailExportResponse>({ data: { run } }, 202)
    } catch (error) {
      return handleMailExportError(context, error)
    }
  })

  app.get('/mail-exports/:exportRunId/artifacts/:artifactId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const artifact = await getMailExportArtifact({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        exportRunId: context.req.param('exportRunId') ?? '',
        artifactId: context.req.param('artifactId') ?? '',
      })
      return new Response(artifact.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader('attachment', artifact.fileName),
          'Content-Length': String(artifact.bytes.byteLength),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': 'application/zip',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleMailExportError(context, error)
    }
  })

  app.delete('/mail-exports/:exportRunId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      await deleteMailExport({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        exportRunId: context.req.param('exportRunId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeleteMailExportResponse>({
        data: { exportRunId: context.req.param('exportRunId') ?? '', deleted: true },
      })
    } catch (error) {
      return handleMailExportError(context, error)
    }
  })

  app.get('/drafts', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const status = context.req.query('status')
      const result = await listDraftWorkspace({
        database: context.env.DB,
        userId: session.userId,
        ...(status ? { status } : {}),
      })
      return context.json<DraftWorkspaceResponse>({ data: result })
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.post('/drafts', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readCreateDraftBody(context.req.raw)
      const draft = await createDraft({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        userId: session.userId,
        ...(input.senderAddressId !== undefined ? { senderAddressId: input.senderAddressId } : {}),
        ...(input.composeKind !== undefined ? { composeKind: input.composeKind } : {}),
        ...(input.sourceMailboxEntryId !== undefined
          ? { sourceMailboxEntryId: input.sourceMailboxEntryId }
          : {}),
      })
      return context.json<DraftDetailResponse>({ data: { draft } }, 201)
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.get('/drafts/:draftId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const draft = await getDraftDetail({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        draftId: context.req.param('draftId') ?? '',
      })
      return context.json<DraftDetailResponse>({ data: { draft } })
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.put('/drafts/:draftId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readSaveDraftBody(context.req.raw)
      const result = await saveDraft({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        userId: session.userId,
        draftId: context.req.param('draftId') ?? '',
        input,
      })
      return context.json<SaveDraftResponse>({ data: result })
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.post('/drafts/:draftId/attachments', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const bytes = await context.req.arrayBuffer()
      if (bytes.byteLength > MAX_DRAFT_ATTACHMENT_BYTES) {
        throw new DraftInputError('file', '单个附件不能超过 20 MB')
      }
      const mutationKey = context.req.header('X-Simlettra-Mutation-Key') ?? ''
      const expectedRevisionNumber = Number(
        context.req.header('X-Simlettra-Expected-Revision') ?? '',
      )
      const encodedFileName = context.req.header('X-Simlettra-File-Name') ?? ''
      let fileName = ''
      try {
        fileName = decodeURIComponent(encodedFileName)
      } catch {
        throw new DraftInputError('fileName', '附件名称编码无效')
      }
      const result = await uploadDraftAttachment({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        userId: session.userId,
        draftId: context.req.param('draftId') ?? '',
        mutationKey,
        expectedRevisionNumber,
        fileName,
        mediaType:
          (context.req.header('Content-Type') ?? 'application/octet-stream').split(';')[0] ?? '',
        bytes,
      })
      return context.json<UploadDraftAttachmentResponse>({ data: result }, 201)
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.get('/drafts/:draftId/attachments/:attachmentId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const attachment = await getDraftAttachmentDownload({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        userId: session.userId,
        draftId: context.req.param('draftId') ?? '',
        attachmentId: context.req.param('attachmentId') ?? '',
      })
      return new Response(attachment.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader('attachment', attachment.fileName),
          'Content-Length': String(attachment.bytes.byteLength),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Type': 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleDraftError(context, error)
    }
  })

  app.post('/drafts/:draftId/trash', async (context) => {
    return changeDraftTrashStatusFromRequest(context, false)
  })

  app.post('/drafts/:draftId/restore', async (context) => {
    return changeDraftTrashStatusFromRequest(context, true)
  })

  app.post('/drafts/:draftId/send', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readSendDraftBody(context.req.raw)
      const result = await sendDraft({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        queue: context.env.TASK_QUEUE,
        userId: session.userId,
        draftId: context.req.param('draftId') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<SendDraftResponse>({ data: result }, 202)
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.get('/sends/:sendOperationId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const send = await getSendOperation({
        database: context.env.DB,
        userId: session.userId,
        sendOperationId: context.req.param('sendOperationId') ?? '',
      })
      return context.json<SendOperationResponse>({ data: { send } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.get('/admin/outbound', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getOutboundManagementOverview({
        database: context.env.DB,
        actorUserId: session.userId,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<OutboundManagementOverviewResponse>({ data })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.get('/admin/platform-resources', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getPlatformResourceOverview({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<PlatformResourceOverviewResponse>({ data })
    } catch (error) {
      return handlePlatformResourceError(context, error)
    }
  })

  app.get('/admin/operations-health', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getOperationsHealthOverview({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
      })
      return context.json<OperationsHealthOverviewResponse>({ data })
    } catch (error) {
      if (error instanceof OperationsHealthPermissionError) {
        return errorResponse(context, 403, 'administrator_required', error.message)
      }
      throw error
    }
  })

  app.get('/admin/backups', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getSystemBackupOverview({
        database: context.env.DB,
        actorUserId: session.userId,
      })
      return context.json<SystemBackupOverviewResponse>({ data })
    } catch (error) {
      return handleSystemBackupError(context, error)
    }
  })

  app.post('/admin/backups', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const backup = await createSystemBackup({
        database: context.env.DB,
        queue: context.env.TASK_QUEUE,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        actorUserId: session.userId,
        configEncryptionKeyConfigured: Boolean(context.env.CONFIG_KEY),
        audit: auditContext(context),
      })
      return context.json<CreateSystemBackupResponse>({ data: { backup } }, 202)
    } catch (error) {
      return handleSystemBackupError(context, error)
    }
  })

  app.get('/admin/backups/:backupId/manifest', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const manifest = await getSystemBackupManifest({
        database: context.env.DB,
        actorUserId: session.userId,
        backupId: context.req.param('backupId') ?? '',
      })
      return new Response(manifest.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader('attachment', manifest.fileName),
          'Content-Length': String(manifest.bytes.byteLength),
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleSystemBackupError(context, error)
    }
  })

  app.get('/admin/backups/:backupId/parts/:entryId', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const part = await getSystemBackupPart({
        database: context.env.DB,
        objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
        actorUserId: session.userId,
        backupId: context.req.param('backupId') ?? '',
        entryId: context.req.param('entryId') ?? '',
      })
      return new Response(part.bytes, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': contentDispositionHeader('attachment', part.fileName),
          'Content-Length': String(part.bytes.byteLength),
          'Content-Type': part.mediaType,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      return handleSystemBackupError(context, error)
    }
  })

  app.put('/admin/platform-resources/configuration', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readPlatformResourceConfigurationBody(context.req.raw)
      const configuration = await savePlatformResourceConfiguration({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        input,
        audit: auditContext(context),
      })
      return context.json<SavePlatformResourceConfigurationResponse>({
        data: { configuration },
      })
    } catch (error) {
      return handlePlatformResourceError(context, error)
    }
  })

  app.delete('/admin/platform-resources/configuration', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      await deletePlatformResourceConfiguration({
        database: context.env.DB,
        actorUserId: session.userId,
        audit: auditContext(context),
      })
      return context.json<DeletePlatformResourceConfigurationResponse>({ data: { deleted: true } })
    } catch (error) {
      return handlePlatformResourceError(context, error)
    }
  })

  app.post('/admin/platform-resources/refresh', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const resources = await refreshPlatformResourceSnapshots({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<RefreshPlatformResourcesResponse>({ data: { resources } })
    } catch (error) {
      return handlePlatformResourceError(context, error)
    }
  })

  app.put('/admin/platform-resources/:resourceKind/threshold', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readPlatformResourceThresholdBody(context.req.raw)
      const resource = await savePlatformResourceThreshold({
        database: context.env.DB,
        actorUserId: session.userId,
        resourceKind: context.req.param('resourceKind') ?? '',
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        input,
        audit: auditContext(context),
      })
      return context.json<SavePlatformResourceThresholdResponse>({ data: { resource } })
    } catch (error) {
      return handlePlatformResourceError(context, error)
    }
  })

  app.get('/admin/storage-quotas', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getStorageQuotaOverview({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
      })
      return context.json<StorageQuotaOverviewResponse>({ data })
    } catch (error) {
      return handleStorageQuotaError(context, error)
    }
  })

  app.put('/admin/storage-quotas/defaults/:ownerType', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readStorageQuotaDefaultBody(context.req.raw)
      const policy = await saveStorageQuotaDefault({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ownerType: context.req.param('ownerType') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<SaveStorageQuotaDefaultResponse>({ data: { policy } })
    } catch (error) {
      return handleStorageQuotaError(context, error)
    }
  })

  app.put('/admin/storage-quotas/:ownerType/:ownerId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readStorageQuotaOverrideBody(context.req.raw)
      const subject = await saveStorageQuotaOverride({
        database: context.env.DB,
        actorUserId: session.userId,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        ownerType: context.req.param('ownerType') ?? '',
        ownerId: context.req.param('ownerId') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<SaveStorageQuotaOverrideResponse>({ data: { subject } })
    } catch (error) {
      return handleStorageQuotaError(context, error)
    }
  })

  app.post('/admin/outbound/providers', async (context) => {
    return saveOutboundProviderFromRequest(context)
  })

  app.put('/admin/outbound/providers/:providerId', async (context) => {
    return saveOutboundProviderFromRequest(context, context.req.param('providerId') ?? '')
  })

  app.put('/admin/outbound/domains/:domainId/route', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readDomainOutboundRouteBody(context.req.raw)
      const route = await saveDomainOutboundRoute({
        database: context.env.DB,
        actorUserId: session.userId,
        domainId: context.req.param('domainId') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<SaveDomainOutboundRouteResponse>({ data: { route } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.put('/admin/outbound/quotas/daily-default', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readOutboundQuotaBody(context.req.raw)
      await saveDailyDefaultQuota({
        database: context.env.DB,
        actorUserId: session.userId,
        limit: input.limit,
        audit: auditContext(context),
      })
      return context.json<SaveOutboundQuotaResponse>({ data: { saved: true } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.put('/admin/outbound/quotas/domain-monthly-default', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readOutboundQuotaBody(context.req.raw)
      await saveDomainMonthlyDefaultQuota({
        database: context.env.DB,
        actorUserId: session.userId,
        limit: input.limit,
        audit: auditContext(context),
      })
      return context.json<SaveOutboundQuotaResponse>({ data: { saved: true } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.put('/admin/outbound/quotas/users/:userId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readOutboundQuotaBody(context.req.raw)
      await saveUserDailyQuota({
        database: context.env.DB,
        actorUserId: session.userId,
        userId: context.req.param('userId') ?? '',
        limit: input.limit,
        useDefault: Boolean(input.useDefault),
        audit: auditContext(context),
      })
      return context.json<SaveOutboundQuotaResponse>({ data: { saved: true } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.put('/admin/outbound/quotas/domains/:domainId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readOutboundQuotaBody(context.req.raw)
      await saveDomainMonthlyQuota({
        database: context.env.DB,
        actorUserId: session.userId,
        domainId: context.req.param('domainId') ?? '',
        limit: input.limit,
        useDefault: Boolean(input.useDefault),
        audit: auditContext(context),
      })
      return context.json<SaveOutboundQuotaResponse>({ data: { saved: true } })
    } catch (error) {
      return handleSendingError(context, error)
    }
  })

  app.get('/notifications', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getNotificationOverview({
        database: context.env.DB,
        userId: session.userId,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<NotificationOverviewResponse>({ data })
    } catch (error) {
      return handleNotificationError(context, error)
    }
  })

  app.post('/notifications', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readNotificationSubscriptionBody(context.req.raw)
      const subscription = await createNotificationSubscription({
        database: context.env.DB,
        userId: session.userId,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        input,
        audit: auditContext(context),
      })
      return context.json<CreateNotificationSubscriptionResponse>({ data: { subscription } }, 201)
    } catch (error) {
      return handleNotificationError(context, error)
    }
  })

  app.post('/notifications/:subscriptionId/status', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readNotificationStatusBody(context.req.raw)
      const subscription = await changeNotificationSubscriptionStatus({
        database: context.env.DB,
        userId: session.userId,
        subscriptionId: context.req.param('subscriptionId') ?? '',
        status: input.status,
        audit: auditContext(context),
      })
      return context.json<ChangeNotificationSubscriptionStatusResponse>({
        data: { subscription },
      })
    } catch (error) {
      return handleNotificationError(context, error)
    }
  })

  app.delete('/notifications/:subscriptionId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    const subscriptionId = context.req.param('subscriptionId') ?? ''
    try {
      await deleteNotificationSubscription({
        database: context.env.DB,
        userId: session.userId,
        subscriptionId,
        audit: auditContext(context),
      })
      return context.json<DeleteNotificationSubscriptionResponse>({
        data: { deletedSubscriptionId: subscriptionId },
      })
    } catch (error) {
      return handleNotificationError(context, error)
    }
  })

  app.get('/forwarding', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const data = await getForwardingOverview({
        database: context.env.DB,
        userId: session.userId,
      })
      return context.json<ForwardingOverviewResponse>({ data })
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.post('/forwarding/targets', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readExternalEmailTargetBody(context.req.raw)
      const target = await createExternalEmailTarget({
        database: context.env.DB,
        userId: session.userId,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        input,
        audit: auditContext(context),
      })
      return context.json<CreateExternalEmailTargetResponse>({ data: { target } }, 201)
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.post('/forwarding/targets/:targetId/verify', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readExternalEmailVerificationBody(context.req.raw)
      const target = await verifyExternalEmailTarget({
        database: context.env.DB,
        userId: session.userId,
        targetId: context.req.param('targetId') ?? '',
        code: input.code,
        audit: auditContext(context),
      })
      return context.json<VerifyExternalEmailTargetResponse>({ data: { target } })
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.delete('/forwarding/targets/:targetId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    const targetId = context.req.param('targetId') ?? ''
    try {
      await deleteExternalEmailTarget({
        database: context.env.DB,
        userId: session.userId,
        targetId,
        audit: auditContext(context),
      })
      return context.json<DeleteExternalEmailTargetResponse>({
        data: { deletedTargetId: targetId },
      })
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.post('/forwarding/rules', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readForwardingRuleBody(context.req.raw)
      const rule = await saveForwardingRule({
        database: context.env.DB,
        userId: session.userId,
        input,
        audit: auditContext(context),
      })
      return context.json<SaveForwardingRuleResponse>({ data: { rule } }, 201)
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.post('/forwarding/rules/:ruleId/status', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readForwardingRuleStatusBody(context.req.raw)
      const rule = await changeForwardingRuleStatus({
        database: context.env.DB,
        userId: session.userId,
        ruleId: context.req.param('ruleId') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<ChangeForwardingRuleStatusResponse>({ data: { rule } })
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.delete('/forwarding/rules/:ruleId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    const ruleId = context.req.param('ruleId') ?? ''
    try {
      await deleteForwardingRule({
        database: context.env.DB,
        userId: session.userId,
        ruleId,
        audit: auditContext(context),
      })
      return context.json<DeleteForwardingRuleResponse>({ data: { deletedRuleId: ruleId } })
    } catch (error) {
      return handleForwardingError(context, error)
    }
  })

  app.post('/password/change', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readChangePasswordBody(context.req.raw)
      const result = await changeOwnPassword({
        database: context.env.DB,
        session,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: input.revokeOtherSessions,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        audit: auditContext(context),
      })

      return context.json<ChangePasswordResponse>({
        data: {
          passwordChanged: true,
          revokedOtherSessions: result.revokedOtherSessions,
          user: result.user,
        },
      })
    } catch (error) {
      return handlePasswordOperationError(context, error)
    }
  })

  app.post('/password/complete-required-change', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (!session.user.passwordChangeRequired) {
      return errorResponse(context, 409, 'password_change_not_required', '当前账号不需要强制改密')
    }

    try {
      const input = await readRequiredPasswordChangeBody(context.req.raw)
      const result = await changeOwnPassword({
        database: context.env.DB,
        session,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
        source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
        audit: auditContext(context),
      })

      return context.json<ChangePasswordResponse>({
        data: {
          passwordChanged: true,
          revokedOtherSessions: result.revokedOtherSessions,
          user: result.user,
        },
      })
    } catch (error) {
      return handlePasswordOperationError(context, error)
    }
  })

  app.get('/administrator/users', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const overview = await getUserManagementOverview({ database: context.env.DB, session })
      return context.json<UserManagementOverviewResponse>({ data: overview })
    } catch (error) {
      return handleUserManagementError(context, error)
    }
  })

  app.post('/administrator/users', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreateManagedUserBody(context.req.raw)
      const result = await createManagedUser({
        database: context.env.DB,
        session,
        input,
        audit: auditContext(context),
      })
      return context.json<CreateManagedUserResponse>({ data: result }, 201)
    } catch (error) {
      return handleUserManagementError(context, error)
    }
  })

  app.get('/administrator/account-registration-invitations', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const overview = await getAccountRegistrationInvitationOverview({
        database: context.env.DB,
        session,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      })
      return context.json<AccountRegistrationInvitationOverviewResponse>({ data: overview })
    } catch (error) {
      return handleAccountRegistrationError(context, error)
    }
  })

  app.post('/administrator/account-registration-invitations', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
    try {
      const input = await readCreateAccountRegistrationInvitationBody(context.req.raw)
      const invitation = await createAccountRegistrationInvitation({
        database: context.env.DB,
        session,
        input,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        audit: auditContext(context),
      })
      return context.json<CreateAccountRegistrationInvitationResponse>(
        { data: { invitation } },
        201,
      )
    } catch (error) {
      return handleAccountRegistrationError(context, error)
    }
  })

  app.post(
    '/administrator/account-registration-invitations/:invitationId/revoke',
    async (context) => {
      const session = await requireMutationSession(context)
      if (session instanceof Response) return session
      if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
      try {
        const invitation = await revokeAccountRegistrationInvitation({
          database: context.env.DB,
          session,
          invitationId: context.req.param('invitationId') ?? '',
          ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
          audit: auditContext(context),
        })
        return context.json<RevokeAccountRegistrationInvitationResponse>({
          data: { invitation },
        })
      } catch (error) {
        return handleAccountRegistrationError(context, error)
      }
    },
  )

  app.post('/administrator/users/:userId/disable', async (context) => {
    return changeUserStatusFromRequest(context, 'disabled')
  })

  app.post('/administrator/users/:userId/enable', async (context) => {
    return changeUserStatusFromRequest(context, 'active')
  })

  app.get('/administrator/domains', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const domains = await listManagedMailDomains({
        database: context.env.DB,
        actor: administratorActor(session),
      })
      return context.json<DomainManagementOverviewResponse>({ data: { domains } })
    } catch (error) {
      return handleDomainManagementError(context, error)
    }
  })

  app.get('/administrator/address-policy', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      if (session.user.role !== 'administrator') {
        throw new AddressPolicyPermissionError('只有系统管理员可以查看地址策略')
      }
      const policy = await getAddressPolicy(context.env.DB)
      return context.json<AddressPolicyResponse>({ data: { policy } })
    } catch (error) {
      return handleAddressPolicyError(context, error)
    }
  })

  app.get('/administrator/inbound', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const overview = await getInboundControlOverview({
        database: context.env.DB,
        actor: administratorActor(session),
      })
      return context.json<InboundControlOverviewResponse>({ data: overview })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.put('/administrator/inbound/scopes/:scopeType/:scopeId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readInboundReceiveStatusBody(context.req.raw)
      const result = await changeInboundReceiveStatus({
        database: context.env.DB,
        actor: administratorActor(session),
        scopeType: inboundScopeTypeFromUnknown(context.req.param('scopeType')),
        scopeId: context.req.param('scopeId') ?? '',
        status: input.status,
        audit: auditContext(context),
      })
      return context.json<ChangeInboundReceiveStatusResponse>({ data: result })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.put('/administrator/inbound/domains/:domainId/catch-all', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readInboundControlJsonBody(context.req.raw, 'mode')
      if (input.mode !== 'reject' && input.mode !== 'unallocated') {
        throw new InboundControlInputError('mode', '请选择拒收未知地址或全域收信')
      }
      const result = await changeDomainCatchAllMode({
        database: context.env.DB,
        actor: administratorActor(session),
        domainId: context.req.param('domainId') ?? '',
        mode: input.mode,
        audit: auditContext(context),
      })
      return context.json<ChangeDomainCatchAllModeResponse>({ data: result })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.put('/administrator/inbound/domains/:domainId/access/:userId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readInboundControlJsonBody(context.req.raw, 'enabled')
      if (typeof input.enabled !== 'boolean') {
        throw new InboundControlInputError('enabled', '请选择是否允许该用户查看未分配来信')
      }
      const result = await changeUnallocatedAccessGrant({
        database: context.env.DB,
        actor: administratorActor(session),
        domainId: context.req.param('domainId') ?? '',
        userId: context.req.param('userId') ?? '',
        enabled: input.enabled,
        audit: auditContext(context),
      })
      return context.json<ChangeUnallocatedAccessGrantResponse>({ data: result })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.post('/administrator/inbound/rules', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readInboundRejectionRuleBody(context.req.raw)
      const rule = await createInboundRejectionRule({
        database: context.env.DB,
        actor: administratorActor(session),
        ruleType: input.ruleType,
        matchValue: input.matchValue,
        audit: auditContext(context),
      })
      return context.json<CreateInboundRejectionRuleResponse>({ data: { rule } }, 201)
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.put('/administrator/inbound/rules/:ruleId/status', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readInboundRejectionRuleStatusBody(context.req.raw)
      const result = await changeInboundRejectionRuleStatus({
        database: context.env.DB,
        actor: administratorActor(session),
        ruleId: context.req.param('ruleId') ?? '',
        status: input.status,
        audit: auditContext(context),
      })
      return context.json<ChangeInboundRejectionRuleStatusResponse>({ data: result })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.delete('/administrator/inbound/rules/:ruleId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const result = await deleteInboundRejectionRule({
        database: context.env.DB,
        actor: administratorActor(session),
        ruleId: context.req.param('ruleId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeleteInboundRejectionRuleResponse>({ data: result })
    } catch (error) {
      return handleInboundControlError(context, error)
    }
  })

  app.patch('/administrator/address-policy', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readUpdateAddressPolicyBody(context.req.raw)
      const policy = await updateAddressPolicy({
        database: context.env.DB,
        actor: administratorActor(session),
        input,
        audit: auditContext(context),
      })
      return context.json<UpdateAddressPolicyResponse>({ data: { policy } })
    } catch (error) {
      return handleAddressPolicyError(context, error)
    }
  })

  app.post('/administrator/domains', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreateMailDomainBody(context.req.raw)
      const domain = await createManagedMailDomain({
        database: context.env.DB,
        actor: administratorActor(session),
        domainName: input.domainName,
        audit: auditContext(context),
      })
      return context.json<CreateMailDomainResponse>({ data: { domain } }, 201)
    } catch (error) {
      return handleDomainManagementError(context, error)
    }
  })

  app.post('/administrator/domains/:domainId/pause', async (context) => {
    return changeDomainStatusFromRequest(context, 'paused')
  })

  app.post('/administrator/domains/:domainId/resume', async (context) => {
    return changeDomainStatusFromRequest(context, 'active')
  })

  app.delete('/administrator/domains/:domainId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readDeleteMailDomainBody(context.req.raw)
      if (!input.confirmed) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认永久删除域名')
      }
      const result = await deleteManagedMailDomain({
        database: context.env.DB,
        actor: administratorActor(session),
        domainId: context.req.param('domainId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeleteMailDomainResponse>({ data: result })
    } catch (error) {
      return handleDomainManagementError(context, error)
    }
  })

  app.get('/personal-addresses', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const overview = await getPersonalAddressOverview({
        database: context.env.DB,
        actor: personalAddressActor(session),
      })
      return context.json<PersonalAddressOverviewResponse>({ data: overview })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.post('/personal-addresses/aliases', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreatePersonalAliasBody(context.req.raw)
      const result = await createPersonalAlias({
        database: context.env.DB,
        actor: personalAddressActor(session),
        targetUserId: session.userId,
        asAdministrator: false,
        localPart: input.localPart,
        domainId: input.domainId,
        audit: auditContext(context),
      })
      return context.json<CreatePersonalAliasResponse>({ data: result }, 201)
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.patch('/personal-addresses/:addressId/preferences', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readPersonalAddressPreferenceBody(context.req.raw)
      const address = await updatePersonalAddressPreference({
        database: context.env.DB,
        actor: personalAddressActor(session),
        addressId: context.req.param('addressId') ?? '',
        input,
        audit: auditContext(context),
      })
      return context.json<UpdatePersonalAddressPreferenceResponse>({ data: { address } })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.post('/personal-addresses/:addressId/default-sender', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const addresses = await setPersonalDefaultSender({
        database: context.env.DB,
        actor: personalAddressActor(session),
        addressId: context.req.param('addressId') ?? '',
        audit: auditContext(context),
      })
      return context.json<SetDefaultSenderResponse>({ data: { addresses } })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.post('/personal-addresses/:addressId/move', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readMovePersonalAddressBody(context.req.raw)
      const result = await movePersonalAddress({
        database: context.env.DB,
        actor: personalAddressActor(session),
        addressId: context.req.param('addressId') ?? '',
        direction: input.direction,
        audit: auditContext(context),
      })
      return context.json<MovePersonalAddressResponse>({ data: result })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.delete('/personal-addresses/aliases/:addressId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readDeletePersonalAliasBody(context.req.raw)
      if (!input.confirmed) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认删除个人别名')
      }
      const result = await deletePersonalAlias({
        database: context.env.DB,
        actor: personalAddressActor(session),
        targetUserId: session.userId,
        asAdministrator: false,
        addressId: context.req.param('addressId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeletePersonalAliasResponse>({ data: result })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.get('/administrator/alias-policies', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const users = await getAdministratorAliasPolicyOverview({
        database: context.env.DB,
        actor: personalAddressActor(session),
      })
      return context.json<AdministratorAliasPolicyOverviewResponse>({ data: { users } })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.patch('/administrator/users/:userId/alias-policy', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readUpdateUserAliasPolicyBody(context.req.raw)
      const user = await updateUserAliasPolicy({
        database: context.env.DB,
        actor: personalAddressActor(session),
        userId: context.req.param('userId') ?? '',
        aliasLimit: input.aliasLimit,
        selfCreationEnabled: input.selfCreationEnabled,
        audit: auditContext(context),
      })
      return context.json<UpdateUserAliasPolicyResponse>({ data: { user } })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.post('/administrator/users/:userId/aliases', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreatePersonalAliasBody(context.req.raw)
      const result = await createPersonalAlias({
        database: context.env.DB,
        actor: personalAddressActor(session),
        targetUserId: context.req.param('userId') ?? '',
        asAdministrator: true,
        localPart: input.localPart,
        domainId: input.domainId,
        audit: auditContext(context),
      })
      return context.json<CreatePersonalAliasResponse>({ data: result }, 201)
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.delete('/administrator/users/:userId/aliases/:addressId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readDeletePersonalAliasBody(context.req.raw)
      if (!input.confirmed) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认删除个人别名')
      }
      const result = await deletePersonalAlias({
        database: context.env.DB,
        actor: personalAddressActor(session),
        targetUserId: context.req.param('userId') ?? '',
        asAdministrator: true,
        addressId: context.req.param('addressId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeletePersonalAliasResponse>({ data: result })
    } catch (error) {
      return handlePersonalAddressError(context, error)
    }
  })

  app.get('/organizations', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const overview = await getOrganizationOverview({
        database: context.env.DB,
        actor: organizationActor(session),
      })
      return context.json<OrganizationOverviewResponse>({ data: overview })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/organizations', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreateOrganizationBody(context.req.raw)
      const organization = await createOrganization({
        database: context.env.DB,
        actor: organizationActor(session),
        input,
        audit: auditContext(context),
      })
      return context.json<CreateOrganizationResponse>({ data: { organization } }, 201)
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.patch('/organization-invitation-policy', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readOrganizationInvitationPolicyBody(context.req.raw)
      const invitationPolicy = await updateInvitationPolicy({
        database: context.env.DB,
        actor: organizationActor(session),
        invitationPolicy: input.invitationPolicy,
        audit: auditContext(context),
      })
      return context.json<UpdateOrganizationInvitationPolicyResponse>({
        data: { invitationPolicy },
      })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/organizations/:organizationId/invitations', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readCreateOrganizationInvitationBody(context.req.raw)
      const result = await createOrganizationInvitation({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        primaryAddress: input.primaryAddress,
        audit: auditContext(context),
      })
      return context.json<CreateOrganizationInvitationResponse>({ data: result }, 201)
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/organization-invitations/:invitationId/accept', async (context) => {
    return resolveOrganizationInvitationFromRequest(context, 'accepted')
  })

  app.post('/organization-invitations/:invitationId/reject', async (context) => {
    return resolveOrganizationInvitationFromRequest(context, 'rejected')
  })

  app.delete('/organizations/:organizationId/invitations/:invitationId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const result = await revokeOrganizationInvitation({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        invitationId: context.req.param('invitationId') ?? '',
        audit: auditContext(context),
      })
      return context.json<ResolveOrganizationInvitationResponse>({ data: result })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.patch('/organizations/:organizationId/sending-permission', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readOrganizationSendingPermissionBody(context.req.raw)
      const organization = await updateOrganizationSendingPermission({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        membersCanSend: input.membersCanSend,
        audit: auditContext(context),
      })
      return context.json<UpdateOrganizationSendingPermissionResponse>({
        data: { organization },
      })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/organizations/:organizationId/leave', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readLeaveOrganizationBody(context.req.raw)
      if (!input.confirmed) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认退出组织')
      }
      const result = await leaveOrganization({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        successorUserId: input.successorUserId,
        audit: auditContext(context),
      })
      return context.json<LeaveOrganizationResponse>({ data: result })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.delete('/organizations/:organizationId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readDeleteOrganizationBody(context.req.raw)
      if (!input.confirmed) {
        return errorResponse(context, 422, 'confirmation_required', '请再次确认删除组织')
      }
      const result = await deleteOrganization({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        audit: auditContext(context),
      })
      return context.json<DeleteOrganizationResponse>({ data: result })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/organizations/:organizationId/restore', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const organization = await restoreOrganization({
        database: context.env.DB,
        actor: organizationActor(session),
        organizationId: context.req.param('organizationId') ?? '',
        audit: auditContext(context),
      })
      return context.json<RestoreOrganizationResponse>({ data: { organization } })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.get('/administrator/organization-policies', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const users = await getAdministratorOrganizationPolicyOverview({
        database: context.env.DB,
        actor: organizationActor(session),
      })
      return context.json<AdministratorOrganizationPolicyOverviewResponse>({ data: { users } })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.patch('/administrator/users/:userId/organization-policy', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readUpdateUserOrganizationPolicyBody(context.req.raw)
      const user = await updateUserOrganizationPolicy({
        database: context.env.DB,
        actor: organizationActor(session),
        userId: context.req.param('userId') ?? '',
        organizationLimit: input.organizationLimit,
        audit: auditContext(context),
      })
      return context.json<UpdateUserOrganizationPolicyResponse>({ data: { user } })
    } catch (error) {
      return handleOrganizationError(context, error)
    }
  })

  app.post('/administrator/users/password-reset', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    try {
      const input = await readAdministratorPasswordResetBody(context.req.raw)
      const result = await resetUserPasswordAsAdministrator({
        database: context.env.DB,
        session,
        primaryAddress: input.primaryAddress,
        audit: auditContext(context),
      })

      return context.json<AdministratorPasswordResetResponse>({
        data: {
          user: result.user,
          temporaryPassword: result.temporaryPassword,
          expiresAt: result.expiresAt,
        },
      })
    } catch (error) {
      return handlePasswordOperationError(context, error)
    }
  })

  app.post('/administrator-recovery/authorize', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }
    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }

    const authorizationError = await authorizeRecoveryRequest(context)
    if (authorizationError) return authorizationError

    const administrator = await getAdministratorRecoverySubject(context.env.DB)
    if (!administrator) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }

    return context.json<AdministratorRecoveryAuthorizationResponse>({
      data: {
        authorized: true,
        administrator: {
          displayName: administrator.displayName,
          primaryAddress: administrator.primaryAddress,
        },
      },
    })
  })

  app.post('/administrator-recovery/complete', async (context) => {
    if (!(await isSystemInitialized(context.env.DB))) {
      return errorResponse(context, 409, 'not_initialized', '系统尚未完成初始化')
    }
    if (!hasSameOrigin(context.req.raw)) {
      return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
    }

    const authorizationError = await authorizeRecoveryRequest(context)
    if (authorizationError) return authorizationError

    try {
      const input = await readAdministratorRecoveryBody(context.req.raw)
      const administrator = await recoverAdministratorPassword({
        database: context.env.DB,
        newPassword: input.newPassword,
        audit: auditContext(context),
      })
      clearAuthenticationCookies(context)

      return context.json<AdministratorRecoveryResponse>({
        data: {
          recovered: true,
          administrator: {
            displayName: administrator.displayName,
            primaryAddress: administrator.primaryAddress,
          },
        },
      })
    } catch (error) {
      return handlePasswordOperationError(context, error)
    }
  })

  app.get('/sessions', async (context) => {
    const session = await requireSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    return context.json<SessionListResponse>({
      data: {
        sessions: await listUserSessions({ database: context.env.DB, session }),
      },
    })
  })

  app.post('/logout', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session

    await revokeUserSession({
      database: context.env.DB,
      session,
      targetSessionId: session.id,
      reason: 'user_logout',
    })
    clearAuthenticationCookies(context)

    return context.json<LogoutResponse>({ data: { authenticated: false } })
  })

  app.delete('/sessions/:sessionId', async (context) => {
    const session = await requireMutationSession(context)
    if (session instanceof Response) return session
    if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

    const targetSessionId = context.req.param('sessionId')
    if (!/^[0-9a-f-]{36}$/u.test(targetSessionId)) {
      return errorResponse(context, 404, 'session_not_found', '该会话不存在或已经退出')
    }

    try {
      const result = await revokeUserSession({
        database: context.env.DB,
        session,
        targetSessionId,
      })
      if (result.currentSessionRevoked) clearAuthenticationCookies(context)

      return context.json<RevokeSessionResponse>({
        data: {
          revokedSessionId: targetSessionId,
          currentSessionRevoked: result.currentSessionRevoked,
        },
      })
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return errorResponse(context, 404, 'session_not_found', error.message)
      }
      throw error
    }
  })

  return app
}

async function requireSession(
  context: AuthenticationContext,
): Promise<AuthenticatedSession | Response> {
  const session = await authenticateSession({
    database: context.env.DB,
    sessionToken: getCookie(context, SESSION_COOKIE_NAME),
  })

  if (session) return session

  clearAuthenticationCookies(context)
  return errorResponse(context, 401, 'authentication_required', '登录会话无效或已经过期')
}

async function requireMutationSession(
  context: AuthenticationContext,
): Promise<AuthenticatedSession | Response> {
  if (!hasSameOrigin(context.req.raw)) {
    return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
  }

  const session = await requireSession(context)
  if (session instanceof Response) return session

  const suppliedToken = context.req.header(CSRF_HEADER_NAME)
  const cookieToken = getCookie(context, CSRF_COOKIE_NAME)
  if (
    !suppliedToken ||
    suppliedToken !== cookieToken ||
    !(await verifySessionCsrf(session, suppliedToken))
  ) {
    return errorResponse(context, 403, 'csrf_rejected', '请求来源验证失败')
  }

  return session
}

async function requireRecoverySession(
  context: AuthenticationContext,
): Promise<AuthenticatedRecoverySession | Response> {
  const session = await authenticateRecoverySession({
    database: context.env.DB,
    sessionToken: getCookie(context, RECOVERY_SESSION_COOKIE_NAME),
  })
  if (session) return session

  clearRecoveryCookies(context)
  return errorResponse(context, 401, 'recovery_session_invalid', '账号恢复会话无效或已经过期')
}

async function requireRecoveryMutationSession(
  context: AuthenticationContext,
): Promise<AuthenticatedRecoverySession | Response> {
  if (!hasSameOrigin(context.req.raw)) {
    return errorResponse(context, 403, 'origin_rejected', '请求来源验证失败')
  }
  const session = await requireRecoverySession(context)
  if (session instanceof Response) return session

  const suppliedToken = context.req.header(RECOVERY_CSRF_HEADER_NAME)
  const cookieToken = getCookie(context, RECOVERY_CSRF_COOKIE_NAME)
  if (
    !suppliedToken ||
    suppliedToken !== cookieToken ||
    !(await verifyRecoverySessionCsrf(session, suppliedToken))
  ) {
    return errorResponse(context, 403, 'csrf_rejected', '请求来源验证失败')
  }
  return session
}

async function authorizeRecoveryRequest(context: AuthenticationContext): Promise<Response | null> {
  try {
    await authorizeInitializationKey({
      database: context.env.DB,
      configuredKey: context.env.INIT_KEY,
      providedKey: decodeInitializationKeyHeader(
        context.req.header(INITIALIZATION_KEY_HEADER) ?? '',
      ),
      source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
    })
    return null
  } catch (error) {
    if (!(error instanceof InitializationKeyError)) throw error

    if (error.code === 'rate_limited') {
      context.header('Retry-After', String(error.retryAfterSeconds ?? 900))
      return errorResponse(context, 429, error.code, error.message)
    }
    if (error.code === 'configuration_invalid') {
      return errorResponse(context, 503, error.code, error.message)
    }
    return errorResponse(context, 401, error.code, error.message)
  }
}

function passwordChangeRequiredResponse(context: AuthenticationContext): Response {
  return errorResponse(
    context,
    403,
    'password_change_required',
    '请先设置新的正式密码，再继续使用其他功能',
  )
}

function handlePasswordOperationError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof PasswordManagementInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof CurrentPasswordIncorrectError) {
    return errorResponse(
      context,
      401,
      'current_password_incorrect',
      error.message,
      'currentPassword',
    )
  }
  if (error instanceof TemporaryPasswordExpiredError) {
    clearAuthenticationCookies(context)
    return errorResponse(context, 401, 'temporary_password_expired', error.message)
  }
  if (error instanceof AdministratorPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof PasswordResetTargetError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message, 'primaryAddress')
  }
  if (error instanceof PasswordUpdateConflictError) {
    return errorResponse(context, 409, 'password_update_conflict', error.message)
  }
  if (error instanceof LoginRateLimitedError) {
    context.header('Retry-After', String(error.retryAfterSeconds))
    return errorResponse(context, 429, 'rate_limited', error.message)
  }
  throw error
}

function handleAccountLifecycleError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof AccountLifecycleInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof AccountLifecycleAccessError) {
    const status =
      error.code === 'invalid_credentials' ||
      error.code === 'recovery_session_invalid' ||
      error.code === 'recovery_expired'
        ? 401
        : 409
    if (status === 401 && error.code !== 'invalid_credentials') clearRecoveryCookies(context)
    return errorResponse(context, status, error.code, error.message)
  }
  if (error instanceof AdministratorPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof LoginRateLimitedError) {
    context.header('Retry-After', String(error.retryAfterSeconds))
    return errorResponse(context, 429, 'rate_limited', error.message)
  }
  throw error
}

function handleMailboxError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof MailboxInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof MailboxAccessError) {
    const status =
      error.code === 'object_unavailable'
        ? 503
        : error.code === 'not_found'
          ? 404
          : error.code === 'permission_denied'
            ? 403
            : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleMailExportError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof MailExportInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof MailExportAccessError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'permission_denied'
          ? 403
          : error.code === 'object_unavailable'
            ? 503
            : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleDraftError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof DraftInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof DraftMutationConflictError) {
    return errorResponse(context, 409, 'mutation_conflict', error.message)
  }
  if (error instanceof DraftAccessError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'sender_unavailable' ? 403 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleNotificationError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof NotificationInputError) {
    const configurationMissing = error.message.includes('CONFIG_KEY')
    return errorResponse(
      context,
      configurationMissing ? 503 : 422,
      configurationMissing ? 'notification_encryption_unavailable' : 'invalid_input',
      error.message,
      error.field,
    )
  }
  if (error instanceof NotificationAccessError) {
    return errorResponse(context, error.code === 'not_found' ? 404 : 409, error.code, error.message)
  }
  throw error
}

function handleForwardingError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof ForwardingInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof ForwardingAccessError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'rate_limited'
          ? 429
          : error.code === 'route_unavailable'
            ? 503
            : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleSendingError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof SendInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof SendMutationConflictError) {
    return errorResponse(context, 409, 'send_key_conflict', error.message)
  }
  if (error instanceof SendAccessError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'sender_unavailable'
          ? 403
          : error.code === 'quota_exceeded'
            ? 429
            : 409
    return errorResponse(context, status, error.code, error.message)
  }
  if (error instanceof OutboundConfigurationError) {
    const status = error.field === 'encryptionKey' ? 503 : error.field === 'providerId' ? 404 : 422
    return errorResponse(
      context,
      status,
      'outbound_configuration_invalid',
      error.message,
      error.field,
    )
  }
  if (error instanceof OutboundPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  throw error
}

function handlePlatformResourceError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof PlatformResourceInputError) {
    const configurationMissing = error.field === 'encryptionKey'
    return errorResponse(
      context,
      configurationMissing ? 503 : 422,
      configurationMissing ? 'platform_resource_encryption_unavailable' : 'invalid_input',
      error.message,
      error.field,
    )
  }
  if (error instanceof PlatformResourcePermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof PlatformResourceRefreshError) {
    const status = error.code === 'configuration_missing' ? 409 : 503
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleStorageQuotaError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof StorageQuotaInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof StorageQuotaPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  throw error
}

function handleSystemBackupError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof SystemBackupPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof SystemBackupAccessError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'object_unavailable' ? 503 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

async function saveOutboundProviderFromRequest(
  context: AuthenticationContext,
  providerId?: string,
): Promise<Response> {
  const session = await requireMutationSession(context)
  if (session instanceof Response) return session
  if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
  try {
    const input = await readOutboundProviderBody(context.req.raw, providerId)
    const provider = await saveOutboundProvider({
      database: context.env.DB,
      actorUserId: session.userId,
      ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
      input,
      audit: auditContext(context),
    })
    return context.json<SaveOutboundProviderResponse>({ data: { provider } }, 201)
  } catch (error) {
    return handleSendingError(context, error)
  }
}

async function changeDraftTrashStatusFromRequest(
  context: AuthenticationContext,
  restore: boolean,
): Promise<Response> {
  const session = await requireMutationSession(context)
  if (session instanceof Response) return session
  if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)
  try {
    const draft = await changeDraftTrashStatus({
      database: context.env.DB,
      objectStore: createMailObjectStore(context.env, parseStorageMode(context.env.STORAGE_MODE)),
      userId: session.userId,
      draftId: context.req.param('draftId') ?? '',
      restore,
    })
    return context.json<ChangeDraftStatusResponse>({ data: { draft } })
  } catch (error) {
    return handleDraftError(context, error)
  }
}

async function readCreateDraftBody(request: Request): Promise<CreateDraftRequest> {
  const value = await readDraftJsonBody(request, 4_096)
  const senderAddressId =
    value.senderAddressId === null || typeof value.senderAddressId === 'string'
      ? value.senderAddressId
      : undefined
  const sourceMailboxEntryId =
    value.sourceMailboxEntryId === null || typeof value.sourceMailboxEntryId === 'string'
      ? value.sourceMailboxEntryId
      : undefined
  const composeKind =
    value.composeKind === 'new' ||
    value.composeKind === 'reply' ||
    value.composeKind === 'reply_all' ||
    value.composeKind === 'forward'
      ? value.composeKind
      : undefined
  return {
    ...(senderAddressId !== undefined ? { senderAddressId } : {}),
    ...(sourceMailboxEntryId !== undefined ? { sourceMailboxEntryId } : {}),
    ...(composeKind !== undefined ? { composeKind } : {}),
  }
}

async function readSendDraftBody(request: Request): Promise<SendDraftRequest> {
  const value = await readSendingJsonBody(request)
  return {
    requestKey: typeof value.requestKey === 'string' ? value.requestKey : '',
    expectedRevisionNumber:
      typeof value.expectedRevisionNumber === 'number' ? value.expectedRevisionNumber : 0,
  }
}

async function readNotificationSubscriptionBody(
  request: Request,
): Promise<CreateNotificationSubscriptionRequest> {
  const value = await readNotificationJsonBody(request)
  return {
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    channelType: notificationChannelFromUnknown(value.channelType),
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    destination: typeof value.destination === 'string' ? value.destination : '',
    credential: typeof value.credential === 'string' ? value.credential : '',
    scopes: Array.isArray(value.scopes) ? value.scopes.map(notificationScopeFromUnknown) : [],
  }
}

async function readNotificationStatusBody(
  request: Request,
): Promise<ChangeNotificationSubscriptionStatusRequest> {
  const value = await readNotificationJsonBody(request)
  if (value.status !== 'active' && value.status !== 'paused') {
    throw new NotificationInputError('subscriptionId', '通知订阅状态无效')
  }
  return { status: value.status }
}

function notificationChannelFromUnknown(value: unknown): NotificationChannelType {
  if (
    value === 'ntfy' ||
    value === 'gotify' ||
    value === 'wxpusher' ||
    value === 'telegram' ||
    value === 'bark'
  ) {
    return value
  }
  throw new NotificationInputError('channelType', '通知通道无效')
}

function notificationScopeFromUnknown(value: unknown): NotificationScopeInput {
  if (!isRecord(value)) throw new NotificationInputError('scopes', '邮件来源格式无效')
  if (value.kind === 'all_personal') return { kind: 'all_personal' }
  if (value.kind === 'personal_address' || value.kind === 'organization_address') {
    return {
      kind: value.kind,
      addressId: typeof value.addressId === 'string' ? value.addressId : '',
    }
  }
  throw new NotificationInputError('scopes', '邮件来源类型无效')
}

async function readNotificationJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new NotificationInputError('subscriptionId', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new NotificationInputError('subscriptionId', '请求内容过大')
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new NotificationInputError('subscriptionId', '请求格式无效')
  }
}

async function readExternalEmailTargetBody(
  request: Request,
): Promise<CreateExternalEmailTargetRequest> {
  const value = await readForwardingJsonBody(request)
  return { emailAddress: typeof value.emailAddress === 'string' ? value.emailAddress : '' }
}

async function readExternalEmailVerificationBody(
  request: Request,
): Promise<VerifyExternalEmailTargetRequest> {
  const value = await readForwardingJsonBody(request)
  return { code: typeof value.code === 'string' ? value.code : '' }
}

async function readForwardingRuleBody(request: Request): Promise<SaveForwardingRuleRequest> {
  const value = await readForwardingJsonBody(request)
  const scope =
    value.scope === 'all_personal' || value.scope === 'selected_personal_addresses'
      ? value.scope
      : 'all_personal'
  return {
    ...(typeof value.ruleId === 'string' ? { ruleId: value.ruleId } : {}),
    targetId: typeof value.targetId === 'string' ? value.targetId : '',
    scope,
    addressIds: Array.isArray(value.addressIds)
      ? value.addressIds.filter((addressId): addressId is string => typeof addressId === 'string')
      : [],
    enabled: value.enabled === true,
  }
}

async function readForwardingRuleStatusBody(
  request: Request,
): Promise<ChangeForwardingRuleStatusRequest> {
  const value = await readForwardingJsonBody(request)
  if (value.status !== 'active' && value.status !== 'paused') {
    throw new ForwardingInputError('ruleId', '转发规则状态无效')
  }
  return { status: value.status }
}

async function readForwardingJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ForwardingInputError('ruleId', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new ForwardingInputError('ruleId', '请求内容过大')
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new ForwardingInputError('ruleId', '请求格式无效')
  }
}

async function readOutboundProviderBody(
  request: Request,
  providerId?: string,
): Promise<SaveOutboundProviderRequest> {
  const value = await readSendingJsonBody(request)
  if (value.providerType !== 'resend' && value.providerType !== 'smtp2go') {
    throw new OutboundConfigurationError('providerType', '首发只支持 Resend 和 SMTP2GO')
  }
  return {
    ...(providerId !== undefined ? { id: providerId } : {}),
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
    providerType: value.providerType,
    credential: typeof value.credential === 'string' ? value.credential : '',
    callbackUsername: typeof value.callbackUsername === 'string' ? value.callbackUsername : null,
    callbackSecret: typeof value.callbackSecret === 'string' ? value.callbackSecret : '',
  }
}

async function readPlatformResourceConfigurationBody(
  request: Request,
): Promise<SavePlatformResourceConfigurationRequest> {
  const value = await readPlatformResourceJsonBody(request, 'accountId')
  return {
    accountId: typeof value.accountId === 'string' ? value.accountId : '',
    d1DatabaseId: typeof value.d1DatabaseId === 'string' ? value.d1DatabaseId : '',
    storageResourceReference:
      typeof value.storageResourceReference === 'string' ? value.storageResourceReference : '',
    apiToken: typeof value.apiToken === 'string' ? value.apiToken : '',
  }
}

async function readPlatformResourceThresholdBody(
  request: Request,
): Promise<SavePlatformResourceThresholdRequest> {
  const value = await readPlatformResourceJsonBody(request, 'warningPercent')
  return {
    warningPercent: typeof value.warningPercent === 'number' ? value.warningPercent : 0,
    stopPercent: typeof value.stopPercent === 'number' ? value.stopPercent : 0,
  }
}

async function readPlatformResourceJsonBody(
  request: Request,
  fallbackField: 'accountId' | 'warningPercent',
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new PlatformResourceInputError(fallbackField, '请求必须使用 JSON 格式')
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > 16_384) {
    throw new PlatformResourceInputError(fallbackField, '请求内容过大')
  }
  try {
    const value = JSON.parse(body) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new PlatformResourceInputError(fallbackField, '请求格式无效')
  }
}

async function readStorageQuotaDefaultBody(
  request: Request,
): Promise<SaveStorageQuotaDefaultRequest> {
  const value = await readStorageQuotaJsonBody(request)
  return { limitBytes: typeof value.limitBytes === 'number' ? value.limitBytes : 0 }
}

async function readStorageQuotaOverrideBody(
  request: Request,
): Promise<SaveStorageQuotaOverrideRequest> {
  const value = await readStorageQuotaJsonBody(request)
  return {
    limitBytes:
      value.limitBytes === null
        ? null
        : typeof value.limitBytes === 'number'
          ? value.limitBytes
          : 0,
  }
}

async function readStorageQuotaJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new StorageQuotaInputError('limitBytes', '请求必须使用 JSON 格式')
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > 16_384) {
    throw new StorageQuotaInputError('limitBytes', '请求内容过大')
  }
  try {
    const value = JSON.parse(body) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new StorageQuotaInputError('limitBytes', '请求格式无效')
  }
}

async function readOutboundQuotaBody(request: Request): Promise<SaveOutboundQuotaRequest> {
  const value = await readSendingJsonBody(request)
  return {
    limit: typeof value.limit === 'number' ? value.limit : null,
    useDefault: value.useDefault === true,
  }
}

async function readDomainOutboundRouteBody(
  request: Request,
): Promise<SaveDomainOutboundRouteRequest> {
  const value = await readSendingJsonBody(request)
  return {
    providerConfigIds: Array.isArray(value.providerConfigIds)
      ? value.providerConfigIds.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

async function readSendingJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new SendInputError('message', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new SendInputError('message', '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SendInputError('message', '请求格式无效')
  }
  if (!isRecord(value)) throw new SendInputError('message', '请求格式无效')
  return value
}

async function readSaveDraftBody(request: Request): Promise<SaveDraftRequest> {
  const value = await readDraftJsonBody(request, MAX_DRAFT_JSON_BYTES)
  return {
    mutationKey: typeof value.mutationKey === 'string' ? value.mutationKey : '',
    expectedRevisionNumber:
      typeof value.expectedRevisionNumber === 'number' ? value.expectedRevisionNumber : 0,
    senderAddressId: typeof value.senderAddressId === 'string' ? value.senderAddressId : null,
    subject: typeof value.subject === 'string' ? value.subject : '',
    bodyFormat: value.bodyFormat === 'plain_text' ? 'plain_text' : 'rich_text',
    body: typeof value.body === 'string' ? value.body : '',
    recipients: Array.isArray(value.recipients)
      ? value.recipients.map(draftRecipientFromUnknown)
      : [],
    attachmentIds: Array.isArray(value.attachmentIds)
      ? value.attachmentIds.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function draftRecipientFromUnknown(value: unknown): DraftRecipient {
  if (!isRecord(value)) return { role: 'to', displayName: null, address: '' }
  return {
    role: value.role === 'cc' ? 'cc' : value.role === 'bcc' ? 'bcc' : 'to',
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
    address: typeof value.address === 'string' ? value.address : '',
  }
}

async function readDraftJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new DraftInputError('draftId', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new DraftInputError('body', '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DraftInputError('draftId', '请求格式无效')
  }
  if (!isRecord(value)) throw new DraftInputError('draftId', '请求格式无效')
  return value
}

async function readMailboxJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new MailboxInputError('mode', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new MailboxInputError('mode', '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MailboxInputError('mode', '请求格式无效')
  }
  if (!isRecord(value)) throw new MailboxInputError('mode', '请求格式无效')
  return value
}

async function readUnallocatedMailJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new UnallocatedMailInputError('confirmed', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new UnallocatedMailInputError('confirmed', '请求内容过大')
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new UnallocatedMailInputError('confirmed', '请求格式无效')
  }
}

async function readMailExportJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new MailExportInputError('scopeType', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new MailExportInputError('scopeType', '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new MailExportInputError('scopeType', '请求格式无效')
  }
  if (!isRecord(value)) throw new MailExportInputError('scopeType', '请求格式无效')
  return value
}

function contentDispositionHeader(kind: 'attachment' | 'inline', fileName: string): string {
  const asciiFallback = fileName
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 120)
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${asciiFallback || 'attachment'}"; filename*=UTF-8''${encoded}`
}

async function changeUserStatusFromRequest(
  context: AuthenticationContext,
  status: 'active' | 'disabled',
): Promise<Response> {
  const session = await requireMutationSession(context)
  if (session instanceof Response) return session
  if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

  try {
    const result = await changeManagedUserStatus({
      database: context.env.DB,
      session,
      userId: context.req.param('userId') ?? '',
      status,
      audit: auditContext(context),
    })
    return context.json<ChangeManagedUserStatusResponse>({ data: result })
  } catch (error) {
    return handleUserManagementError(context, error)
  }
}

function handleUserManagementError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof AdministratorPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof UserManagementInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof UserCreationConflictError) {
    return errorResponse(context, 409, error.code, error.message, 'localPart')
  }
  if (error instanceof ManagedUserTargetError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleAccountRegistrationError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof AccountRegistrationInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof AccountRegistrationPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof AccountRegistrationRateLimitedError) {
    context.header('Retry-After', String(error.retryAfterSeconds))
    return errorResponse(context, 429, 'rate_limited', error.message)
  }
  if (error instanceof InvitationCodeConfigurationError) {
    return errorResponse(context, 503, 'invitation_encryption_unavailable', error.message)
  }
  if (error instanceof AccountRegistrationAccessError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message, error.field)
  }
  throw error
}

async function changeDomainStatusFromRequest(
  context: AuthenticationContext,
  status: 'active' | 'paused',
): Promise<Response> {
  const session = await requireMutationSession(context)
  if (session instanceof Response) return session
  if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

  try {
    const result = await changeManagedMailDomainStatus({
      database: context.env.DB,
      actor: administratorActor(session),
      domainId: context.req.param('domainId') ?? '',
      status,
      audit: auditContext(context),
    })
    return context.json<ChangeMailDomainStatusResponse>({ data: result })
  } catch (error) {
    return handleDomainManagementError(context, error)
  }
}

function handleDomainManagementError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof DomainManagementPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof DomainManagementInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof MailDomainConflictError) {
    return errorResponse(context, 409, error.code, error.message, 'domainName')
  }
  if (error instanceof MailDomainTargetError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleInboundControlError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof InboundControlPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof InboundControlInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof InboundControlTargetError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleUnallocatedMailError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof UnallocatedMailInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof AddressPolicyInputError) {
    return errorResponse(context, 422, 'invalid_address_policy', error.message, error.field)
  }
  if (error instanceof UnallocatedMailAccessError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'permission_denied'
          ? 403
          : error.code === 'object_unavailable'
            ? 503
            : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handlePersonalAddressError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof AddressPolicyInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof PersonalAddressPermissionError) {
    return errorResponse(context, 403, 'address_permission_denied', error.message)
  }
  if (error instanceof PersonalAddressInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof PersonalAliasCreationError) {
    const status = error.code === 'address_unavailable' ? 409 : 422
    return errorResponse(context, status, error.code, error.message, error.field ?? undefined)
  }
  if (error instanceof PersonalAddressTargetError) {
    const status = error.code === 'not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message)
  }
  throw error
}

function handleAddressPolicyError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof AddressPolicyPermissionError) {
    return errorResponse(context, 403, 'administrator_required', error.message)
  }
  if (error instanceof AddressPolicyInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof AddressPolicyConflictError) {
    return errorResponse(context, 409, 'address_policy_conflict', error.message)
  }
  throw error
}

async function resolveOrganizationInvitationFromRequest(
  context: AuthenticationContext,
  decision: 'accepted' | 'rejected',
): Promise<Response> {
  const session = await requireMutationSession(context)
  if (session instanceof Response) return session
  if (session.user.passwordChangeRequired) return passwordChangeRequiredResponse(context)

  try {
    const result = await resolveOrganizationInvitation({
      database: context.env.DB,
      actor: organizationActor(session),
      invitationId: context.req.param('invitationId') ?? '',
      decision,
      audit: auditContext(context),
    })
    return context.json<ResolveOrganizationInvitationResponse>({ data: result })
  } catch (error) {
    return handleOrganizationError(context, error)
  }
}

function handleOrganizationError(context: AuthenticationContext, error: unknown): Response {
  if (error instanceof OrganizationInputError) {
    return errorResponse(context, 422, 'invalid_input', error.message, error.field)
  }
  if (error instanceof OrganizationPermissionError) {
    return errorResponse(context, 403, 'organization_permission_denied', error.message)
  }
  if (error instanceof OrganizationCreationError) {
    const status = error.code === 'domain_unavailable' ? 422 : 409
    return errorResponse(context, status, error.code, error.message, error.field ?? undefined)
  }
  if (error instanceof OrganizationInvitationError) {
    const status =
      error.code === 'user_not_found' || error.code === 'invitation_not_found' ? 404 : 409
    return errorResponse(context, status, error.code, error.message, error.field ?? undefined)
  }
  if (error instanceof OrganizationTargetError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'successor_required' || error.code === 'successor_unavailable'
          ? 422
          : 409
    return errorResponse(context, status, error.code, error.message, error.field ?? undefined)
  }
  throw error
}

function administratorActor(session: AuthenticatedSession) {
  return {
    userId: session.userId,
    isAdministrator: session.user.role === 'administrator',
  }
}

function personalAddressActor(session: AuthenticatedSession) {
  return {
    userId: session.userId,
    isAdministrator: session.user.role === 'administrator',
  }
}

function organizationActor(session: AuthenticatedSession) {
  return {
    userId: session.userId,
    isAdministrator: session.user.role === 'administrator',
  }
}

async function readCreateOrganizationBody(request: Request): Promise<CreateOrganizationRequest> {
  const value = await readOrganizationJsonBody(request, 'name')
  return {
    name: readOrganizationString(value, 'name', 120),
    localPart: readOrganizationString(value, 'localPart', 64),
    domainId: readOrganizationString(value, 'domainId', 36),
  }
}

async function readOrganizationInvitationPolicyBody(
  request: Request,
): Promise<UpdateOrganizationInvitationPolicyRequest> {
  const value = await readOrganizationJsonBody(request, 'invitationPolicy')
  if (
    value.invitationPolicy !== 'reject_all' &&
    value.invitationPolicy !== 'manual' &&
    value.invitationPolicy !== 'auto_accept'
  ) {
    throw new OrganizationInputError('invitationPolicy', '请选择有效的组织邀请策略')
  }
  return { invitationPolicy: value.invitationPolicy }
}

async function readCreateOrganizationInvitationBody(
  request: Request,
): Promise<CreateOrganizationInvitationRequest> {
  const value = await readOrganizationJsonBody(request, 'primaryAddress')
  return { primaryAddress: readOrganizationString(value, 'primaryAddress', 320) }
}

async function readOrganizationSendingPermissionBody(
  request: Request,
): Promise<UpdateOrganizationSendingPermissionRequest> {
  const value = await readOrganizationJsonBody(request, 'membersCanSend')
  if (typeof value.membersCanSend !== 'boolean') {
    throw new OrganizationInputError('membersCanSend', '请选择成员是否可以使用组织地址发信')
  }
  return { membersCanSend: value.membersCanSend }
}

async function readLeaveOrganizationBody(request: Request): Promise<LeaveOrganizationRequest> {
  const value = await readOrganizationJsonBody(request, 'successorUserId')
  if (
    value.successorUserId !== null &&
    (typeof value.successorUserId !== 'string' || value.successorUserId.length > 36)
  ) {
    throw new OrganizationInputError('successorUserId', '请选择有效的继承成员')
  }
  return {
    successorUserId: value.successorUserId,
    confirmed: value.confirmed === true,
  }
}

async function readDeleteOrganizationBody(request: Request): Promise<DeleteOrganizationRequest> {
  const value = await readOrganizationJsonBody(request, 'name')
  return { confirmed: value.confirmed === true }
}

async function readUpdateUserOrganizationPolicyBody(
  request: Request,
): Promise<UpdateUserOrganizationPolicyRequest> {
  const value = await readOrganizationJsonBody(request, 'organizationLimit')
  if (!Number.isInteger(value.organizationLimit)) {
    throw new OrganizationInputError('organizationLimit', '请输入有效的组织上限')
  }
  return { organizationLimit: value.organizationLimit as number }
}

async function readOrganizationJsonBody(
  request: Request,
  fallbackField:
    | 'name'
    | 'primaryAddress'
    | 'invitationPolicy'
    | 'membersCanSend'
    | 'successorUserId'
    | 'organizationLimit',
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new OrganizationInputError(fallbackField, '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new OrganizationInputError(fallbackField, '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new OrganizationInputError(fallbackField, '请求格式无效')
  }
  if (!isRecord(value)) throw new OrganizationInputError(fallbackField, '请求格式无效')
  return value
}

function readOrganizationString(
  value: Record<string, unknown>,
  field: 'name' | 'localPart' | 'domainId' | 'primaryAddress',
  maximumLength: number,
): string {
  const input = value[field]
  if (typeof input !== 'string' || input.trim().length === 0 || [...input].length > maximumLength) {
    throw new OrganizationInputError(field, '请完整填写组织信息')
  }
  return input
}

async function readCreatePersonalAliasBody(request: Request): Promise<CreatePersonalAliasRequest> {
  const value = await readPersonalAddressJsonBody(request)
  return {
    localPart: readPersonalAddressString(value, 'localPart', 64),
    domainId: readPersonalAddressString(value, 'domainId', 36),
  }
}

async function readUpdateAddressPolicyBody(request: Request): Promise<UpdateAddressPolicyRequest> {
  const value = await readPersonalAddressJsonBody(request)
  return {
    minimumLocalPartLength: readAddressPolicyInteger(value, 'minimumLocalPartLength'),
    aliasRetentionDays: readAddressPolicyInteger(value, 'aliasRetentionDays'),
    blockedSubstrings: readAddressPolicyStringList(value, 'blockedSubstrings'),
    reservedNames: readAddressPolicyStringList(value, 'reservedNames'),
    expectedVersion: readAddressPolicyInteger(value, 'expectedVersion'),
  }
}

function readAddressPolicyInteger(
  value: Record<string, unknown>,
  field: 'minimumLocalPartLength' | 'aliasRetentionDays' | 'expectedVersion',
): number {
  const input = value[field]
  if (!Number.isInteger(input)) {
    throw new AddressPolicyInputError(field, '请输入有效的整数')
  }
  return input as number
}

function readAddressPolicyStringList(
  value: Record<string, unknown>,
  field: 'blockedSubstrings' | 'reservedNames',
): string[] {
  const input = value[field]
  if (!Array.isArray(input) || input.some((item) => typeof item !== 'string')) {
    throw new AddressPolicyInputError(field, '请按每行一项填写地址规则')
  }
  return input as string[]
}

async function readUpdateUserAliasPolicyBody(
  request: Request,
): Promise<UpdateUserAliasPolicyRequest> {
  const value = await readPersonalAddressJsonBody(request)
  if (!Number.isInteger(value.aliasLimit)) {
    throw new PersonalAddressInputError('aliasLimit', '请输入有效的个人别名上限')
  }
  if (typeof value.selfCreationEnabled !== 'boolean') {
    throw new PersonalAddressInputError('selfCreationEnabled', '请选择是否允许用户自行创建别名')
  }
  return {
    aliasLimit: value.aliasLimit as number,
    selfCreationEnabled: value.selfCreationEnabled,
  }
}

async function readPersonalAddressPreferenceBody(
  request: Request,
): Promise<UpdatePersonalAddressPreferenceRequest> {
  const value = await readPersonalAddressJsonBody(request)
  if (value.customLabel !== null && typeof value.customLabel !== 'string') {
    throw new PersonalAddressInputError('customLabel', '地址显示名称格式无效')
  }
  if (typeof value.isPinned !== 'boolean') {
    throw new PersonalAddressInputError('isPinned', '请选择是否置顶该地址')
  }
  return { customLabel: value.customLabel, isPinned: value.isPinned }
}

async function readMovePersonalAddressBody(request: Request): Promise<MovePersonalAddressRequest> {
  const value = await readPersonalAddressJsonBody(request)
  if (value.direction !== 'up' && value.direction !== 'down') {
    throw new PersonalAddressInputError('direction', '地址移动方向无效')
  }
  return { direction: value.direction }
}

async function readDeletePersonalAliasBody(request: Request): Promise<DeletePersonalAliasRequest> {
  const value = await readPersonalAddressJsonBody(request)
  return { confirmed: value.confirmed === true }
}

async function readPersonalAddressJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new PersonalAddressInputError('localPart', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new PersonalAddressInputError('localPart', '请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PersonalAddressInputError('localPart', '请求格式无效')
  }
  if (!isRecord(value)) throw new PersonalAddressInputError('localPart', '请求格式无效')
  return value
}

function readPersonalAddressString(
  value: Record<string, unknown>,
  field: 'localPart' | 'domainId',
  maximumLength: number,
): string {
  const input = value[field]
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > maximumLength) {
    throw new PersonalAddressInputError(field, '请完整填写个人别名信息')
  }
  return input
}

async function readCreateMailDomainBody(request: Request): Promise<CreateMailDomainRequest> {
  const value = await readDomainManagementJsonBody(request)
  const domainName = value.domainName
  if (typeof domainName !== 'string' || domainName.trim().length === 0 || domainName.length > 253) {
    throw new DomainManagementInputError('请输入邮件域名')
  }
  return { domainName }
}

async function readInboundReceiveStatusBody(
  request: Request,
): Promise<ChangeInboundReceiveStatusRequest> {
  const value = await readInboundControlJsonBody(request, 'status')
  if (value.status !== 'accepting' && value.status !== 'paused') {
    throw new InboundControlInputError('status', '请选择有效的收信状态')
  }
  return { status: value.status }
}

async function readInboundRejectionRuleBody(
  request: Request,
): Promise<CreateInboundRejectionRuleRequest> {
  const value = await readInboundControlJsonBody(request, 'ruleType')
  if (
    value.ruleType !== 'sender_address' &&
    value.ruleType !== 'sender_domain' &&
    value.ruleType !== 'subject_keyword' &&
    value.ruleType !== 'body_keyword'
  ) {
    throw new InboundControlInputError('ruleType', '请选择有效的拒收规则类型')
  }
  return {
    ruleType: value.ruleType,
    matchValue: typeof value.matchValue === 'string' ? value.matchValue : '',
  }
}

async function readInboundRejectionRuleStatusBody(
  request: Request,
): Promise<ChangeInboundRejectionRuleStatusRequest> {
  const value = await readInboundControlJsonBody(request, 'status')
  if (value.status !== 'active' && value.status !== 'paused') {
    throw new InboundControlInputError('status', '请选择有效的拒收规则状态')
  }
  return { status: value.status }
}

async function readInboundControlJsonBody(
  request: Request,
  fallbackField: 'status' | 'ruleType' | 'mode' | 'enabled',
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new InboundControlInputError(fallbackField, '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new InboundControlInputError(fallbackField, '请求内容过大')
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new InboundControlInputError(fallbackField, '请求格式无效')
  }
}

function inboundScopeTypeFromUnknown(value: string | undefined): InboundControlScopeType {
  if (value === 'domain' || value === 'address' || value === 'user') return value
  throw new InboundControlInputError('scopeType', '收信控制范围无效')
}

async function readDeleteMailDomainBody(request: Request): Promise<DeleteMailDomainRequest> {
  const value = await readDomainManagementJsonBody(request)
  return { confirmed: value.confirmed === true }
}

async function readDomainManagementJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new DomainManagementInputError('请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new DomainManagementInputError('请求内容过大')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DomainManagementInputError('请求格式无效')
  }
  if (!isRecord(value)) throw new DomainManagementInputError('请求格式无效')
  return value
}

async function readCreateManagedUserBody(request: Request): Promise<CreateManagedUserRequest> {
  const value = await readUserManagementJsonBody(request)
  return {
    displayName: readManagedUserString(value, 'displayName', 80),
    localPart: readManagedUserString(value, 'localPart', 64),
    domainId: readManagedUserString(value, 'domainId', 36),
    timezone: readManagedUserString(value, 'timezone', 64),
  }
}

async function readCreateAccountRegistrationInvitationBody(
  request: Request,
): Promise<CreateAccountRegistrationInvitationRequest> {
  const value = await readAccountRegistrationJsonBody(request, 'domainId')
  if (value.domainId === undefined || value.domainId === null || value.domainId === '') return {}
  if (typeof value.domainId !== 'string' || value.domainId.length > 36) {
    throw new AccountRegistrationInputError('domainId', '请选择邮件域名')
  }
  return { domainId: value.domainId }
}

async function readVerifyAccountRegistrationInvitationBody(
  request: Request,
): Promise<VerifyAccountRegistrationInvitationRequest> {
  const value = await readAccountRegistrationJsonBody(request, 'code')
  return {
    code: readAccountRegistrationString(value, 'code', 80, '请输入完整的邀请码'),
  }
}

async function readRegisterAccountWithInvitationBody(
  request: Request,
): Promise<RegisterAccountWithInvitationRequest> {
  const value = await readAccountRegistrationJsonBody(request, 'code')
  return {
    code: readAccountRegistrationString(value, 'code', 80, '请输入完整的邀请码'),
    displayName: readAccountRegistrationString(value, 'displayName', 80, '请输入显示名称'),
    localPart: readAccountRegistrationString(value, 'localPart', 64, '请输入邮箱前缀'),
    password: readAccountRegistrationString(value, 'password', 128, '请输入登录密码'),
    timezone: readAccountRegistrationString(value, 'timezone', 64, '请输入时区'),
  }
}

async function readAccountRegistrationJsonBody(
  request: Request,
  fallbackField: 'code' | 'domainId',
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AccountRegistrationInputError(fallbackField, '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new AccountRegistrationInputError(fallbackField, '请求内容过大')
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new AccountRegistrationInputError(fallbackField, '请求格式无效')
  }
}

function readAccountRegistrationString(
  value: Record<string, unknown>,
  field: keyof RegisterAccountWithInvitationRequest,
  maximumLength: number,
  message: string,
): string {
  const result = value[field]
  if (
    typeof result !== 'string' ||
    result.trim().length === 0 ||
    [...result].length > maximumLength
  ) {
    throw new AccountRegistrationInputError(field, message)
  }
  return result
}

async function readUserManagementJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new UserManagementInputError('displayName', '请求必须使用 JSON 格式')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new UserManagementInputError('displayName', '请求内容过大')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new UserManagementInputError('displayName', '请求格式无效')
  }
  if (!isRecord(value)) throw new UserManagementInputError('displayName', '请求格式无效')
  return value
}

function readManagedUserString(
  value: Record<string, unknown>,
  field: keyof CreateManagedUserRequest,
  maximumLength: number,
): string {
  const fieldValue = value[field]
  if (
    typeof fieldValue !== 'string' ||
    fieldValue.trim().length === 0 ||
    [...fieldValue].length > maximumLength
  ) {
    throw new UserManagementInputError(field, '请完整填写用户信息')
  }
  return fieldValue
}

async function readChangePasswordBody(
  request: Request,
): Promise<ChangePasswordRequest & { currentPassword: string }> {
  const value = await readPasswordJsonBody(request, 'currentPassword')
  const currentPassword = readPasswordValue(value, 'currentPassword', '请输入当前密码')
  const newPassword = readPasswordValue(value, 'newPassword', '请输入新密码')
  if (typeof value.revokeOtherSessions !== 'boolean') {
    throw new PasswordManagementInputError('newPassword', '请选择是否退出其他设备')
  }

  return {
    currentPassword,
    newPassword,
    revokeOtherSessions: value.revokeOtherSessions,
  }
}

async function readRequiredPasswordChangeBody(request: Request): Promise<{ newPassword: string }> {
  const value = await readPasswordJsonBody(request, 'newPassword')
  return { newPassword: readPasswordValue(value, 'newPassword', '请输入新密码') }
}

async function readAdministratorPasswordResetBody(
  request: Request,
): Promise<AdministratorPasswordResetRequest> {
  const value = await readPasswordJsonBody(request, 'primaryAddress')
  if (
    typeof value.primaryAddress !== 'string' ||
    value.primaryAddress.trim().length === 0 ||
    value.primaryAddress.length > 320
  ) {
    throw new PasswordManagementInputError('primaryAddress', '请输入用户的主邮箱地址')
  }
  return { primaryAddress: value.primaryAddress }
}

async function readAdministratorRecoveryBody(
  request: Request,
): Promise<AdministratorRecoveryRequest> {
  const value = await readPasswordJsonBody(request, 'newPassword')
  return { newPassword: readPasswordValue(value, 'newPassword', '请输入新密码') }
}

async function readPasswordJsonBody(
  request: Request,
  defaultField: 'currentPassword' | 'newPassword' | 'primaryAddress',
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new PasswordManagementInputError(defaultField, '请求必须使用 JSON 格式')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new PasswordManagementInputError(defaultField, '请求内容过大')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PasswordManagementInputError(defaultField, '请求格式无效')
  }
  if (!isRecord(value)) throw new PasswordManagementInputError(defaultField, '请求格式无效')
  return value
}

function readPasswordValue(
  value: Record<string, unknown>,
  field: 'currentPassword' | 'newPassword',
  message: string,
): string {
  const password = value[field]
  if (typeof password !== 'string' || password.length === 0 || [...password].length > 128) {
    throw new PasswordManagementInputError(field, message)
  }
  return password
}

function setAuthenticationCookies(
  context: AuthenticationContext,
  sessionToken: string,
  csrfToken: string,
) {
  setCookie(context, SESSION_COOKIE_NAME, sessionToken, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
  setCookie(context, CSRF_COOKIE_NAME, csrfToken, {
    path: '/',
    secure: true,
    sameSite: 'Lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
}

function clearAuthenticationCookies(context: AuthenticationContext) {
  deleteCookie(context, SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  })
  deleteCookie(context, CSRF_COOKIE_NAME, {
    path: '/',
    secure: true,
    sameSite: 'Lax',
  })
}

function setRecoveryCookies(
  context: AuthenticationContext,
  sessionToken: string,
  csrfToken: string,
) {
  setCookie(context, RECOVERY_SESSION_COOKIE_NAME, sessionToken, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
  })
  setCookie(context, RECOVERY_CSRF_COOKIE_NAME, csrfToken, {
    path: '/',
    secure: true,
    sameSite: 'Lax',
    maxAge: RECOVERY_COOKIE_MAX_AGE_SECONDS,
  })
}

function clearRecoveryCookies(context: AuthenticationContext) {
  deleteCookie(context, RECOVERY_SESSION_COOKIE_NAME, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  })
  deleteCookie(context, RECOVERY_CSRF_COOKIE_NAME, {
    path: '/',
    secure: true,
    sameSite: 'Lax',
  })
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return origin !== null && origin === new URL(request.url).origin
}

async function readLoginBody(request: Request): Promise<LoginRequest> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new LoginInputError('email', '登录请求必须使用 JSON 格式')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_LOGIN_BODY_BYTES) {
    throw new LoginInputError('email', '登录请求内容过大')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new LoginInputError('email', '登录请求格式无效')
  }

  if (!isRecord(value)) throw new LoginInputError('email', '登录请求格式无效')

  const email = value.email
  const password = value.password
  if (typeof email !== 'string' || email.trim().length === 0 || email.length > 320) {
    throw new LoginInputError('email', '请输入主邮箱地址')
  }
  if (typeof password !== 'string' || password.length === 0 || [...password].length > 128) {
    throw new LoginInputError('password', '请输入登录密码')
  }

  return { email, password }
}

async function readTransferAdministratorBody(
  request: Request,
): Promise<TransferAdministratorRequest> {
  const value = await readAccountLifecycleJsonBody(request)
  if (typeof value.successorUserId !== 'string' || value.successorUserId.length > 64) {
    throw new AccountLifecycleInputError('successorUserId', '请选择新的系统管理员')
  }
  return { successorUserId: value.successorUserId }
}

async function readAccountDeletionBody(request: Request): Promise<RequestAccountDeletionRequest> {
  const value = await readAccountLifecycleJsonBody(request)
  if (
    typeof value.currentPassword !== 'string' ||
    value.currentPassword.length === 0 ||
    [...value.currentPassword].length > 128
  ) {
    throw new AccountLifecycleInputError('currentPassword', '请输入当前密码')
  }
  if (value.confirmation !== 'DELETE_MY_ACCOUNT') {
    throw new AccountLifecycleInputError('confirmation', '请输入指定确认文字')
  }
  return { currentPassword: value.currentPassword, confirmation: value.confirmation }
}

async function readAccountRecoveryLoginBody(
  request: Request,
): Promise<AccountRecoveryLoginRequest> {
  const value = await readAccountLifecycleJsonBody(request)
  if (
    typeof value.email !== 'string' ||
    value.email.trim().length === 0 ||
    value.email.length > 320
  ) {
    throw new AccountLifecycleInputError('email', '请输入主邮箱地址')
  }
  if (
    typeof value.password !== 'string' ||
    value.password.length === 0 ||
    [...value.password].length > 128
  ) {
    throw new AccountLifecycleInputError('password', '请输入登录密码')
  }
  return { email: value.email, password: value.password }
}

async function readAccountLifecycleJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AccountLifecycleInputError('request', '请求必须使用 JSON 格式')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PASSWORD_BODY_BYTES) {
    throw new AccountLifecycleInputError('request', '请求内容过大')
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('invalid')
    return value
  } catch {
    throw new AccountLifecycleInputError('request', '请求格式无效')
  }
}

function describeClient(userAgent: string): string {
  const browser = describeBrowser(userAgent)
  const platform = /iPhone|iPad/u.test(userAgent)
    ? 'iPhone 或 iPad'
    : /Android/u.test(userAgent)
      ? 'Android'
      : /Windows/u.test(userAgent)
        ? 'Windows'
        : /Macintosh|Mac OS/u.test(userAgent)
          ? 'macOS'
          : /Linux/u.test(userAgent)
            ? 'Linux'
            : ''

  return platform ? `${browser} · ${platform}` : browser
}

function describeBrowser(userAgent: string): string {
  return /Edg\//u.test(userAgent)
    ? 'Edge'
    : /Firefox\//u.test(userAgent)
      ? 'Firefox'
      : /Chrome\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : '浏览器'
}

function auditContext(context: AuthenticationContext) {
  return {
    requestTraceId: crypto.randomUUID(),
    sourceIp: context.req.header('CF-Connecting-IP') ?? null,
    browserFamily: describeBrowser(context.req.header('User-Agent') ?? ''),
  }
}

class LoginInputError extends Error {
  constructor(
    readonly field: keyof LoginRequest,
    message: string,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorResponse(
  context: AuthenticationContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  field?: string,
): Response {
  return context.json(
    {
      error: {
        code,
        message,
        ...(field ? { field } : {}),
      },
    },
    status,
  )
}
