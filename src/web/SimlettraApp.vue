<script setup lang="ts">
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bold,
  ChevronDown,
  FilePlus2,
  Forward,
  Inbox,
  Italic,
  List,
  LogOut,
  Mail,
  MailOpen,
  Mails,
  Menu,
  MoreHorizontal,
  OctagonAlert,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Star,
  Trash2,
  Undo2,
  X,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type {
  AddressPolicySummary,
  UpdateAddressPolicyRequest,
} from '../shared/contracts/address-policy-management'
import type {
  AdministratorPasswordResetResponse,
  AdministratorRecoveryAuthorizationResponse,
  AuthenticationResponse,
  SessionSummary,
} from '../shared/contracts/authentication'
import type {
  InitializeSystemRequest,
  InitializeSystemResponse,
} from '../shared/contracts/initialization'
import type {
  DomainManagementOverviewResponse,
  ManagedMailDomain,
} from '../shared/contracts/domain-management'
import type {
  InboundControlOverviewResponse,
  InboundControlScopeType,
  InboundReceiveStatus,
  InboundRejectionRuleType,
} from '../shared/contracts/inbound-control'
import type {
  AdministratorAliasPolicyOverviewResponse,
  AdministratorAliasPolicyUser,
  PersonalAddressOverviewResponse,
  PersonalAddressSummary,
} from '../shared/contracts/personal-address-management'
import type {
  AdministratorOrganizationPolicyOverviewResponse,
  AdministratorOrganizationPolicyUser,
  CreateOrganizationRequest,
  OrganizationInvitationPolicy,
  OrganizationOverviewResponse,
  OrganizationSummary,
} from '../shared/contracts/organization-management'
import type {
  MailboxHeaderAddress,
  MailboxConversationEntry,
  MailboxListItem,
  MailboxMessageDetail,
  MailboxOrganizeAction,
  MailboxOrganizationScope,
  MailboxSearchFilters,
  MailboxSearchIndexState,
  MailboxScope,
  MailboxView,
  RemoteImagePermissionMode,
} from '../shared/contracts/mailbox'
import type {
  UnallocatedMailDetail,
  UnallocatedMailListItem,
} from '../shared/contracts/unallocated-mail'
import type {
  DraftBodyFormat,
  DraftComposeKind,
  DraftDetail,
  DraftRecipient,
  DraftStatus,
  DraftWorkspaceResponse,
} from '../shared/contracts/drafts'
import type {
  OutboundManagementOverviewResponse,
  OutboundProviderType,
  SendOperationResult,
} from '../shared/contracts/sending'
import type {
  NotificationChannelType,
  NotificationOverviewResponse,
  NotificationScopeInput,
  NotificationSubscriptionSummary,
} from '../shared/contracts/notifications'
import type {
  ExternalEmailTargetSummary,
  ForwardingOverviewResponse,
  ForwardingResultStatus,
  ForwardingRuleScope,
  ForwardingRuleSummary,
} from '../shared/contracts/forwarding'
import type {
  PlatformResourceKind,
  PlatformResourceOverviewResponse,
  PlatformResourceSummary,
} from '../shared/contracts/platform-resources'
import type {
  OperationsHealthOverviewResponse,
  OperationsHealthStatus,
} from '../shared/contracts/operations-health'
import type { StorageQuotaOverviewResponse } from '../shared/contracts/storage-quotas'
import type { SystemStatusResponse } from '../shared/contracts/system-status'
import type {
  MailExportOverviewResponse,
  MailExportRunSummary,
} from '../shared/contracts/mail-exports'
import type {
  CreateManagedUserRequest,
  ManagedUserSummary,
  UserManagementOverviewResponse,
} from '../shared/contracts/user-management'
import type {
  AccountRegistrationInvitationOverviewResponse,
  AccountRegistrationInvitationSummary,
  RegisterAccountWithInvitationRequest,
} from '../shared/contracts/account-registration'
import type {
  AccountLifecycleOverviewResponse,
  AccountRecoverySessionSummary,
} from '../shared/contracts/user-lifecycle'
import { ApiRequestError } from './services/api-client'
import { createMailAutoRefreshScheduler } from './mail-auto-refresh'
import { fetchAddressPolicy, updateAddressPolicy } from './services/address-policy-management-api'
import {
  authorizeAdministratorRecovery,
  changePassword,
  completeAdministratorRecovery,
  completeRequiredPasswordChange,
  fetchCurrentSession,
  fetchSessions,
  login,
  logout as logoutSession,
  resetUserPassword,
  revokeSession,
} from './services/authentication-api'
import {
  cancelAccountDeletion as cancelPendingAccountDeletion,
  fetchAccountLifecycle,
  fetchAccountRecoverySession,
  loginAccountRecovery,
  requestAccountDeletion as submitAccountDeletionRequest,
  transferAdministrator,
} from './services/user-lifecycle-api'
import {
  authorizeInitialization,
  completeInitialization,
  fetchSystemStatus,
} from './services/system-api'
import {
  changeMailDomainStatus,
  createMailDomain,
  deleteMailDomain,
  fetchDomainManagementOverview,
} from './services/domain-management-api'
import {
  changeDomainCatchAllMode,
  changeInboundReceiveStatus,
  changeInboundRejectionRuleStatus,
  changeUnallocatedAccessGrant,
  createInboundRejectionRule,
  deleteInboundRejectionRule,
  fetchInboundControlOverview,
} from './services/inbound-control-api'
import {
  changeUserStatus,
  createUser as createManagedUser,
  fetchUserManagementOverview,
} from './services/user-management-api'
import {
  createAccountRegistrationInvitation,
  fetchAccountRegistrationInvitations,
  registerAccountWithInvitation,
  revokeAccountRegistrationInvitation,
  verifyAccountRegistrationInvitation,
} from './services/account-registration-api'
import {
  assignPersonalAlias,
  createPersonalAlias,
  deleteAssignedPersonalAlias,
  deletePersonalAlias,
  fetchAdministratorAliasPolicies,
  fetchPersonalAddressOverview,
  movePersonalAddress,
  setDefaultSender,
  updateAdministratorAliasPolicy,
  updatePersonalAddressPreference,
} from './services/personal-address-management-api'
import {
  createOrganization,
  deleteOrganization,
  fetchAdministratorOrganizationPolicies,
  fetchOrganizationOverview,
  inviteOrganizationMember,
  leaveOrganization,
  resolveOrganizationInvitation,
  restoreOrganization,
  revokeOrganizationInvitation,
  updateAdministratorOrganizationPolicy,
  updateOrganizationInvitationPolicy,
  updateOrganizationSendingPermission,
} from './services/organization-management-api'
import {
  attachmentUrl,
  fetchInbox,
  fetchMessageDetail,
  organizeMessages,
  permanentlyDeleteMessage,
  setMessageRead,
  setRemoteImagePermission,
  untrustSender,
} from './services/mailbox-api'
import {
  claimUnallocatedAddress,
  fetchUnallocatedMail,
  fetchUnallocatedMailDetail,
  unallocatedAttachmentUrl,
} from './services/unallocated-mail-api'
import {
  createServerDraft,
  draftAttachmentUrl,
  fetchDraftDetail,
  fetchDraftWorkspace,
  restoreServerDraft,
  saveServerDraft,
  trashServerDraft,
  uploadServerDraftAttachment,
} from './services/draft-api'
import {
  fetchOutboundManagement,
  fetchSendOperation,
  saveDailyDefaultQuota,
  saveDomainMonthlyDefaultQuota,
  saveDomainMonthlyQuota,
  saveDomainOutboundRoute,
  saveOutboundProvider,
  saveUserDailyQuota,
  sendServerDraft,
} from './services/sending-api'
import {
  changeNotificationSubscriptionStatus,
  createNotificationSubscription,
  deleteNotificationSubscription,
  fetchNotificationOverview,
} from './services/notification-api'
import {
  changeForwardingRuleStatus,
  createExternalEmailTarget,
  deleteExternalEmailTarget,
  deleteForwardingRule,
  fetchForwardingOverview,
  saveForwardingRule,
  verifyExternalEmailTarget,
} from './services/forwarding-api'
import {
  deletePlatformResourceConfiguration,
  fetchPlatformResourceOverview,
  refreshPlatformResources,
  savePlatformResourceConfiguration,
  savePlatformResourceThreshold,
} from './services/platform-resources-api'
import { fetchOperationsHealthOverview } from './services/operations-health-api'
import {
  fetchStorageQuotaOverview,
  saveStorageQuotaDefault,
  saveStorageQuotaOverride,
} from './services/storage-quotas-api'
import {
  createMailExport,
  deleteMailExport,
  fetchMailExportOverview,
} from './services/mail-exports-api'
import { createSafeEmailDocument, sanitizeDraftHtml } from './mail-html'

type WizardStep = 1 | 2 | 3
type FormField = keyof InitializeSystemRequest | 'initKey' | 'confirmPassword'
type LoginField = 'email' | 'password'
type AccountRegistrationField = keyof RegisterAccountWithInvitationRequest | 'confirmPassword'
type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword'
type RecoveryField = 'initKey' | 'newPassword' | 'confirmPassword'
type AccountRecoveryField = 'email' | 'password'
type AccountDeletionField = 'currentPassword' | 'confirmation' | 'successorUserId'
type ManagedUserField = keyof CreateManagedUserRequest
type MailDomainField = 'domainName'
type PersonalAliasField = 'localPart' | 'domainId'
type AddressPolicyField = keyof UpdateAddressPolicyRequest
type OrganizationField = keyof CreateOrganizationRequest | 'primaryAddress' | 'successorUserId'
type WorkspaceView = 'mailbox' | 'drafts' | 'settings'
type MobileHistoryLayer = 'mail-detail' | 'draft-editor' | 'settings'
type SettingsSection =
  | 'account-security'
  | 'addresses'
  | 'forwarding'
  | 'notifications'
  | 'exports'
  | 'organizations'
  | 'account-lifecycle'
  | 'health'
  | 'receiving'
  | 'resources'
  | 'organization-policy'
  | 'storage'
  | 'address-policy'
  | 'outbound'
  | 'domains'
  | 'alias-policy'
  | 'invitations'
  | 'users'
type MailboxMode = 'assigned' | 'unallocated'
type MessageBodyMode = 'html' | 'plain'
type MailboxSearchDraft = Omit<MailboxSearchFilters, 'dateFrom' | 'dateTo'> & {
  dateFrom: string
  dateTo: string
}

interface AddressPreferenceDraft {
  customLabel: string
  isPinned: boolean
}

interface AliasPolicyDraft {
  aliasLimit: number
  selfCreationEnabled: boolean
}

interface AddressPolicyDraft {
  minimumLocalPartLength: number
  aliasRetentionDays: number
  blockedSubstrings: string
  reservedNames: string
}

interface PendingAliasDeletion {
  address: PersonalAddressSummary
  targetUserId: string
  targetDisplayName: string
  administratorAction: boolean
}

interface OrganizationPolicyDraft {
  organizationLimit: number
}

interface OutboundProviderForm {
  id: string | null
  displayName: string
  providerType: OutboundProviderType
  credential: string
  callbackUsername: string
  callbackSecret: string
}

interface OutboundRouteDraft {
  primaryProviderId: string
  backupProviderId: string
}

interface NotificationSubscriptionForm {
  displayName: string
  channelType: NotificationChannelType
  baseUrl: string
  destination: string
  credential: string
  allPersonal: boolean
  addressIds: string[]
}

interface ForwardingRuleForm {
  ruleId: string | null
  targetId: string
  scope: ForwardingRuleScope
  addressIds: string[]
  enabled: boolean
}

interface PendingOrganizationAction {
  organization: OrganizationSummary
  kind: 'leave' | 'delete'
  successorUserId: string
  confirmed: boolean
}

type DraftSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict'

interface DraftEditorForm {
  senderAddressId: string | null
  to: string
  cc: string
  bcc: string
  subject: string
  bodyFormat: DraftBodyFormat
  body: string
  attachmentIds: string[]
}

const status = ref<SystemStatusResponse | null>(null)
const authentication = ref<AuthenticationResponse['data'] | null>(null)
const sessions = ref<SessionSummary[]>([])
const mailExportOverview = ref<MailExportOverviewResponse['data'] | null>(null)
const mailExportLoading = ref(false)
const mailExportAction = ref<string | null>(null)
const mailExportError = ref('')
const mailExportNotice = ref('')
const mailExportScope = ref<'personal' | 'organization'>('personal')
const mailExportOrganizationId = ref('')
let mailExportRefreshTimer: ReturnType<typeof setTimeout> | null = null
const loading = ref(true)
const submitting = ref(false)
const accountRegistrationSubmitting = ref(false)
const sessionLoading = ref(false)
const sessionActionId = ref<string | null>(null)
const passwordSubmitting = ref(false)
const recoverySubmitting = ref(false)
const userManagementLoading = ref(false)
const userCreateSubmitting = ref(false)
const userActionId = ref<string | null>(null)
const domainManagementLoading = ref(false)
const domainCreateSubmitting = ref(false)
const domainActionId = ref<string | null>(null)
const step = ref<WizardStep>(1)
const pageError = ref('')
const authError = ref('')
const authNotice = ref('')
const accountNotice = ref('')
const result = ref<InitializeSystemResponse | null>(null)
const controller = new AbortController()

const form = reactive({
  initKey: '',
  adminDisplayName: '',
  domainName: '',
  localPart: '',
  password: '',
  confirmPassword: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  showPassword: false,
})
const fieldErrors = reactive<Partial<Record<FormField, string>>>({})

const loginForm = reactive({
  email: '',
  password: '',
  showPassword: false,
})
const loginErrors = reactive<Partial<Record<LoginField, string>>>({})
const accountRegistrationMode = ref(false)
const accountRegistrationDomain = ref<string | null>(null)
const accountRegistrationForm = reactive({
  code: '',
  displayName: '',
  localPart: '',
  password: '',
  confirmPassword: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  showPassword: false,
})
const accountRegistrationErrors = reactive<Partial<Record<AccountRegistrationField, string>>>({})

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
  revokeOtherSessions: true,
  showPassword: false,
})
const passwordErrors = reactive<Partial<Record<PasswordField, string>>>({})

const accountLifecycle = ref<AccountLifecycleOverviewResponse['data'] | null>(null)
const accountLifecycleLoading = ref(false)
const accountLifecycleSubmitting = ref(false)
const accountLifecycleNotice = ref('')
const accountLifecycleError = ref('')
const accountDeletionForm = reactive({
  successorUserId: '',
  currentPassword: '',
  confirmed: false,
  showPassword: false,
})
const accountDeletionErrors = reactive<Partial<Record<AccountDeletionField, string>>>({})

const requiredPasswordForm = reactive({
  newPassword: '',
  confirmPassword: '',
  showPassword: false,
})
const requiredPasswordErrors = reactive<Partial<Record<PasswordField, string>>>({})

const userManagement = ref<UserManagementOverviewResponse['data'] | null>(null)
const accountRegistrationInvitations = ref<
  AccountRegistrationInvitationOverviewResponse['data'] | null
>(null)
const accountRegistrationInvitationLoading = ref(false)
const accountRegistrationInvitationAction = ref<string | null>(null)
const accountRegistrationInvitationDomainId = ref('')
const accountRegistrationInvitationError = ref('')
const accountRegistrationInvitationNotice = ref('')
const userForm = reactive<CreateManagedUserRequest>({
  displayName: '',
  localPart: '',
  domainId: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
})
const userErrors = reactive<Partial<Record<ManagedUserField, string>>>({})
const temporaryPasswordResult = ref<AdministratorPasswordResetResponse['data'] | null>(null)
const temporaryPasswordNotice = ref('')
const temporaryPasswordHeading = ref('')

const domainManagement = ref<DomainManagementOverviewResponse['data'] | null>(null)
const domainForm = reactive({ domainName: '' })
const domainErrors = reactive<Partial<Record<MailDomainField, string>>>({})
const domainPendingDeletion = ref<ManagedMailDomain | null>(null)
const domainDeletionConfirmed = ref(false)

const inboundControl = ref<InboundControlOverviewResponse['data'] | null>(null)
const inboundControlLoading = ref(false)
const inboundControlAction = ref<string | null>(null)
const inboundControlError = ref('')
const inboundControlNotice = ref('')
const inboundRejectionRuleForm = reactive<{
  ruleType: InboundRejectionRuleType
  matchValue: string
}>({
  ruleType: 'sender_address',
  matchValue: '',
})

const personalAddressOverview = ref<PersonalAddressOverviewResponse['data'] | null>(null)
const personalAddressLoading = ref(false)
const personalAddressActionId = ref<string | null>(null)
const personalAliasForm = reactive({ localPart: '', domainId: '' })
const personalAliasErrors = reactive<Partial<Record<PersonalAliasField, string>>>({})
const addressPreferenceDrafts = reactive<Record<string, AddressPreferenceDraft>>({})
const aliasPendingDeletion = ref<PendingAliasDeletion | null>(null)
const aliasDeletionConfirmed = ref(false)

const administratorAliasPolicies = ref<AdministratorAliasPolicyOverviewResponse['data'] | null>(
  null,
)
const aliasPolicyLoading = ref(false)
const aliasPolicyActionId = ref<string | null>(null)
const aliasPolicyDrafts = reactive<Record<string, AliasPolicyDraft>>({})
const administratorAliasForm = reactive({ userId: '', localPart: '', domainId: '' })
const administratorAliasErrors = reactive<Partial<Record<PersonalAliasField | 'userId', string>>>(
  {},
)

const addressPolicy = ref<AddressPolicySummary | null>(null)
const addressPolicyLoading = ref(false)
const addressPolicySubmitting = ref(false)
const addressPolicyDraft = reactive<AddressPolicyDraft>({
  minimumLocalPartLength: 1,
  aliasRetentionDays: 0,
  blockedSubstrings: '',
  reservedNames: '',
})
const addressPolicyErrors = reactive<Partial<Record<AddressPolicyField, string>>>({})

const organizationOverview = ref<OrganizationOverviewResponse['data'] | null>(null)
const organizationLoading = ref(false)
const organizationActionId = ref<string | null>(null)
const organizationForm = reactive<CreateOrganizationRequest>({
  name: '',
  localPart: '',
  domainId: '',
})
const organizationErrors = reactive<Partial<Record<OrganizationField, string>>>({})
const organizationInvitationPolicyDraft = ref<OrganizationInvitationPolicy>('manual')
const organizationInvitationInputs = reactive<Record<string, string>>({})
const pendingOrganizationAction = ref<PendingOrganizationAction | null>(null)

const administratorOrganizationPolicies = ref<
  AdministratorOrganizationPolicyOverviewResponse['data'] | null
>(null)
const organizationPolicyLoading = ref(false)
const organizationPolicyActionId = ref<string | null>(null)
const organizationPolicyDrafts = reactive<Record<string, OrganizationPolicyDraft>>({})

const workspaceView = ref<WorkspaceView>('mailbox')
const settingsSection = ref<SettingsSection>('account-security')
const mobileNavigationOpen = ref(false)
const accountMenuOpen = ref(false)
const mailboxMoreOpen = ref(false)
const mailboxSelectionMode = ref(false)
const messageActionsOpen = ref(false)
const draftCopiesOpen = ref(false)
const draftActionsOpen = ref(false)
const mailboxSearchInput = ref<HTMLInputElement | null>(null)
const mailboxDetailPanel = ref<HTMLElement | null>(null)
const mailboxDetailHeading = ref<HTMLHeadingElement | null>(null)
const mailboxMode = ref<MailboxMode>('assigned')
const mailboxView = ref<MailboxView>('inbox')
const mailboxScope = ref<MailboxScope>('all')
const mailboxOrganizationId = ref('')
const mailboxItems = ref<MailboxListItem[]>([])
const mailboxOrganizations = ref<MailboxOrganizationScope[]>([])
const mailboxNextCursor = ref<string | null>(null)
const mailboxLoading = ref(false)
const mailboxLoadingMore = ref(false)
const mailboxError = ref('')
const mailboxNotice = ref('')
const selectedMailboxEntryIds = ref<Set<string>>(new Set())
const mailboxBulkAction = ref<MailboxOrganizeAction | null>(null)
const selectedMessage = ref<MailboxMessageDetail | null>(null)
const selectedConversationEntries = ref<MailboxConversationEntry[]>([])
const selectedMessageLoading = ref(false)
const selectedMessageAction = ref<string | null>(null)
const selectedMessageBodyMode = ref<MessageBodyMode>('html')
const previewAttachmentId = ref<string | null>(null)
const pendingMailboxPermanentDeletion = ref<MailboxMessageDetail | null>(null)
const mailboxPermanentDeletionConfirmed = ref(false)
const mailboxSearchOpen = ref(false)
const mailboxSearchDraft = reactive(createDefaultMailboxSearchDraft())
const mailboxSearchApplied = ref<MailboxSearchFilters>(createDefaultMailboxSearchFilters())
const mailboxSearchIndex = ref<MailboxSearchIndexState | null>(null)
const unallocatedMailItems = ref<UnallocatedMailListItem[]>([])
const unallocatedMailNextCursor = ref<string | null>(null)
const unallocatedMailQuery = ref('')
const unallocatedMailAppliedQuery = ref('')
const unallocatedMailLoading = ref(false)
const unallocatedMailLoadingMore = ref(false)
const selectedUnallocatedMessage = ref<UnallocatedMailDetail | null>(null)
const selectedUnallocatedMessageLoading = ref(false)
const unallocatedMailAction = ref<string | null>(null)
const pendingUnallocatedClaim = ref<UnallocatedMailDetail | null>(null)
const unallocatedClaimConfirmed = ref(false)

const draftWorkspace = ref<DraftWorkspaceResponse['data'] | null>(null)
const draftListStatus = ref<DraftStatus>('active')
const draftLoading = ref(false)
const draftAction = ref<string | null>(null)
const draftError = ref('')
const draftNotice = ref('')
const selectedDraft = ref<DraftDetail | null>(null)
const draftSaveState = ref<DraftSaveState>('clean')
const draftSaveInFlight = ref(false)
const lastSendOperation = ref<SendOperationResult | null>(null)
const draftSendRequest = ref<{
  draftId: string
  revisionNumber: number
  requestKey: string
} | null>(null)
const draftRichEditor = ref<HTMLElement | null>(null)
const draftForm = reactive<DraftEditorForm>({
  senderAddressId: null,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  bodyFormat: 'rich_text',
  body: '',
  attachmentIds: [],
})
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let sendStatusTimer: ReturnType<typeof setTimeout> | null = null
let draftEditVersion = 0
let draftReturnWorkspace: WorkspaceView = 'drafts'
let mailboxReturnFocus: HTMLElement | null = null

const mailAutoRefreshScheduler = createMailAutoRefreshScheduler({
  refresh: performAutomaticMailRefresh,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle),
})

const outboundManagement = ref<OutboundManagementOverviewResponse['data'] | null>(null)
const outboundLoading = ref(false)
const outboundAction = ref<string | null>(null)
const outboundError = ref('')
const outboundNotice = ref('')
const outboundProviderForm = reactive<OutboundProviderForm>({
  id: null,
  displayName: '',
  providerType: 'resend',
  credential: '',
  callbackUsername: '',
  callbackSecret: '',
})
const outboundRouteDrafts = reactive<Record<string, OutboundRouteDraft>>({})
const outboundUserQuotaDrafts = reactive<Record<string, number>>({})
const outboundDomainQuotaDrafts = reactive<Record<string, string>>({})
const outboundDailyDefaultDraft = ref(500)
const outboundDomainMonthlyDefaultDraft = ref('')

const platformResourceOverview = ref<PlatformResourceOverviewResponse['data'] | null>(null)
const platformResourceLoading = ref(false)
const platformResourceAction = ref<string | null>(null)
const platformResourceError = ref('')
const platformResourceNotice = ref('')
const platformResourceConfigurationForm = reactive({
  accountId: '',
  d1DatabaseId: '',
  storageResourceReference: '',
  apiToken: '',
})
const platformResourceThresholdDrafts = reactive<
  Record<PlatformResourceKind, { warningPercent: number; stopPercent: number }>
>({
  d1: { warningPercent: 80, stopPercent: 95 },
  kv: { warningPercent: 80, stopPercent: 95 },
  r2: { warningPercent: 80, stopPercent: 95 },
})
const operationsHealth = ref<OperationsHealthOverviewResponse['data'] | null>(null)
const operationsHealthLoading = ref(false)
const operationsHealthError = ref('')
const storageQuotaOverview = ref<StorageQuotaOverviewResponse['data'] | null>(null)
const storageQuotaLoading = ref(false)
const storageQuotaAction = ref<string | null>(null)
const storageQuotaError = ref('')
const storageQuotaNotice = ref('')
const storageQuotaDefaultDrafts = reactive({ user: 100_000_000, organization: 100_000_000 })
const storageQuotaOverrideDrafts = reactive<Record<string, string>>({})

const notificationOverview = ref<NotificationOverviewResponse['data'] | null>(null)
const notificationLoading = ref(false)
const notificationAction = ref<string | null>(null)
const notificationError = ref('')
const notificationNotice = ref('')
const notificationForm = reactive<NotificationSubscriptionForm>({
  displayName: '',
  channelType: 'ntfy',
  baseUrl: 'https://ntfy.sh',
  destination: '',
  credential: '',
  allPersonal: true,
  addressIds: [],
})

const forwardingOverview = ref<ForwardingOverviewResponse['data'] | null>(null)
const forwardingLoading = ref(false)
const forwardingAction = ref<string | null>(null)
const forwardingError = ref('')
const forwardingNotice = ref('')
const forwardingTargetEmail = ref('')
const forwardingVerificationCodes = reactive<Record<string, string>>({})
const forwardingRuleForm = reactive<ForwardingRuleForm>({
  ruleId: null,
  targetId: '',
  scope: 'all_personal',
  addressIds: [],
  enabled: true,
})

const recoveryMode = ref(false)
const recoveryStep = ref<1 | 2>(1)
const recoverySubject = ref<
  AdministratorRecoveryAuthorizationResponse['data']['administrator'] | null
>(null)
const recoveryForm = reactive({
  initKey: '',
  newPassword: '',
  confirmPassword: '',
  showPassword: false,
})
const recoveryErrors = reactive<Partial<Record<RecoveryField, string>>>({})
const accountRecoveryMode = ref(false)
const accountRecoverySession = ref<AccountRecoverySessionSummary | null>(null)
const accountRecoverySubmitting = ref(false)
const accountRecoveryForm = reactive({
  email: '',
  password: '',
  showPassword: false,
})
const accountRecoveryErrors = reactive<Partial<Record<AccountRecoveryField, string>>>({})

const administratorSuccessors = computed(() =>
  (userManagement.value?.users ?? []).filter(
    (user) => user.status === 'active' && user.id !== authentication.value?.user.id,
  ),
)

const storageModeLabel = computed(() =>
  status.value?.data.storageMode === 'kv' ? 'D1 + KV' : 'D1 + R2',
)

const primaryAddressPreview = computed(() => {
  const localPart = form.localPart.trim().toLowerCase()
  const domain = normalizeDomainPreview(form.domainName)
  return localPart && domain ? `${localPart}@${domain}` : '尚未填写'
})

const safeSelectedMessageHtml = computed(() => {
  const message = selectedMessage.value
  if (!message?.untrustedHtmlBody) return ''
  return createSafeEmailDocument(message.untrustedHtmlBody, message.remoteImagesAllowed)
})

const safeSelectedUnallocatedMessageHtml = computed(() => {
  const message = selectedUnallocatedMessage.value
  if (!message?.untrustedHtmlBody) return ''
  return createSafeEmailDocument(message.untrustedHtmlBody, false)
})

const selectedMessageSender = computed(
  () =>
    selectedMessage.value?.addresses.find(
      (address) => address.role === 'from' || address.role === 'sender',
    ) ?? null,
)

const mailboxSearchActive = computed(() => countActiveMailboxSearchFilters() > 0)
const mailboxSearchFilterCount = computed(() => countActiveMailboxSearchDraftFilters())
const mailboxViewTitle = computed(() =>
  mailboxSearchActive.value ? '搜索结果' : mailboxViewLabel(mailboxView.value),
)

const allLoadedMailboxItemsSelected = computed(
  () =>
    mailboxItems.value.length > 0 &&
    mailboxItems.value.every((item) => selectedMailboxEntryIds.value.has(item.id)),
)

const draftAttachmentTotalSize = computed(() =>
  (selectedDraft.value?.attachments ?? []).reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  ),
)

const inboundActiveUsers = computed(() =>
  (inboundControl.value?.users ?? []).filter((user) => user.userStatus === 'active'),
)

function openWorkspace(view: WorkspaceView) {
  workspaceView.value = view
  mobileNavigationOpen.value = false
  accountMenuOpen.value = false
  messageActionsOpen.value = false
}

function openSettings(section: SettingsSection = settingsSection.value) {
  const enteringSettings = workspaceView.value !== 'settings'
  settingsSection.value = section
  openWorkspace('settings')
  if (enteringSettings) pushMobileHistoryLayer('settings')
}

function closeSettings() {
  if (currentMobileHistoryLayer() === 'settings') {
    window.history.back()
    return
  }
  openWorkspace('mailbox')
}

function toggleMobileNavigation() {
  if (workspaceView.value === 'settings') openWorkspace('mailbox')
  mobileNavigationOpen.value = !mobileNavigationOpen.value
}

async function focusMailboxSearch() {
  openWorkspace('mailbox')
  mailboxMode.value = 'assigned'
  await nextTick()
  mailboxSearchInput.value?.focus()
}

function usesMobileWorkspaceLayout(): boolean {
  return window.matchMedia('(max-width: 720px)').matches
}

const mobileHistoryStateKey = '__simlettraMobileLayer'

function currentMobileHistoryLayer(): MobileHistoryLayer | null {
  const historyState = window.history.state
  if (!historyState || typeof historyState !== 'object') return null
  const layer = (historyState as Record<string, unknown>)[mobileHistoryStateKey]
  return layer === 'mail-detail' || layer === 'draft-editor' || layer === 'settings' ? layer : null
}

function pushMobileHistoryLayer(layer: MobileHistoryLayer) {
  if (!usesMobileWorkspaceLayout() || currentMobileHistoryLayer() === layer) return
  const historyState = window.history.state
  window.history.pushState(
    {
      ...(historyState && typeof historyState === 'object' ? historyState : {}),
      [mobileHistoryStateKey]: layer,
    },
    '',
  )
}

async function handleMobileHistoryNavigation() {
  if (!usesMobileWorkspaceLayout()) return

  if (workspaceView.value === 'drafts' && selectedDraft.value) {
    if (!(await prepareDraftNavigation())) {
      pushMobileHistoryLayer('draft-editor')
      return
    }
    selectedDraft.value = null
    if (draftReturnWorkspace === 'mailbox') openWorkspace('mailbox')
    return
  }

  if (workspaceView.value === 'settings') {
    openWorkspace('mailbox')
    return
  }

  if (selectedMessage.value) {
    await closeMailboxMessage()
    return
  }

  if (selectedUnallocatedMessage.value) await closeUnallocatedMessage()
}

function rememberMailboxReturnFocus() {
  const activeElement = document.activeElement
  if (
    activeElement instanceof HTMLElement &&
    activeElement.closest('.mailbox-message-list') !== null
  ) {
    mailboxReturnFocus = activeElement
  }
}

async function presentMailboxDetail() {
  await nextTick()
  if (mailboxDetailPanel.value) mailboxDetailPanel.value.scrollTop = 0
  if (!usesMobileWorkspaceLayout()) return
  mailboxDetailHeading.value?.focus({ preventScroll: true })
  if (mailboxDetailPanel.value) mailboxDetailPanel.value.scrollTop = 0
}

async function restoreMailboxListFocus() {
  if (!usesMobileWorkspaceLayout()) return
  const returnTarget = mailboxReturnFocus
  mailboxReturnFocus = null
  await nextTick()
  returnTarget?.focus({ preventScroll: true })
}

onMounted(async () => {
  document.addEventListener('visibilitychange', handleMailAutoRefreshVisibilityChange)
  window.addEventListener('online', handleMailAutoRefreshOnline)
  window.addEventListener('offline', handleMailAutoRefreshOffline)
  window.addEventListener('popstate', handleMobileHistoryNavigation)
  await loadStatus()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleMailAutoRefreshVisibilityChange)
  window.removeEventListener('online', handleMailAutoRefreshOnline)
  window.removeEventListener('offline', handleMailAutoRefreshOffline)
  window.removeEventListener('popstate', handleMobileHistoryNavigation)
  mailAutoRefreshScheduler.stop()
  cancelDraftSaveTimer()
  cancelSendStatusTimer()
  cancelMailExportRefresh()
  controller.abort()
  clearSensitiveFields()
  loginForm.password = ''
  clearPasswordForms()
  clearRecoveryForm()
  clearAccountRecoveryForm()
  clearAccountDeletionForm()
})

async function loadStatus() {
  loading.value = true
  pageError.value = ''

  try {
    status.value = await fetchSystemStatus(controller.signal)
    if (status.value.data.initialization === 'initialized') {
      await restoreSession()
      if (!authentication.value) await restoreAccountRecoverySession()
    } else {
      clearAuthentication()
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      pageError.value = error instanceof Error ? error.message : '无法读取系统状态'
    }
  } finally {
    loading.value = false
  }
}

async function restoreSession() {
  authError.value = ''

  try {
    const response = await fetchCurrentSession()
    authentication.value = response.data
    if (!response.data.user.passwordChangeRequired) await refreshAccountData()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法恢复登录会话'
  }
}

async function submitLogin() {
  clearLoginErrors()

  if (!loginForm.email.trim()) loginErrors.email = '请输入主邮箱地址'
  if (!loginForm.password) loginErrors.password = '请输入密码'
  if (Object.keys(loginErrors).length > 0) return

  submitting.value = true
  try {
    const response = await login({
      email: loginForm.email,
      password: loginForm.password,
    })
    authentication.value = response.data
    sessions.value = [response.data.session]
    loginForm.email = response.data.user.primaryAddress
    loginForm.password = ''
    if (!response.data.user.passwordChangeRequired) await refreshAccountData()
  } catch (error) {
    handleLoginError(error)
  } finally {
    submitting.value = false
  }
}

function openAccountRegistration() {
  recoveryMode.value = false
  accountRecoveryMode.value = false
  accountRegistrationMode.value = true
  authError.value = ''
  authNotice.value = ''
  clearFieldErrors(accountRegistrationErrors)
}

function closeAccountRegistration() {
  accountRegistrationMode.value = false
  accountRegistrationDomain.value = null
  accountRegistrationForm.code = ''
  accountRegistrationForm.displayName = ''
  accountRegistrationForm.localPart = ''
  accountRegistrationForm.password = ''
  accountRegistrationForm.confirmPassword = ''
  accountRegistrationForm.showPassword = false
  clearFieldErrors(accountRegistrationErrors)
  authError.value = ''
}

function changeAccountRegistrationInvitation() {
  accountRegistrationDomain.value = null
  accountRegistrationForm.displayName = ''
  accountRegistrationForm.localPart = ''
  accountRegistrationForm.password = ''
  accountRegistrationForm.confirmPassword = ''
  clearFieldErrors(accountRegistrationErrors)
  authError.value = ''
}

async function submitAccountRegistrationInvitationVerification() {
  clearFieldErrors(accountRegistrationErrors)
  authError.value = ''
  if (!accountRegistrationForm.code.trim()) {
    accountRegistrationErrors.code = '请输入完整的邀请码'
    return
  }
  accountRegistrationSubmitting.value = true
  try {
    const response = await verifyAccountRegistrationInvitation(accountRegistrationForm.code)
    accountRegistrationDomain.value = response.data.domainName
  } catch (error) {
    if (error instanceof ApiRequestError && error.field === 'code') {
      accountRegistrationErrors.code = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '邀请码验证失败'
    }
  } finally {
    accountRegistrationSubmitting.value = false
  }
}

async function submitAccountRegistration() {
  clearFieldErrors(accountRegistrationErrors)
  authError.value = ''
  if (!accountRegistrationDomain.value) {
    accountRegistrationErrors.code = '请先验证邀请码'
    return
  }
  if (!accountRegistrationForm.displayName.trim()) {
    accountRegistrationErrors.displayName = '请输入显示名称'
  }
  if (!accountRegistrationForm.localPart.trim()) {
    accountRegistrationErrors.localPart = '请输入邮箱前缀'
  }
  if (!accountRegistrationForm.password) {
    accountRegistrationErrors.password = '请输入密码'
  } else if ([...accountRegistrationForm.password].length < 15) {
    accountRegistrationErrors.password = '密码至少需要 15 个字符'
  }
  if (accountRegistrationForm.confirmPassword !== accountRegistrationForm.password) {
    accountRegistrationErrors.confirmPassword = '两次输入的密码不一致'
  }
  if (!accountRegistrationForm.timezone.trim()) {
    accountRegistrationErrors.timezone = '请输入时区'
  }
  if (Object.keys(accountRegistrationErrors).length > 0) return

  accountRegistrationSubmitting.value = true
  try {
    const response = await registerAccountWithInvitation({
      code: accountRegistrationForm.code,
      displayName: accountRegistrationForm.displayName,
      localPart: accountRegistrationForm.localPart,
      password: accountRegistrationForm.password,
      timezone: accountRegistrationForm.timezone,
    })
    authentication.value = response.data
    sessions.value = [response.data.session]
    loginForm.email = response.data.user.primaryAddress
    closeAccountRegistration()
    await refreshAccountData()
  } catch (error) {
    if (error instanceof ApiRequestError && isAccountRegistrationField(error.field)) {
      accountRegistrationErrors[error.field] = error.message
      if (error.field === 'code') accountRegistrationDomain.value = null
    } else {
      authError.value = error instanceof Error ? error.message : '账号注册失败'
    }
  } finally {
    accountRegistrationSubmitting.value = false
  }
}

async function refreshSessions() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return

  sessionLoading.value = true
  try {
    sessions.value = (await fetchSessions()).data.sessions
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取登录会话'
  } finally {
    sessionLoading.value = false
  }
}

async function refreshAccountData() {
  await Promise.all([
    refreshMailbox(),
    refreshUnallocatedMail(),
    refreshDrafts(),
    refreshSessions(),
    refreshPersonalAddressManagement(),
    refreshOrganizationManagement(),
    refreshNotificationManagement(),
    refreshForwardingManagement(),
    refreshMailExportManagement(),
    refreshAccountLifecycle(),
    authentication.value?.user.role === 'administrator'
      ? refreshUserManagement()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshAccountRegistrationInvitations()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshDomainManagement()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshInboundControl()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshAdministratorAliasPolicies()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshAddressPolicy()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshAdministratorOrganizationPolicies()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshOutboundManagement()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshPlatformResourceManagement()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshOperationsHealth()
      : Promise.resolve(),
    authentication.value?.user.role === 'administrator'
      ? refreshStorageQuotaManagement()
      : Promise.resolve(),
  ])
  syncMailAutoRefresh()
}

function canAutomaticallyRefreshMail(): boolean {
  return Boolean(
    authentication.value &&
    !authentication.value.user.passwordChangeRequired &&
    document.visibilityState === 'visible' &&
    navigator.onLine !== false,
  )
}

function syncMailAutoRefresh(options?: { immediate?: boolean }) {
  if (!canAutomaticallyRefreshMail()) {
    mailAutoRefreshScheduler.pause()
    return
  }
  mailAutoRefreshScheduler.start({ immediate: options?.immediate ?? false })
}

function handleMailAutoRefreshVisibilityChange() {
  syncMailAutoRefresh({ immediate: document.visibilityState === 'visible' })
}

function handleMailAutoRefreshOnline() {
  syncMailAutoRefresh({ immediate: true })
}

function handleMailAutoRefreshOffline() {
  mailAutoRefreshScheduler.pause()
}

async function performAutomaticMailRefresh(): Promise<boolean> {
  if (!canAutomaticallyRefreshMail()) return true
  if (
    mailboxLoading.value ||
    mailboxLoadingMore.value ||
    unallocatedMailLoading.value ||
    unallocatedMailLoadingMore.value
  ) {
    return true
  }
  return mailboxMode.value === 'unallocated'
    ? refreshUnallocatedMail(false, { silent: true })
    : refreshMailbox(false, { silent: true })
}

async function refreshActiveMailbox() {
  if (mailboxMode.value === 'unallocated') await refreshUnallocatedMail()
  else await refreshMailbox()
}

async function refreshUnallocatedMail(
  loadMore = false,
  options?: { silent?: boolean },
): Promise<boolean> {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return false
  if (loadMore && !unallocatedMailNextCursor.value) return true

  if (loadMore) unallocatedMailLoadingMore.value = true
  else if (!options?.silent) unallocatedMailLoading.value = true
  if (!options?.silent) {
    mailboxError.value = ''
    if (!loadMore) mailboxNotice.value = ''
  }
  try {
    const response = await fetchUnallocatedMail({
      ...(loadMore && unallocatedMailNextCursor.value
        ? { cursor: unallocatedMailNextCursor.value }
        : {}),
      ...(unallocatedMailAppliedQuery.value ? { query: unallocatedMailAppliedQuery.value } : {}),
    })
    unallocatedMailItems.value = loadMore
      ? [...unallocatedMailItems.value, ...response.data.items]
      : response.data.items
    unallocatedMailNextCursor.value = response.data.nextCursor
    return true
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return false
    }
    if (!options?.silent) {
      mailboxError.value = error instanceof Error ? error.message : '无法读取未分配来信'
    }
    return false
  } finally {
    if (!options?.silent) unallocatedMailLoading.value = false
    unallocatedMailLoadingMore.value = false
  }
}

async function refreshAccountLifecycle() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return
  accountLifecycleLoading.value = true
  accountLifecycleError.value = ''
  try {
    accountLifecycle.value = (await fetchAccountLifecycle()).data
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    accountLifecycleError.value = error instanceof Error ? error.message : '无法读取账号注销状态'
  } finally {
    accountLifecycleLoading.value = false
  }
}

async function restoreAccountRecoverySession() {
  try {
    accountRecoverySession.value = (await fetchAccountRecoverySession()).data.session
    accountRecoveryMode.value = true
    accountRecoveryForm.email = accountRecoverySession.value.primaryAddress
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.status === 401)) {
      authError.value = error instanceof Error ? error.message : '无法恢复账号恢复会话'
    }
    accountRecoverySession.value = null
    accountRecoveryMode.value = false
  }
}

async function refreshMailbox(loadMore = false, options?: { silent?: boolean }): Promise<boolean> {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return false
  if (loadMore && !mailboxNextCursor.value) return true

  if (loadMore) mailboxLoadingMore.value = true
  else if (!options?.silent) {
    mailboxLoading.value = true
    selectedMailboxEntryIds.value = new Set()
  }
  if (!options?.silent) {
    mailboxError.value = ''
    if (!loadMore) mailboxNotice.value = ''
  }
  try {
    const response = await fetchInbox({
      scope: mailboxScope.value,
      view: mailboxView.value,
      ...(mailboxScope.value === 'organization'
        ? { organizationId: mailboxOrganizationId.value }
        : {}),
      ...(loadMore && mailboxNextCursor.value ? { cursor: mailboxNextCursor.value } : {}),
      search: mailboxSearchApplied.value,
    })
    mailboxItems.value = loadMore
      ? [...mailboxItems.value, ...response.data.items]
      : response.data.items
    mailboxOrganizations.value = response.data.organizations
    mailboxNextCursor.value = response.data.nextCursor
    mailboxSearchIndex.value = response.data.searchIndex
    if (
      mailboxScope.value === 'organization' &&
      !mailboxOrganizations.value.some(
        (organization) => organization.id === mailboxOrganizationId.value,
      )
    ) {
      mailboxScope.value = 'all'
      mailboxOrganizationId.value = ''
      return refreshMailbox(false, options)
    }
    return true
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return false
    }
    if (!options?.silent) {
      mailboxError.value = error instanceof Error ? error.message : '无法读取收件箱'
    }
    return false
  } finally {
    if (!options?.silent) mailboxLoading.value = false
    mailboxLoadingMore.value = false
  }
}

async function refreshDrafts() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return
  draftLoading.value = true
  draftError.value = ''
  try {
    draftWorkspace.value = (await fetchDraftWorkspace(draftListStatus.value)).data
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    draftError.value = error instanceof Error ? error.message : '无法读取草稿'
  } finally {
    draftLoading.value = false
  }
}

async function enterDraftWorkspace(status: DraftStatus = 'active') {
  if (!(await prepareDraftNavigation())) return
  openWorkspace('drafts')
  if (draftListStatus.value !== status) {
    draftListStatus.value = status
    selectedDraft.value = null
  }
  await refreshDrafts()
}

async function startNewDraft() {
  if (!(await prepareDraftNavigation())) return
  const returnWorkspace = workspaceView.value
  draftAction.value = 'create'
  draftError.value = ''
  draftNotice.value = ''
  try {
    const response = await createServerDraft()
    openWorkspace('drafts')
    draftListStatus.value = 'active'
    await setSelectedDraft(response.data.draft)
    await refreshDrafts()
    draftReturnWorkspace = returnWorkspace
    pushMobileHistoryLayer('draft-editor')
  } catch (error) {
    handleDraftApiError(error, '无法新建草稿')
  } finally {
    draftAction.value = null
  }
}

async function startRelatedDraft(composeKind: Exclude<DraftComposeKind, 'new'>) {
  const message = selectedMessage.value
  if (!message || !(await prepareDraftNavigation())) return
  selectedMessageAction.value = `compose:${composeKind}`
  draftError.value = ''
  draftNotice.value = ''
  mailboxError.value = ''
  try {
    const response = await createServerDraft({
      composeKind,
      sourceMailboxEntryId: message.id,
    })
    openWorkspace('drafts')
    draftListStatus.value = 'active'
    await setSelectedDraft(response.data.draft)
    await refreshDrafts()
    draftReturnWorkspace = 'mailbox'
    pushMobileHistoryLayer('draft-editor')
  } catch (error) {
    mailboxError.value = error instanceof Error ? error.message : '无法从这封邮件建立草稿'
  } finally {
    selectedMessageAction.value = null
  }
}

async function openDraft(draftId: string) {
  if (selectedDraft.value?.id === draftId) return
  if (!(await prepareDraftNavigation())) return
  const openingEditor = selectedDraft.value === null
  cancelDraftSaveTimer()
  draftAction.value = `open:${draftId}`
  draftError.value = ''
  draftNotice.value = ''
  try {
    await setSelectedDraft((await fetchDraftDetail(draftId)).data.draft)
    if (openingEditor) {
      draftReturnWorkspace = 'drafts'
      pushMobileHistoryLayer('draft-editor')
    }
  } catch (error) {
    handleDraftApiError(error, '无法打开草稿')
  } finally {
    draftAction.value = null
  }
}

async function setSelectedDraft(draft: DraftDetail) {
  lastSendOperation.value = null
  selectedDraft.value = draft
  draftForm.senderAddressId = draft.senderAddressId
  draftForm.to = recipientText(draft.recipients, 'to')
  draftForm.cc = recipientText(draft.recipients, 'cc')
  draftForm.bcc = recipientText(draft.recipients, 'bcc')
  draftCopiesOpen.value = Boolean(draftForm.cc || draftForm.bcc)
  draftActionsOpen.value = false
  draftForm.subject = draft.subject
  draftForm.bodyFormat = draft.bodyFormat
  draftForm.body = draft.body
  draftForm.attachmentIds = draft.attachments.map((attachment) => attachment.id)
  draftEditVersion = 0
  draftSaveState.value = 'clean'
  await nextTick()
  syncRichDraftEditor()
}

function scheduleDraftSave() {
  if (!selectedDraft.value || selectedDraft.value.status !== 'active') return
  draftEditVersion += 1
  draftSaveState.value = 'dirty'
  cancelDraftSaveTimer()
  draftSaveTimer = setTimeout(() => void saveDraftNow(), 2_000)
}

function cancelDraftSaveTimer() {
  if (draftSaveTimer !== null) {
    clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
}

async function prepareDraftNavigation(): Promise<boolean> {
  if (draftSaveInFlight.value) {
    draftNotice.value = '正在保存当前草稿，请稍候再切换。'
    return false
  }
  if (
    (draftSaveState.value === 'dirty' || draftSaveState.value === 'failed') &&
    !(await saveDraftNow())
  ) {
    return false
  }
  return true
}

async function closeSelectedDraft() {
  if (currentMobileHistoryLayer() === 'draft-editor') {
    window.history.back()
    return
  }
  if (!(await prepareDraftNavigation())) return
  selectedDraft.value = null
  if (usesMobileWorkspaceLayout() && draftReturnWorkspace === 'mailbox') openWorkspace('mailbox')
}

async function saveDraftNow(): Promise<DraftDetail | null> {
  const draft = selectedDraft.value
  if (!draft || draft.status !== 'active') return draft
  if (draftSaveState.value === 'clean' || draftSaveState.value === 'saved') return draft
  if (draftSaveInFlight.value) return null
  cancelDraftSaveTimer()
  const savedEditVersion = draftEditVersion
  const savedSessionId = authentication.value?.session.id
  draftSaveInFlight.value = true
  draftSaveState.value = 'saving'
  draftError.value = ''
  try {
    const response = await saveServerDraft(draft.id, {
      mutationKey: crypto.randomUUID(),
      expectedRevisionNumber: draft.revisionNumber,
      senderAddressId: draftForm.senderAddressId,
      subject: draftForm.subject,
      bodyFormat: draftForm.bodyFormat,
      body:
        draftForm.bodyFormat === 'rich_text' ? sanitizeDraftHtml(draftForm.body) : draftForm.body,
      recipients: draftRecipientsFromForm(),
      attachmentIds: [...draftForm.attachmentIds],
    })
    if (authentication.value?.session.id !== savedSessionId) return null
    const editedWhileSaving = draftEditVersion !== savedEditVersion
    selectedDraft.value = response.data.draft
    draftForm.attachmentIds = response.data.draft.attachments.map((attachment) => attachment.id)
    if (editedWhileSaving) {
      draftSaveState.value = 'dirty'
      draftNotice.value =
        response.data.outcome === 'conflict_copy'
          ? '另一台设备已经保存了更新内容，本次编辑已切换到冲突副本。'
          : ''
      draftSaveTimer = setTimeout(() => void saveDraftNow(), 2_000)
    } else if (response.data.outcome === 'conflict_copy') {
      await setSelectedDraft(response.data.draft)
      draftSaveState.value = 'conflict'
      draftNotice.value = '另一台设备已经保存了更新内容，本次编辑已另存为冲突副本。'
    } else {
      draftSaveState.value = 'saved'
      draftNotice.value = ''
    }
    await refreshDrafts()
    return response.data.draft
  } catch (error) {
    draftSaveState.value = 'failed'
    handleDraftApiError(error, '草稿保存失败')
    return null
  } finally {
    draftSaveInFlight.value = false
  }
}

function handleRichDraftInput(event: Event) {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  draftForm.body = sanitizeDraftHtml(target.innerHTML)
  scheduleDraftSave()
}

function applyDraftFormat(command: 'bold' | 'italic' | 'insertUnorderedList') {
  draftRichEditor.value?.focus()
  document.execCommand(command)
  if (draftRichEditor.value) draftForm.body = sanitizeDraftHtml(draftRichEditor.value.innerHTML)
  scheduleDraftSave()
}

async function changeDraftBodyFormat(format: DraftBodyFormat) {
  if (draftForm.bodyFormat === format) return
  if (format === 'plain_text') {
    draftForm.body = draftRichEditor.value?.innerText ?? htmlToPlainText(draftForm.body)
  } else {
    draftForm.body = plainTextToHtml(draftForm.body)
  }
  draftForm.bodyFormat = format
  await nextTick()
  syncRichDraftEditor()
  scheduleDraftSave()
}

function syncRichDraftEditor() {
  if (draftForm.bodyFormat === 'rich_text' && draftRichEditor.value) {
    draftRichEditor.value.innerHTML = sanitizeDraftHtml(draftForm.body)
  }
}

async function uploadDraftFiles(event: Event) {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement) || !input.files?.length || !selectedDraft.value) return
  cancelDraftSaveTimer()
  if (draftSaveState.value === 'dirty' || draftSaveState.value === 'failed') {
    if (!(await saveDraftNow())) {
      input.value = ''
      return
    }
  }
  draftAction.value = 'attachment'
  draftError.value = ''
  try {
    for (const file of Array.from(input.files)) {
      if (file.size > 20_000_000) throw new Error('单个附件不能超过 20 MB')
      const current = selectedDraft.value
      if (!current) break
      const response = await uploadServerDraftAttachment(
        current.id,
        current.revisionNumber,
        crypto.randomUUID(),
        file,
      )
      await setSelectedDraft(response.data.draft)
      draftSaveState.value = 'saved'
    }
    await refreshDrafts()
  } catch (error) {
    draftSaveState.value = 'failed'
    handleDraftApiError(error, '附件上传失败')
  } finally {
    input.value = ''
    draftAction.value = null
  }
}

async function removeDraftAttachment(attachmentId: string) {
  draftForm.attachmentIds = draftForm.attachmentIds.filter((id) => id !== attachmentId)
  scheduleDraftSave()
  await saveDraftNow()
}

async function trashSelectedDraft() {
  const draft = selectedDraft.value
  if (!draft) return
  if (!(await prepareDraftNavigation())) return
  draftAction.value = `trash:${draft.id}`
  try {
    await trashServerDraft(draft.id)
    selectedDraft.value = null
    draftNotice.value = '草稿已移入垃圾箱。'
    await refreshDrafts()
  } catch (error) {
    handleDraftApiError(error, '无法丢弃草稿')
  } finally {
    draftAction.value = null
  }
}

async function restoreDraft(draftId: string) {
  draftAction.value = `restore:${draftId}`
  try {
    const response = await restoreServerDraft(draftId)
    if (selectedDraft.value?.id === draftId) await setSelectedDraft(response.data.draft)
    draftNotice.value = '草稿已恢复。'
    await refreshDrafts()
  } catch (error) {
    handleDraftApiError(error, '无法恢复草稿')
  } finally {
    draftAction.value = null
  }
}

async function sendCurrentDraft() {
  const current = selectedDraft.value
  if (!current || current.status !== 'active') return
  draftError.value = ''
  draftNotice.value = ''
  const draft = await saveDraftNow()
  if (!draft) return
  const previous = draftSendRequest.value
  const request =
    previous?.draftId === draft.id && previous.revisionNumber === draft.revisionNumber
      ? previous
      : { draftId: draft.id, revisionNumber: draft.revisionNumber, requestKey: crypto.randomUUID() }
  draftSendRequest.value = request
  draftAction.value = `send:${draft.id}`
  try {
    const response = await sendServerDraft(draft.id, {
      requestKey: request.requestKey,
      expectedRevisionNumber: draft.revisionNumber,
    })
    lastSendOperation.value = response.data.send
    selectedDraft.value = null
    draftSendRequest.value = null
    draftNotice.value = response.data.replayed ? '已确认此前的发送结果。' : '邮件已接受发送。'
    await Promise.all([refreshDrafts(), refreshMailbox()])
    scheduleSendStatusRefresh(response.data.send.id, 15)
  } catch (error) {
    handleDraftApiError(error, '邮件发送失败')
  } finally {
    draftAction.value = null
  }
}

async function refreshLastSendOperation() {
  const current = lastSendOperation.value
  if (!current) return
  try {
    lastSendOperation.value = (await fetchSendOperation(current.id)).data.send
  } catch (error) {
    handleDraftApiError(error, '无法刷新发信状态')
  }
}

function scheduleSendStatusRefresh(sendOperationId: string, remaining: number) {
  cancelSendStatusTimer()
  if (remaining <= 0 || lastSendOperation.value?.workflowStatus === 'finished') return
  sendStatusTimer = setTimeout(async () => {
    try {
      const response = await fetchSendOperation(sendOperationId)
      if (lastSendOperation.value?.id !== sendOperationId) return
      lastSendOperation.value = response.data.send
      scheduleSendStatusRefresh(sendOperationId, remaining - 1)
    } catch {
      cancelSendStatusTimer()
    }
  }, 2_000)
}

function cancelSendStatusTimer() {
  if (sendStatusTimer !== null) {
    clearTimeout(sendStatusTimer)
    sendStatusTimer = null
  }
}

function sendStatusLabel(status: SendOperationResult['recipients'][number]['status']): string {
  return {
    waiting: '等待提交',
    submitting: '正在提交',
    submitted: '已提交',
    delayed: '投递延迟',
    delivered: '已送达',
    bounced: '已退信',
    failed: '发送失败',
    unknown: '结果待确认',
  }[status]
}

function draftRecipientsFromForm(): DraftRecipient[] {
  return [
    ...parseDraftAddressList(draftForm.to, 'to'),
    ...parseDraftAddressList(draftForm.cc, 'cc'),
    ...parseDraftAddressList(draftForm.bcc, 'bcc'),
  ]
}

function parseDraftAddressList(value: string, role: DraftRecipient['role']): DraftRecipient[] {
  return value
    .split(/[;,\n]/u)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ role, displayName: null, address }))
}

function recipientText(recipients: DraftRecipient[], role: DraftRecipient['role']): string {
  return recipients
    .filter((recipient) => recipient.role === role)
    .map((recipient) => recipient.address)
    .join(', ')
}

function draftSaveStateLabel(): string {
  const labels: Record<DraftSaveState, string> = {
    clean: '没有待保存内容',
    dirty: '尚未保存',
    saving: '正在保存',
    saved: '已保存到服务器',
    failed: '保存失败',
    conflict: '已另存为冲突副本',
  }
  return labels[draftSaveState.value]
}

function handleDraftApiError(error: unknown, fallback: string) {
  if (isAuthenticationRequired(error)) {
    clearAuthentication()
    return
  }
  draftError.value = error instanceof Error ? error.message : fallback
}

function htmlToPlainText(value: string): string {
  const document = new DOMParser().parseFromString(sanitizeDraftHtml(value), 'text/html')
  return document.body.innerText
}

function plainTextToHtml(value: string): string {
  return value
    .split(/\n{2,}/u)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/gu, '<br>')}</p>`)
    .join('')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character] ?? character
  })
}

async function applyMailboxSearch() {
  mailboxSearchApplied.value = {
    body: mailboxSearchDraft.body.trim(),
    subject: mailboxSearchDraft.subject.trim(),
    sender: mailboxSearchDraft.sender.trim(),
    recipient: mailboxSearchDraft.recipient.trim(),
    mailboxAddress: mailboxSearchDraft.mailboxAddress.trim(),
    dateFrom: localDateStart(mailboxSearchDraft.dateFrom),
    dateTo: localDateEnd(mailboxSearchDraft.dateTo),
    attachment: mailboxSearchDraft.attachment,
    read: mailboxSearchDraft.read,
    starred: mailboxSearchDraft.starred,
    archived: mailboxSearchDraft.archived,
    sort: mailboxSearchDraft.sort,
  }
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  await refreshMailbox()
}

async function applyUnallocatedMailSearch() {
  unallocatedMailAppliedQuery.value = unallocatedMailQuery.value.trim()
  closeUnallocatedMessage()
  await refreshUnallocatedMail()
}

async function clearUnallocatedMailSearch() {
  unallocatedMailQuery.value = ''
  unallocatedMailAppliedQuery.value = ''
  closeUnallocatedMessage()
  await refreshUnallocatedMail()
}

async function selectMailboxMode(mode: MailboxMode) {
  openWorkspace('mailbox')
  mailboxMode.value = mode
  messageActionsOpen.value = false
  selectedMessage.value = null
  selectedConversationEntries.value = []
  selectedUnallocatedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  cancelUnallocatedClaim()
  if (mode === 'unallocated') await refreshUnallocatedMail()
  else await refreshMailbox()
}

async function clearMailboxSearch() {
  Object.assign(mailboxSearchDraft, createDefaultMailboxSearchDraft())
  mailboxSearchApplied.value = createDefaultMailboxSearchFilters()
  mailboxSearchIndex.value = null
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  await refreshMailbox()
}

async function selectMailboxScope(scope: MailboxScope, organizationId = '') {
  openWorkspace('mailbox')
  mailboxMode.value = 'assigned'
  mailboxScope.value = scope
  mailboxOrganizationId.value = organizationId
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  await refreshMailbox()
}

async function selectMailboxView(view: MailboxView) {
  openWorkspace('mailbox')
  mailboxMode.value = 'assigned'
  mailboxView.value = view
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  await refreshMailbox()
}

function toggleMailboxSelection(entryId: string) {
  const next = new Set(selectedMailboxEntryIds.value)
  if (next.has(entryId)) next.delete(entryId)
  else next.add(entryId)
  selectedMailboxEntryIds.value = next
}

function toggleMailboxSelectionMode() {
  mailboxSelectionMode.value = !mailboxSelectionMode.value
  if (!mailboxSelectionMode.value) selectedMailboxEntryIds.value = new Set()
}

function toggleAllLoadedMailboxItems() {
  selectedMailboxEntryIds.value = allLoadedMailboxItemsSelected.value
    ? new Set()
    : new Set(mailboxItems.value.map((item) => item.id))
}

async function runMailboxOrganizeAction(
  action: MailboxOrganizeAction,
  entryIds = [...selectedMailboxEntryIds.value],
) {
  if (entryIds.length === 0) return
  mailboxBulkAction.value = action
  mailboxError.value = ''
  try {
    await organizeMessages(entryIds, action)
    const message = selectedMessage.value
    if (message && entryIds.includes(message.id)) {
      if (action === 'mark_read') message.isRead = true
      else if (action === 'mark_unread') message.isRead = false
      else if (action === 'star') message.isStarred = true
      else if (action === 'unstar') message.isStarred = false
      else selectedMessage.value = null
    }
    await refreshMailbox()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailboxError.value = error instanceof Error ? error.message : '无法整理邮件'
  } finally {
    mailboxBulkAction.value = null
  }
}

async function openMailboxMessage(item: { id: string }) {
  const openingFromList = selectedMessage.value === null
  if (openingFromList) rememberMailboxReturnFocus()
  messageActionsOpen.value = false
  selectedMessageLoading.value = true
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  mailboxError.value = ''
  try {
    const response = await fetchMessageDetail(item.id)
    selectedMessage.value = response.data.message
    selectedConversationEntries.value = response.data.conversation.entries
    selectedMessageBodyMode.value = response.data.message.untrustedHtmlBody ? 'html' : 'plain'
    if (!response.data.message.isRead) {
      await setMessageRead(item.id, true)
      response.data.message.isRead = true
      const conversationEntry = selectedConversationEntries.value.find(
        (candidate) => candidate.id === item.id,
      )
      if (conversationEntry) conversationEntry.isRead = true
      const listItem = mailboxItems.value.find((candidate) => candidate.id === item.id)
      if (listItem) listItem.isRead = true
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailboxError.value = error instanceof Error ? error.message : '无法读取邮件'
  } finally {
    selectedMessageLoading.value = false
    if (selectedMessage.value) {
      await presentMailboxDetail()
      if (openingFromList) pushMobileHistoryLayer('mail-detail')
    }
  }
}

function requestCloseMailboxMessage() {
  if (currentMobileHistoryLayer() === 'mail-detail') {
    window.history.back()
    return
  }
  void closeMailboxMessage()
}

async function closeMailboxMessage() {
  selectedMessage.value = null
  selectedConversationEntries.value = []
  previewAttachmentId.value = null
  cancelMailboxPermanentDeletion()
  messageActionsOpen.value = false
  await restoreMailboxListFocus()
}

async function openUnallocatedMessage(item: { deliveryId: string }) {
  const openingFromList = selectedUnallocatedMessage.value === null
  if (openingFromList) rememberMailboxReturnFocus()
  selectedUnallocatedMessageLoading.value = true
  selectedUnallocatedMessage.value = null
  selectedMessage.value = null
  previewAttachmentId.value = null
  cancelUnallocatedClaim()
  mailboxError.value = ''
  try {
    const response = await fetchUnallocatedMailDetail(item.deliveryId)
    selectedUnallocatedMessage.value = response.data.message
    selectedMessageBodyMode.value = response.data.message.untrustedHtmlBody ? 'html' : 'plain'
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailboxError.value = error instanceof Error ? error.message : '无法读取未分配邮件'
  } finally {
    selectedUnallocatedMessageLoading.value = false
    if (selectedUnallocatedMessage.value) {
      await presentMailboxDetail()
      if (openingFromList) pushMobileHistoryLayer('mail-detail')
    }
  }
}

function requestCloseUnallocatedMessage() {
  if (currentMobileHistoryLayer() === 'mail-detail') {
    window.history.back()
    return
  }
  void closeUnallocatedMessage()
}

async function closeUnallocatedMessage() {
  selectedUnallocatedMessage.value = null
  previewAttachmentId.value = null
  cancelUnallocatedClaim()
  await restoreMailboxListFocus()
}

function requestUnallocatedClaim() {
  if (!selectedUnallocatedMessage.value) return
  pendingUnallocatedClaim.value = selectedUnallocatedMessage.value
  unallocatedClaimConfirmed.value = false
}

function cancelUnallocatedClaim() {
  pendingUnallocatedClaim.value = null
  unallocatedClaimConfirmed.value = false
}

async function confirmUnallocatedClaim() {
  const message = pendingUnallocatedClaim.value
  if (!message || !unallocatedClaimConfirmed.value) return
  unallocatedMailAction.value = 'claim'
  mailboxError.value = ''
  mailboxNotice.value = ''
  try {
    const response = await claimUnallocatedAddress(message.periodId)
    if (personalAddressOverview.value) {
      const claimedAlias = response.data.claimedAlias
      const existingIndex = personalAddressOverview.value.addresses.findIndex(
        (address) => address.id === claimedAlias.id,
      )
      const addresses = [...personalAddressOverview.value.addresses]
      if (existingIndex >= 0) addresses[existingIndex] = claimedAlias
      else addresses.push(claimedAlias)
      personalAddressOverview.value = {
        ...personalAddressOverview.value,
        addresses,
        policy: {
          ...personalAddressOverview.value.policy,
          aliasUsed: Math.max(
            personalAddressOverview.value.policy.aliasUsed,
            addresses.filter((address) => address.role === 'alias').length,
          ),
        },
      }
      syncAddressPreferenceDrafts(addresses)
    }
    mailboxNotice.value = `已认领 ${response.data.address}，已加入个人别名；${response.data.newlyAddedMessageCount} 封历史邮件已加入个人邮箱。`
    closeUnallocatedMessage()
    await Promise.all([
      refreshUnallocatedMail(),
      refreshMailbox(),
      refreshPersonalAddressManagement(),
    ])
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailboxError.value = error instanceof Error ? error.message : '无法认领未分配地址'
  } finally {
    unallocatedMailAction.value = null
  }
}

async function toggleSelectedMessageRead() {
  const message = selectedMessage.value
  if (!message) return
  selectedMessageAction.value = 'read'
  try {
    const isRead = !message.isRead
    await setMessageRead(message.id, isRead)
    message.isRead = isRead
    const conversationEntry = selectedConversationEntries.value.find(
      (candidate) => candidate.id === message.id,
    )
    if (conversationEntry) conversationEntry.isRead = isRead
    const listItem = mailboxItems.value.find((candidate) => candidate.id === message.id)
    if (listItem) listItem.isRead = isRead
  } catch (error) {
    mailboxError.value = error instanceof Error ? error.message : '无法修改已读状态'
  } finally {
    selectedMessageAction.value = null
  }
}

async function changeRemoteImagePermission(mode: RemoteImagePermissionMode) {
  const message = selectedMessage.value
  if (!message) return
  selectedMessageAction.value = `remote:${mode}`
  try {
    const response = await setRemoteImagePermission(message.id, mode)
    message.remoteImagesAllowed = response.data.remoteImagesAllowed
    message.remoteImagePermission = response.data.remoteImagePermission
    message.trustedSenderAddress = response.data.trustedSenderAddress
  } catch (error) {
    mailboxError.value = error instanceof Error ? error.message : '无法修改远程图片设置'
  } finally {
    selectedMessageAction.value = null
  }
}

async function removeSelectedTrustedSender() {
  const message = selectedMessage.value
  if (!message?.trustedSenderAddress) return
  selectedMessageAction.value = 'untrust-sender'
  try {
    await untrustSender(message.trustedSenderAddress)
    message.trustedSenderAddress = null
    if (message.remoteImagePermission === 'sender') {
      message.remoteImagePermission = 'default'
      message.remoteImagesAllowed = false
    }
  } catch (error) {
    mailboxError.value = error instanceof Error ? error.message : '无法取消可信发件人'
  } finally {
    selectedMessageAction.value = null
  }
}

function requestMailboxPermanentDeletion() {
  const message = selectedMessage.value
  if (!message?.canPermanentlyDelete || message.location !== 'trash') return
  pendingMailboxPermanentDeletion.value = message
  mailboxPermanentDeletionConfirmed.value = false
  mailboxError.value = ''
}

function cancelMailboxPermanentDeletion() {
  pendingMailboxPermanentDeletion.value = null
  mailboxPermanentDeletionConfirmed.value = false
}

async function confirmMailboxPermanentDeletion() {
  const message = pendingMailboxPermanentDeletion.value
  if (!message || !mailboxPermanentDeletionConfirmed.value) return
  selectedMessageAction.value = 'permanent-delete'
  mailboxError.value = ''
  try {
    const response = await permanentlyDeleteMessage(message.id)
    const result = response.data
    closeMailboxMessage()
    cancelMailboxPermanentDeletion()
    await refreshMailbox()
    mailboxNotice.value =
      result.deletionScope === 'organization'
        ? `组织邮件已永久删除，${result.affectedMemberCount} 名当前成员已失去访问。正文和附件将按共享引用情况在后台清理。`
        : result.physicalCleanupScheduled
          ? '个人邮件已永久删除，正文和附件正在后台清理。'
          : '个人邮件已永久删除；同一物理邮件仍被其他邮箱引用，因此共享内容会继续保留。'
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailboxError.value = error instanceof Error ? error.message : '邮件永久删除失败'
  } finally {
    selectedMessageAction.value = null
  }
}

function mailboxPermanentDeletionImpactText(): string {
  const message = pendingMailboxPermanentDeletion.value
  if (!message) return ''
  if (message.mailboxType === 'organization') {
    return `这会从“${message.organization?.name ?? '组织邮箱'}”中删除原始邮件，所有当前成员会立即失去访问。正文和附件仅在没有其他邮箱引用后由后台清理。`
  }
  return '这会删除你的个人邮箱副本，你会立即失去访问。正文和附件仅在没有其他邮箱引用后由后台清理。'
}

async function refreshAddressPolicy() {
  if (!authentication.value || authentication.value.user.role !== 'administrator') return

  addressPolicyLoading.value = true
  try {
    addressPolicy.value = (await fetchAddressPolicy()).data.policy
    syncAddressPolicyDraft(addressPolicy.value)
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取地址策略'
  } finally {
    addressPolicyLoading.value = false
  }
}

async function refreshNotificationManagement() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return
  notificationLoading.value = true
  notificationError.value = ''
  try {
    notificationOverview.value = (await fetchNotificationOverview()).data
    const available = new Set(
      notificationOverview.value.availableScopes.map((scope) => scope.addressId),
    )
    notificationForm.addressIds = notificationForm.addressIds.filter((id) => available.has(id))
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    notificationError.value = error instanceof Error ? error.message : '无法读取外部通知设置'
  } finally {
    notificationLoading.value = false
  }
}

async function refreshForwardingManagement() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return
  forwardingLoading.value = true
  forwardingError.value = ''
  try {
    forwardingOverview.value = (await fetchForwardingOverview()).data
    const verifiedTargets = forwardingOverview.value.targets.filter(
      (target) => target.status === 'verified',
    )
    if (
      !forwardingRuleForm.targetId ||
      !verifiedTargets.some((target) => target.id === forwardingRuleForm.targetId)
    ) {
      forwardingRuleForm.targetId = verifiedTargets[0]?.id ?? ''
    }
    const availableAddresses = new Set(
      forwardingOverview.value.addresses.map((address) => address.id),
    )
    forwardingRuleForm.addressIds = forwardingRuleForm.addressIds.filter((id) =>
      availableAddresses.has(id),
    )
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    forwardingError.value = error instanceof Error ? error.message : '无法读取自动转发设置'
  } finally {
    forwardingLoading.value = false
  }
}

async function refreshMailExportManagement(options: { silent?: boolean } = {}) {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return
  if (!options.silent) mailExportLoading.value = true
  mailExportError.value = ''
  try {
    mailExportOverview.value = (await fetchMailExportOverview()).data
    const organizations = mailExportOverview.value.organizations
    if (!organizations.some((organization) => organization.id === mailExportOrganizationId.value)) {
      mailExportOrganizationId.value = organizations[0]?.id ?? ''
    }
    const active = mailExportOverview.value.runs.some(
      (run) => run.status === 'planned' || run.status === 'running',
    )
    if (active) scheduleMailExportRefresh()
    else cancelMailExportRefresh()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailExportError.value = error instanceof Error ? error.message : '无法读取邮件导出记录'
  } finally {
    if (!options.silent) mailExportLoading.value = false
  }
}

function scheduleMailExportRefresh() {
  cancelMailExportRefresh()
  mailExportRefreshTimer = setTimeout(() => {
    mailExportRefreshTimer = null
    void refreshMailExportManagement({ silent: true })
  }, 3000)
}

function cancelMailExportRefresh() {
  if (mailExportRefreshTimer) clearTimeout(mailExportRefreshTimer)
  mailExportRefreshTimer = null
}

async function submitMailExport() {
  if (mailExportAction.value) return
  mailExportAction.value = 'create'
  mailExportError.value = ''
  mailExportNotice.value = ''
  try {
    const response = await createMailExport({
      scopeType: mailExportScope.value,
      ...(mailExportScope.value === 'organization'
        ? { organizationId: mailExportOrganizationId.value }
        : {}),
    })
    mailExportNotice.value = `已开始准备 ${mailExportScope.value === 'personal' ? '个人邮件' : '组织邮件'} 导出。`
    mailExportOverview.value = mergeMailExportRun(response.data.run, mailExportOverview.value)
    scheduleMailExportRefresh()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailExportError.value = error instanceof Error ? error.message : '创建邮件导出失败'
  } finally {
    mailExportAction.value = null
  }
}

async function removeMailExport(run: MailExportRunSummary) {
  if (mailExportAction.value) return
  mailExportAction.value = `delete:${run.id}`
  mailExportError.value = ''
  mailExportNotice.value = ''
  try {
    await deleteMailExport(run.id)
    mailExportNotice.value = '导出文件已删除。'
    await refreshMailExportManagement({ silent: true })
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    mailExportError.value = error instanceof Error ? error.message : '删除导出文件失败'
  } finally {
    mailExportAction.value = null
  }
}

function mergeMailExportRun(
  run: MailExportRunSummary,
  overview: MailExportOverviewResponse['data'] | null,
) {
  const current = overview ?? { organizations: [], runs: [] }
  return {
    ...current,
    runs: [run, ...current.runs.filter((item) => item.id !== run.id)].slice(0, 30),
  }
}

function mailExportStatusLabel(status: MailExportRunSummary['status']) {
  return status === 'planned'
    ? '等待处理'
    : status === 'running'
      ? '正在生成'
      : status === 'succeeded'
        ? '可以下载'
        : status === 'failed'
          ? '需要检查'
          : status === 'expired'
            ? '已过期'
            : '已删除'
}

function mailExportScopeLabel(run: MailExportRunSummary) {
  return run.scopeType === 'personal'
    ? '个人邮件'
    : `组织邮件 · ${run.organization?.name ?? '组织'}`
}

async function submitForwardingTarget() {
  forwardingAction.value = 'target:create'
  forwardingError.value = ''
  forwardingNotice.value = ''
  try {
    const response = await createExternalEmailTarget({
      emailAddress: forwardingTargetEmail.value,
    })
    forwardingTargetEmail.value = ''
    forwardingNotice.value =
      response.data.target.latestVerificationStatus === 'pending_input'
        ? '验证邮件已提交，请填写邮件中的一次性验证码。'
        : '验证邮件未能确认送达，请检查最近状态后重试。'
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法发送验证邮件'
  } finally {
    forwardingAction.value = null
  }
}

function resendForwardingTarget(target: ExternalEmailTargetSummary) {
  forwardingTargetEmail.value = target.emailAddress
  void submitForwardingTarget()
}

async function submitForwardingVerification(target: ExternalEmailTargetSummary) {
  forwardingAction.value = `target:verify:${target.id}`
  forwardingError.value = ''
  try {
    await verifyExternalEmailTarget(target.id, {
      code: forwardingVerificationCodes[target.id] ?? '',
    })
    delete forwardingVerificationCodes[target.id]
    forwardingNotice.value = `${target.emailAddress} 已完成验证。`
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法完成外部邮箱验证'
  } finally {
    forwardingAction.value = null
  }
}

async function removeForwardingTarget(target: ExternalEmailTargetSummary) {
  forwardingAction.value = `target:delete:${target.id}`
  forwardingError.value = ''
  try {
    await deleteExternalEmailTarget(target.id)
    delete forwardingVerificationCodes[target.id]
    forwardingNotice.value = '外部邮箱及其当前转发规则已删除。'
    resetForwardingRuleForm()
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法删除外部邮箱'
  } finally {
    forwardingAction.value = null
  }
}

async function submitForwardingRule() {
  forwardingAction.value = 'rule:save'
  forwardingError.value = ''
  forwardingNotice.value = ''
  try {
    await saveForwardingRule({
      ...(forwardingRuleForm.ruleId ? { ruleId: forwardingRuleForm.ruleId } : {}),
      targetId: forwardingRuleForm.targetId,
      scope: forwardingRuleForm.scope,
      addressIds: forwardingRuleForm.scope === 'all_personal' ? [] : forwardingRuleForm.addressIds,
      enabled: forwardingRuleForm.enabled,
    })
    forwardingNotice.value = forwardingRuleForm.ruleId
      ? '自动转发规则已更新。'
      : '自动转发规则已建立。'
    resetForwardingRuleForm()
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法保存自动转发规则'
  } finally {
    forwardingAction.value = null
  }
}

function editForwardingRule(rule: ForwardingRuleSummary) {
  forwardingRuleForm.ruleId = rule.id
  forwardingRuleForm.targetId = rule.targetId
  forwardingRuleForm.scope = rule.scope
  forwardingRuleForm.addressIds = [...rule.addressIds]
  forwardingRuleForm.enabled = rule.status === 'active'
  forwardingNotice.value = ''
}

function resetForwardingRuleForm() {
  forwardingRuleForm.ruleId = null
  forwardingRuleForm.targetId =
    forwardingOverview.value?.targets.find((target) => target.status === 'verified')?.id ?? ''
  forwardingRuleForm.scope = 'all_personal'
  forwardingRuleForm.addressIds = []
  forwardingRuleForm.enabled = true
}

async function toggleForwardingRule(rule: ForwardingRuleSummary) {
  forwardingAction.value = `rule:status:${rule.id}`
  forwardingError.value = ''
  try {
    await changeForwardingRuleStatus(rule.id, {
      status: rule.status === 'active' ? 'paused' : 'active',
    })
    forwardingNotice.value = rule.status === 'active' ? '自动转发已暂停。' : '自动转发已恢复。'
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法修改自动转发状态'
  } finally {
    forwardingAction.value = null
  }
}

async function removeForwardingRule(rule: ForwardingRuleSummary) {
  forwardingAction.value = `rule:delete:${rule.id}`
  forwardingError.value = ''
  try {
    await deleteForwardingRule(rule.id)
    if (forwardingRuleForm.ruleId === rule.id) resetForwardingRuleForm()
    forwardingNotice.value = '自动转发规则已删除。'
    await refreshForwardingManagement()
  } catch (error) {
    forwardingError.value = error instanceof Error ? error.message : '无法删除自动转发规则'
  } finally {
    forwardingAction.value = null
  }
}

function externalEmailTargetStatusLabel(target: ExternalEmailTargetSummary): string {
  return target.status === 'verified'
    ? '已验证'
    : target.latestVerificationStatus === 'pending_input'
      ? '等待验证码'
      : target.latestVerificationStatus === 'delivery_unknown'
        ? '发送结果未知'
        : target.latestVerificationStatus === 'delivery_failed'
          ? '发送失败'
          : target.status === 'expired'
            ? '已过期'
            : '等待发送'
}

function forwardingResultStatusLabel(status: ForwardingResultStatus): string {
  return status === 'pending'
    ? '等待转发'
    : status === 'submitting'
      ? '正在提交'
      : status === 'submitted'
        ? '已提交'
        : status === 'unknown'
          ? '结果未知'
          : status === 'rejected_loop'
            ? '已阻止环路'
            : status === 'cancelled'
              ? '已取消'
              : '失败'
}

function changeNotificationChannel() {
  notificationForm.baseUrl =
    notificationForm.channelType === 'ntfy'
      ? 'https://ntfy.sh'
      : notificationForm.channelType === 'bark'
        ? 'https://api.day.app'
        : ''
  notificationForm.destination = ''
  notificationForm.credential = ''
}

async function submitNotificationSubscription() {
  notificationAction.value = 'create'
  notificationError.value = ''
  notificationNotice.value = ''
  try {
    const selected = new Set(notificationForm.addressIds)
    const scopes: NotificationScopeInput[] = [
      ...(notificationForm.allPersonal ? [{ kind: 'all_personal' as const }] : []),
      ...(notificationOverview.value?.availableScopes ?? [])
        .filter(
          (scope) =>
            selected.has(scope.addressId) &&
            !(notificationForm.allPersonal && scope.kind === 'personal_address'),
        )
        .map((scope) => ({ kind: scope.kind, addressId: scope.addressId })),
    ]
    await createNotificationSubscription({
      displayName: notificationForm.displayName,
      channelType: notificationForm.channelType,
      baseUrl: notificationForm.baseUrl,
      destination: notificationForm.destination,
      credential: notificationForm.credential,
      scopes,
    })
    notificationForm.displayName = ''
    notificationForm.destination = ''
    notificationForm.credential = ''
    notificationNotice.value = '外部通知订阅已建立。'
    await refreshNotificationManagement()
  } catch (error) {
    notificationError.value = error instanceof Error ? error.message : '无法建立外部通知订阅'
  } finally {
    notificationAction.value = null
  }
}

async function toggleNotificationSubscription(subscription: NotificationSubscriptionSummary) {
  notificationAction.value = `status:${subscription.id}`
  notificationError.value = ''
  try {
    await changeNotificationSubscriptionStatus(subscription.id, {
      status: subscription.status === 'active' ? 'paused' : 'active',
    })
    notificationNotice.value =
      subscription.status === 'active' ? '通知订阅已暂停。' : '通知订阅已恢复。'
    await refreshNotificationManagement()
  } catch (error) {
    notificationError.value = error instanceof Error ? error.message : '无法修改通知订阅状态'
  } finally {
    notificationAction.value = null
  }
}

async function removeNotificationSubscription(subscription: NotificationSubscriptionSummary) {
  notificationAction.value = `delete:${subscription.id}`
  notificationError.value = ''
  try {
    await deleteNotificationSubscription(subscription.id)
    notificationNotice.value = '通知订阅已删除。'
    await refreshNotificationManagement()
  } catch (error) {
    notificationError.value = error instanceof Error ? error.message : '无法删除通知订阅'
  } finally {
    notificationAction.value = null
  }
}

function notificationChannelLabel(channel: NotificationChannelType): string {
  return channel === 'ntfy'
    ? 'ntfy'
    : channel === 'gotify'
      ? 'Gotify'
      : channel === 'wxpusher'
        ? 'WxPusher'
        : channel === 'telegram'
          ? 'Telegram'
          : 'Bark'
}

function notificationDestinationLabel(channel: NotificationChannelType): string {
  return channel === 'ntfy'
    ? '主题'
    : channel === 'wxpusher'
      ? 'UID'
      : channel === 'telegram'
        ? 'Chat ID'
        : ''
}

function notificationCredentialLabel(channel: NotificationChannelType): string {
  return channel === 'ntfy'
    ? '访问令牌（可留空）'
    : channel === 'gotify'
      ? '应用令牌'
      : channel === 'wxpusher'
        ? 'AppToken'
        : channel === 'telegram'
          ? 'Bot Token'
          : '设备密钥'
}

function notificationOperationStatusLabel(
  status: NotificationOverviewResponse['data']['recentOperations'][number]['status'],
): string {
  return status === 'pending'
    ? '等待发送'
    : status === 'submitting'
      ? '正在提交'
      : status === 'submitted'
        ? '已提交'
        : status === 'unknown'
          ? '结果未知'
          : status === 'cancelled'
            ? '已取消'
            : '失败'
}

async function refreshPlatformResourceManagement() {
  if (authentication.value?.user.role !== 'administrator') return
  platformResourceLoading.value = true
  platformResourceError.value = ''
  try {
    platformResourceOverview.value = (await fetchPlatformResourceOverview()).data
    syncPlatformResourceDrafts()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    platformResourceError.value =
      error instanceof Error ? error.message : '无法读取 Cloudflare 免费资源用量'
  } finally {
    platformResourceLoading.value = false
  }
}

async function refreshOperationsHealth() {
  if (authentication.value?.user.role !== 'administrator') return
  operationsHealthLoading.value = true
  operationsHealthError.value = ''
  try {
    operationsHealth.value = (await fetchOperationsHealthOverview()).data
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    operationsHealthError.value = error instanceof Error ? error.message : '无法读取运行健康状态'
  } finally {
    operationsHealthLoading.value = false
  }
}

function operationsHealthStatusLabel(status: OperationsHealthStatus): string {
  return {
    healthy: '正常',
    attention: '需检查',
    unknown: '尚无记录',
    not_configured: '未配置',
  }[status]
}

function optionalDate(value: number | null): string {
  return value === null ? '尚无记录' : formatDate(value)
}

async function refreshStorageQuotaManagement() {
  if (authentication.value?.user.role !== 'administrator') return
  storageQuotaLoading.value = true
  storageQuotaError.value = ''
  try {
    storageQuotaOverview.value = (await fetchStorageQuotaOverview()).data
    syncStorageQuotaDrafts()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    storageQuotaError.value = error instanceof Error ? error.message : '无法读取逻辑存储配额'
  } finally {
    storageQuotaLoading.value = false
  }
}

function syncStorageQuotaDrafts() {
  const overview = storageQuotaOverview.value
  if (!overview) return
  for (const item of overview.defaults) storageQuotaDefaultDrafts[item.ownerType] = item.limitBytes
  for (const subject of [...overview.users, ...overview.organizations]) {
    storageQuotaOverrideDrafts[`${subject.ownerType}:${subject.ownerId}`] = subject.usesDefault
      ? ''
      : String(subject.limitBytes)
  }
}

async function submitStorageQuotaDefault(ownerType: 'user' | 'organization') {
  storageQuotaAction.value = `default:${ownerType}`
  storageQuotaError.value = ''
  storageQuotaNotice.value = ''
  try {
    await saveStorageQuotaDefault(ownerType, { limitBytes: storageQuotaDefaultDrafts[ownerType] })
    await refreshStorageQuotaManagement()
    storageQuotaNotice.value = `${ownerType === 'user' ? '用户' : '组织'}默认存储配额已保存。`
  } catch (error) {
    storageQuotaError.value = error instanceof Error ? error.message : '无法保存默认存储配额'
  } finally {
    storageQuotaAction.value = null
  }
}

async function submitStorageQuotaOverride(ownerType: 'user' | 'organization', ownerId: string) {
  storageQuotaAction.value = `override:${ownerType}:${ownerId}`
  storageQuotaError.value = ''
  storageQuotaNotice.value = ''
  const raw = storageQuotaOverrideDrafts[`${ownerType}:${ownerId}`]?.trim() ?? ''
  try {
    await saveStorageQuotaOverride(ownerType, ownerId, {
      limitBytes: raw === '' ? null : Number(raw),
    })
    await refreshStorageQuotaManagement()
    storageQuotaNotice.value = '单独存储配额已保存。'
  } catch (error) {
    storageQuotaError.value = error instanceof Error ? error.message : '无法保存单独存储配额'
  } finally {
    storageQuotaAction.value = null
  }
}

function storageQuotaUsageLabel(bytes: number) {
  return `${formatStorageSize(bytes)}`
}

function syncPlatformResourceDrafts() {
  const overview = platformResourceOverview.value
  if (!overview) return
  Object.assign(platformResourceConfigurationForm, {
    accountId: overview.configuration.accountId,
    d1DatabaseId: overview.configuration.d1DatabaseId,
    storageResourceReference: overview.configuration.storageResourceReference,
    apiToken: overview.configuration.apiToken,
  })
  for (const resource of overview.resources) {
    platformResourceThresholdDrafts[resource.resourceKind] = {
      warningPercent: resource.warningPercent,
      stopPercent: resource.stopPercent,
    }
  }
}

async function submitPlatformResourceConfiguration() {
  platformResourceAction.value = 'configuration'
  platformResourceError.value = ''
  platformResourceNotice.value = ''
  try {
    await savePlatformResourceConfiguration({ ...platformResourceConfigurationForm })
    platformResourceNotice.value = 'Cloudflare 只读配置已保存并测试。'
    await refreshPlatformResourceManagement()
  } catch (error) {
    platformResourceError.value = error instanceof Error ? error.message : '无法保存资源配置'
  } finally {
    platformResourceAction.value = null
  }
}

async function removePlatformResourceConfiguration() {
  if (!window.confirm('删除后将改用仅覆盖 Simlettra 的本地估算，确定继续吗？')) return
  platformResourceAction.value = 'delete-configuration'
  platformResourceError.value = ''
  platformResourceNotice.value = ''
  try {
    await deletePlatformResourceConfiguration()
    platformResourceConfigurationForm.apiToken = ''
    platformResourceNotice.value = 'Cloudflare 只读配置已删除，当前使用本地估算。'
    await refreshPlatformResourceManagement()
  } catch (error) {
    platformResourceError.value = error instanceof Error ? error.message : '无法删除资源配置'
  } finally {
    platformResourceAction.value = null
  }
}

async function refreshPlatformResourceUsage() {
  platformResourceAction.value = 'refresh'
  platformResourceError.value = ''
  platformResourceNotice.value = ''
  try {
    const response = await refreshPlatformResources()
    if (platformResourceOverview.value) {
      platformResourceOverview.value.resources = response.data.resources
    }
    platformResourceNotice.value = 'Cloudflare 免费资源用量已刷新。'
  } catch (error) {
    platformResourceError.value = error instanceof Error ? error.message : '无法刷新资源用量'
  } finally {
    platformResourceAction.value = null
  }
}

async function submitPlatformResourceThreshold(resourceKind: PlatformResourceKind) {
  platformResourceAction.value = `threshold:${resourceKind}`
  platformResourceError.value = ''
  platformResourceNotice.value = ''
  try {
    const response = await savePlatformResourceThreshold(
      resourceKind,
      platformResourceThresholdDrafts[resourceKind],
    )
    if (platformResourceOverview.value) {
      const index = platformResourceOverview.value.resources.findIndex(
        (item) => item.resourceKind === resourceKind,
      )
      if (index >= 0) platformResourceOverview.value.resources[index] = response.data.resource
    }
    platformResourceNotice.value = `${platformResourceLabel(resourceKind)} 阈值已保存。`
  } catch (error) {
    platformResourceError.value = error instanceof Error ? error.message : '无法保存资源阈值'
  } finally {
    platformResourceAction.value = null
  }
}

function platformResourceLabel(resourceKind: PlatformResourceKind): string {
  return resourceKind === 'd1' ? 'D1 数据库' : resourceKind === 'kv' ? 'KV 存储' : 'R2 存储'
}

function platformResourceSourceLabel(resource: PlatformResourceSummary): string {
  if (resource.dataSource === 'local_estimate') {
    const reason =
      resource.errorCode === 'permission_denied'
        ? 'Cloudflare 权限不足'
        : resource.errorCode === 'unavailable'
          ? 'Cloudflare 接口不可用'
          : resource.errorCode === 'refresh_failed'
            ? '刷新失败'
            : resource.errorCode === 'configuration_missing'
              ? '未配置只读 Token'
              : ''
    return reason ? `仅 Simlettra 本地估算 · ${reason}` : '仅 Simlettra 本地估算'
  }
  return resource.fetchStatus === 'success' ? 'Cloudflare 账号指标' : 'Cloudflare 账号指标已过期'
}

function platformResourceStatusLabel(resource: PlatformResourceSummary): string {
  if (resource.stopped) return '已停止新增'
  if (resource.warningReached) return '已到预警线'
  return '正常'
}

function platformResourceUsagePercent(resource: PlatformResourceSummary): number {
  const accountPercent = resource.accountUsedBytes
    ? (resource.accountUsedBytes / resource.freeLimitBytes) * 100
    : 0
  const currentPercent = resource.simlettraUsedBytes
    ? (resource.simlettraUsedBytes / resource.currentResourceLimitBytes) * 100
    : 0
  return Math.min(100, Math.max(accountPercent, currentPercent))
}

async function refreshOutboundManagement() {
  if (authentication.value?.user.role !== 'administrator') return
  outboundLoading.value = true
  outboundError.value = ''
  try {
    outboundManagement.value = (await fetchOutboundManagement()).data
    syncOutboundDrafts()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    outboundError.value = error instanceof Error ? error.message : '无法读取域外发信设置'
  } finally {
    outboundLoading.value = false
  }
}

function syncOutboundDrafts() {
  const overview = outboundManagement.value
  if (!overview) return
  outboundDailyDefaultDraft.value = overview.dailyDefaultRecipientLimit
  outboundDomainMonthlyDefaultDraft.value = overview.domainMonthlyDefaultLimit?.toString() ?? ''
  for (const user of overview.userDailyQuotas) outboundUserQuotaDrafts[user.userId] = user.limit
  for (const domain of overview.domainMonthlyQuotas) {
    outboundDomainQuotaDrafts[domain.domainId] = domain.limit?.toString() ?? ''
  }
  for (const domain of overview.domainMonthlyQuotas) {
    const route = overview.routes.find(
      (item) => item.domainId === domain.domainId && item.status === 'active',
    )
    outboundRouteDrafts[domain.domainId] = {
      primaryProviderId: route?.providerConfigIds[0] ?? '',
      backupProviderId: route?.providerConfigIds[1] ?? '',
    }
  }
}

function resetOutboundProviderForm() {
  outboundProviderForm.id = null
  outboundProviderForm.displayName = ''
  outboundProviderForm.providerType = 'resend'
  outboundProviderForm.credential = ''
  outboundProviderForm.callbackUsername = ''
  outboundProviderForm.callbackSecret = ''
}

function editOutboundProvider(
  provider: OutboundManagementOverviewResponse['data']['providers'][number],
) {
  outboundProviderForm.id = provider.id
  outboundProviderForm.displayName = provider.displayName
  outboundProviderForm.providerType = provider.providerType
  outboundProviderForm.credential = provider.credential
  outboundProviderForm.callbackUsername = provider.callbackUsername ?? ''
  outboundProviderForm.callbackSecret = provider.callbackSecret
  outboundNotice.value = ''
  outboundError.value = ''
}

async function submitOutboundProvider() {
  outboundAction.value = 'provider'
  outboundError.value = ''
  outboundNotice.value = ''
  try {
    await saveOutboundProvider({
      ...(outboundProviderForm.id ? { id: outboundProviderForm.id } : {}),
      displayName: outboundProviderForm.displayName,
      providerType: outboundProviderForm.providerType,
      credential: outboundProviderForm.credential,
      callbackUsername:
        outboundProviderForm.providerType === 'smtp2go'
          ? outboundProviderForm.callbackUsername
          : null,
      callbackSecret: outboundProviderForm.callbackSecret,
    })
    resetOutboundProviderForm()
    outboundNotice.value = '发信服务配置已保存。'
    await refreshOutboundManagement()
  } catch (error) {
    outboundError.value = error instanceof Error ? error.message : '无法保存发信服务配置'
  } finally {
    outboundAction.value = null
  }
}

function outboundRouteDraft(domainId: string): OutboundRouteDraft {
  return (outboundRouteDrafts[domainId] ??= {
    primaryProviderId: '',
    backupProviderId: '',
  })
}

async function submitOutboundRoute(domainId: string) {
  const route = outboundRouteDraft(domainId)
  const providerConfigIds = [route.primaryProviderId, route.backupProviderId].filter(Boolean)
  outboundAction.value = `route:${domainId}`
  outboundError.value = ''
  try {
    await saveDomainOutboundRoute(domainId, { providerConfigIds })
    outboundNotice.value = '域名发信顺序已保存。'
    await refreshOutboundManagement()
  } catch (error) {
    outboundError.value = error instanceof Error ? error.message : '无法保存域名发信顺序'
  } finally {
    outboundAction.value = null
  }
}

async function submitOutboundDefaultQuotas() {
  outboundAction.value = 'quota:defaults'
  outboundError.value = ''
  try {
    await Promise.all([
      saveDailyDefaultQuota({ limit: outboundDailyDefaultDraft.value }),
      saveDomainMonthlyDefaultQuota({
        limit: parseOptionalPositiveInteger(outboundDomainMonthlyDefaultDraft.value),
      }),
    ])
    outboundNotice.value = '默认发件额度已保存。'
    await refreshOutboundManagement()
  } catch (error) {
    outboundError.value = error instanceof Error ? error.message : '无法保存默认发件额度'
  } finally {
    outboundAction.value = null
  }
}

async function submitOutboundUserQuota(userId: string, useDefault = false) {
  outboundAction.value = `quota:user:${userId}`
  outboundError.value = ''
  try {
    await saveUserDailyQuota(userId, {
      limit: useDefault ? null : (outboundUserQuotaDrafts[userId] ?? 1),
      useDefault,
    })
    outboundNotice.value = '用户每日发件额度已保存。'
    await refreshOutboundManagement()
  } catch (error) {
    outboundError.value = error instanceof Error ? error.message : '无法保存用户发件额度'
  } finally {
    outboundAction.value = null
  }
}

async function submitOutboundDomainQuota(domainId: string, useDefault = false) {
  outboundAction.value = `quota:domain:${domainId}`
  outboundError.value = ''
  try {
    await saveDomainMonthlyQuota(domainId, {
      limit: useDefault
        ? null
        : parseOptionalPositiveInteger(outboundDomainQuotaDrafts[domainId] ?? ''),
      useDefault,
    })
    outboundNotice.value = '域名月度发件额度已保存。'
    await refreshOutboundManagement()
  } catch (error) {
    outboundError.value = error instanceof Error ? error.message : '无法保存域名发件额度'
  } finally {
    outboundAction.value = null
  }
}

function parseOptionalPositiveInteger(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('额度必须是正整数或留空')
  return parsed
}

function outboundCallbackUrl(
  provider: OutboundManagementOverviewResponse['data']['providers'][number],
): string {
  return `${window.location.origin}/api/outbound/events/${provider.providerType}/${provider.configurationKey}`
}

async function refreshUserManagement() {
  if (!authentication.value || authentication.value.user.role !== 'administrator') return

  userManagementLoading.value = true
  try {
    userManagement.value = (await fetchUserManagementOverview()).data
    if (!userManagement.value.domains.some((domain) => domain.id === userForm.domainId)) {
      userForm.domainId = userManagement.value.domains[0]?.id ?? ''
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取用户列表'
  } finally {
    userManagementLoading.value = false
  }
}

async function refreshAccountRegistrationInvitations() {
  if (authentication.value?.user.role !== 'administrator') return
  accountRegistrationInvitationLoading.value = true
  accountRegistrationInvitationError.value = ''
  try {
    accountRegistrationInvitations.value = (await fetchAccountRegistrationInvitations()).data
    const domains = accountRegistrationInvitations.value.domains
    if (domains.length === 1) {
      accountRegistrationInvitationDomainId.value = domains[0]!.id
    } else if (
      !domains.some((domain) => domain.id === accountRegistrationInvitationDomainId.value)
    ) {
      accountRegistrationInvitationDomainId.value = ''
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    accountRegistrationInvitationError.value =
      error instanceof Error ? error.message : '无法读取账号邀请码'
  } finally {
    accountRegistrationInvitationLoading.value = false
  }
}

async function submitAccountRegistrationInvitationCreation() {
  const domains = accountRegistrationInvitations.value?.domains ?? []
  accountRegistrationInvitationError.value = ''
  accountRegistrationInvitationNotice.value = ''
  if (domains.length > 1 && !accountRegistrationInvitationDomainId.value) {
    accountRegistrationInvitationError.value = '请选择邀请码所属的邮件域名'
    return
  }
  accountRegistrationInvitationAction.value = 'create'
  try {
    const response = await createAccountRegistrationInvitation(
      accountRegistrationInvitationDomainId.value
        ? { domainId: accountRegistrationInvitationDomainId.value }
        : {},
    )
    accountRegistrationInvitationNotice.value = '邀请码已生成，可以从下方列表复制。'
    if (accountRegistrationInvitations.value) {
      accountRegistrationInvitations.value.invitations.unshift(response.data.invitation)
    }
  } catch (error) {
    accountRegistrationInvitationError.value =
      error instanceof Error ? error.message : '无法生成账号邀请码'
  } finally {
    accountRegistrationInvitationAction.value = null
  }
}

async function revokeManagedAccountRegistrationInvitation(
  invitation: AccountRegistrationInvitationSummary,
) {
  accountRegistrationInvitationError.value = ''
  accountRegistrationInvitationNotice.value = ''
  accountRegistrationInvitationAction.value = `revoke:${invitation.id}`
  try {
    const response = await revokeAccountRegistrationInvitation(invitation.id)
    replaceAccountRegistrationInvitation(response.data.invitation)
    accountRegistrationInvitationNotice.value = '邀请码已撤销。'
  } catch (error) {
    accountRegistrationInvitationError.value =
      error instanceof Error ? error.message : '无法撤销账号邀请码'
  } finally {
    accountRegistrationInvitationAction.value = null
  }
}

async function copyAccountRegistrationInvitationCode(
  invitation: AccountRegistrationInvitationSummary,
) {
  try {
    await navigator.clipboard.writeText(invitation.code)
    accountRegistrationInvitationNotice.value = '邀请码已复制。'
  } catch {
    accountRegistrationInvitationNotice.value = '浏览器未允许复制，请手动选择邀请码。'
  }
}

function replaceAccountRegistrationInvitation(invitation: AccountRegistrationInvitationSummary) {
  if (!accountRegistrationInvitations.value) return
  const index = accountRegistrationInvitations.value.invitations.findIndex(
    (item) => item.id === invitation.id,
  )
  if (index >= 0) accountRegistrationInvitations.value.invitations[index] = invitation
}

async function refreshDomainManagement() {
  if (!authentication.value || authentication.value.user.role !== 'administrator') return

  domainManagementLoading.value = true
  try {
    domainManagement.value = (await fetchDomainManagementOverview()).data
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取邮件域名列表'
  } finally {
    domainManagementLoading.value = false
  }
}

async function refreshInboundControl() {
  if (authentication.value?.user.role !== 'administrator') return
  inboundControlLoading.value = true
  inboundControlError.value = ''
  try {
    inboundControl.value = (await fetchInboundControlOverview()).data
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法读取收信控制设置'
  } finally {
    inboundControlLoading.value = false
  }
}

async function toggleInboundReceiveStatus(
  scopeType: InboundControlScopeType,
  scopeId: string,
  currentStatus: InboundReceiveStatus,
) {
  inboundControlAction.value = `scope:${scopeType}:${scopeId}`
  inboundControlError.value = ''
  inboundControlNotice.value = ''
  try {
    const nextStatus = currentStatus === 'accepting' ? 'paused' : 'accepting'
    await changeInboundReceiveStatus(scopeType, scopeId, nextStatus)
    inboundControlNotice.value = nextStatus === 'accepting' ? '已恢复收信。' : '已暂停收信。'
    await refreshInboundControl()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法修改收信状态'
  } finally {
    inboundControlAction.value = null
  }
}

async function updateDomainCatchAllMode(domainId: string, mode: 'reject' | 'unallocated') {
  inboundControlAction.value = `catch-all:${domainId}`
  inboundControlError.value = ''
  inboundControlNotice.value = ''
  try {
    await changeDomainCatchAllMode(domainId, mode)
    inboundControlNotice.value =
      mode === 'unallocated' ? '已开启全域收信。' : '已拒收未创建地址，并清除查看授权。'
    await Promise.all([refreshInboundControl(), refreshUnallocatedMail()])
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法修改全域收信设置'
  } finally {
    inboundControlAction.value = null
  }
}

async function handleDomainCatchAllChange(domainId: string, event: Event) {
  if (!(event.currentTarget instanceof HTMLSelectElement)) return
  const mode = event.currentTarget.value
  if (mode !== 'reject' && mode !== 'unallocated') return
  await updateDomainCatchAllMode(domainId, mode)
}

async function updateUnallocatedAccess(domainId: string, userId: string, enabled: boolean) {
  inboundControlAction.value = `access:${domainId}:${userId}`
  inboundControlError.value = ''
  inboundControlNotice.value = ''
  try {
    await changeUnallocatedAccessGrant(domainId, userId, enabled)
    inboundControlNotice.value = enabled ? '已授予未分配来信查看权。' : '已撤销查看权。'
    await Promise.all([refreshInboundControl(), refreshUnallocatedMail()])
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法修改查看授权'
  } finally {
    inboundControlAction.value = null
  }
}

async function handleUnallocatedAccessChange(domainId: string, userId: string, event: Event) {
  if (!(event.currentTarget instanceof HTMLInputElement)) return
  await updateUnallocatedAccess(domainId, userId, event.currentTarget.checked)
}

async function submitInboundRejectionRule() {
  const matchValue = inboundRejectionRuleForm.matchValue.trim()
  if (!matchValue) {
    inboundControlError.value = '请输入拒收匹配内容'
    return
  }
  inboundControlAction.value = 'rule:create'
  inboundControlError.value = ''
  inboundControlNotice.value = ''
  try {
    await createInboundRejectionRule(inboundRejectionRuleForm.ruleType, matchValue)
    inboundRejectionRuleForm.matchValue = ''
    inboundControlNotice.value = '拒收规则已创建。'
    await refreshInboundControl()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法创建拒收规则'
  } finally {
    inboundControlAction.value = null
  }
}

async function toggleInboundRejectionRule(ruleId: string, currentStatus: 'active' | 'paused') {
  inboundControlAction.value = `rule:status:${ruleId}`
  inboundControlError.value = ''
  try {
    await changeInboundRejectionRuleStatus(ruleId, currentStatus === 'active' ? 'paused' : 'active')
    await refreshInboundControl()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法修改拒收规则'
  } finally {
    inboundControlAction.value = null
  }
}

async function removeInboundRejectionRule(ruleId: string) {
  inboundControlAction.value = `rule:delete:${ruleId}`
  inboundControlError.value = ''
  try {
    await deleteInboundRejectionRule(ruleId)
    inboundControlNotice.value = '拒收规则已删除。'
    await refreshInboundControl()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    inboundControlError.value = error instanceof Error ? error.message : '无法删除拒收规则'
  } finally {
    inboundControlAction.value = null
  }
}

async function refreshPersonalAddressManagement() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return

  personalAddressLoading.value = true
  try {
    personalAddressOverview.value = (await fetchPersonalAddressOverview()).data
    syncAddressPreferenceDrafts(personalAddressOverview.value.addresses)
    if (
      !personalAddressOverview.value.activeDomains.some(
        (domain) => domain.id === personalAliasForm.domainId,
      )
    ) {
      personalAliasForm.domainId = personalAddressOverview.value.activeDomains[0]?.id ?? ''
    }
    if (
      !personalAddressOverview.value.activeDomains.some(
        (domain) => domain.id === administratorAliasForm.domainId,
      )
    ) {
      administratorAliasForm.domainId = personalAddressOverview.value.activeDomains[0]?.id ?? ''
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取个人邮箱地址'
  } finally {
    personalAddressLoading.value = false
  }
}

async function refreshAdministratorAliasPolicies() {
  if (!authentication.value || authentication.value.user.role !== 'administrator') return

  aliasPolicyLoading.value = true
  try {
    administratorAliasPolicies.value = (await fetchAdministratorAliasPolicies()).data
    syncAliasPolicyDrafts(administratorAliasPolicies.value.users)
    if (
      !administratorAliasPolicies.value.users.some(
        (user) => user.id === administratorAliasForm.userId && user.status === 'active',
      )
    ) {
      administratorAliasForm.userId =
        administratorAliasPolicies.value.users.find((user) => user.status === 'active')?.id ?? ''
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取用户别名策略'
  } finally {
    aliasPolicyLoading.value = false
  }
}

async function refreshOrganizationManagement() {
  if (!authentication.value || authentication.value.user.passwordChangeRequired) return

  organizationLoading.value = true
  try {
    organizationOverview.value = (await fetchOrganizationOverview()).data
    organizationInvitationPolicyDraft.value = organizationOverview.value.invitationPolicy
    if (
      !organizationOverview.value.activeDomains.some(
        (domain) => domain.id === organizationForm.domainId,
      )
    ) {
      organizationForm.domainId = organizationOverview.value.activeDomains[0]?.id ?? ''
    }
    const visibleIds = new Set(organizationOverview.value.organizations.map((item) => item.id))
    for (const id of Object.keys(organizationInvitationInputs)) {
      if (!visibleIds.has(id)) delete organizationInvitationInputs[id]
    }
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取组织与邀请'
  } finally {
    organizationLoading.value = false
  }
}

async function refreshAdministratorOrganizationPolicies() {
  if (!authentication.value || authentication.value.user.role !== 'administrator') return

  organizationPolicyLoading.value = true
  try {
    administratorOrganizationPolicies.value = (await fetchAdministratorOrganizationPolicies()).data
    syncOrganizationPolicyDrafts(administratorOrganizationPolicies.value.users)
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '无法读取用户组织额度'
  } finally {
    organizationPolicyLoading.value = false
  }
}

async function submitOrganizationCreation() {
  clearFieldErrors(organizationErrors)
  authError.value = ''
  accountNotice.value = ''
  if (!organizationForm.name.trim()) organizationErrors.name = '请输入组织名称'
  if (!organizationForm.localPart.trim()) organizationErrors.localPart = '请输入组织邮箱前缀'
  if (!organizationForm.domainId) organizationErrors.domainId = '请选择邮件域名'
  if (Object.keys(organizationErrors).length > 0) return

  organizationActionId.value = 'create'
  try {
    const response = await createOrganization(organizationForm)
    organizationForm.name = ''
    organizationForm.localPart = ''
    accountNotice.value = `${response.data.organization.name} 已建立。`
    await Promise.all([
      refreshOrganizationManagement(),
      authentication.value?.user.role === 'administrator'
        ? refreshAdministratorOrganizationPolicies()
        : Promise.resolve(),
    ])
  } catch (error) {
    handleOrganizationFormError(error, '组织创建失败')
  } finally {
    organizationActionId.value = null
  }
}

async function saveOrganizationInvitationPolicy() {
  organizationActionId.value = 'invitation-policy'
  authError.value = ''
  accountNotice.value = ''
  try {
    await updateOrganizationInvitationPolicy(organizationInvitationPolicyDraft.value)
    if (organizationOverview.value) {
      organizationOverview.value.invitationPolicy = organizationInvitationPolicyDraft.value
    }
    accountNotice.value = '组织邀请策略已保存。'
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '组织邀请策略保存失败'
  } finally {
    organizationActionId.value = null
  }
}

async function submitOrganizationInvitation(organization: OrganizationSummary) {
  const primaryAddress = organizationInvitationInputs[organization.id]?.trim() ?? ''
  if (!primaryAddress) {
    authError.value = '请输入现有用户的主邮箱地址'
    return
  }
  organizationActionId.value = `invite:${organization.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await inviteOrganizationMember(organization.id, { primaryAddress })
    organizationInvitationInputs[organization.id] = ''
    accountNotice.value =
      response.data.outcome === 'accepted'
        ? '对方已按个人策略自动加入组织。'
        : response.data.outcome === 'rejected'
          ? '对方的个人策略已拒绝本次邀请。'
          : '组织邀请已发出。'
    await refreshOrganizationManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '组织邀请失败'
  } finally {
    organizationActionId.value = null
  }
}

async function respondToOrganizationInvitation(
  invitationId: string,
  decision: 'accept' | 'reject',
) {
  organizationActionId.value = `${decision}:${invitationId}`
  authError.value = ''
  accountNotice.value = ''
  try {
    await resolveOrganizationInvitation(invitationId, decision)
    accountNotice.value = decision === 'accept' ? '已加入组织。' : '已拒绝组织邀请。'
    await refreshOrganizationManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '组织邀请处理失败'
  } finally {
    organizationActionId.value = null
  }
}

async function withdrawOrganizationInvitation(organizationId: string, invitationId: string) {
  organizationActionId.value = `revoke:${invitationId}`
  authError.value = ''
  try {
    await revokeOrganizationInvitation(organizationId, invitationId)
    accountNotice.value = '邀请已撤回。'
    await refreshOrganizationManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '撤回邀请失败'
  } finally {
    organizationActionId.value = null
  }
}

async function toggleOrganizationSendingPermission(organization: OrganizationSummary) {
  organizationActionId.value = `sending:${organization.id}`
  authError.value = ''
  try {
    await updateOrganizationSendingPermission(organization.id, !organization.membersCanSend)
    accountNotice.value = organization.membersCanSend
      ? '已关闭普通成员使用组织地址发信。'
      : '已允许普通成员使用组织地址发信。'
    await refreshOrganizationManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '组织发件权限修改失败'
  } finally {
    organizationActionId.value = null
  }
}

function requestOrganizationAction(organization: OrganizationSummary, kind: 'leave' | 'delete') {
  pendingOrganizationAction.value = {
    organization,
    kind,
    successorUserId:
      organization.members.find((member) => member.userId !== authentication.value?.user.id)
        ?.userId ?? '',
    confirmed: false,
  }
}

function cancelOrganizationAction() {
  pendingOrganizationAction.value = null
}

async function confirmOrganizationAction() {
  const pending = pendingOrganizationAction.value
  if (!pending?.confirmed) return
  const organization = pending.organization
  organizationActionId.value = `${pending.kind}:${organization.id}`
  authError.value = ''
  try {
    if (pending.kind === 'delete') {
      const response = await deleteOrganization(organization.id)
      accountNotice.value = `组织已停用，可在 ${formatDate(response.data.deletionDueAt)} 前恢复。`
    } else {
      const response = await leaveOrganization(organization.id, {
        successorUserId:
          organization.isCreator && organization.memberCount > 1
            ? pending.successorUserId || null
            : null,
        confirmed: true,
      })
      accountNotice.value =
        response.data.outcome === 'transferred'
          ? '创建者身份已交接，你已退出组织。'
          : response.data.outcome === 'deletion_pending'
            ? `组织已停用，可在 ${formatDate(response.data.deletionDueAt ?? '')} 前恢复。`
            : '你已退出组织。'
    }
    pendingOrganizationAction.value = null
    await Promise.all([
      refreshOrganizationManagement(),
      authentication.value?.user.role === 'administrator'
        ? refreshAdministratorOrganizationPolicies()
        : Promise.resolve(),
    ])
  } catch (error) {
    if (error instanceof ApiRequestError && error.field === 'successorUserId') {
      organizationErrors.successorUserId = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '组织操作失败'
    }
  } finally {
    organizationActionId.value = null
  }
}

async function restorePendingOrganization(organization: OrganizationSummary) {
  organizationActionId.value = `restore:${organization.id}`
  authError.value = ''
  try {
    await restoreOrganization(organization.id)
    accountNotice.value = `${organization.name} 已恢复。`
    await refreshOrganizationManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '恢复组织失败'
  } finally {
    organizationActionId.value = null
  }
}

async function saveOrganizationPolicy(user: AdministratorOrganizationPolicyUser) {
  const draft = organizationPolicyDraft(user)
  organizationPolicyActionId.value = user.userId
  authError.value = ''
  try {
    const response = await updateAdministratorOrganizationPolicy(
      user.userId,
      draft.organizationLimit,
    )
    if (administratorOrganizationPolicies.value) {
      const index = administratorOrganizationPolicies.value.users.findIndex(
        (item) => item.userId === user.userId,
      )
      if (index >= 0) administratorOrganizationPolicies.value.users[index] = response.data.user
    }
    organizationPolicyDrafts[user.userId] = {
      organizationLimit: response.data.user.policy.organizationLimit,
    }
    if (user.userId === authentication.value?.user.id) await refreshOrganizationManagement()
    accountNotice.value = `${user.displayName} 的组织上限已保存。`
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '组织额度保存失败'
  } finally {
    organizationPolicyActionId.value = null
  }
}

async function exitSession(session: SessionSummary) {
  sessionActionId.value = session.id
  authError.value = ''

  try {
    if (session.current) {
      await logoutSession()
      clearAuthentication()
      return
    }

    await revokeSession(session.id)
    sessions.value = sessions.value.filter((item) => item.id !== session.id)
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '退出会话失败'
  } finally {
    sessionActionId.value = null
  }
}

async function exitCurrentSession() {
  const currentSession = sessions.value.find((session) => session.current)
  if (currentSession) {
    await exitSession(currentSession)
    return
  }

  sessionActionId.value = authentication.value?.session.id ?? 'current'
  try {
    await logoutSession()
    clearAuthentication()
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '退出登录失败'
  } finally {
    sessionActionId.value = null
  }
}

async function submitPasswordChange() {
  clearFieldErrors(passwordErrors)
  accountNotice.value = ''
  authError.value = ''

  if (!passwordForm.currentPassword) passwordErrors.currentPassword = '请输入当前密码'
  validateNewPasswordPair(passwordForm, passwordErrors)
  if (Object.keys(passwordErrors).length > 0) return

  passwordSubmitting.value = true
  try {
    const response = await changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
      revokeOtherSessions: passwordForm.revokeOtherSessions,
    })
    updateAuthenticatedUser(response.data.user)
    clearPasswordForms()
    accountNotice.value = response.data.revokedOtherSessions
      ? `密码已修改，并退出了 ${response.data.revokedOtherSessions} 个其他会话。`
      : '密码已修改。'
    await refreshAccountData()
  } catch (error) {
    handlePasswordFormError(error, passwordErrors)
  } finally {
    passwordSubmitting.value = false
  }
}

async function submitRequiredPasswordChange() {
  clearFieldErrors(requiredPasswordErrors)
  authError.value = ''
  validateNewPasswordPair(requiredPasswordForm, requiredPasswordErrors)
  if (Object.keys(requiredPasswordErrors).length > 0) return

  passwordSubmitting.value = true
  try {
    const response = await completeRequiredPasswordChange(requiredPasswordForm.newPassword)
    updateAuthenticatedUser(response.data.user)
    clearPasswordForms()
    accountNotice.value = '正式密码已设置，可以继续使用澄笺。'
    await refreshAccountData()
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.code === 'authentication_required' || error.code === 'temporary_password_expired')
    ) {
      clearAuthentication()
      authError.value = error.message
      return
    }
    handlePasswordFormError(error, requiredPasswordErrors)
  } finally {
    passwordSubmitting.value = false
  }
}

async function submitUserCreation() {
  clearFieldErrors(userErrors)
  temporaryPasswordResult.value = null
  temporaryPasswordNotice.value = ''
  authError.value = ''

  if (!userForm.displayName.trim()) userErrors.displayName = '请输入显示名称'
  if (!userForm.localPart.trim()) userErrors.localPart = '请输入邮箱前缀'
  if (!userForm.domainId) userErrors.domainId = '请选择邮件域名'
  if (!userForm.timezone.trim()) userErrors.timezone = '请输入时区'
  if (Object.keys(userErrors).length > 0) return

  userCreateSubmitting.value = true
  try {
    const response = await createManagedUser(userForm)
    temporaryPasswordResult.value = response.data
    temporaryPasswordHeading.value = '用户已创建'
    if (userManagement.value) userManagement.value.users.push(response.data.user)
    userForm.displayName = ''
    userForm.localPart = ''
    accountNotice.value = `${response.data.user.primaryAddress} 已建立。`
    await Promise.all([
      refreshAdministratorAliasPolicies(),
      refreshAdministratorOrganizationPolicies(),
    ])
  } catch (error) {
    if (error instanceof ApiRequestError && isManagedUserField(error.field)) {
      userErrors[error.field] = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '用户创建失败'
    }
  } finally {
    userCreateSubmitting.value = false
  }
}

async function resetManagedUserPassword(user: ManagedUserSummary) {
  userActionId.value = `reset:${user.id}`
  temporaryPasswordResult.value = null
  temporaryPasswordNotice.value = ''
  authError.value = ''
  try {
    temporaryPasswordResult.value = await resetUserPassword(user.primaryAddress).then(
      (response) => response.data,
    )
    temporaryPasswordHeading.value = '临时密码已重置'
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '临时密码生成失败'
  } finally {
    userActionId.value = null
  }
}

async function toggleManagedUserStatus(user: ManagedUserSummary) {
  const nextStatus = user.status === 'active' ? 'disabled' : 'active'
  userActionId.value = `status:${user.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await changeUserStatus(user.id, nextStatus)
    if (userManagement.value) {
      const index = userManagement.value.users.findIndex((item) => item.id === user.id)
      if (index >= 0) userManagement.value.users[index] = response.data.user
    }
    accountNotice.value =
      nextStatus === 'disabled'
        ? `${user.primaryAddress} 已禁用，${response.data.revokedSessions} 个会话已退出。`
        : `${user.primaryAddress} 已重新启用。`
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '用户状态修改失败'
  } finally {
    userActionId.value = null
  }
}

async function submitDomainCreation() {
  clearFieldErrors(domainErrors)
  authError.value = ''
  accountNotice.value = ''

  if (!domainForm.domainName.trim()) {
    domainErrors.domainName = '请输入邮件域名'
    return
  }

  domainCreateSubmitting.value = true
  try {
    const response = await createMailDomain(domainForm.domainName)
    if (domainManagement.value) domainManagement.value.domains.push(response.data.domain)
    domainForm.domainName = ''
    accountNotice.value = `${response.data.domain.canonicalName} 已添加。`
    await Promise.all([refreshUserManagement(), refreshPersonalAddressManagement()])
  } catch (error) {
    if (error instanceof ApiRequestError && error.field === 'domainName') {
      domainErrors.domainName = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '邮件域名添加失败'
    }
  } finally {
    domainCreateSubmitting.value = false
  }
}

async function toggleMailDomainStatus(domain: ManagedMailDomain) {
  const nextStatus = domain.status === 'active' ? 'paused' : 'active'
  domainActionId.value = `status:${domain.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await changeMailDomainStatus(domain.id, nextStatus)
    replaceManagedDomain(response.data.domain)
    accountNotice.value =
      nextStatus === 'paused'
        ? `${domain.canonicalName} 已暂停收信和新地址分配。`
        : `${domain.canonicalName} 已恢复使用。`
    await Promise.all([refreshUserManagement(), refreshPersonalAddressManagement()])
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '域名状态修改失败'
  } finally {
    domainActionId.value = null
  }
}

function requestMailDomainDeletion(domain: ManagedMailDomain) {
  domainPendingDeletion.value = domain
  domainDeletionConfirmed.value = false
  authError.value = ''
}

function cancelMailDomainDeletion() {
  domainPendingDeletion.value = null
  domainDeletionConfirmed.value = false
}

async function confirmMailDomainDeletion() {
  const domain = domainPendingDeletion.value
  if (!domain || !domainDeletionConfirmed.value) return

  domainActionId.value = `delete:${domain.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await deleteMailDomain(domain.id)
    if (domainManagement.value) {
      domainManagement.value.domains = domainManagement.value.domains.filter(
        (item) => item.id !== response.data.deletedDomainId,
      )
    }
    cancelMailDomainDeletion()
    accountNotice.value = `${response.data.canonicalName} 已永久删除。`
    await Promise.all([refreshUserManagement(), refreshPersonalAddressManagement()])
  } catch (error) {
    if (isAuthenticationRequired(error)) {
      clearAuthentication()
      return
    }
    authError.value = error instanceof Error ? error.message : '邮件域名删除失败'
  } finally {
    domainActionId.value = null
  }
}

function replaceManagedDomain(domain: ManagedMailDomain) {
  if (!domainManagement.value) return
  const index = domainManagement.value.domains.findIndex((item) => item.id === domain.id)
  if (index >= 0) domainManagement.value.domains[index] = domain
}

async function submitPersonalAliasCreation() {
  clearFieldErrors(personalAliasErrors)
  authError.value = ''
  accountNotice.value = ''
  if (!personalAliasForm.localPart.trim()) personalAliasErrors.localPart = '请输入邮箱前缀'
  if (!personalAliasForm.domainId) personalAliasErrors.domainId = '请选择邮件域名'
  if (Object.keys(personalAliasErrors).length > 0) return

  personalAddressActionId.value = 'create:self'
  try {
    const response = await createPersonalAlias(personalAliasForm)
    personalAliasForm.localPart = ''
    accountNotice.value = `${response.data.address.address} 已创建。`
    await Promise.all([
      refreshPersonalAddressManagement(),
      authentication.value?.user.role === 'administrator'
        ? refreshAdministratorAliasPolicies()
        : Promise.resolve(),
    ])
  } catch (error) {
    handlePersonalAliasError(error, personalAliasErrors, '个人别名创建失败')
  } finally {
    personalAddressActionId.value = null
  }
}

async function savePersonalAddressPreference(address: PersonalAddressSummary) {
  const draft = addressPreferenceDrafts[address.id]
  if (!draft) return
  personalAddressActionId.value = `preference:${address.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await updatePersonalAddressPreference(address.id, {
      customLabel: draft.customLabel.trim() || null,
      isPinned: draft.isPinned,
    })
    replacePersonalAddress(response.data.address)
    syncAddressPreferenceDrafts(personalAddressOverview.value?.addresses ?? [])
    accountNotice.value = `${response.data.address.address} 的显示设置已保存。`
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '地址设置保存失败'
  } finally {
    personalAddressActionId.value = null
  }
}

async function changePersonalAddressOrder(
  address: PersonalAddressSummary,
  direction: 'up' | 'down',
) {
  personalAddressActionId.value = `move:${address.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await movePersonalAddress(address.id, direction)
    if (personalAddressOverview.value) {
      personalAddressOverview.value.addresses = response.data.addresses
      syncAddressPreferenceDrafts(response.data.addresses)
    }
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '地址顺序修改失败'
  } finally {
    personalAddressActionId.value = null
  }
}

async function changeDefaultSender(address: PersonalAddressSummary) {
  personalAddressActionId.value = `default:${address.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await setDefaultSender(address.id)
    if (personalAddressOverview.value)
      personalAddressOverview.value.addresses = response.data.addresses
    accountNotice.value = `${address.address} 已设为默认发件地址。`
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '默认发件地址修改失败'
  } finally {
    personalAddressActionId.value = null
  }
}

function requestPersonalAliasDeletion(address: PersonalAddressSummary) {
  if (!authentication.value || address.role !== 'alias') return
  aliasPendingDeletion.value = {
    address,
    targetUserId: authentication.value.user.id,
    targetDisplayName: authentication.value.user.displayName,
    administratorAction: false,
  }
  aliasDeletionConfirmed.value = false
}

function requestAdministratorAliasDeletion(
  user: AdministratorAliasPolicyUser,
  address: PersonalAddressSummary,
) {
  aliasPendingDeletion.value = {
    address,
    targetUserId: user.id,
    targetDisplayName: user.displayName,
    administratorAction: true,
  }
  aliasDeletionConfirmed.value = false
}

function cancelAliasDeletion() {
  aliasPendingDeletion.value = null
  aliasDeletionConfirmed.value = false
}

async function confirmAliasDeletion() {
  const pending = aliasPendingDeletion.value
  if (!pending || !aliasDeletionConfirmed.value) return
  personalAddressActionId.value = `delete:${pending.address.id}`
  aliasPolicyActionId.value = `delete:${pending.address.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = pending.administratorAction
      ? await deleteAssignedPersonalAlias(pending.targetUserId, pending.address.id)
      : await deletePersonalAlias(pending.address.id)
    cancelAliasDeletion()
    accountNotice.value = response.data.releasedImmediately
      ? `${response.data.canonicalAddress} 已删除，地址已立即释放。`
      : `${response.data.canonicalAddress} 已删除，将保留到 ${formatDate(response.data.releaseAt ?? '')}。`
    await Promise.all([
      refreshPersonalAddressManagement(),
      authentication.value?.user.role === 'administrator'
        ? refreshAdministratorAliasPolicies()
        : Promise.resolve(),
    ])
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '个人别名删除失败'
  } finally {
    personalAddressActionId.value = null
    aliasPolicyActionId.value = null
  }
}

async function saveAddressPolicy() {
  if (!addressPolicy.value) return
  clearFieldErrors(addressPolicyErrors)
  authError.value = ''
  accountNotice.value = ''
  addressPolicySubmitting.value = true
  try {
    const response = await updateAddressPolicy({
      minimumLocalPartLength: addressPolicyDraft.minimumLocalPartLength,
      aliasRetentionDays: addressPolicyDraft.aliasRetentionDays,
      blockedSubstrings: splitAddressPolicyTerms(addressPolicyDraft.blockedSubstrings),
      reservedNames: splitAddressPolicyTerms(addressPolicyDraft.reservedNames),
      expectedVersion: addressPolicy.value.policyVersion,
    })
    addressPolicy.value = response.data.policy
    syncAddressPolicyDraft(response.data.policy)
    if (personalAddressOverview.value) {
      personalAddressOverview.value.aliasRetentionDays = response.data.policy.aliasRetentionDays
    }
    accountNotice.value = '地址规则与个人别名保留期已保存。'
  } catch (error) {
    if (error instanceof ApiRequestError && isAddressPolicyField(error.field)) {
      addressPolicyErrors[error.field] = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '地址策略保存失败'
    }
  } finally {
    addressPolicySubmitting.value = false
  }
}

function syncAddressPolicyDraft(policy: AddressPolicySummary) {
  addressPolicyDraft.minimumLocalPartLength = policy.minimumLocalPartLength
  addressPolicyDraft.aliasRetentionDays = policy.aliasRetentionDays
  addressPolicyDraft.blockedSubstrings = policy.blockedSubstrings.join('\n')
  addressPolicyDraft.reservedNames = policy.reservedNames.join('\n')
}

function splitAddressPolicyTerms(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isAddressPolicyField(field: string | undefined): field is AddressPolicyField {
  return (
    field === 'minimumLocalPartLength' ||
    field === 'aliasRetentionDays' ||
    field === 'blockedSubstrings' ||
    field === 'reservedNames' ||
    field === 'expectedVersion'
  )
}

function currentAliasRetentionDays(): number {
  return (
    addressPolicy.value?.aliasRetentionDays ??
    personalAddressOverview.value?.aliasRetentionDays ??
    0
  )
}

function aliasDeletionImpactText(): string {
  const days = currentAliasRetentionDays()
  return days === 0
    ? '地址会立即释放，之后任何用户都可能重新创建它。'
    : `地址会保留 ${days} 天，保留期结束前不能被重新创建。`
}

function aliasDeletionConfirmationText(): string {
  const days = currentAliasRetentionDays()
  return days === 0 ? '我确认删除并立即释放这个个人别名' : `我确认删除并保留这个地址 ${days} 天`
}

async function saveAliasPolicy(user: AdministratorAliasPolicyUser) {
  const draft = aliasPolicyDrafts[user.id]
  if (!draft) return
  aliasPolicyActionId.value = `policy:${user.id}`
  authError.value = ''
  accountNotice.value = ''
  try {
    const response = await updateAdministratorAliasPolicy(user.id, draft)
    replaceAdministratorAliasPolicyUser(response.data.user)
    syncAliasPolicyDrafts(administratorAliasPolicies.value?.users ?? [])
    accountNotice.value = `${user.primaryAddress} 的个人别名策略已保存。`
    if (user.id === authentication.value?.user.id) await refreshPersonalAddressManagement()
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '个人别名策略保存失败'
  } finally {
    aliasPolicyActionId.value = null
  }
}

async function submitAdministratorAliasAssignment() {
  clearFieldErrors(administratorAliasErrors)
  authError.value = ''
  accountNotice.value = ''
  if (!administratorAliasForm.userId) administratorAliasErrors.userId = '请选择用户'
  if (!administratorAliasForm.localPart.trim()) {
    administratorAliasErrors.localPart = '请输入邮箱前缀'
  }
  if (!administratorAliasForm.domainId) administratorAliasErrors.domainId = '请选择邮件域名'
  if (Object.keys(administratorAliasErrors).length > 0) return

  aliasPolicyActionId.value = 'assign'
  try {
    const response = await assignPersonalAlias(administratorAliasForm.userId, {
      localPart: administratorAliasForm.localPart,
      domainId: administratorAliasForm.domainId,
    })
    administratorAliasForm.localPart = ''
    accountNotice.value = `${response.data.address.address} 已分配。`
    await Promise.all([
      refreshAdministratorAliasPolicies(),
      administratorAliasForm.userId === authentication.value?.user.id
        ? refreshPersonalAddressManagement()
        : Promise.resolve(),
    ])
  } catch (error) {
    handlePersonalAliasError(error, administratorAliasErrors, '个人别名分配失败')
  } finally {
    aliasPolicyActionId.value = null
  }
}

function replacePersonalAddress(address: PersonalAddressSummary) {
  if (!personalAddressOverview.value) return
  const index = personalAddressOverview.value.addresses.findIndex((item) => item.id === address.id)
  if (index >= 0) personalAddressOverview.value.addresses[index] = address
  personalAddressOverview.value.addresses.sort(comparePersonalAddresses)
}

function replaceAdministratorAliasPolicyUser(user: AdministratorAliasPolicyUser) {
  if (!administratorAliasPolicies.value) return
  const index = administratorAliasPolicies.value.users.findIndex((item) => item.id === user.id)
  if (index >= 0) administratorAliasPolicies.value.users[index] = user
}

function syncAddressPreferenceDrafts(addresses: PersonalAddressSummary[]) {
  const currentIds = new Set(addresses.map((address) => address.id))
  for (const id of Object.keys(addressPreferenceDrafts)) {
    if (!currentIds.has(id)) delete addressPreferenceDrafts[id]
  }
  for (const address of addresses) {
    addressPreferenceDrafts[address.id] = {
      customLabel: address.customLabel ?? '',
      isPinned: address.isPinned,
    }
  }
}

function addressPreferenceDraft(address: PersonalAddressSummary): AddressPreferenceDraft {
  return (addressPreferenceDrafts[address.id] ??= {
    customLabel: address.customLabel ?? '',
    isPinned: address.isPinned,
  })
}

function syncAliasPolicyDrafts(users: AdministratorAliasPolicyUser[]) {
  const currentIds = new Set(users.map((user) => user.id))
  for (const id of Object.keys(aliasPolicyDrafts)) {
    if (!currentIds.has(id)) delete aliasPolicyDrafts[id]
  }
  for (const user of users) {
    aliasPolicyDrafts[user.id] = {
      aliasLimit: user.policy.aliasLimit,
      selfCreationEnabled: user.policy.selfCreationEnabled,
    }
  }
}

function syncOrganizationPolicyDrafts(users: AdministratorOrganizationPolicyUser[]) {
  const userIds = new Set(users.map((user) => user.userId))
  for (const id of Object.keys(organizationPolicyDrafts)) {
    if (!userIds.has(id)) delete organizationPolicyDrafts[id]
  }
  for (const user of users) {
    organizationPolicyDrafts[user.userId] = {
      organizationLimit: user.policy.organizationLimit,
    }
  }
}

function organizationPolicyDraft(
  user: AdministratorOrganizationPolicyUser,
): OrganizationPolicyDraft {
  return (organizationPolicyDrafts[user.userId] ??= {
    organizationLimit: user.policy.organizationLimit,
  })
}

function organizationActionImpactText(): string {
  const pending = pendingOrganizationAction.value
  if (!pending) return ''
  const organization = pending.organization
  if (pending.kind === 'delete') {
    return `删除后 ${organization.sharedAddress} 立即停用，成员无法继续访问。创建者可在 7 天内恢复。`
  }
  if (organization.isCreator && organization.memberCount > 1) {
    return '你必须选择一名当前成员继承创建者身份；交接后你将立即失去访问权。'
  }
  if (organization.isCreator) {
    return '组织只剩你一人，退出等同删除；组织地址将立即停用，7 天内可恢复。'
  }
  return '退出后你将立即失去组织邮件的访问权，已有历史操作保留必要署名。'
}

function handleOrganizationFormError(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError && isOrganizationField(error.field)) {
    organizationErrors[error.field] = error.message
    return
  }
  authError.value = error instanceof Error ? error.message : fallback
}

function aliasPolicyDraft(user: AdministratorAliasPolicyUser): AliasPolicyDraft {
  return (aliasPolicyDrafts[user.id] ??= {
    aliasLimit: user.policy.aliasLimit,
    selfCreationEnabled: user.policy.selfCreationEnabled,
  })
}

function canMovePersonalAddress(
  address: PersonalAddressSummary,
  direction: 'up' | 'down',
): boolean {
  const peers = (personalAddressOverview.value?.addresses ?? []).filter(
    (item) => item.isPinned === address.isPinned,
  )
  const index = peers.findIndex((item) => item.id === address.id)
  return direction === 'up' ? index > 0 : index >= 0 && index < peers.length - 1
}

function comparePersonalAddresses(left: PersonalAddressSummary, right: PersonalAddressSummary) {
  if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1
  return left.sortOrder - right.sortOrder || left.address.localeCompare(right.address)
}

function handlePersonalAliasError(
  error: unknown,
  errors: Partial<Record<PersonalAliasField | 'userId', string>>,
  fallback: string,
) {
  if (
    error instanceof ApiRequestError &&
    (error.field === 'localPart' || error.field === 'domainId')
  ) {
    errors[error.field] = error.message
    return
  }
  authError.value = error instanceof Error ? error.message : fallback
}

async function copyTemporaryPassword() {
  if (!temporaryPasswordResult.value) return
  try {
    await navigator.clipboard.writeText(temporaryPasswordResult.value.temporaryPassword)
    temporaryPasswordNotice.value = '临时密码已复制。'
  } catch {
    temporaryPasswordNotice.value = '浏览器未允许复制，请手动选择临时密码。'
  }
}

async function submitAdministratorTransfer() {
  clearFieldErrors(accountDeletionErrors)
  accountLifecycleError.value = ''
  accountLifecycleNotice.value = ''
  if (!accountDeletionForm.successorUserId) {
    accountDeletionErrors.successorUserId = '请选择新的系统管理员'
    return
  }

  accountLifecycleSubmitting.value = true
  try {
    await transferAdministrator(accountDeletionForm.successorUserId)
    const session = await fetchCurrentSession()
    authentication.value = session.data
    accountLifecycleNotice.value = '系统管理员身份已转让。你现在可以继续申请注销账号。'
    await refreshAccountData()
  } catch (error) {
    handleAccountLifecycleFormError(error)
  } finally {
    accountLifecycleSubmitting.value = false
  }
}

async function submitAccountDeletion() {
  clearFieldErrors(accountDeletionErrors)
  accountLifecycleError.value = ''
  accountLifecycleNotice.value = ''
  if (!accountDeletionForm.currentPassword) {
    accountDeletionErrors.currentPassword = '请输入当前密码'
  }
  if (!accountDeletionForm.confirmed) {
    accountDeletionErrors.confirmation = '请确认你已经了解注销影响'
  }
  if (Object.keys(accountDeletionErrors).length > 0) return

  accountLifecycleSubmitting.value = true
  try {
    const response = await submitAccountDeletionRequest({
      currentPassword: accountDeletionForm.currentPassword,
      confirmation: 'DELETE_MY_ACCOUNT',
    })
    const primaryAddress = authentication.value?.user.primaryAddress ?? ''
    clearAuthentication()
    accountRecoveryMode.value = true
    accountRecoverySession.value = null
    accountRecoveryForm.email = primaryAddress
    accountRecoveryForm.password = ''
    authNotice.value = `注销申请已提交。账号将在 ${formatDate(response.data.deletionDueAt)} 永久删除；在此之前可以取消。`
  } catch (error) {
    handleAccountLifecycleFormError(error)
  } finally {
    accountLifecycleSubmitting.value = false
  }
}

function openAccountRecovery() {
  recoveryMode.value = false
  accountRecoveryMode.value = true
  accountRecoverySession.value = null
  accountRecoveryForm.email = loginForm.email
  accountRecoveryForm.password = ''
  clearFieldErrors(accountRecoveryErrors)
  authError.value = ''
}

function closeAccountRecovery() {
  accountRecoveryMode.value = false
  accountRecoverySession.value = null
  clearAccountRecoveryForm()
  authError.value = ''
}

async function submitAccountRecoveryLogin() {
  clearFieldErrors(accountRecoveryErrors)
  authError.value = ''
  if (!accountRecoveryForm.email.trim()) accountRecoveryErrors.email = '请输入主邮箱地址'
  if (!accountRecoveryForm.password) accountRecoveryErrors.password = '请输入密码'
  if (Object.keys(accountRecoveryErrors).length > 0) return

  accountRecoverySubmitting.value = true
  try {
    const response = await loginAccountRecovery({
      email: accountRecoveryForm.email,
      password: accountRecoveryForm.password,
    })
    accountRecoverySession.value = response.data.session
    accountRecoveryForm.email = response.data.session.primaryAddress
    accountRecoveryForm.password = ''
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.field === 'email' || error.field === 'password')
    ) {
      accountRecoveryErrors[error.field] = error.message
    } else {
      authError.value = error instanceof Error ? error.message : '无法进入账号恢复流程'
    }
  } finally {
    accountRecoverySubmitting.value = false
  }
}

async function cancelAccountDeletionFromRecovery() {
  accountRecoverySubmitting.value = true
  authError.value = ''
  try {
    const primaryAddress = accountRecoverySession.value?.primaryAddress ?? accountRecoveryForm.email
    await cancelPendingAccountDeletion()
    closeAccountRecovery()
    loginForm.email = primaryAddress
    authNotice.value = '账号注销已取消。请使用原密码重新登录。'
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '取消账号注销失败'
  } finally {
    accountRecoverySubmitting.value = false
  }
}

function handleAccountLifecycleFormError(error: unknown) {
  if (error instanceof ApiRequestError) {
    if (
      error.field === 'currentPassword' ||
      error.field === 'confirmation' ||
      error.field === 'successorUserId'
    ) {
      accountDeletionErrors[error.field] = error.message
      return
    }
    accountLifecycleError.value = error.message
    return
  }
  accountLifecycleError.value = error instanceof Error ? error.message : '账号操作失败'
}

function openRecovery() {
  clearLoginErrors()
  accountRecoveryMode.value = false
  recoveryMode.value = true
  recoveryStep.value = 1
  recoverySubject.value = null
  clearRecoveryForm()
}

function closeRecovery() {
  recoveryMode.value = false
  recoveryStep.value = 1
  recoverySubject.value = null
  clearRecoveryForm()
  authError.value = ''
}

function returnToRecoveryAuthorization() {
  recoveryStep.value = 1
  recoverySubject.value = null
  recoveryForm.newPassword = ''
  recoveryForm.confirmPassword = ''
  recoveryForm.showPassword = false
  clearFieldErrors(recoveryErrors)
  authError.value = ''
}

async function authorizeRecovery() {
  clearFieldErrors(recoveryErrors)
  authError.value = ''
  if (!recoveryForm.initKey) {
    recoveryErrors.initKey = '请输入部署配置中的初始化密钥'
    return
  }

  recoverySubmitting.value = true
  try {
    const response = await authorizeAdministratorRecovery(recoveryForm.initKey)
    recoverySubject.value = response.data.administrator
    recoveryStep.value = 2
  } catch (error) {
    if (error instanceof ApiRequestError) {
      recoveryErrors.initKey = error.retryAfterSeconds
        ? `${error.message}，请在 ${error.retryAfterSeconds} 秒后重试`
        : error.message
    } else {
      authError.value = error instanceof Error ? error.message : '无法进入管理员恢复流程'
    }
  } finally {
    recoverySubmitting.value = false
  }
}

async function completeRecovery() {
  clearFieldErrors(recoveryErrors)
  authError.value = ''
  validateNewPasswordPair(recoveryForm, recoveryErrors)
  if (Object.keys(recoveryErrors).length > 0) return

  recoverySubmitting.value = true
  try {
    const response = await completeAdministratorRecovery(
      recoveryForm.initKey,
      recoveryForm.newPassword,
    )
    loginForm.email = response.data.administrator.primaryAddress
    closeRecovery()
    authNotice.value = '管理员密码已恢复，原有会话均已退出。请使用新密码登录。'
  } catch (error) {
    if (error instanceof ApiRequestError && error.field === 'newPassword') {
      recoveryErrors.newPassword = error.message
    } else if (error instanceof ApiRequestError) {
      recoveryErrors.initKey = error.retryAfterSeconds
        ? `${error.message}，请在 ${error.retryAfterSeconds} 秒后重试`
        : error.message
      recoveryStep.value = 1
    } else {
      authError.value = error instanceof Error ? error.message : '管理员密码恢复失败'
    }
  } finally {
    recoverySubmitting.value = false
  }
}

async function verifyInitializationKey() {
  clearErrors()
  if (!form.initKey) {
    fieldErrors.initKey = '请输入部署时设置的初始化密钥'
    return
  }

  submitting.value = true
  try {
    await authorizeInitialization(form.initKey)
    step.value = 2
  } catch (error) {
    handleApiError(error, 'initKey')
  } finally {
    submitting.value = false
  }
}

function reviewDetails() {
  clearErrors()

  if (!form.adminDisplayName.trim()) {
    fieldErrors.adminDisplayName = '请输入管理员显示名称'
  }
  if (!form.localPart.trim()) {
    fieldErrors.localPart = '请输入邮箱前缀'
  }
  if (!form.domainName.trim()) {
    fieldErrors.domainName = '请输入邮件域名'
  }
  if ([...form.password].length < 15) {
    fieldErrors.password = '密码至少需要 15 个字符'
  }
  if (form.password !== form.confirmPassword) {
    fieldErrors.confirmPassword = '两次输入的密码不一致'
  }
  if (!form.timezone.trim()) {
    fieldErrors.timezone = '请输入时区'
  }

  if (Object.keys(fieldErrors).length === 0) {
    step.value = 3
  }
}

async function finishInitialization() {
  clearErrors()
  submitting.value = true

  try {
    result.value = await completeInitialization(form.initKey, {
      adminDisplayName: form.adminDisplayName,
      domainName: form.domainName,
      localPart: form.localPart,
      password: form.password,
      timezone: form.timezone,
    })
    clearSensitiveFields()
  } catch (error) {
    if (error instanceof ApiRequestError && error.field) {
      fieldErrors[error.field as FormField] = error.message
      step.value = 2
    } else if (error instanceof ApiRequestError && error.code === 'already_initialized') {
      clearSensitiveFields()
      await loadStatus()
    } else {
      handleApiError(error)
    }
  } finally {
    submitting.value = false
  }
}

async function continueToLogin() {
  if (!result.value) return
  loginForm.email = result.value.data.administrator.primaryAddress
  result.value = null
  await loadStatus()
}

function handleLoginError(error: unknown) {
  if (error instanceof ApiRequestError) {
    const field = error.field as LoginField | undefined
    if (field === 'email' || field === 'password') {
      loginErrors[field] = error.message
      return
    }

    authError.value = error.retryAfterSeconds
      ? `${error.message}，请在 ${error.retryAfterSeconds} 秒后重试`
      : error.message
    return
  }

  authError.value = error instanceof Error ? error.message : '登录未完成，请稍后重试'
}

function handlePasswordFormError(
  error: unknown,
  errors: {
    currentPassword?: string
    newPassword?: string
    confirmPassword?: string
  },
) {
  if (error instanceof ApiRequestError) {
    if (error.field === 'currentPassword' || error.field === 'newPassword') {
      errors[error.field] = error.message
      return
    }
    authError.value = error.retryAfterSeconds
      ? `${error.message}，请在 ${error.retryAfterSeconds} 秒后重试`
      : error.message
    return
  }
  authError.value = error instanceof Error ? error.message : '密码修改失败'
}

function validateNewPasswordPair(
  input: { newPassword: string; confirmPassword: string },
  errors: { newPassword?: string; confirmPassword?: string },
) {
  if ([...input.newPassword].length < 15) {
    errors.newPassword = '新密码至少需要 15 个字符'
  }
  if (input.newPassword !== input.confirmPassword) {
    errors.confirmPassword = '两次输入的新密码不一致'
  }
}

function updateAuthenticatedUser(user: AuthenticationResponse['data']['user']) {
  if (!authentication.value) return
  authentication.value = {
    ...authentication.value,
    user,
  }
}

function handleApiError(error: unknown, defaultField?: FormField) {
  if (error instanceof ApiRequestError) {
    const targetField = (error.field as FormField | undefined) ?? defaultField
    if (targetField) {
      fieldErrors[targetField] = error.message
      return
    }
    pageError.value = error.message
    return
  }

  pageError.value = error instanceof Error ? error.message : '操作未完成，请稍后重试'
}

function clearErrors() {
  pageError.value = ''
  for (const field of Object.keys(fieldErrors) as FormField[]) {
    delete fieldErrors[field]
  }
}

function clearLoginErrors() {
  authError.value = ''
  authNotice.value = ''
  for (const field of Object.keys(loginErrors) as LoginField[]) {
    delete loginErrors[field]
  }
}

function clearFieldErrors(errors: object) {
  for (const key of Object.keys(errors)) {
    delete (errors as Record<string, unknown>)[key]
  }
}

function clearAuthentication() {
  authentication.value = null
  mailAutoRefreshScheduler.stop()
  cancelDraftSaveTimer()
  cancelSendStatusTimer()
  draftWorkspace.value = null
  draftListStatus.value = 'active'
  draftLoading.value = false
  draftAction.value = null
  draftError.value = ''
  draftNotice.value = ''
  selectedDraft.value = null
  draftEditVersion += 1
  draftSaveState.value = 'clean'
  lastSendOperation.value = null
  draftSendRequest.value = null
  draftForm.senderAddressId = null
  draftForm.to = ''
  draftForm.cc = ''
  draftForm.bcc = ''
  draftForm.subject = ''
  draftForm.bodyFormat = 'rich_text'
  draftForm.body = ''
  draftForm.attachmentIds = []
  workspaceView.value = 'mailbox'
  settingsSection.value = 'account-security'
  mobileNavigationOpen.value = false
  accountMenuOpen.value = false
  mailboxMoreOpen.value = false
  mailboxSelectionMode.value = false
  messageActionsOpen.value = false
  draftCopiesOpen.value = false
  draftActionsOpen.value = false
  mailboxMode.value = 'assigned'
  mailboxView.value = 'inbox'
  mailboxScope.value = 'all'
  mailboxOrganizationId.value = ''
  mailboxItems.value = []
  mailboxOrganizations.value = []
  mailboxNextCursor.value = null
  mailboxLoading.value = false
  mailboxLoadingMore.value = false
  mailboxError.value = ''
  mailboxNotice.value = ''
  selectedMailboxEntryIds.value = new Set()
  mailboxBulkAction.value = null
  selectedMessage.value = null
  selectedConversationEntries.value = []
  selectedMessageLoading.value = false
  selectedMessageAction.value = null
  pendingMailboxPermanentDeletion.value = null
  mailboxPermanentDeletionConfirmed.value = false
  mailboxSearchOpen.value = false
  Object.assign(mailboxSearchDraft, createDefaultMailboxSearchDraft())
  mailboxSearchApplied.value = createDefaultMailboxSearchFilters()
  mailboxSearchIndex.value = null
  selectedMessageBodyMode.value = 'html'
  previewAttachmentId.value = null
  unallocatedMailItems.value = []
  unallocatedMailNextCursor.value = null
  unallocatedMailQuery.value = ''
  unallocatedMailAppliedQuery.value = ''
  unallocatedMailLoading.value = false
  unallocatedMailLoadingMore.value = false
  selectedUnallocatedMessage.value = null
  selectedUnallocatedMessageLoading.value = false
  unallocatedMailAction.value = null
  cancelUnallocatedClaim()
  sessions.value = []
  userManagement.value = null
  accountRegistrationInvitations.value = null
  accountRegistrationInvitationLoading.value = false
  accountRegistrationInvitationAction.value = null
  accountRegistrationInvitationDomainId.value = ''
  accountRegistrationInvitationError.value = ''
  accountRegistrationInvitationNotice.value = ''
  sessionLoading.value = false
  sessionActionId.value = null
  userManagementLoading.value = false
  userCreateSubmitting.value = false
  userActionId.value = null
  domainManagement.value = null
  domainManagementLoading.value = false
  domainCreateSubmitting.value = false
  domainActionId.value = null
  domainForm.domainName = ''
  cancelMailDomainDeletion()
  inboundControl.value = null
  inboundControlLoading.value = false
  inboundControlAction.value = null
  inboundControlError.value = ''
  inboundControlNotice.value = ''
  inboundRejectionRuleForm.ruleType = 'sender_address'
  inboundRejectionRuleForm.matchValue = ''
  personalAddressOverview.value = null
  personalAddressLoading.value = false
  personalAddressActionId.value = null
  personalAliasForm.localPart = ''
  personalAliasForm.domainId = ''
  clearFieldErrors(personalAliasErrors)
  for (const id of Object.keys(addressPreferenceDrafts)) delete addressPreferenceDrafts[id]
  administratorAliasPolicies.value = null
  aliasPolicyLoading.value = false
  aliasPolicyActionId.value = null
  administratorAliasForm.userId = ''
  administratorAliasForm.localPart = ''
  administratorAliasForm.domainId = ''
  clearFieldErrors(administratorAliasErrors)
  for (const id of Object.keys(aliasPolicyDrafts)) delete aliasPolicyDrafts[id]
  addressPolicy.value = null
  addressPolicyLoading.value = false
  addressPolicySubmitting.value = false
  syncAddressPolicyDraft({
    minimumLocalPartLength: 1,
    aliasRetentionDays: 0,
    blockedSubstrings: [],
    reservedNames: [],
    policyVersion: 1,
    updatedAt: new Date(0).toISOString(),
  })
  clearFieldErrors(addressPolicyErrors)
  cancelAliasDeletion()
  organizationOverview.value = null
  organizationLoading.value = false
  organizationActionId.value = null
  organizationForm.name = ''
  organizationForm.localPart = ''
  organizationForm.domainId = ''
  organizationInvitationPolicyDraft.value = 'manual'
  clearFieldErrors(organizationErrors)
  for (const id of Object.keys(organizationInvitationInputs)) {
    delete organizationInvitationInputs[id]
  }
  pendingOrganizationAction.value = null
  administratorOrganizationPolicies.value = null
  organizationPolicyLoading.value = false
  organizationPolicyActionId.value = null
  for (const id of Object.keys(organizationPolicyDrafts)) delete organizationPolicyDrafts[id]
  outboundManagement.value = null
  outboundLoading.value = false
  outboundAction.value = null
  outboundError.value = ''
  outboundNotice.value = ''
  resetOutboundProviderForm()
  outboundDailyDefaultDraft.value = 500
  outboundDomainMonthlyDefaultDraft.value = ''
  for (const id of Object.keys(outboundRouteDrafts)) delete outboundRouteDrafts[id]
  for (const id of Object.keys(outboundUserQuotaDrafts)) delete outboundUserQuotaDrafts[id]
  for (const id of Object.keys(outboundDomainQuotaDrafts)) delete outboundDomainQuotaDrafts[id]
  platformResourceOverview.value = null
  platformResourceLoading.value = false
  platformResourceAction.value = null
  platformResourceError.value = ''
  platformResourceNotice.value = ''
  Object.assign(platformResourceConfigurationForm, {
    accountId: '',
    d1DatabaseId: '',
    storageResourceReference: '',
    apiToken: '',
  })
  platformResourceThresholdDrafts.d1 = { warningPercent: 80, stopPercent: 95 }
  platformResourceThresholdDrafts.kv = { warningPercent: 80, stopPercent: 95 }
  platformResourceThresholdDrafts.r2 = { warningPercent: 80, stopPercent: 95 }
  operationsHealth.value = null
  operationsHealthLoading.value = false
  operationsHealthError.value = ''
  notificationOverview.value = null
  notificationLoading.value = false
  notificationAction.value = null
  notificationError.value = ''
  notificationNotice.value = ''
  notificationForm.displayName = ''
  notificationForm.channelType = 'ntfy'
  notificationForm.baseUrl = 'https://ntfy.sh'
  notificationForm.destination = ''
  notificationForm.credential = ''
  notificationForm.allPersonal = true
  notificationForm.addressIds = []
  forwardingOverview.value = null
  forwardingLoading.value = false
  forwardingAction.value = null
  forwardingError.value = ''
  forwardingNotice.value = ''
  forwardingTargetEmail.value = ''
  for (const id of Object.keys(forwardingVerificationCodes)) {
    delete forwardingVerificationCodes[id]
  }
  forwardingRuleForm.ruleId = null
  forwardingRuleForm.targetId = ''
  forwardingRuleForm.scope = 'all_personal'
  forwardingRuleForm.addressIds = []
  forwardingRuleForm.enabled = true
  accountNotice.value = ''
  accountLifecycle.value = null
  accountLifecycleLoading.value = false
  accountLifecycleSubmitting.value = false
  accountLifecycleNotice.value = ''
  accountLifecycleError.value = ''
  clearAccountDeletionForm()
  temporaryPasswordResult.value = null
  temporaryPasswordNotice.value = ''
  temporaryPasswordHeading.value = ''
  userForm.displayName = ''
  userForm.localPart = ''
  userForm.domainId = ''
  clearFieldErrors(userErrors)
  clearFieldErrors(domainErrors)
  clearPasswordForms()
  accountRegistrationMode.value = false
  accountRegistrationDomain.value = null
  accountRegistrationForm.code = ''
  accountRegistrationForm.displayName = ''
  accountRegistrationForm.localPart = ''
  accountRegistrationForm.password = ''
  accountRegistrationForm.confirmPassword = ''
  clearFieldErrors(accountRegistrationErrors)
}

function clearSensitiveFields() {
  form.initKey = ''
  form.password = ''
  form.confirmPassword = ''
  accountRegistrationForm.password = ''
  accountRegistrationForm.confirmPassword = ''
  notificationForm.credential = ''
}

function clearPasswordForms() {
  passwordForm.currentPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  passwordForm.showPassword = false
  requiredPasswordForm.newPassword = ''
  requiredPasswordForm.confirmPassword = ''
  requiredPasswordForm.showPassword = false
  clearFieldErrors(passwordErrors)
  clearFieldErrors(requiredPasswordErrors)
}

function clearRecoveryForm() {
  recoveryForm.initKey = ''
  recoveryForm.newPassword = ''
  recoveryForm.confirmPassword = ''
  recoveryForm.showPassword = false
  clearFieldErrors(recoveryErrors)
}

function clearAccountRecoveryForm() {
  accountRecoveryForm.email = ''
  accountRecoveryForm.password = ''
  accountRecoveryForm.showPassword = false
  clearFieldErrors(accountRecoveryErrors)
}

function clearAccountDeletionForm() {
  accountDeletionForm.successorUserId = ''
  accountDeletionForm.currentPassword = ''
  accountDeletionForm.confirmed = false
  accountDeletionForm.showPassword = false
  clearFieldErrors(accountDeletionErrors)
}

function isAuthenticationRequired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401
}

function isManagedUserField(field: string | undefined): field is ManagedUserField {
  return (
    field === 'displayName' || field === 'localPart' || field === 'domainId' || field === 'timezone'
  )
}

function isAccountRegistrationField(field: string | undefined): field is AccountRegistrationField {
  return (
    field === 'code' ||
    field === 'displayName' ||
    field === 'localPart' ||
    field === 'password' ||
    field === 'timezone'
  )
}

function isOrganizationField(field: string | undefined): field is OrganizationField {
  return (
    field === 'name' ||
    field === 'localPart' ||
    field === 'domainId' ||
    field === 'primaryAddress' ||
    field === 'successorUserId'
  )
}

function userStatusLabel(status: ManagedUserSummary['status']): string {
  return status === 'active' ? '正常' : '已禁用'
}

function accountRegistrationInvitationStatusLabel(
  status: AccountRegistrationInvitationSummary['status'],
): string {
  return status === 'available' ? '可使用' : status === 'used' ? '已使用' : '已撤销'
}

function domainStatusLabel(status: ManagedMailDomain['status']): string {
  return status === 'active' ? '正常' : '已暂停'
}

function formatDate(value: string | number): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return String(value)

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: authentication.value?.user.timezone ?? undefined,
  }).format(date)
}

function formatFileSize(value: number): string {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} KB`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`
}

function formatStorageSize(value: number): string {
  if (value < 1_000) return `${value} B`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} KB`
  if (value < 1_000_000_000) {
    return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`
  }
  return `${(value / 1_000_000_000).toFixed(value < 10_000_000_000 ? 1 : 0)} GB`
}

function formatOptionalStorageSize(value: number | null): string {
  return value === null ? '不可用' : formatStorageSize(value)
}

function createDefaultMailboxSearchDraft(): MailboxSearchDraft {
  return {
    body: '',
    subject: '',
    sender: '',
    recipient: '',
    mailboxAddress: '',
    dateFrom: '',
    dateTo: '',
    attachment: 'all',
    read: 'all',
    starred: 'all',
    archived: 'all',
    sort: 'newest',
  }
}

function createDefaultMailboxSearchFilters(): MailboxSearchFilters {
  return {
    ...createDefaultMailboxSearchDraft(),
    dateFrom: null,
    dateTo: null,
  }
}

function countActiveMailboxSearchFilters(): number {
  const search = mailboxSearchApplied.value
  return [
    search.body,
    search.subject,
    search.sender,
    search.recipient,
    search.mailboxAddress,
    search.dateFrom,
    search.dateTo,
    search.attachment === 'all' ? null : search.attachment,
    search.read === 'all' ? null : search.read,
    search.starred === 'all' ? null : search.starred,
    search.archived === 'all' ? null : search.archived,
  ].filter((value) => value !== '' && value !== null).length
}

function countActiveMailboxSearchDraftFilters(): number {
  const search = mailboxSearchDraft
  return [
    search.body,
    search.subject,
    search.sender,
    search.recipient,
    search.mailboxAddress,
    search.dateFrom,
    search.dateTo,
    search.attachment === 'all' ? '' : search.attachment,
    search.read === 'all' ? '' : search.read,
    search.starred === 'all' ? '' : search.starred,
    search.archived === 'all' ? '' : search.archived,
    search.sort === 'newest' ? '' : search.sort,
  ].filter(Boolean).length
}

function localDateStart(value: string): number | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.valueOf()) ? null : date.valueOf()
}

function localDateEnd(value: string): number | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.valueOf())) return null
  date.setDate(date.getDate() + 1)
  return date.valueOf() - 1
}

function mailboxSenderLabel(item: MailboxListItem): string {
  return item.sender?.displayName || item.sender?.address || '未知发件人'
}

function unallocatedSenderLabel(item: UnallocatedMailListItem): string {
  return item.sender?.displayName || item.sender?.address || '未知发件人'
}

function mailboxScopeLabel(item: MailboxListItem): string {
  return item.organization?.name ?? '个人邮箱'
}

function mailboxViewLabel(view: MailboxView): string {
  const labels: Record<MailboxView, string> = {
    inbox: '收件箱',
    sent: '已发送',
    starred: '星标',
    archive: '归档',
    spam: '垃圾邮件',
    trash: '垃圾箱',
    all: '全部邮件',
  }
  return labels[view]
}

function mailboxEmptyLabel(view: MailboxView): string {
  if (mailboxSearchActive.value) return '没有找到符合当前条件的邮件。'
  return `${mailboxViewLabel(view)}暂时没有邮件。`
}

function mailboxTrashDueLabel(timestamp: number): string {
  return `${formatDate(timestamp)}后自动清理`
}

function headerRoleLabel(role: MailboxHeaderAddress['role']): string {
  if (role === 'from') return '发件人'
  if (role === 'sender') return '代发人'
  if (role === 'reply_to') return '回复至'
  if (role === 'to') return '收件人'
  if (role === 'cc') return '抄送'
  return '密送'
}

function inboundRejectionRuleTypeLabel(type: InboundRejectionRuleType): string {
  const labels: Record<InboundRejectionRuleType, string> = {
    sender_address: '发件地址',
    sender_domain: '发件域名',
    subject_keyword: '主题关键词',
    body_keyword: '正文关键词',
  }
  return labels[type]
}

function normalizeDomainPreview(value: string): string {
  const input = value.trim().replace(/\.$/, '').toLowerCase()
  if (!input) return ''

  try {
    return new URL(`http://${input}`).hostname.toLowerCase()
  } catch {
    return input
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header" :class="{ 'app-header--authenticated': authentication }">
      <div class="header-leading">
        <button
          v-if="authentication"
          class="icon-button mobile-navigation-toggle"
          type="button"
          title="打开邮箱导航"
          aria-label="打开邮箱导航"
          :aria-expanded="mobileNavigationOpen"
          @click="toggleMobileNavigation"
        >
          <Menu :size="20" />
        </button>
        <div class="brand" aria-label="澄笺 Simlettra">
          <span class="brand-mark" aria-hidden="true">澄</span>
          <span class="brand-name">澄笺</span>
          <span class="brand-divider" aria-hidden="true"></span>
          <span class="brand-latin">Simlettra</span>
        </div>
      </div>

      <button
        v-if="authentication"
        class="header-search-button"
        type="button"
        aria-label="搜索邮件"
        @click="focusMailboxSearch"
      >
        <Search :size="17" />
        <span>搜索邮件</span>
      </button>

      <div v-if="authentication" class="header-account">
        <button
          class="header-account-trigger"
          type="button"
          :aria-expanded="accountMenuOpen"
          @click="accountMenuOpen = !accountMenuOpen"
        >
          <span>
            <strong>{{ authentication.user.displayName }}</strong>
            <small>{{ authentication.user.primaryAddress }}</small>
          </span>
          <ChevronDown :size="16" />
        </button>
        <div v-if="accountMenuOpen" class="header-account-menu">
          <button type="button" @click="openSettings('account-security')">
            <Settings :size="16" />
            <span>设置</span>
          </button>
          <button type="button" :disabled="sessionActionId !== null" @click="exitCurrentSession">
            <LogOut :size="16" />
            <span>退出登录</span>
          </button>
        </div>
      </div>
    </header>

    <main class="setup-page" :class="{ 'setup-page--authenticated': authentication }">
      <section v-if="loading" class="message-view" aria-live="polite">
        <p class="status-indicator">
          <span class="status-dot" aria-hidden="true"></span>正在连接系统
        </p>
        <h1>正在载入</h1>
      </section>

      <section v-else-if="pageError && !status" class="message-view" aria-live="assertive">
        <p class="status-indicator status-indicator--error">
          <span class="status-dot" aria-hidden="true"></span>系统暂时不可用
        </p>
        <h1>无法读取部署状态</h1>
        <p class="lead">{{ pageError }}</p>
        <button class="button button--secondary" type="button" @click="loadStatus">重新检查</button>
      </section>

      <section v-else-if="result" class="message-view" aria-live="polite">
        <p class="status-indicator">
          <span class="status-dot" aria-hidden="true"></span>初始化完成
        </p>
        <h1>管理员账号已建立</h1>
        <p class="lead">{{ result.data.administrator.primaryAddress }}</p>
        <dl class="summary-list">
          <div>
            <dt>显示名称</dt>
            <dd>{{ result.data.administrator.displayName }}</dd>
          </div>
          <div>
            <dt>邮件域名</dt>
            <dd>{{ result.data.domain.canonicalName }}</dd>
          </div>
          <div>
            <dt>存储方式</dt>
            <dd>{{ result.data.storageMode === 'kv' ? 'D1 + KV' : 'D1 + R2' }}</dd>
          </div>
        </dl>
        <div class="form-actions form-actions--end">
          <button class="button button--primary" type="button" @click="continueToLogin">
            使用管理员账号登录
          </button>
        </div>
      </section>

      <section
        v-else-if="
          status?.data.initialization === 'initialized' &&
          authentication?.user.passwordChangeRequired
        "
        class="required-password-view"
        aria-labelledby="required-password-title"
      >
        <div class="account-heading">
          <p class="eyebrow">临时密码</p>
          <h1 id="required-password-title">设置正式密码</h1>
          <p class="lead">{{ authentication.user.primaryAddress }}</p>
        </div>

        <p v-if="authError" class="form-alert" role="alert">{{ authError }}</p>
        <p class="form-notice">
          当前为受限会话。临时密码最晚于
          {{
            authentication.user.temporaryPasswordExpiresAt
              ? formatDate(authentication.user.temporaryPasswordExpiresAt)
              : '当前恢复期限'
          }}
          失效。
        </p>

        <form class="account-form" @submit.prevent="submitRequiredPasswordChange">
          <div class="form-grid">
            <label class="field">
              <span>新密码</span>
              <input
                v-model="requiredPasswordForm.newPassword"
                :type="requiredPasswordForm.showPassword ? 'text' : 'password'"
                name="required-new-password"
                autocomplete="new-password"
                maxlength="128"
                required
                :aria-invalid="Boolean(requiredPasswordErrors.newPassword)"
              />
              <small v-if="requiredPasswordErrors.newPassword" class="field-error">{{
                requiredPasswordErrors.newPassword
              }}</small>
            </label>

            <label class="field">
              <span>确认新密码</span>
              <input
                v-model="requiredPasswordForm.confirmPassword"
                :type="requiredPasswordForm.showPassword ? 'text' : 'password'"
                name="required-confirm-password"
                autocomplete="new-password"
                maxlength="128"
                required
                :aria-invalid="Boolean(requiredPasswordErrors.confirmPassword)"
              />
              <small v-if="requiredPasswordErrors.confirmPassword" class="field-error">{{
                requiredPasswordErrors.confirmPassword
              }}</small>
            </label>

            <label class="checkbox-field field--wide">
              <input v-model="requiredPasswordForm.showPassword" type="checkbox" />
              <span>显示密码</span>
            </label>
          </div>

          <div class="form-actions form-actions--end">
            <button class="button button--primary" type="submit" :disabled="passwordSubmitting">
              {{ passwordSubmitting ? '正在保存' : '设置正式密码' }}
            </button>
          </div>
        </form>
      </section>

      <section
        v-else-if="status?.data.initialization === 'initialized' && authentication"
        class="account-page"
        aria-labelledby="account-title"
      >
        <h1 id="account-title" class="visually-hidden">
          {{ authentication.user.displayName }}的邮箱
        </h1>

        <div v-if="authError || accountNotice" class="workspace-feedback">
          <p v-if="authError" class="form-alert" role="alert">{{ authError }}</p>
          <p v-if="accountNotice" class="form-success" role="status">{{ accountNotice }}</p>
        </div>

        <section
          v-if="workspaceView === 'mailbox' || workspaceView === 'drafts'"
          :class="workspaceView === 'mailbox' ? 'mailbox-workspace' : 'draft-workspace'"
          aria-label="邮箱工作区"
        >
          <aside
            class="mailbox-folders"
            :class="{ 'mailbox-folders--open': mobileNavigationOpen }"
            aria-label="邮箱视图与范围"
          >
            <div class="mailbox-folders-heading">
              <h2>邮件</h2>
              <div class="mailbox-folder-heading-actions">
                <button
                  class="icon-button"
                  type="button"
                  title="刷新邮件"
                  aria-label="刷新邮件"
                  :disabled="mailboxLoading || unallocatedMailLoading"
                  @click="refreshActiveMailbox"
                >
                  <RefreshCw :size="17" />
                </button>
                <button
                  class="icon-button mailbox-navigation-close"
                  type="button"
                  title="关闭邮箱导航"
                  aria-label="关闭邮箱导航"
                  @click="mobileNavigationOpen = false"
                >
                  <X :size="18" />
                </button>
              </div>
            </div>
            <button
              class="draft-compose-button"
              type="button"
              :disabled="draftAction !== null"
              @click="startNewDraft"
            >
              <PenLine :size="17" />
              <span>{{ draftAction === 'create' ? '正在新建' : '写邮件' }}</span>
            </button>
            <nav class="mailbox-system-folders" aria-label="系统邮箱视图">
              <button
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'inbox' ? 'page' : undefined
                "
                @click="selectMailboxView('inbox')"
              >
                <Inbox :size="17" />
                <span>收件箱</span>
              </button>
              <button
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'sent' ? 'page' : undefined
                "
                @click="selectMailboxView('sent')"
              >
                <Send :size="17" />
                <span>已发送</span>
              </button>
              <button type="button" @click="enterDraftWorkspace('active')">
                <FilePlus2 :size="17" />
                <span>草稿箱</span>
              </button>
              <button
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'starred' ? 'page' : undefined
                "
                @click="selectMailboxView('starred')"
              >
                <Star :size="17" />
                <span>星标</span>
              </button>
              <button
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'archive' ? 'page' : undefined
                "
                @click="selectMailboxView('archive')"
              >
                <Archive :size="17" />
                <span>归档</span>
              </button>
              <button
                class="mailbox-more-toggle"
                type="button"
                :aria-expanded="mailboxMoreOpen"
                @click="mailboxMoreOpen = !mailboxMoreOpen"
              >
                <MoreHorizontal :size="17" />
                <span>更多</span>
                <ChevronDown class="mailbox-more-chevron" :size="15" />
              </button>
              <button
                v-show="mailboxMoreOpen"
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'spam' ? 'page' : undefined
                "
                @click="selectMailboxView('spam')"
              >
                <OctagonAlert :size="17" />
                <span>垃圾邮件</span>
              </button>
              <button
                v-show="mailboxMoreOpen"
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'trash' ? 'page' : undefined
                "
                @click="selectMailboxView('trash')"
              >
                <Trash2 :size="17" />
                <span>垃圾箱</span>
              </button>
              <button
                v-show="mailboxMoreOpen"
                type="button"
                :aria-current="
                  mailboxMode === 'assigned' && mailboxView === 'all' ? 'page' : undefined
                "
                @click="selectMailboxView('all')"
              >
                <Mails :size="17" />
                <span>全部邮件</span>
              </button>
              <button
                type="button"
                :aria-current="mailboxMode === 'unallocated' ? 'page' : undefined"
                @click="selectMailboxMode('unallocated')"
              >
                <Mail :size="17" />
                <span>待认领邮件</span>
              </button>
            </nav>
            <p v-if="mailboxMode === 'assigned'" class="mailbox-folder-label">邮箱范围</p>
            <button
              v-if="mailboxMode === 'assigned'"
              type="button"
              :class="{ 'mailbox-scope--active': mailboxScope === 'all' }"
              @click="selectMailboxScope('all')"
            >
              全部邮箱
            </button>
            <button
              v-if="mailboxMode === 'assigned'"
              type="button"
              :class="{ 'mailbox-scope--active': mailboxScope === 'personal' }"
              @click="selectMailboxScope('personal')"
            >
              个人邮箱
            </button>
            <p
              v-if="mailboxMode === 'assigned' && mailboxOrganizations.length"
              class="mailbox-folder-label"
            >
              组织邮箱
            </p>
            <button
              v-for="organization in mailboxOrganizations"
              v-show="mailboxMode === 'assigned'"
              :key="organization.id"
              type="button"
              :class="{
                'mailbox-scope--active':
                  mailboxScope === 'organization' && mailboxOrganizationId === organization.id,
              }"
              @click="selectMailboxScope('organization', organization.id)"
            >
              {{ organization.name }}
            </button>
            <div class="workspace-navigation-footer">
              <button type="button" @click="openSettings()">
                <Settings :size="17" />
                <span>设置</span>
              </button>
            </div>
          </aside>

          <button
            v-if="mobileNavigationOpen"
            class="mobile-navigation-backdrop"
            type="button"
            aria-label="关闭邮箱导航"
            @click="mobileNavigationOpen = false"
          ></button>

          <template v-if="workspaceView === 'mailbox'">
            <section
              class="mailbox-list-panel"
              :class="{
                'mailbox-list-panel--selection-mode': mailboxSelectionMode,
                'mailbox-list-panel--hidden-mobile':
                  selectedMessage ||
                  selectedMessageLoading ||
                  selectedUnallocatedMessage ||
                  selectedUnallocatedMessageLoading,
              }"
              aria-labelledby="mailbox-list-title"
            >
              <template v-if="mailboxMode === 'assigned'">
                <form class="mailbox-search" role="search" @submit.prevent="applyMailboxSearch">
                  <div class="mailbox-search-primary">
                    <Search :size="16" aria-hidden="true" />
                    <input
                      ref="mailboxSearchInput"
                      v-model="mailboxSearchDraft.body"
                      type="search"
                      maxlength="200"
                      aria-label="搜索邮件正文"
                      placeholder="搜索正文关键词"
                    />
                    <div class="mailbox-search-primary-actions">
                      <button
                        class="icon-button"
                        type="submit"
                        title="搜索"
                        aria-label="搜索"
                        :disabled="mailboxLoading"
                      >
                        <Search :size="16" />
                      </button>
                      <button
                        class="icon-button mailbox-search-filter-button"
                        type="button"
                        title="组合搜索条件"
                        aria-label="组合搜索条件"
                        :aria-expanded="mailboxSearchOpen"
                        @click="mailboxSearchOpen = !mailboxSearchOpen"
                      >
                        <SlidersHorizontal :size="16" />
                        <span v-if="mailboxSearchFilterCount" aria-hidden="true">
                          {{ mailboxSearchFilterCount }}
                        </span>
                      </button>
                      <button
                        v-if="mailboxSearchActive"
                        class="icon-button"
                        type="button"
                        title="清除搜索"
                        aria-label="清除搜索"
                        :disabled="mailboxLoading"
                        @click="clearMailboxSearch"
                      >
                        <X :size="16" />
                      </button>
                    </div>
                  </div>

                  <div v-if="mailboxSearchOpen" class="mailbox-search-filters">
                    <label>
                      <span>主题</span>
                      <input v-model="mailboxSearchDraft.subject" type="search" maxlength="320" />
                    </label>
                    <label>
                      <span>发件人</span>
                      <input v-model="mailboxSearchDraft.sender" type="search" maxlength="320" />
                    </label>
                    <label>
                      <span>收件人</span>
                      <input v-model="mailboxSearchDraft.recipient" type="search" maxlength="320" />
                    </label>
                    <label>
                      <span>实际投递地址</span>
                      <input
                        v-model="mailboxSearchDraft.mailboxAddress"
                        type="search"
                        maxlength="320"
                      />
                    </label>
                    <div class="mailbox-search-date-range">
                      <label>
                        <span>开始日期</span>
                        <input v-model="mailboxSearchDraft.dateFrom" type="date" />
                      </label>
                      <label>
                        <span>结束日期</span>
                        <input v-model="mailboxSearchDraft.dateTo" type="date" />
                      </label>
                    </div>
                    <label>
                      <span>附件</span>
                      <select v-model="mailboxSearchDraft.attachment">
                        <option value="all">不限</option>
                        <option value="with">有附件</option>
                        <option value="without">无附件</option>
                      </select>
                    </label>
                    <label>
                      <span>已读状态</span>
                      <select v-model="mailboxSearchDraft.read">
                        <option value="all">不限</option>
                        <option value="unread">未读</option>
                        <option value="read">已读</option>
                      </select>
                    </label>
                    <label>
                      <span>星标状态</span>
                      <select v-model="mailboxSearchDraft.starred">
                        <option value="all">不限</option>
                        <option value="starred">已星标</option>
                        <option value="unstarred">未星标</option>
                      </select>
                    </label>
                    <label>
                      <span>归档状态</span>
                      <select v-model="mailboxSearchDraft.archived">
                        <option value="all">不限</option>
                        <option value="archived">已归档</option>
                        <option value="unarchived">未归档</option>
                      </select>
                    </label>
                    <label>
                      <span>排序</span>
                      <select v-model="mailboxSearchDraft.sort">
                        <option value="newest">最新优先</option>
                        <option value="oldest">最早优先</option>
                        <option value="unread">未读优先</option>
                        <option value="starred">星标优先</option>
                        <option value="attachments">有附件优先</option>
                      </select>
                    </label>
                    <div class="mailbox-search-actions">
                      <button
                        class="button button--secondary button--compact"
                        type="button"
                        :disabled="mailboxLoading"
                        @click="clearMailboxSearch"
                      >
                        清除
                      </button>
                      <button
                        class="button button--primary button--compact"
                        type="submit"
                        :disabled="mailboxLoading"
                      >
                        应用条件
                      </button>
                    </div>
                  </div>
                </form>
                <div class="mailbox-list-heading">
                  <input
                    type="checkbox"
                    :checked="allLoadedMailboxItemsSelected"
                    :disabled="mailboxItems.length === 0 || mailboxLoading"
                    aria-label="选择所有已加载邮件"
                    @change="toggleAllLoadedMailboxItems"
                  />
                  <div>
                    <h2 id="mailbox-list-title">{{ mailboxViewTitle }}</h2>
                    <p>{{ mailboxItems.length }} 封已加载</p>
                  </div>
                  <button
                    class="button button--secondary button--compact mobile-selection-button"
                    type="button"
                    @click="toggleMailboxSelectionMode"
                  >
                    {{ mailboxSelectionMode ? '完成' : '选择' }}
                  </button>
                </div>
                <div
                  v-if="selectedMailboxEntryIds.size"
                  class="mailbox-bulk-toolbar"
                  aria-label="批量操作"
                >
                  <span>{{ selectedMailboxEntryIds.size }} 封</span>
                  <button
                    class="icon-button"
                    type="button"
                    title="标为已读"
                    aria-label="标为已读"
                    :disabled="mailboxBulkAction !== null"
                    @click="runMailboxOrganizeAction('mark_read')"
                  >
                    <MailOpen :size="17" />
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    title="标为未读"
                    aria-label="标为未读"
                    :disabled="mailboxBulkAction !== null"
                    @click="runMailboxOrganizeAction('mark_unread')"
                  >
                    <Mail :size="17" />
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :title="mailboxView === 'starred' ? '取消星标' : '添加星标'"
                    :aria-label="mailboxView === 'starred' ? '取消星标' : '添加星标'"
                    :disabled="mailboxBulkAction !== null"
                    @click="runMailboxOrganizeAction(mailboxView === 'starred' ? 'unstar' : 'star')"
                  >
                    <Star :size="17" :fill="mailboxView === 'starred' ? 'currentColor' : 'none'" />
                  </button>
                  <button
                    v-if="mailboxView === 'inbox' || mailboxView === 'archive'"
                    class="icon-button"
                    type="button"
                    :title="mailboxView === 'archive' ? '取消归档' : '归档'"
                    :aria-label="mailboxView === 'archive' ? '取消归档' : '归档'"
                    :disabled="mailboxBulkAction !== null"
                    @click="
                      runMailboxOrganizeAction(mailboxView === 'archive' ? 'unarchive' : 'archive')
                    "
                  >
                    <ArchiveRestore v-if="mailboxView === 'archive'" :size="17" />
                    <Archive v-else :size="17" />
                  </button>
                  <button
                    v-if="mailboxView === 'inbox' || mailboxView === 'spam'"
                    class="icon-button"
                    type="button"
                    :title="mailboxView === 'spam' ? '不是垃圾邮件' : '标为垃圾邮件'"
                    :aria-label="mailboxView === 'spam' ? '不是垃圾邮件' : '标为垃圾邮件'"
                    :disabled="mailboxBulkAction !== null"
                    @click="
                      runMailboxOrganizeAction(
                        mailboxView === 'spam' ? 'restore_from_spam' : 'mark_spam',
                      )
                    "
                  >
                    <Undo2 v-if="mailboxView === 'spam'" :size="17" />
                    <OctagonAlert v-else :size="17" />
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :title="mailboxView === 'trash' ? '恢复' : '移入垃圾箱'"
                    :aria-label="mailboxView === 'trash' ? '恢复' : '移入垃圾箱'"
                    :disabled="mailboxBulkAction !== null"
                    @click="
                      runMailboxOrganizeAction(
                        mailboxView === 'trash' ? 'restore_from_trash' : 'move_to_trash',
                      )
                    "
                  >
                    <Undo2 v-if="mailboxView === 'trash'" :size="17" />
                    <Trash2 v-else :size="17" />
                  </button>
                </div>
                <p v-if="mailboxError" class="mailbox-error" role="alert">{{ mailboxError }}</p>
                <p v-if="mailboxNotice" class="mailbox-notice" role="status">{{ mailboxNotice }}</p>
                <p v-if="mailboxLoading" class="mailbox-loading" role="status">正在读取邮件…</p>
                <p
                  v-else-if="mailboxSearchIndex?.status === 'building'"
                  class="mailbox-search-status"
                  role="status"
                >
                  正在建立正文搜索索引，尚有
                  {{ mailboxSearchIndex.pendingMessageCount }} 封邮件未完成。
                </p>
                <p
                  v-else-if="mailboxSearchIndex?.status === 'needs_attention'"
                  class="mailbox-search-status mailbox-search-status--attention"
                  role="alert"
                >
                  正文搜索索引需要管理员处理，普通筛选仍可使用。
                </p>
                <div v-else-if="mailboxItems.length" class="mailbox-message-list">
                  <article
                    v-for="item in mailboxItems"
                    :key="item.id"
                    class="mailbox-message-row"
                    :class="{
                      'mailbox-message-row--unread': !item.isRead,
                      'mailbox-message-row--selected': selectedMessage?.id === item.id,
                      'mailbox-message-row--checked': selectedMailboxEntryIds.has(item.id),
                    }"
                  >
                    <input
                      type="checkbox"
                      :checked="selectedMailboxEntryIds.has(item.id)"
                      :aria-label="`选择邮件：${item.subject || '无主题'}`"
                      @change="toggleMailboxSelection(item.id)"
                    />
                    <button
                      class="mailbox-message-open"
                      type="button"
                      @click="openMailboxMessage(item)"
                    >
                      <span class="mailbox-message-main">
                        <span class="mailbox-message-sender">{{ mailboxSenderLabel(item) }}</span>
                        <span class="mailbox-message-subject">{{
                          item.subject || '（无主题）'
                        }}</span>
                        <span class="mailbox-message-delivery">
                          {{ mailboxScopeLabel(item) }} ·
                          {{ item.actualDeliveryAddresses.join('、') || '投递地址未知' }}
                        </span>
                      </span>
                      <span class="mailbox-message-meta">
                        <time :datetime="new Date(item.occurredAt).toISOString()">{{
                          formatDate(item.occurredAt)
                        }}</time>
                        <span v-if="item.conversationMessageCount > 1">
                          {{ item.conversationMessageCount }} 封
                          <template v-if="item.conversationUnreadCount > 0">
                            · {{ item.conversationUnreadCount }} 封未读
                          </template>
                        </span>
                        <span v-if="item.hasAttachments" class="mailbox-attachment-count">
                          <Paperclip :size="13" />
                          {{ item.attachmentCount }}
                        </span>
                        <span v-if="item.trashDueAt">{{
                          mailboxTrashDueLabel(item.trashDueAt)
                        }}</span>
                      </span>
                    </button>
                    <button
                      class="icon-button mailbox-row-star"
                      type="button"
                      :title="item.isStarred ? '取消星标' : '添加星标'"
                      :aria-label="item.isStarred ? '取消星标' : '添加星标'"
                      :disabled="mailboxBulkAction !== null"
                      @click="
                        runMailboxOrganizeAction(item.isStarred ? 'unstar' : 'star', [item.id])
                      "
                    >
                      <Star :size="16" :fill="item.isStarred ? 'currentColor' : 'none'" />
                    </button>
                  </article>
                  <button
                    v-if="mailboxNextCursor"
                    class="button button--secondary mailbox-load-more"
                    type="button"
                    :disabled="mailboxLoadingMore"
                    @click="refreshMailbox(true)"
                  >
                    {{ mailboxLoadingMore ? '正在加载' : '加载更多' }}
                  </button>
                </div>
                <p v-else class="empty-state">{{ mailboxEmptyLabel(mailboxView) }}</p>
              </template>

              <template v-else>
                <form
                  class="mailbox-search"
                  role="search"
                  @submit.prevent="applyUnallocatedMailSearch"
                >
                  <div class="mailbox-search-primary">
                    <Search :size="16" aria-hidden="true" />
                    <input
                      v-model="unallocatedMailQuery"
                      type="search"
                      maxlength="320"
                      aria-label="搜索未分配来信"
                      placeholder="搜索主题、发件人或投递地址"
                    />
                    <div class="mailbox-search-primary-actions">
                      <button
                        class="icon-button"
                        type="submit"
                        title="搜索"
                        aria-label="搜索"
                        :disabled="unallocatedMailLoading"
                      >
                        <Search :size="16" />
                      </button>
                      <button
                        v-if="unallocatedMailAppliedQuery"
                        class="icon-button"
                        type="button"
                        title="清除搜索"
                        aria-label="清除搜索"
                        :disabled="unallocatedMailLoading"
                        @click="clearUnallocatedMailSearch"
                      >
                        <X :size="16" />
                      </button>
                    </div>
                  </div>
                </form>
                <div class="mailbox-list-heading mailbox-list-heading--plain">
                  <div>
                    <h2 id="mailbox-list-title">未分配来信</h2>
                    <p>{{ unallocatedMailItems.length }} 封已加载</p>
                  </div>
                </div>
                <p v-if="mailboxError" class="mailbox-error" role="alert">{{ mailboxError }}</p>
                <p v-if="mailboxNotice" class="mailbox-notice" role="status">{{ mailboxNotice }}</p>
                <p v-if="unallocatedMailLoading" class="mailbox-loading" role="status">
                  正在读取未分配来信…
                </p>
                <div v-else-if="unallocatedMailItems.length" class="mailbox-message-list">
                  <article
                    v-for="item in unallocatedMailItems"
                    :key="item.deliveryId"
                    class="mailbox-message-row mailbox-message-row--unallocated"
                    :class="{
                      'mailbox-message-row--selected':
                        selectedUnallocatedMessage?.deliveryId === item.deliveryId,
                    }"
                  >
                    <button
                      class="mailbox-message-open"
                      type="button"
                      @click="openUnallocatedMessage(item)"
                    >
                      <span class="mailbox-message-main">
                        <span class="mailbox-message-sender">{{
                          unallocatedSenderLabel(item)
                        }}</span>
                        <span class="mailbox-message-subject">{{
                          item.subject || '（无主题）'
                        }}</span>
                        <span class="mailbox-message-delivery">{{
                          item.actualDeliveryAddress
                        }}</span>
                      </span>
                      <span class="mailbox-message-meta">
                        <time :datetime="new Date(item.occurredAt).toISOString()">
                          {{ formatDate(item.occurredAt) }}
                        </time>
                        <span v-if="item.hasAttachments" class="mailbox-attachment-count">
                          <Paperclip :size="13" />
                          {{ item.attachmentCount }}
                        </span>
                      </span>
                    </button>
                  </article>
                  <button
                    v-if="unallocatedMailNextCursor"
                    class="button button--secondary mailbox-load-more"
                    type="button"
                    :disabled="unallocatedMailLoadingMore"
                    @click="refreshUnallocatedMail(true)"
                  >
                    {{ unallocatedMailLoadingMore ? '正在加载' : '加载更多' }}
                  </button>
                </div>
                <p v-else class="empty-state">
                  {{
                    unallocatedMailAppliedQuery
                      ? '没有符合条件的未分配来信。'
                      : '当前没有未分配来信。'
                  }}
                </p>
              </template>
            </section>

            <article
              ref="mailboxDetailPanel"
              class="mailbox-detail-panel"
              :class="{
                'mailbox-detail-panel--visible-mobile':
                  selectedMessage ||
                  selectedMessageLoading ||
                  selectedUnallocatedMessage ||
                  selectedUnallocatedMessageLoading,
              }"
              aria-label="邮件详情"
            >
              <p
                v-if="selectedMessageLoading || selectedUnallocatedMessageLoading"
                class="mailbox-loading"
              >
                正在打开邮件…
              </p>
              <template v-else-if="mailboxMode === 'assigned' && selectedMessage">
                <div class="mailbox-detail-toolbar">
                  <button
                    class="button button--secondary button--compact mailbox-back-button"
                    type="button"
                    @click="requestCloseMailboxMessage"
                  >
                    <ArrowLeft :size="16" />
                    返回
                  </button>
                  <div class="mailbox-detail-actions">
                    <button
                      v-if="selectedMessage.entryKind === 'received'"
                      class="button button--primary button--compact"
                      type="button"
                      title="回复"
                      aria-label="回复"
                      :disabled="selectedMessageAction !== null || mailboxBulkAction !== null"
                      @click="startRelatedDraft('reply')"
                    >
                      <Reply :size="17" />
                      <span>回复</span>
                    </button>
                    <button
                      v-if="selectedMessage.entryKind === 'received'"
                      class="button button--secondary button--compact"
                      type="button"
                      title="回复全部"
                      aria-label="回复全部"
                      :disabled="selectedMessageAction !== null || mailboxBulkAction !== null"
                      @click="startRelatedDraft('reply_all')"
                    >
                      <ReplyAll :size="17" />
                      <span>回复全部</span>
                    </button>
                    <button
                      v-if="messageActionsOpen"
                      class="icon-button mailbox-secondary-action"
                      type="button"
                      title="转发"
                      aria-label="转发"
                      :disabled="selectedMessageAction !== null || mailboxBulkAction !== null"
                      @click="startRelatedDraft('forward')"
                    >
                      <Forward :size="17" />
                    </button>
                    <button
                      v-if="messageActionsOpen"
                      class="button button--secondary button--compact mailbox-secondary-action"
                      type="button"
                      :disabled="selectedMessageAction !== null || mailboxBulkAction !== null"
                      @click="toggleSelectedMessageRead"
                    >
                      <Mail v-if="selectedMessage.isRead" :size="16" />
                      <MailOpen v-else :size="16" />
                      {{ selectedMessage.isRead ? '标为未读' : '标为已读' }}
                    </button>
                    <button
                      class="icon-button"
                      type="button"
                      :title="selectedMessage.isStarred ? '取消星标' : '添加星标'"
                      :aria-label="selectedMessage.isStarred ? '取消星标' : '添加星标'"
                      :disabled="mailboxBulkAction !== null"
                      @click="
                        runMailboxOrganizeAction(selectedMessage.isStarred ? 'unstar' : 'star', [
                          selectedMessage.id,
                        ])
                      "
                    >
                      <Star
                        :size="17"
                        :fill="selectedMessage.isStarred ? 'currentColor' : 'none'"
                      />
                    </button>
                    <button
                      class="icon-button mailbox-more-actions-button"
                      type="button"
                      title="更多操作"
                      aria-label="更多操作"
                      :aria-expanded="messageActionsOpen"
                      @click="messageActionsOpen = !messageActionsOpen"
                    >
                      <MoreHorizontal :size="18" />
                    </button>
                    <button
                      v-if="
                        messageActionsOpen &&
                        selectedMessage.entryKind === 'received' &&
                        selectedMessage.location === 'inbox'
                      "
                      class="icon-button mailbox-secondary-action"
                      type="button"
                      :title="selectedMessage.isArchived ? '取消归档' : '归档'"
                      :aria-label="selectedMessage.isArchived ? '取消归档' : '归档'"
                      :disabled="mailboxBulkAction !== null"
                      @click="
                        runMailboxOrganizeAction(
                          selectedMessage.isArchived ? 'unarchive' : 'archive',
                          [selectedMessage.id],
                        )
                      "
                    >
                      <ArchiveRestore v-if="selectedMessage.isArchived" :size="17" />
                      <Archive v-else :size="17" />
                    </button>
                    <button
                      v-if="
                        messageActionsOpen &&
                        selectedMessage.entryKind === 'received' &&
                        selectedMessage.location === 'inbox'
                      "
                      class="icon-button mailbox-secondary-action"
                      type="button"
                      title="标为垃圾邮件"
                      aria-label="标为垃圾邮件"
                      :disabled="mailboxBulkAction !== null"
                      @click="runMailboxOrganizeAction('mark_spam', [selectedMessage.id])"
                    >
                      <OctagonAlert :size="17" />
                    </button>
                    <button
                      v-if="messageActionsOpen && selectedMessage.location === 'spam'"
                      class="icon-button mailbox-secondary-action"
                      type="button"
                      title="不是垃圾邮件"
                      aria-label="不是垃圾邮件"
                      :disabled="mailboxBulkAction !== null"
                      @click="runMailboxOrganizeAction('restore_from_spam', [selectedMessage.id])"
                    >
                      <Undo2 :size="17" />
                    </button>
                    <button
                      v-if="messageActionsOpen"
                      class="icon-button mailbox-secondary-action"
                      type="button"
                      :title="selectedMessage.location === 'trash' ? '恢复' : '移入垃圾箱'"
                      :aria-label="selectedMessage.location === 'trash' ? '恢复' : '移入垃圾箱'"
                      :disabled="mailboxBulkAction !== null"
                      @click="
                        runMailboxOrganizeAction(
                          selectedMessage.location === 'trash'
                            ? 'restore_from_trash'
                            : 'move_to_trash',
                          [selectedMessage.id],
                        )
                      "
                    >
                      <Undo2 v-if="selectedMessage.location === 'trash'" :size="17" />
                      <Trash2 v-else :size="17" />
                    </button>
                    <button
                      v-if="
                        messageActionsOpen &&
                        selectedMessage.location === 'trash' &&
                        selectedMessage.canPermanentlyDelete
                      "
                      class="button button--danger-quiet button--compact mailbox-secondary-action"
                      type="button"
                      :disabled="selectedMessageAction !== null || mailboxBulkAction !== null"
                      @click="requestMailboxPermanentDeletion"
                    >
                      <Trash2 :size="16" />
                      永久删除
                    </button>
                  </div>
                </div>

                <section
                  v-if="pendingMailboxPermanentDeletion"
                  class="destructive-confirmation mailbox-delete-confirmation"
                  aria-labelledby="mailbox-permanent-deletion-title"
                >
                  <h2 id="mailbox-permanent-deletion-title">
                    {{
                      pendingMailboxPermanentDeletion.mailboxType === 'organization'
                        ? '为组织永久删除邮件'
                        : '永久删除个人邮件'
                    }}
                  </h2>
                  <p>{{ mailboxPermanentDeletionImpactText() }}</p>
                  <label class="checkbox-field">
                    <input v-model="mailboxPermanentDeletionConfirmed" type="checkbox" />
                    <span>
                      {{
                        pendingMailboxPermanentDeletion.mailboxType === 'organization'
                          ? '我确认所有组织成员都将失去这封邮件'
                          : '我确认永久删除这封个人邮件'
                      }}
                    </span>
                  </label>
                  <div class="confirmation-actions">
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="selectedMessageAction !== null"
                      @click="cancelMailboxPermanentDeletion"
                    >
                      取消
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="
                        !mailboxPermanentDeletionConfirmed || selectedMessageAction !== null
                      "
                      @click="confirmMailboxPermanentDeletion"
                    >
                      {{ selectedMessageAction === 'permanent-delete' ? '正在删除' : '永久删除' }}
                    </button>
                  </div>
                </section>

                <nav
                  v-if="selectedConversationEntries.length > 1"
                  class="mailbox-conversation-timeline"
                  aria-label="会话邮件"
                >
                  <button
                    v-for="entry in selectedConversationEntries"
                    :key="entry.id"
                    type="button"
                    :class="{
                      'mailbox-conversation-entry--active': entry.id === selectedMessage.id,
                      'mailbox-conversation-entry--unread': !entry.isRead,
                    }"
                    :aria-current="entry.id === selectedMessage.id ? 'true' : undefined"
                    @click="openMailboxMessage(entry)"
                  >
                    <span>{{
                      entry.sender?.displayName || entry.sender?.address || '未知发件人'
                    }}</span>
                    <time :datetime="new Date(entry.occurredAt).toISOString()">
                      {{ formatDate(entry.occurredAt) }}
                    </time>
                    <Paperclip v-if="entry.hasAttachments" :size="13" />
                  </button>
                </nav>

                <header class="mailbox-detail-header">
                  <p class="mailbox-detail-scope">
                    {{ selectedMessage.organization?.name ?? '个人邮箱' }}
                  </p>
                  <p v-if="selectedMessage.trashDueAt" class="mailbox-trash-due">
                    {{ mailboxTrashDueLabel(selectedMessage.trashDueAt) }}
                  </p>
                  <p
                    v-if="
                      selectedMessage.location === 'trash' &&
                      selectedMessage.mailboxType === 'organization' &&
                      !selectedMessage.canPermanentlyDelete
                    "
                    class="mailbox-trash-permission"
                  >
                    只有组织创建者可以为整个组织永久删除这封邮件。
                  </p>
                  <h2 ref="mailboxDetailHeading" tabindex="-1">
                    {{ selectedMessage.subject || '（无主题）' }}
                  </h2>
                  <dl class="mailbox-header-addresses">
                    <div
                      v-for="(address, index) in selectedMessage.addresses"
                      :key="`${address.role}-${index}`"
                    >
                      <dt>{{ headerRoleLabel(address.role) }}</dt>
                      <dd>
                        <strong v-if="address.displayName">{{ address.displayName }}</strong>
                        <span>{{ address.address }}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>实际投递</dt>
                      <dd>{{ selectedMessage.actualDeliveryAddresses.join('、') }}</dd>
                    </div>
                    <div>
                      <dt>时间</dt>
                      <dd>
                        {{ formatDate(selectedMessage.headerDateAt ?? selectedMessage.acceptedAt) }}
                      </dd>
                    </div>
                  </dl>
                </header>

                <div
                  v-if="selectedMessage.untrustedHtmlBody && !selectedMessage.remoteImagesAllowed"
                  class="remote-image-notice"
                >
                  <span>远程图片已阻止。</span>
                  <button
                    type="button"
                    :disabled="selectedMessageAction !== null"
                    @click="changeRemoteImagePermission('message')"
                  >
                    仅本封显示
                  </button>
                  <button
                    v-if="selectedMessage.trustedSenderAddress"
                    type="button"
                    :disabled="selectedMessageAction !== null"
                    @click="removeSelectedTrustedSender"
                  >
                    取消信任此发件人
                  </button>
                  <button
                    v-else-if="selectedMessageSender"
                    type="button"
                    :disabled="selectedMessageAction !== null"
                    @click="changeRemoteImagePermission('sender')"
                  >
                    信任此发件人
                  </button>
                </div>
                <div
                  v-else-if="
                    selectedMessage.untrustedHtmlBody && selectedMessage.remoteImagesAllowed
                  "
                  class="remote-image-notice remote-image-notice--allowed"
                >
                  <span>
                    {{
                      selectedMessage.remoteImagePermission === 'sender'
                        ? '已信任此发件人的远程图片。'
                        : '已为本封邮件显示远程图片。'
                    }}
                  </span>
                  <button
                    v-if="selectedMessage.trustedSenderAddress"
                    type="button"
                    :disabled="selectedMessageAction !== null"
                    @click="removeSelectedTrustedSender"
                  >
                    取消信任
                  </button>
                  <button
                    v-else
                    type="button"
                    :disabled="selectedMessageAction !== null"
                    @click="changeRemoteImagePermission('block')"
                  >
                    重新阻止
                  </button>
                </div>

                <div
                  v-if="selectedMessage.untrustedHtmlBody && selectedMessage.plainTextBody !== null"
                  class="message-body-tabs"
                  role="group"
                  aria-label="正文格式"
                >
                  <button
                    type="button"
                    :aria-pressed="selectedMessageBodyMode === 'html'"
                    @click="selectedMessageBodyMode = 'html'"
                  >
                    HTML
                  </button>
                  <button
                    type="button"
                    :aria-pressed="selectedMessageBodyMode === 'plain'"
                    @click="selectedMessageBodyMode = 'plain'"
                  >
                    纯文本
                  </button>
                </div>

                <iframe
                  v-if="selectedMessage.untrustedHtmlBody && selectedMessageBodyMode === 'html'"
                  class="safe-mail-frame"
                  title="邮件 HTML 正文"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  :srcdoc="safeSelectedMessageHtml"
                />
                <pre v-else class="plain-mail-body">{{ selectedMessage.plainTextBody ?? '' }}</pre>

                <section v-if="selectedMessage.attachments.length" class="mailbox-attachments">
                  <h3>附件</h3>
                  <article
                    v-for="attachment in selectedMessage.attachments"
                    :key="attachment.id"
                    class="mailbox-attachment-row"
                  >
                    <div>
                      <strong>{{ attachment.fileName }}</strong>
                      <span
                        >{{ attachment.mediaType }} ·
                        {{ formatFileSize(attachment.sizeBytes) }}</span
                      >
                    </div>
                    <div class="mailbox-attachment-actions">
                      <button
                        v-if="attachment.previewable"
                        class="button button--secondary button--compact"
                        type="button"
                        @click="
                          previewAttachmentId =
                            previewAttachmentId === attachment.id ? null : attachment.id
                        "
                      >
                        {{ previewAttachmentId === attachment.id ? '关闭预览' : '预览' }}
                      </button>
                      <a
                        class="button button--secondary button--compact"
                        :href="attachmentUrl(selectedMessage.id, attachment.id)"
                      >
                        下载
                      </a>
                    </div>
                    <img
                      v-if="attachment.previewable && previewAttachmentId === attachment.id"
                      class="mailbox-attachment-preview"
                      :src="attachmentUrl(selectedMessage.id, attachment.id, true)"
                      :alt="attachment.fileName"
                    />
                  </article>
                </section>
              </template>
              <template v-else-if="mailboxMode === 'unallocated' && selectedUnallocatedMessage">
                <div class="mailbox-detail-toolbar">
                  <button
                    class="button button--secondary button--compact mailbox-back-button"
                    type="button"
                    @click="requestCloseUnallocatedMessage"
                  >
                    <ArrowLeft :size="16" />
                    返回
                  </button>
                  <div class="mailbox-detail-actions">
                    <button
                      class="button button--primary button--compact"
                      type="button"
                      :disabled="unallocatedMailAction !== null"
                      @click="requestUnallocatedClaim"
                    >
                      {{ unallocatedMailAction === 'claim' ? '正在认领' : '认领地址' }}
                    </button>
                  </div>
                </div>

                <section
                  v-if="pendingUnallocatedClaim"
                  class="destructive-confirmation mailbox-delete-confirmation"
                  aria-labelledby="unallocated-claim-title"
                >
                  <h2 id="unallocated-claim-title">认领未分配地址</h2>
                  <p>
                    将把 <strong>{{ pendingUnallocatedClaim.actualDeliveryAddress }}</strong>
                    建立为你的个人别名，并把这个地址当前未分配时期的全部历史来信加入个人邮箱。操作会占用个人别名和逻辑存储额度。
                  </p>
                  <label class="checkbox-field">
                    <input v-model="unallocatedClaimConfirmed" type="checkbox" />
                    <span>我确认认领这个地址及其当前历史来信</span>
                  </label>
                  <div class="confirmation-actions">
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="unallocatedMailAction !== null"
                      @click="cancelUnallocatedClaim"
                    >
                      取消
                    </button>
                    <button
                      class="button button--primary button--compact"
                      type="button"
                      :disabled="!unallocatedClaimConfirmed || unallocatedMailAction !== null"
                      @click="confirmUnallocatedClaim"
                    >
                      {{ unallocatedMailAction === 'claim' ? '正在认领' : '确认认领' }}
                    </button>
                  </div>
                </section>

                <header class="mailbox-detail-header">
                  <p class="mailbox-detail-scope">未分配来信</p>
                  <h2 ref="mailboxDetailHeading" tabindex="-1">
                    {{ selectedUnallocatedMessage.subject || '（无主题）' }}
                  </h2>
                  <dl class="mailbox-header-addresses">
                    <div
                      v-for="(address, index) in selectedUnallocatedMessage.addresses"
                      :key="`${address.role}-${index}`"
                    >
                      <dt>{{ headerRoleLabel(address.role) }}</dt>
                      <dd>
                        <strong v-if="address.displayName">{{ address.displayName }}</strong>
                        <span>{{ address.address }}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>实际投递</dt>
                      <dd>{{ selectedUnallocatedMessage.actualDeliveryAddress }}</dd>
                    </div>
                    <div>
                      <dt>时间</dt>
                      <dd>
                        {{
                          formatDate(
                            selectedUnallocatedMessage.headerDateAt ??
                              selectedUnallocatedMessage.acceptedAt,
                          )
                        }}
                      </dd>
                    </div>
                  </dl>
                </header>

                <div
                  v-if="selectedUnallocatedMessage.untrustedHtmlBody"
                  class="remote-image-notice"
                >
                  <span>远程图片已阻止；认领前不能放行。</span>
                </div>

                <div
                  v-if="
                    selectedUnallocatedMessage.untrustedHtmlBody &&
                    selectedUnallocatedMessage.plainTextBody !== null
                  "
                  class="message-body-tabs"
                  role="group"
                  aria-label="正文格式"
                >
                  <button
                    type="button"
                    :aria-pressed="selectedMessageBodyMode === 'html'"
                    @click="selectedMessageBodyMode = 'html'"
                  >
                    HTML
                  </button>
                  <button
                    type="button"
                    :aria-pressed="selectedMessageBodyMode === 'plain'"
                    @click="selectedMessageBodyMode = 'plain'"
                  >
                    纯文本
                  </button>
                </div>

                <iframe
                  v-if="
                    selectedUnallocatedMessage.untrustedHtmlBody &&
                    selectedMessageBodyMode === 'html'
                  "
                  class="safe-mail-frame"
                  title="未分配邮件 HTML 正文"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  :srcdoc="safeSelectedUnallocatedMessageHtml"
                />
                <pre v-else class="plain-mail-body">{{
                  selectedUnallocatedMessage.plainTextBody ?? ''
                }}</pre>

                <section
                  v-if="selectedUnallocatedMessage.attachments.length"
                  class="mailbox-attachments"
                >
                  <h3>附件</h3>
                  <article
                    v-for="attachment in selectedUnallocatedMessage.attachments"
                    :key="attachment.id"
                    class="mailbox-attachment-row"
                  >
                    <div>
                      <strong>{{ attachment.fileName }}</strong>
                      <span
                        >{{ attachment.mediaType }} ·
                        {{ formatFileSize(attachment.sizeBytes) }}</span
                      >
                    </div>
                    <div class="mailbox-attachment-actions">
                      <button
                        v-if="attachment.previewable"
                        class="button button--secondary button--compact"
                        type="button"
                        @click="
                          previewAttachmentId =
                            previewAttachmentId === attachment.id ? null : attachment.id
                        "
                      >
                        {{ previewAttachmentId === attachment.id ? '关闭预览' : '预览' }}
                      </button>
                      <a
                        class="button button--secondary button--compact"
                        :href="
                          unallocatedAttachmentUrl(
                            selectedUnallocatedMessage.deliveryId,
                            attachment.id,
                          )
                        "
                      >
                        下载
                      </a>
                    </div>
                    <img
                      v-if="attachment.previewable && previewAttachmentId === attachment.id"
                      class="mailbox-attachment-preview"
                      :src="
                        unallocatedAttachmentUrl(
                          selectedUnallocatedMessage.deliveryId,
                          attachment.id,
                          true,
                        )
                      "
                      :alt="attachment.fileName"
                    />
                  </article>
                </section>
              </template>
              <div v-else class="mailbox-detail-placeholder">
                <h2>选择一封邮件</h2>
                <p>邮件正文和附件将在这里显示。</p>
              </div>
            </article>
          </template>

          <template v-else>
            <aside
              class="draft-list-panel"
              :class="{ 'draft-list-panel--hidden-mobile': selectedDraft }"
            >
              <header class="draft-list-header">
                <div>
                  <h2>{{ draftListStatus === 'active' ? '草稿箱' : '已丢弃草稿' }}</h2>
                  <p>{{ draftWorkspace?.drafts.length ?? 0 }} 封</p>
                </div>
                <div class="draft-list-actions">
                  <button
                    class="icon-button"
                    type="button"
                    title="新建草稿"
                    aria-label="新建草稿"
                    :disabled="draftAction !== null"
                    @click="startNewDraft"
                  >
                    <PenLine :size="17" />
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    title="刷新草稿"
                    aria-label="刷新草稿"
                    :disabled="draftLoading"
                    @click="refreshDrafts"
                  >
                    <RefreshCw :size="17" />
                  </button>
                </div>
              </header>
              <div class="draft-status-tabs" role="group" aria-label="草稿状态">
                <button
                  type="button"
                  :aria-pressed="draftListStatus === 'active'"
                  @click="enterDraftWorkspace('active')"
                >
                  草稿
                </button>
                <button
                  type="button"
                  :aria-pressed="draftListStatus === 'trashed'"
                  @click="enterDraftWorkspace('trashed')"
                >
                  已丢弃
                </button>
              </div>
              <p v-if="draftError" class="mailbox-error" role="alert">{{ draftError }}</p>
              <p v-if="draftNotice" class="mailbox-notice" role="status">{{ draftNotice }}</p>
              <p v-if="draftLoading" class="mailbox-loading">正在读取草稿…</p>
              <div v-else-if="draftWorkspace?.drafts.length" class="draft-list">
                <article
                  v-for="draft in draftWorkspace.drafts"
                  :key="draft.id"
                  class="draft-list-row"
                  :class="{ 'draft-list-row--selected': selectedDraft?.id === draft.id }"
                >
                  <button type="button" @click="openDraft(draft.id)">
                    <span class="draft-list-recipient">
                      {{ draft.recipientPreview || '尚未填写收件人' }}
                    </span>
                    <strong>{{ draft.subject || '（无主题）' }}</strong>
                    <span>
                      {{ draft.conflictCopy ? '冲突副本 · ' : '' }}{{ formatDate(draft.updatedAt) }}
                    </span>
                  </button>
                  <button
                    v-if="draft.status === 'trashed'"
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="draftAction !== null"
                    @click="restoreDraft(draft.id)"
                  >
                    {{ draftAction === `restore:${draft.id}` ? '正在恢复' : '恢复' }}
                  </button>
                </article>
              </div>
              <p v-else class="empty-state">
                {{ draftListStatus === 'active' ? '草稿箱暂时为空。' : '没有已丢弃的草稿。' }}
              </p>
            </aside>

            <article class="draft-editor-panel">
              <template v-if="selectedDraft">
                <header class="draft-editor-header">
                  <button
                    class="icon-button draft-back-button"
                    type="button"
                    title="返回草稿列表"
                    aria-label="返回草稿列表"
                    @click="closeSelectedDraft"
                  >
                    <ArrowLeft :size="17" />
                  </button>
                  <div class="draft-save-status" :data-state="draftSaveState">
                    <span aria-hidden="true"></span>
                    {{ draftSaveStateLabel() }}
                  </div>
                  <div class="draft-editor-actions">
                    <button
                      v-if="selectedDraft.status === 'active'"
                      class="button button--primary button--compact"
                      type="button"
                      :disabled="draftSaveInFlight || draftAction !== null"
                      @click="sendCurrentDraft"
                    >
                      <Send :size="15" />
                      {{ draftAction === `send:${selectedDraft.id}` ? '正在发送' : '发送' }}
                    </button>
                    <button
                      v-if="selectedDraft.status === 'active'"
                      class="icon-button"
                      type="button"
                      title="更多草稿操作"
                      aria-label="更多草稿操作"
                      :aria-expanded="draftActionsOpen"
                      @click="draftActionsOpen = !draftActionsOpen"
                    >
                      <MoreHorizontal :size="18" />
                    </button>
                    <button
                      v-if="selectedDraft.status === 'active' && draftActionsOpen"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="draftSaveInFlight || draftAction !== null"
                      @click="saveDraftNow"
                    >
                      保存
                    </button>
                    <button
                      v-if="selectedDraft.status === 'active' && draftActionsOpen"
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="draftAction !== null"
                      @click="trashSelectedDraft"
                    >
                      {{ draftAction === `trash:${selectedDraft.id}` ? '正在丢弃' : '丢弃' }}
                    </button>
                    <button
                      v-else
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="draftAction !== null"
                      @click="restoreDraft(selectedDraft.id)"
                    >
                      恢复草稿
                    </button>
                  </div>
                </header>

                <p v-if="draftError" class="mailbox-error draft-editor-feedback" role="alert">
                  {{ draftError }}
                </p>
                <p v-if="draftNotice" class="mailbox-notice draft-editor-feedback" role="status">
                  {{ draftNotice }}
                </p>

                <form class="draft-editor-form" @submit.prevent="saveDraftNow">
                  <label class="draft-field-row">
                    <span>发件人</span>
                    <select
                      v-model="draftForm.senderAddressId"
                      :disabled="selectedDraft.status !== 'active'"
                      @change="scheduleDraftSave"
                    >
                      <option :value="null">未选择</option>
                      <option
                        v-for="sender in draftWorkspace?.senderAddresses ?? []"
                        :key="sender.id"
                        :value="sender.id"
                      >
                        {{ sender.organizationName ? `${sender.organizationName} · ` : ''
                        }}{{ sender.address }}
                      </option>
                    </select>
                    <small v-if="!selectedDraft.senderAvailable" class="field-error">
                      原发件地址当前不可用，请重新选择。
                    </small>
                  </label>
                  <label class="draft-field-row">
                    <span>收件人</span>
                    <input
                      v-model="draftForm.to"
                      type="text"
                      autocomplete="off"
                      placeholder="name@example.com"
                      :disabled="selectedDraft.status !== 'active'"
                      @input="scheduleDraftSave"
                    />
                  </label>
                  <button
                    class="draft-copy-toggle"
                    type="button"
                    :aria-expanded="draftCopiesOpen"
                    @click="draftCopiesOpen = !draftCopiesOpen"
                  >
                    {{ draftCopiesOpen ? '收起抄送与密送' : '添加抄送或密送' }}
                  </button>
                  <label v-show="draftCopiesOpen || Boolean(draftForm.cc)" class="draft-field-row">
                    <span>抄送</span>
                    <input
                      v-model="draftForm.cc"
                      type="text"
                      autocomplete="off"
                      :disabled="selectedDraft.status !== 'active'"
                      @input="scheduleDraftSave"
                    />
                  </label>
                  <label v-show="draftCopiesOpen || Boolean(draftForm.bcc)" class="draft-field-row">
                    <span>密送</span>
                    <input
                      v-model="draftForm.bcc"
                      type="text"
                      autocomplete="off"
                      :disabled="selectedDraft.status !== 'active'"
                      @input="scheduleDraftSave"
                    />
                  </label>
                  <label class="draft-field-row">
                    <span>主题</span>
                    <input
                      v-model="draftForm.subject"
                      type="text"
                      maxlength="998"
                      :disabled="selectedDraft.status !== 'active'"
                      @input="scheduleDraftSave"
                    />
                  </label>

                  <div class="draft-body-toolbar">
                    <div class="draft-format-switch" role="group" aria-label="正文格式">
                      <button
                        type="button"
                        :aria-pressed="draftForm.bodyFormat === 'rich_text'"
                        :disabled="selectedDraft.status !== 'active'"
                        @click="changeDraftBodyFormat('rich_text')"
                      >
                        富文本
                      </button>
                      <button
                        type="button"
                        :aria-pressed="draftForm.bodyFormat === 'plain_text'"
                        :disabled="selectedDraft.status !== 'active'"
                        @click="changeDraftBodyFormat('plain_text')"
                      >
                        纯文本
                      </button>
                    </div>
                    <div v-if="draftForm.bodyFormat === 'rich_text'" class="draft-format-actions">
                      <button
                        class="icon-button"
                        type="button"
                        title="加粗"
                        aria-label="加粗"
                        :disabled="selectedDraft.status !== 'active'"
                        @mousedown.prevent
                        @click="applyDraftFormat('bold')"
                      >
                        <Bold :size="16" />
                      </button>
                      <button
                        class="icon-button"
                        type="button"
                        title="斜体"
                        aria-label="斜体"
                        :disabled="selectedDraft.status !== 'active'"
                        @mousedown.prevent
                        @click="applyDraftFormat('italic')"
                      >
                        <Italic :size="16" />
                      </button>
                      <button
                        class="icon-button"
                        type="button"
                        title="项目列表"
                        aria-label="项目列表"
                        :disabled="selectedDraft.status !== 'active'"
                        @mousedown.prevent
                        @click="applyDraftFormat('insertUnorderedList')"
                      >
                        <List :size="16" />
                      </button>
                    </div>
                  </div>

                  <div
                    v-if="draftForm.bodyFormat === 'rich_text'"
                    ref="draftRichEditor"
                    class="draft-rich-editor"
                    :contenteditable="selectedDraft.status === 'active'"
                    role="textbox"
                    aria-label="邮件正文"
                    aria-multiline="true"
                    @input="handleRichDraftInput"
                  ></div>
                  <textarea
                    v-else
                    v-model="draftForm.body"
                    class="draft-plain-editor"
                    rows="14"
                    aria-label="邮件正文"
                    :readonly="selectedDraft.status !== 'active'"
                    @input="scheduleDraftSave"
                  ></textarea>

                  <section class="draft-attachments" aria-labelledby="draft-attachments-title">
                    <div class="section-heading--row">
                      <div>
                        <h2 id="draft-attachments-title">附件</h2>
                        <p>
                          {{ selectedDraft.attachments.length }} 个 ·
                          {{ formatFileSize(draftAttachmentTotalSize) }} / 20 MB
                        </p>
                      </div>
                      <label
                        v-if="selectedDraft.status === 'active'"
                        class="button button--secondary button--compact draft-upload-button"
                      >
                        <Paperclip :size="15" />
                        <span>{{ draftAction === 'attachment' ? '正在上传' : '添加附件' }}</span>
                        <input
                          type="file"
                          multiple
                          :disabled="draftAction !== null || draftSaveInFlight"
                          @change="uploadDraftFiles"
                        />
                      </label>
                    </div>
                    <div v-if="selectedDraft.attachments.length" class="draft-attachment-list">
                      <article
                        v-for="attachment in selectedDraft.attachments"
                        :key="attachment.id"
                        class="draft-attachment-row"
                      >
                        <div>
                          <strong>{{ attachment.fileName }}</strong>
                          <span>{{ formatFileSize(attachment.sizeBytes) }}</span>
                        </div>
                        <div>
                          <a
                            class="button button--secondary button--compact"
                            :href="draftAttachmentUrl(selectedDraft.id, attachment.id)"
                          >
                            下载
                          </a>
                          <button
                            v-if="selectedDraft.status === 'active'"
                            class="icon-button"
                            type="button"
                            title="移除附件"
                            :aria-label="`移除附件 ${attachment.fileName}`"
                            :disabled="draftSaveInFlight"
                            @click="removeDraftAttachment(attachment.id)"
                          >
                            <X :size="16" />
                          </button>
                        </div>
                      </article>
                    </div>
                    <p v-else class="empty-state">没有附件。</p>
                  </section>
                </form>
              </template>
              <div v-else-if="lastSendOperation" class="draft-send-result" aria-live="polite">
                <div class="section-heading section-heading--row">
                  <div>
                    <p class="eyebrow">发信结果</p>
                    <h2>{{ lastSendOperation.subject || '无主题' }}</h2>
                  </div>
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    @click="refreshLastSendOperation"
                  >
                    刷新状态
                  </button>
                </div>
                <p v-if="draftNotice" class="mailbox-notice" role="status">{{ draftNotice }}</p>
                <dl class="send-result-summary">
                  <div>
                    <dt>发件地址</dt>
                    <dd>{{ lastSendOperation.senderAddress }}</dd>
                  </div>
                  <div>
                    <dt>邮件大小</dt>
                    <dd>{{ formatFileSize(lastSendOperation.payloadSizeBytes) }}</dd>
                  </div>
                </dl>
                <div class="send-recipient-list">
                  <article v-for="recipient in lastSendOperation.recipients" :key="recipient.id">
                    <div>
                      <strong>{{ recipient.address }}</strong>
                      <small>{{
                        recipient.channel === 'internal' ? '系统内投递' : '域外投递'
                      }}</small>
                    </div>
                    <span class="status-label" :data-status="recipient.status">
                      {{ sendStatusLabel(recipient.status) }}
                    </span>
                  </article>
                </div>
              </div>
              <div v-else class="mailbox-detail-placeholder">
                <h2>选择或新建草稿</h2>
              </div>
            </article>
          </template>
        </section>

        <div v-else class="settings-workspace">
          <aside class="settings-navigation" aria-label="设置分类">
            <button
              class="settings-back-button"
              type="button"
              aria-label="返回邮件"
              @click="closeSettings"
            >
              <ArrowLeft :size="16" />
              <span>返回邮件</span>
            </button>

            <label class="settings-mobile-select">
              <span>当前设置</span>
              <select v-model="settingsSection">
                <optgroup label="个人">
                  <option value="account-security">账户与安全</option>
                  <option value="addresses">邮箱地址</option>
                  <option value="forwarding">自动转发</option>
                  <option value="notifications">外部通知</option>
                  <option value="exports">邮件导出</option>
                  <option value="account-lifecycle">账号注销</option>
                </optgroup>
                <optgroup label="协作">
                  <option value="organizations">组织与邀请</option>
                </optgroup>
                <optgroup v-if="authentication.user.role === 'administrator'" label="系统管理">
                  <option value="health">运行健康</option>
                  <option value="users">用户管理</option>
                  <option value="invitations">注册邀请码</option>
                  <option value="domains">邮件域名</option>
                  <option value="receiving">收信控制</option>
                  <option value="outbound">域外发信</option>
                  <option value="address-policy">地址策略</option>
                  <option value="alias-policy">用户别名</option>
                  <option value="organization-policy">组织配额</option>
                  <option value="storage">存储配额</option>
                  <option value="resources">免费资源</option>
                </optgroup>
              </select>
            </label>

            <p>个人</p>
            <button
              type="button"
              :aria-current="settingsSection === 'account-security' ? 'page' : undefined"
              @click="settingsSection = 'account-security'"
            >
              账户与安全
            </button>
            <button
              type="button"
              :aria-current="settingsSection === 'addresses' ? 'page' : undefined"
              @click="settingsSection = 'addresses'"
            >
              邮箱地址
            </button>
            <button
              type="button"
              :aria-current="settingsSection === 'forwarding' ? 'page' : undefined"
              @click="settingsSection = 'forwarding'"
            >
              自动转发
            </button>
            <button
              type="button"
              :aria-current="settingsSection === 'notifications' ? 'page' : undefined"
              @click="settingsSection = 'notifications'"
            >
              外部通知
            </button>
            <button
              type="button"
              :aria-current="settingsSection === 'exports' ? 'page' : undefined"
              @click="settingsSection = 'exports'"
            >
              邮件导出
            </button>
            <button
              type="button"
              :aria-current="settingsSection === 'account-lifecycle' ? 'page' : undefined"
              @click="settingsSection = 'account-lifecycle'"
            >
              账号注销
            </button>

            <p>协作</p>
            <button
              type="button"
              :aria-current="settingsSection === 'organizations' ? 'page' : undefined"
              @click="settingsSection = 'organizations'"
            >
              组织与邀请
            </button>

            <template v-if="authentication.user.role === 'administrator'">
              <p>系统管理</p>
              <button
                type="button"
                :aria-current="settingsSection === 'health' ? 'page' : undefined"
                @click="settingsSection = 'health'"
              >
                运行健康
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'users' ? 'page' : undefined"
                @click="settingsSection = 'users'"
              >
                用户管理
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'invitations' ? 'page' : undefined"
                @click="settingsSection = 'invitations'"
              >
                注册邀请码
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'domains' ? 'page' : undefined"
                @click="settingsSection = 'domains'"
              >
                邮件域名
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'receiving' ? 'page' : undefined"
                @click="settingsSection = 'receiving'"
              >
                收信控制
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'outbound' ? 'page' : undefined"
                @click="settingsSection = 'outbound'"
              >
                域外发信
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'address-policy' ? 'page' : undefined"
                @click="settingsSection = 'address-policy'"
              >
                地址策略
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'alias-policy' ? 'page' : undefined"
                @click="settingsSection = 'alias-policy'"
              >
                用户别名
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'organization-policy' ? 'page' : undefined"
                @click="settingsSection = 'organization-policy'"
              >
                组织配额
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'storage' ? 'page' : undefined"
                @click="settingsSection = 'storage'"
              >
                存储配额
              </button>
              <button
                type="button"
                :aria-current="settingsSection === 'resources' ? 'page' : undefined"
                @click="settingsSection = 'resources'"
              >
                免费资源
              </button>
            </template>
          </aside>

          <div class="settings-content">
            <section
              v-show="settingsSection === 'account-security'"
              class="sessions-section"
              aria-labelledby="sessions-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="sessions-title">登录会话</h2>
                  <p>{{ sessions.length }} 个有效会话</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="sessionLoading || sessionActionId !== null"
                  @click="refreshSessions"
                >
                  {{ sessionLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <div v-if="sessions.length" class="session-list">
                <article v-for="session in sessions" :key="session.id" class="session-row">
                  <div class="session-primary">
                    <div class="session-title">
                      <strong>{{ session.clientLabel }}</strong>
                      <span v-if="session.current">当前会话</span>
                    </div>
                    <dl class="session-details">
                      <div>
                        <dt>最近活动</dt>
                        <dd>{{ formatDate(session.lastActivityAt) }}</dd>
                      </div>
                      <div>
                        <dt>登录时间</dt>
                        <dd>{{ formatDate(session.createdAt) }}</dd>
                      </div>
                      <div>
                        <dt>最晚失效</dt>
                        <dd>{{ formatDate(session.absoluteExpiresAt) }}</dd>
                      </div>
                    </dl>
                  </div>
                  <button
                    class="button button--danger-quiet button--compact"
                    type="button"
                    :disabled="sessionActionId !== null"
                    @click="exitSession(session)"
                  >
                    {{ sessionActionId === session.id ? '正在退出' : '退出会话' }}
                  </button>
                </article>
              </div>
              <p v-else-if="!sessionLoading" class="empty-state">没有可显示的登录会话。</p>
            </section>

            <section
              v-show="settingsSection === 'exports'"
              class="account-settings-section"
              aria-labelledby="mail-exports-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="mail-exports-title">邮件导出</h2>
                  <p>导出你有权访问的邮件，生成的 ZIP 文件默认保留 7 天。</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="mailExportLoading || mailExportAction !== null"
                  @click="refreshMailExportManagement()"
                >
                  {{ mailExportLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>
              <p v-if="mailExportError" class="form-alert" role="alert">{{ mailExportError }}</p>
              <p v-if="mailExportNotice" class="form-success" role="status">
                {{ mailExportNotice }}
              </p>

              <form class="account-form" @submit.prevent="submitMailExport">
                <div class="form-grid mail-export-create-grid">
                  <label class="field">
                    <span>导出范围</span>
                    <select v-model="mailExportScope" name="mail-export-scope">
                      <option value="personal">我的个人邮件</option>
                      <option v-if="mailExportOverview?.organizations.length" value="organization">
                        组织邮件
                      </option>
                    </select>
                  </label>
                  <label v-if="mailExportScope === 'organization'" class="field">
                    <span>组织</span>
                    <select
                      v-model="mailExportOrganizationId"
                      name="mail-export-organization"
                      required
                    >
                      <option
                        v-for="organization in mailExportOverview?.organizations ?? []"
                        :key="organization.id"
                        :value="organization.id"
                      >
                        {{ organization.name }}
                      </option>
                    </select>
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      mailExportAction !== null ||
                      (mailExportScope === 'organization' && !mailExportOrganizationId)
                    "
                  >
                    {{ mailExportAction === 'create' ? '正在创建' : '开始导出' }}
                  </button>
                </div>
              </form>

              <div v-if="mailExportOverview?.runs.length" class="mail-export-list">
                <article
                  v-for="run in mailExportOverview.runs"
                  :key="run.id"
                  class="mail-export-row"
                >
                  <div>
                    <div class="mail-export-heading">
                      <strong>{{ mailExportScopeLabel(run) }}</strong>
                      <span class="status-label" :data-status="run.status">
                        {{ mailExportStatusLabel(run.status) }}
                      </span>
                    </div>
                    <small>
                      {{ run.frozenMessageCount }} 封邮件 · {{ formatDate(run.createdAt) }}
                      <span v-if="run.status === 'succeeded'">
                        · {{ run.artifactCount }} 个分卷</span
                      >
                    </small>
                    <small v-if="run.errorCode" class="field-error"
                      >错误：{{ run.errorCode }}</small
                    >
                  </div>
                  <div class="mail-export-actions">
                    <a
                      v-for="artifact in run.artifacts"
                      :key="artifact.id"
                      class="button button--secondary button--compact"
                      :href="artifact.downloadUrl"
                    >
                      下载第 {{ artifact.sequenceNumber }} 卷
                    </a>
                    <button
                      v-if="!['planned', 'running'].includes(run.status)"
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="mailExportAction !== null"
                      @click="removeMailExport(run)"
                    >
                      {{ mailExportAction === `delete:${run.id}` ? '正在删除' : '删除记录' }}
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!mailExportLoading" class="empty-state">还没有邮件导出记录。</p>
            </section>

            <section
              v-show="settingsSection === 'addresses'"
              class="account-settings-section"
              aria-labelledby="personal-addresses-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="personal-addresses-title">我的邮箱地址</h2>
                  <p>
                    已使用 {{ personalAddressOverview?.policy.aliasUsed ?? 0 }} /
                    {{ personalAddressOverview?.policy.aliasLimit ?? 0 }}
                    个个人别名
                  </p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="personalAddressLoading || personalAddressActionId !== null"
                  @click="refreshPersonalAddressManagement"
                >
                  {{ personalAddressLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <form
                v-if="personalAddressOverview?.policy.selfCreationEnabled"
                class="account-form management-create-form"
                @submit.prevent="submitPersonalAliasCreation"
              >
                <div class="form-grid address-create-grid">
                  <label class="field">
                    <span>邮箱前缀</span>
                    <input
                      v-model="personalAliasForm.localPart"
                      name="personal-alias-local-part"
                      inputmode="email"
                      autocapitalize="none"
                      maxlength="64"
                      required
                      :aria-invalid="Boolean(personalAliasErrors.localPart)"
                    />
                    <small v-if="personalAliasErrors.localPart" class="field-error">{{
                      personalAliasErrors.localPart
                    }}</small>
                  </label>
                  <label class="field">
                    <span>邮件域名</span>
                    <select
                      v-model="personalAliasForm.domainId"
                      name="personal-alias-domain"
                      required
                      :aria-invalid="Boolean(personalAliasErrors.domainId)"
                    >
                      <option value="" disabled>选择域名</option>
                      <option
                        v-for="domain in personalAddressOverview.activeDomains"
                        :key="domain.id"
                        :value="domain.id"
                      >
                        {{ domain.canonicalName }}
                      </option>
                    </select>
                    <small v-if="personalAliasErrors.domainId" class="field-error">{{
                      personalAliasErrors.domainId
                    }}</small>
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      personalAddressActionId !== null ||
                      personalAddressOverview.policy.aliasUsed >=
                        personalAddressOverview.policy.aliasLimit ||
                      personalAddressOverview.activeDomains.length === 0
                    "
                  >
                    {{ personalAddressActionId === 'create:self' ? '正在创建' : '创建个人别名' }}
                  </button>
                </div>
              </form>
              <p v-else-if="personalAddressOverview" class="form-notice">
                管理员已关闭个人别名自助创建，现有地址仍可正常使用。
              </p>

              <div v-if="personalAddressOverview?.addresses.length" class="personal-address-list">
                <article
                  v-for="address in personalAddressOverview.addresses"
                  :key="address.id"
                  class="personal-address-row"
                >
                  <div class="personal-address-identity">
                    <div class="personal-address-title">
                      <strong>{{ address.address }}</strong>
                      <span class="status-label">{{
                        address.role === 'primary' ? '主地址' : '别名'
                      }}</span>
                      <span v-if="address.isDefaultSender" class="status-label">默认发件</span>
                    </div>
                    <p>{{ address.domainDisplayName }}</p>
                  </div>

                  <div class="personal-address-preferences">
                    <label class="field field--compact">
                      <span>显示名称</span>
                      <input
                        v-model="addressPreferenceDraft(address).customLabel"
                        :name="`address-label-${address.id}`"
                        maxlength="80"
                        placeholder="使用账号显示名称"
                      />
                    </label>
                    <label class="checkbox-field personal-address-pin">
                      <input v-model="addressPreferenceDraft(address).isPinned" type="checkbox" />
                      <span>置顶</span>
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="personalAddressActionId !== null"
                      @click="savePersonalAddressPreference(address)"
                    >
                      {{
                        personalAddressActionId === `preference:${address.id}`
                          ? '正在保存'
                          : '保存设置'
                      }}
                    </button>
                  </div>

                  <div class="personal-address-actions">
                    <button
                      class="button button--secondary button--icon"
                      type="button"
                      title="上移"
                      :aria-label="`上移 ${address.address}`"
                      :disabled="
                        personalAddressActionId !== null || !canMovePersonalAddress(address, 'up')
                      "
                      @click="changePersonalAddressOrder(address, 'up')"
                    >
                      ↑
                    </button>
                    <button
                      class="button button--secondary button--icon"
                      type="button"
                      title="下移"
                      :aria-label="`下移 ${address.address}`"
                      :disabled="
                        personalAddressActionId !== null || !canMovePersonalAddress(address, 'down')
                      "
                      @click="changePersonalAddressOrder(address, 'down')"
                    >
                      ↓
                    </button>
                    <button
                      v-if="!address.isDefaultSender"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="personalAddressActionId !== null"
                      @click="changeDefaultSender(address)"
                    >
                      {{
                        personalAddressActionId === `default:${address.id}`
                          ? '正在设置'
                          : '设为默认发件'
                      }}
                    </button>
                    <button
                      v-if="address.role === 'alias'"
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="personalAddressActionId !== null"
                      @click="requestPersonalAliasDeletion(address)"
                    >
                      删除
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!personalAddressLoading" class="empty-state">没有可显示的邮箱地址。</p>

              <section
                v-if="aliasPendingDeletion && !aliasPendingDeletion.administratorAction"
                class="destructive-confirmation"
                aria-labelledby="personal-alias-deletion-title"
              >
                <h2 id="personal-alias-deletion-title">删除个人别名</h2>
                <p>
                  将删除 <strong>{{ aliasPendingDeletion.address.address }}</strong
                  >。{{ aliasDeletionImpactText() }}
                </p>
                <label class="checkbox-field">
                  <input v-model="aliasDeletionConfirmed" type="checkbox" />
                  <span>{{ aliasDeletionConfirmationText() }}</span>
                </label>
                <div class="confirmation-actions">
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="personalAddressActionId !== null"
                    @click="cancelAliasDeletion"
                  >
                    取消
                  </button>
                  <button
                    class="button button--danger-quiet button--compact"
                    type="button"
                    :disabled="!aliasDeletionConfirmed || personalAddressActionId !== null"
                    @click="confirmAliasDeletion"
                  >
                    {{
                      personalAddressActionId === `delete:${aliasPendingDeletion.address.id}`
                        ? '正在删除'
                        : '确认删除'
                    }}
                  </button>
                </div>
              </section>
            </section>

            <section
              v-show="settingsSection === 'organizations'"
              class="account-settings-section"
              aria-labelledby="organizations-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="organizations-title">组织与邀请</h2>
                  <p>
                    已创建 {{ organizationOverview?.policy.ownedOrganizationCount ?? 0 }} /
                    {{ organizationOverview?.policy.organizationLimit ?? 0 }} 个组织
                  </p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="organizationLoading || organizationActionId !== null"
                  @click="refreshOrganizationManagement"
                >
                  {{ organizationLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <div class="organization-preference-row">
                <label class="field field--compact">
                  <span>收到组织邀请时</span>
                  <select
                    v-model="organizationInvitationPolicyDraft"
                    name="organization-invitation-policy"
                  >
                    <option value="reject_all">全部拒绝</option>
                    <option value="manual">每次确认</option>
                    <option value="auto_accept">自动接受</option>
                  </select>
                </label>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="organizationActionId !== null"
                  @click="saveOrganizationInvitationPolicy"
                >
                  {{ organizationActionId === 'invitation-policy' ? '正在保存' : '保存邀请策略' }}
                </button>
              </div>

              <div
                v-if="organizationOverview?.pendingInvitations.length"
                class="organization-invitation-list"
              >
                <article
                  v-for="invitation in organizationOverview.pendingInvitations"
                  :key="invitation.id"
                  class="organization-invitation-row"
                >
                  <div>
                    <strong>{{ invitation.organizationName }}</strong>
                    <p>
                      {{ invitation.sharedAddress }} ·
                      {{ invitation.invitedByDisplayName }} 邀请你加入
                    </p>
                  </div>
                  <div class="organization-row-actions">
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="organizationActionId !== null"
                      @click="respondToOrganizationInvitation(invitation.id, 'reject')"
                    >
                      {{ organizationActionId === `reject:${invitation.id}` ? '正在拒绝' : '拒绝' }}
                    </button>
                    <button
                      class="button button--primary button--compact"
                      type="button"
                      :disabled="organizationActionId !== null"
                      @click="respondToOrganizationInvitation(invitation.id, 'accept')"
                    >
                      {{ organizationActionId === `accept:${invitation.id}` ? '正在加入' : '接受' }}
                    </button>
                  </div>
                </article>
              </div>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitOrganizationCreation"
              >
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>组织名称</span>
                    <input
                      v-model="organizationForm.name"
                      name="new-organization-name"
                      maxlength="120"
                      required
                      :aria-invalid="Boolean(organizationErrors.name)"
                    />
                    <small v-if="organizationErrors.name" class="field-error">{{
                      organizationErrors.name
                    }}</small>
                  </label>
                  <label class="field">
                    <span>共享邮箱前缀</span>
                    <input
                      v-model="organizationForm.localPart"
                      name="new-organization-local-part"
                      inputmode="email"
                      autocapitalize="none"
                      maxlength="64"
                      required
                      :aria-invalid="Boolean(organizationErrors.localPart)"
                    />
                    <small v-if="organizationErrors.localPart" class="field-error">{{
                      organizationErrors.localPart
                    }}</small>
                  </label>
                  <label class="field">
                    <span>邮件域名</span>
                    <select
                      v-model="organizationForm.domainId"
                      name="new-organization-domain"
                      required
                      :aria-invalid="Boolean(organizationErrors.domainId)"
                    >
                      <option value="" disabled>选择域名</option>
                      <option
                        v-for="domain in organizationOverview?.activeDomains ?? []"
                        :key="domain.id"
                        :value="domain.id"
                      >
                        {{ domain.canonicalName }}
                      </option>
                    </select>
                    <small v-if="organizationErrors.domainId" class="field-error">{{
                      organizationErrors.domainId
                    }}</small>
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      organizationActionId !== null ||
                      !(organizationOverview?.activeDomains.length ?? 0) ||
                      (organizationOverview?.policy.remainingOrganizationCount ?? 0) === 0
                    "
                  >
                    {{ organizationActionId === 'create' ? '正在建立' : '创建组织' }}
                  </button>
                </div>
              </form>

              <div v-if="organizationOverview?.organizations.length" class="organization-list">
                <article
                  v-for="organization in organizationOverview.organizations"
                  :key="organization.id"
                  class="organization-row"
                >
                  <div class="organization-row-heading">
                    <div>
                      <div class="managed-user-title">
                        <strong>{{ organization.name }}</strong>
                        <span class="status-label">
                          {{ organization.isCreator ? '创建者' : '成员' }}
                        </span>
                        <span
                          v-if="organization.status === 'deletion_pending'"
                          class="status-label status-label--disabled"
                        >
                          已停用
                        </span>
                      </div>
                      <p>{{ organization.sharedAddress }}</p>
                    </div>
                    <div class="organization-row-actions">
                      <button
                        v-if="organization.status === 'deletion_pending'"
                        class="button button--secondary button--compact"
                        type="button"
                        :disabled="organizationActionId !== null"
                        @click="restorePendingOrganization(organization)"
                      >
                        {{
                          organizationActionId === `restore:${organization.id}`
                            ? '正在恢复'
                            : '恢复组织'
                        }}
                      </button>
                      <template v-else>
                        <button
                          class="button button--secondary button--compact"
                          type="button"
                          :disabled="organizationActionId !== null"
                          @click="requestOrganizationAction(organization, 'leave')"
                        >
                          退出组织
                        </button>
                        <button
                          v-if="organization.isCreator"
                          class="button button--danger-quiet button--compact"
                          type="button"
                          :disabled="organizationActionId !== null"
                          @click="requestOrganizationAction(organization, 'delete')"
                        >
                          删除组织
                        </button>
                      </template>
                    </div>
                  </div>

                  <p
                    v-if="organization.status === 'deletion_pending'"
                    class="organization-pending-note"
                  >
                    恢复期至
                    {{
                      organization.deletionDueAt ? formatDate(organization.deletionDueAt) : '已结束'
                    }}
                  </p>

                  <div class="organization-member-list">
                    <div v-for="member in organization.members" :key="member.membershipId">
                      <span>
                        <strong>{{ member.displayName }}</strong>
                        <small>{{ member.primaryAddress }}</small>
                      </span>
                      <span class="status-label">{{
                        member.role === 'creator' ? '创建者' : '成员'
                      }}</span>
                    </div>
                  </div>

                  <template v-if="organization.isCreator && organization.status === 'active'">
                    <div class="organization-setting-row">
                      <div>
                        <strong>普通成员使用组织地址发信</strong>
                        <small>创建者始终可以使用组织地址</small>
                      </div>
                      <button
                        class="button button--secondary button--compact"
                        type="button"
                        :disabled="organizationActionId !== null"
                        @click="toggleOrganizationSendingPermission(organization)"
                      >
                        {{
                          organizationActionId === `sending:${organization.id}`
                            ? '正在保存'
                            : organization.membersCanSend
                              ? '关闭'
                              : '开启'
                        }}
                      </button>
                    </div>

                    <form
                      class="organization-invite-form"
                      @submit.prevent="submitOrganizationInvitation(organization)"
                    >
                      <label class="field field--compact">
                        <span>邀请现有用户</span>
                        <input
                          v-model="organizationInvitationInputs[organization.id]"
                          :name="`organization-invite-${organization.id}`"
                          type="email"
                          inputmode="email"
                          autocapitalize="none"
                          placeholder="对方的主邮箱地址"
                          maxlength="320"
                          required
                        />
                      </label>
                      <button
                        class="button button--secondary button--compact"
                        type="submit"
                        :disabled="organizationActionId !== null"
                      >
                        {{
                          organizationActionId === `invite:${organization.id}`
                            ? '正在邀请'
                            : '发送邀请'
                        }}
                      </button>
                    </form>

                    <div
                      v-if="organization.pendingInvitations.length"
                      class="organization-pending-invitations"
                    >
                      <div
                        v-for="invitation in organization.pendingInvitations"
                        :key="invitation.id"
                      >
                        <span>
                          {{ invitation.invitedUserDisplayName }} ·
                          {{ invitation.invitedUserPrimaryAddress }}
                        </span>
                        <button
                          class="button button--danger-quiet button--compact"
                          type="button"
                          :disabled="organizationActionId !== null"
                          @click="withdrawOrganizationInvitation(organization.id, invitation.id)"
                        >
                          {{
                            organizationActionId === `revoke:${invitation.id}` ? '正在撤回' : '撤回'
                          }}
                        </button>
                      </div>
                    </div>
                  </template>
                </article>
              </div>
              <p v-else-if="!organizationLoading" class="empty-state">尚未加入或创建组织。</p>

              <section
                v-if="pendingOrganizationAction"
                class="destructive-confirmation"
                aria-labelledby="organization-action-title"
              >
                <h2 id="organization-action-title">
                  {{ pendingOrganizationAction.kind === 'delete' ? '删除组织' : '退出组织' }}
                </h2>
                <p>
                  <strong>{{ pendingOrganizationAction.organization.name }}</strong
                  >：{{ organizationActionImpactText() }}
                </p>
                <label
                  v-if="
                    pendingOrganizationAction.kind === 'leave' &&
                    pendingOrganizationAction.organization.isCreator &&
                    pendingOrganizationAction.organization.memberCount > 1
                  "
                  class="field organization-successor-field"
                >
                  <span>继承创建者的成员</span>
                  <select v-model="pendingOrganizationAction.successorUserId" required>
                    <option
                      v-for="member in pendingOrganizationAction.organization.members.filter(
                        (item) => item.userId !== authentication?.user.id,
                      )"
                      :key="member.userId"
                      :value="member.userId"
                    >
                      {{ member.displayName }} · {{ member.primaryAddress }}
                    </option>
                  </select>
                  <small v-if="organizationErrors.successorUserId" class="field-error">{{
                    organizationErrors.successorUserId
                  }}</small>
                </label>
                <label class="checkbox-field">
                  <input v-model="pendingOrganizationAction.confirmed" type="checkbox" />
                  <span>我已了解这次操作对地址、成员和邮件访问的影响</span>
                </label>
                <div class="confirmation-actions">
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="organizationActionId !== null"
                    @click="cancelOrganizationAction"
                  >
                    取消
                  </button>
                  <button
                    class="button button--danger-quiet button--compact"
                    type="button"
                    :disabled="
                      !pendingOrganizationAction.confirmed ||
                      organizationActionId !== null ||
                      (pendingOrganizationAction.kind === 'leave' &&
                        pendingOrganizationAction.organization.isCreator &&
                        pendingOrganizationAction.organization.memberCount > 1 &&
                        !pendingOrganizationAction.successorUserId)
                    "
                    @click="confirmOrganizationAction"
                  >
                    {{ organizationActionId ? '正在处理' : '确认继续' }}
                  </button>
                </div>
              </section>
            </section>

            <section
              v-show="settingsSection === 'forwarding'"
              class="account-settings-section"
              aria-labelledby="forwarding-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="forwarding-title">自动转发</h2>
                  <p>{{ forwardingOverview?.rules.length ?? 0 }} 条当前规则</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="forwardingLoading || forwardingAction !== null"
                  @click="refreshForwardingManagement"
                >
                  {{ forwardingLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="forwardingError" class="form-alert" role="alert">
                {{ forwardingError }}
              </p>
              <p v-if="forwardingNotice" class="form-success" role="status">
                {{ forwardingNotice }}
              </p>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitForwardingTarget"
              >
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>外部邮箱</span>
                    <input
                      v-model="forwardingTargetEmail"
                      name="forwarding-target-email"
                      type="email"
                      inputmode="email"
                      autocapitalize="none"
                      autocomplete="email"
                      maxlength="320"
                      required
                    />
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="forwardingAction !== null"
                  >
                    {{ forwardingAction === 'target:create' ? '正在发送' : '发送验证码' }}
                  </button>
                </div>
              </form>

              <div v-if="forwardingOverview?.targets.length" class="notification-subscription-list">
                <article
                  v-for="target in forwardingOverview.targets"
                  :key="target.id"
                  class="notification-subscription-row forwarding-target-row"
                >
                  <div class="notification-subscription-primary">
                    <div class="managed-user-title">
                      <strong>{{ target.emailAddress }}</strong>
                      <span class="status-label">{{ externalEmailTargetStatusLabel(target) }}</span>
                    </div>
                    <small v-if="target.verifiedAt">
                      验证于 {{ formatDate(target.verifiedAt) }}
                    </small>
                    <form
                      v-if="
                        target.status === 'pending' &&
                        target.latestVerificationStatus === 'pending_input'
                      "
                      class="forwarding-code-form"
                      @submit.prevent="submitForwardingVerification(target)"
                    >
                      <label class="field">
                        <span>一次性验证码</span>
                        <input
                          v-model="forwardingVerificationCodes[target.id]"
                          :name="`forwarding-code-${target.id}`"
                          autocomplete="one-time-code"
                          autocapitalize="characters"
                          maxlength="19"
                          required
                        />
                      </label>
                      <button
                        class="button button--primary button--compact"
                        type="submit"
                        :disabled="forwardingAction !== null"
                      >
                        验证
                      </button>
                    </form>
                  </div>
                  <div class="notification-subscription-actions">
                    <button
                      v-if="target.status !== 'verified'"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="forwardingAction !== null"
                      @click="resendForwardingTarget(target)"
                    >
                      重发
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="forwardingAction !== null"
                      @click="removeForwardingTarget(target)"
                    >
                      删除
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!forwardingLoading" class="empty-state">尚未添加外部邮箱。</p>

              <form
                v-if="forwardingOverview?.targets.some((target) => target.status === 'verified')"
                class="account-form management-create-form forwarding-rule-form"
                @submit.prevent="submitForwardingRule"
              >
                <div class="section-heading">
                  <h3>{{ forwardingRuleForm.ruleId ? '编辑转发规则' : '建立转发规则' }}</h3>
                </div>
                <div class="form-grid">
                  <label class="field">
                    <span>转发目标</span>
                    <select v-model="forwardingRuleForm.targetId" required>
                      <option
                        v-for="target in forwardingOverview.targets.filter(
                          (item) => item.status === 'verified',
                        )"
                        :key="target.id"
                        :value="target.id"
                      >
                        {{ target.emailAddress }}
                      </option>
                    </select>
                  </label>
                  <label class="field">
                    <span>邮件来源</span>
                    <select v-model="forwardingRuleForm.scope">
                      <option value="all_personal">全部个人地址</option>
                      <option value="selected_personal_addresses">指定个人地址</option>
                    </select>
                  </label>
                </div>
                <fieldset
                  v-if="forwardingRuleForm.scope === 'selected_personal_addresses'"
                  class="notification-scopes"
                >
                  <legend>个人地址</legend>
                  <label
                    v-for="address in forwardingOverview.addresses"
                    :key="address.id"
                    class="checkbox-field"
                  >
                    <input
                      v-model="forwardingRuleForm.addressIds"
                      type="checkbox"
                      :value="address.id"
                    />
                    <span>{{ address.address }}</span>
                  </label>
                </fieldset>
                <label class="checkbox-field">
                  <input v-model="forwardingRuleForm.enabled" type="checkbox" />
                  <span>保存后立即启用</span>
                </label>
                <div class="form-actions form-actions--end">
                  <button
                    v-if="forwardingRuleForm.ruleId"
                    class="button button--secondary"
                    type="button"
                    :disabled="forwardingAction !== null"
                    @click="resetForwardingRuleForm"
                  >
                    取消编辑
                  </button>
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      forwardingAction !== null ||
                      !forwardingRuleForm.targetId ||
                      (forwardingRuleForm.scope === 'selected_personal_addresses' &&
                        forwardingRuleForm.addressIds.length === 0)
                    "
                  >
                    {{ forwardingAction === 'rule:save' ? '正在保存' : '保存规则' }}
                  </button>
                </div>
              </form>

              <div v-if="forwardingOverview?.rules.length" class="notification-subscription-list">
                <article
                  v-for="rule in forwardingOverview.rules"
                  :key="rule.id"
                  class="notification-subscription-row"
                >
                  <div class="notification-subscription-primary">
                    <div class="managed-user-title">
                      <strong>{{ rule.targetAddress }}</strong>
                      <span class="status-label">
                        {{ rule.status === 'active' ? '启用' : '暂停' }}
                      </span>
                    </div>
                    <small>
                      {{
                        rule.scope === 'all_personal'
                          ? '全部个人地址'
                          : forwardingOverview.addresses
                              .filter((address) => rule.addressIds.includes(address.id))
                              .map((address) => address.address)
                              .join('、')
                      }}
                    </small>
                  </div>
                  <div class="notification-subscription-actions">
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="forwardingAction !== null"
                      @click="editForwardingRule(rule)"
                    >
                      编辑
                    </button>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="forwardingAction !== null"
                      @click="toggleForwardingRule(rule)"
                    >
                      {{ rule.status === 'active' ? '暂停' : '恢复' }}
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="forwardingAction !== null"
                      @click="removeForwardingRule(rule)"
                    >
                      删除
                    </button>
                  </div>
                </article>
              </div>

              <div v-if="forwardingOverview?.recentResults.length" class="notification-results">
                <div class="section-heading"><h3>最近转发</h3></div>
                <div class="notification-result-list">
                  <article
                    v-for="operation in forwardingOverview.recentResults"
                    :key="operation.id"
                  >
                    <div>
                      <strong>{{ operation.subject || '（无主题）' }}</strong>
                      <small>
                        {{ operation.actualAddress }} → {{ operation.targetAddress }} ·
                        {{ formatDate(operation.createdAt) }}
                      </small>
                      <small v-if="operation.errorSummary">{{ operation.errorSummary }}</small>
                    </div>
                    <span class="status-label">
                      {{ forwardingResultStatusLabel(operation.status) }}
                    </span>
                  </article>
                </div>
              </div>
            </section>

            <section
              v-show="settingsSection === 'notifications'"
              class="account-settings-section"
              aria-labelledby="notification-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="notification-title">外部通知</h2>
                  <p>{{ notificationOverview?.subscriptions.length ?? 0 }} 个通知订阅</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="notificationLoading || notificationAction !== null"
                  @click="refreshNotificationManagement"
                >
                  {{ notificationLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="notificationError" class="form-alert" role="alert">
                {{ notificationError }}
              </p>
              <p v-if="notificationNotice" class="form-success" role="status">
                {{ notificationNotice }}
              </p>
              <p
                v-if="notificationOverview && !notificationOverview.encryptionConfigured"
                class="form-alert"
              >
                部署配置中尚未设置 CONFIG_KEY。
              </p>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitNotificationSubscription"
              >
                <div class="form-grid notification-form-grid">
                  <label class="field">
                    <span>订阅名称</span>
                    <input
                      v-model="notificationForm.displayName"
                      name="notification-name"
                      maxlength="120"
                      required
                    />
                  </label>
                  <label class="field">
                    <span>通知通道</span>
                    <select
                      v-model="notificationForm.channelType"
                      name="notification-channel"
                      @change="changeNotificationChannel"
                    >
                      <option value="ntfy">ntfy</option>
                      <option value="gotify">Gotify</option>
                      <option value="wxpusher">WxPusher</option>
                      <option value="telegram">Telegram</option>
                      <option value="bark">Bark</option>
                    </select>
                  </label>
                  <label
                    v-if="['ntfy', 'gotify', 'bark'].includes(notificationForm.channelType)"
                    class="field field--wide"
                  >
                    <span>服务地址</span>
                    <input
                      v-model="notificationForm.baseUrl"
                      name="notification-base-url"
                      type="url"
                      inputmode="url"
                      autocapitalize="none"
                      placeholder="https://push.example.com"
                      required
                    />
                  </label>
                  <label
                    v-if="notificationDestinationLabel(notificationForm.channelType)"
                    class="field field--wide"
                  >
                    <span>{{ notificationDestinationLabel(notificationForm.channelType) }}</span>
                    <input
                      v-model="notificationForm.destination"
                      name="notification-destination"
                      autocapitalize="none"
                      maxlength="256"
                      required
                    />
                  </label>
                  <label class="field field--wide">
                    <span>{{ notificationCredentialLabel(notificationForm.channelType) }}</span>
                    <input
                      v-model="notificationForm.credential"
                      name="notification-credential"
                      type="password"
                      autocomplete="off"
                      maxlength="4096"
                      :required="notificationForm.channelType !== 'ntfy'"
                    />
                  </label>
                </div>

                <fieldset class="notification-scopes">
                  <legend>邮件来源</legend>
                  <label class="checkbox-field">
                    <input v-model="notificationForm.allPersonal" type="checkbox" />
                    <span>全部个人邮箱</span>
                  </label>
                  <label
                    v-for="scope in notificationOverview?.availableScopes ?? []"
                    :key="`${scope.kind}:${scope.addressId}`"
                    class="checkbox-field"
                  >
                    <input
                      v-model="notificationForm.addressIds"
                      type="checkbox"
                      :value="scope.addressId"
                      :disabled="notificationForm.allPersonal && scope.kind === 'personal_address'"
                    />
                    <span>{{ scope.label }} · {{ scope.address }}</span>
                  </label>
                </fieldset>

                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      notificationAction !== null || !notificationOverview?.encryptionConfigured
                    "
                  >
                    {{ notificationAction === 'create' ? '正在建立' : '建立通知订阅' }}
                  </button>
                </div>
              </form>

              <div
                v-if="notificationOverview?.subscriptions.length"
                class="notification-subscription-list"
              >
                <article
                  v-for="subscription in notificationOverview.subscriptions"
                  :key="subscription.id"
                  class="notification-subscription-row"
                >
                  <div class="notification-subscription-primary">
                    <div class="managed-user-title">
                      <strong>{{ subscription.displayName }}</strong>
                      <span class="status-label">
                        {{ notificationChannelLabel(subscription.channelType) }} ·
                        {{ subscription.status === 'active' ? '启用' : '暂停' }}
                      </span>
                    </div>
                    <p v-if="subscription.baseUrl">{{ subscription.baseUrl }}</p>
                    <p v-if="subscription.destination">{{ subscription.destination }}</p>
                    <small>{{ subscription.scopes.map((scope) => scope.label).join('、') }}</small>
                  </div>
                  <div class="notification-subscription-actions">
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="notificationAction !== null"
                      @click="toggleNotificationSubscription(subscription)"
                    >
                      {{ subscription.status === 'active' ? '暂停' : '恢复' }}
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="notificationAction !== null"
                      @click="removeNotificationSubscription(subscription)"
                    >
                      删除
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!notificationLoading" class="empty-state">尚未建立通知订阅。</p>

              <div
                v-if="notificationOverview?.recentOperations.length"
                class="notification-results"
              >
                <div class="section-heading"><h3>最近通知</h3></div>
                <div class="notification-result-list">
                  <article
                    v-for="operation in notificationOverview.recentOperations"
                    :key="operation.id"
                  >
                    <div>
                      <strong>{{ operation.subject || '（无主题）' }}</strong>
                      <small>
                        {{ operation.subscriptionName }} · {{ formatDate(operation.createdAt) }}
                      </small>
                      <small v-if="operation.errorSummary">{{ operation.errorSummary }}</small>
                    </div>
                    <span class="status-label">
                      {{ notificationOperationStatusLabel(operation.status) }}
                    </span>
                  </article>
                </div>
              </div>
            </section>

            <section
              v-show="settingsSection === 'account-security'"
              class="account-settings-section"
              aria-labelledby="password-title"
            >
              <div class="section-heading">
                <h2 id="password-title">修改密码</h2>
              </div>

              <form class="account-form" @submit.prevent="submitPasswordChange">
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>当前密码</span>
                    <input
                      v-model="passwordForm.currentPassword"
                      :type="passwordForm.showPassword ? 'text' : 'password'"
                      name="current-password"
                      autocomplete="current-password"
                      maxlength="128"
                      required
                      :aria-invalid="Boolean(passwordErrors.currentPassword)"
                    />
                    <small v-if="passwordErrors.currentPassword" class="field-error">{{
                      passwordErrors.currentPassword
                    }}</small>
                  </label>

                  <label class="field">
                    <span>新密码</span>
                    <input
                      v-model="passwordForm.newPassword"
                      :type="passwordForm.showPassword ? 'text' : 'password'"
                      name="new-password"
                      autocomplete="new-password"
                      maxlength="128"
                      required
                      :aria-invalid="Boolean(passwordErrors.newPassword)"
                    />
                    <small v-if="passwordErrors.newPassword" class="field-error">{{
                      passwordErrors.newPassword
                    }}</small>
                  </label>

                  <label class="field">
                    <span>确认新密码</span>
                    <input
                      v-model="passwordForm.confirmPassword"
                      :type="passwordForm.showPassword ? 'text' : 'password'"
                      name="confirm-new-password"
                      autocomplete="new-password"
                      maxlength="128"
                      required
                      :aria-invalid="Boolean(passwordErrors.confirmPassword)"
                    />
                    <small v-if="passwordErrors.confirmPassword" class="field-error">{{
                      passwordErrors.confirmPassword
                    }}</small>
                  </label>

                  <label class="checkbox-field field--wide">
                    <input v-model="passwordForm.showPassword" type="checkbox" />
                    <span>显示密码</span>
                  </label>
                  <label class="checkbox-field field--wide">
                    <input v-model="passwordForm.revokeOtherSessions" type="checkbox" />
                    <span>退出其他设备</span>
                  </label>
                </div>

                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="passwordSubmitting"
                  >
                    {{ passwordSubmitting ? '正在修改' : '修改密码' }}
                  </button>
                </div>
              </form>
            </section>

            <section
              v-show="settingsSection === 'account-lifecycle'"
              class="account-settings-section"
              aria-labelledby="account-lifecycle-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="account-lifecycle-title">账号注销</h2>
                  <p>提交后立即退出所有设备，七天内可恢复，期满后永久清理账号数据。</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="accountLifecycleLoading || accountLifecycleSubmitting"
                  @click="refreshAccountLifecycle"
                >
                  {{ accountLifecycleLoading ? '正在检查' : '检查状态' }}
                </button>
              </div>

              <p v-if="accountLifecycleError" class="form-alert" role="alert">
                {{ accountLifecycleError }}
              </p>
              <p v-if="accountLifecycleNotice" class="form-success" role="status">
                {{ accountLifecycleNotice }}
              </p>

              <div v-if="accountLifecycle?.blockers.length" class="account-lifecycle-blockers">
                <p class="form-notice">需要先处理以下事项：</p>
                <ul>
                  <li
                    v-for="blocker in accountLifecycle.blockers"
                    :key="blocker.code + blocker.reference"
                  >
                    <strong>{{ blocker.label }}</strong>
                    <span v-if="blocker.code === 'administrator_transfer_required'">
                      先将系统管理员身份转让给另一名已启用用户。
                    </span>
                    <span v-else>先转让或永久删除该组织。</span>
                  </li>
                </ul>
              </div>

              <form
                v-if="
                  authentication.user.role === 'administrator' &&
                  accountLifecycle?.blockers.some(
                    (item) => item.code === 'administrator_transfer_required',
                  )
                "
                class="account-form account-lifecycle-form"
                @submit.prevent="submitAdministratorTransfer"
              >
                <label class="field field--wide">
                  <span>新的系统管理员</span>
                  <select
                    v-model="accountDeletionForm.successorUserId"
                    :aria-invalid="Boolean(accountDeletionErrors.successorUserId)"
                    required
                  >
                    <option value="">请选择已启用用户</option>
                    <option v-for="user in administratorSuccessors" :key="user.id" :value="user.id">
                      {{ user.displayName }} · {{ user.primaryAddress }}
                    </option>
                  </select>
                  <small v-if="accountDeletionErrors.successorUserId" class="field-error">
                    {{ accountDeletionErrors.successorUserId }}
                  </small>
                  <small v-else-if="administratorSuccessors.length === 0" class="field-error">
                    当前没有可继任的已启用用户，请先创建或启用一名用户。
                  </small>
                </label>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--secondary"
                    type="submit"
                    :disabled="accountLifecycleSubmitting || administratorSuccessors.length === 0"
                  >
                    {{ accountLifecycleSubmitting ? '正在转让' : '转让管理员身份' }}
                  </button>
                </div>
              </form>

              <form
                v-if="accountLifecycle?.canRequestDeletion"
                class="account-form account-lifecycle-form"
                @submit.prevent="submitAccountDeletion"
              >
                <p class="confirmation-note field--wide">
                  注销期间不能登录、收信或发信。七天后，个人邮件、草稿、地址和设置将永久清理。
                </p>
                <label class="field field--wide">
                  <span>当前密码</span>
                  <input
                    v-model="accountDeletionForm.currentPassword"
                    :type="accountDeletionForm.showPassword ? 'text' : 'password'"
                    name="account-deletion-password"
                    autocomplete="current-password"
                    maxlength="128"
                    required
                    :aria-invalid="Boolean(accountDeletionErrors.currentPassword)"
                  />
                  <small v-if="accountDeletionErrors.currentPassword" class="field-error">
                    {{ accountDeletionErrors.currentPassword }}
                  </small>
                </label>
                <label class="checkbox-field field--wide">
                  <input v-model="accountDeletionForm.showPassword" type="checkbox" />
                  <span>显示密码</span>
                </label>
                <label class="checkbox-field field--wide">
                  <input v-model="accountDeletionForm.confirmed" type="checkbox" />
                  <span>我已了解七天冷静期和永久删除影响</span>
                </label>
                <small v-if="accountDeletionErrors.confirmation" class="field-error field--wide">
                  {{ accountDeletionErrors.confirmation }}
                </small>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--danger-quiet"
                    type="submit"
                    :disabled="accountLifecycleSubmitting"
                  >
                    {{ accountLifecycleSubmitting ? '正在提交' : '申请注销账号' }}
                  </button>
                </div>
              </form>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'health'"
              class="account-settings-section"
              aria-labelledby="operations-health-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="operations-health-title">运行健康状态</h2>
                  <p>根据系统账本判断收信、发信、存储和定时维护是否需要处理。</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="operationsHealthLoading"
                  @click="refreshOperationsHealth"
                >
                  {{ operationsHealthLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="operationsHealthError" class="form-alert" role="alert">
                {{ operationsHealthError }}
              </p>

              <div v-if="operationsHealth" class="operations-health-list">
                <article>
                  <div class="operations-health-heading">
                    <strong>收信</strong>
                    <span
                      class="status-label"
                      :data-health-status="operationsHealth.inbound.status"
                    >
                      {{ operationsHealthStatusLabel(operationsHealth.inbound.status) }}
                    </span>
                  </div>
                  <p>{{ operationsHealth.inbound.summary }}</p>
                  <dl class="operations-health-metrics">
                    <div>
                      <dt>最近接受</dt>
                      <dd>{{ optionalDate(operationsHealth.inbound.lastAcceptedAt) }}</dd>
                    </div>
                    <div>
                      <dt>最近可见</dt>
                      <dd>{{ optionalDate(operationsHealth.inbound.lastVisibleAt) }}</dd>
                    </div>
                    <div>
                      <dt>停滞操作</dt>
                      <dd>{{ operationsHealth.inbound.stalledCount }}</dd>
                    </div>
                    <div>
                      <dt>需检查结果</dt>
                      <dd>{{ operationsHealth.inbound.attentionCount }}</dd>
                    </div>
                  </dl>
                </article>

                <article>
                  <div class="operations-health-heading">
                    <strong>发信</strong>
                    <span
                      class="status-label"
                      :data-health-status="operationsHealth.outbound.status"
                    >
                      {{ operationsHealthStatusLabel(operationsHealth.outbound.status) }}
                    </span>
                  </div>
                  <p>{{ operationsHealth.outbound.summary }}</p>
                  <dl class="operations-health-metrics">
                    <div>
                      <dt>启用服务</dt>
                      <dd>{{ operationsHealth.outbound.activeProviderCount }}</dd>
                    </div>
                    <div>
                      <dt>启用路线</dt>
                      <dd>{{ operationsHealth.outbound.activeRouteCount }}</dd>
                    </div>
                    <div>
                      <dt>结果未知</dt>
                      <dd>{{ operationsHealth.outbound.unknownRecipientCount }}</dd>
                    </div>
                    <div>
                      <dt>最近活动</dt>
                      <dd>{{ optionalDate(operationsHealth.outbound.lastActivityAt) }}</dd>
                    </div>
                  </dl>
                </article>

                <article>
                  <div class="operations-health-heading">
                    <strong>存储</strong>
                    <span
                      class="status-label"
                      :data-health-status="operationsHealth.storage.status"
                    >
                      {{ operationsHealthStatusLabel(operationsHealth.storage.status) }}
                    </span>
                  </div>
                  <p>{{ operationsHealth.storage.summary }}</p>
                  <dl class="operations-health-metrics">
                    <div>
                      <dt>达到预警线</dt>
                      <dd>{{ operationsHealth.storage.warningResourceCount }}</dd>
                    </div>
                    <div>
                      <dt>达到停止线</dt>
                      <dd>{{ operationsHealth.storage.stoppedResourceCount }}</dd>
                    </div>
                    <div>
                      <dt>缺少快照</dt>
                      <dd>{{ operationsHealth.storage.missingResourceCount }}</dd>
                    </div>
                    <div>
                      <dt>最近快照</dt>
                      <dd>{{ optionalDate(operationsHealth.storage.latestSnapshotAt) }}</dd>
                    </div>
                  </dl>
                </article>

                <article>
                  <div class="operations-health-heading">
                    <strong>定时维护</strong>
                    <span
                      class="status-label"
                      :data-health-status="operationsHealth.scheduled.status"
                    >
                      {{ operationsHealthStatusLabel(operationsHealth.scheduled.status) }}
                    </span>
                  </div>
                  <p>{{ operationsHealth.scheduled.summary }}</p>
                  <dl class="operations-health-metrics">
                    <div>
                      <dt>最近成功</dt>
                      <dd>{{ optionalDate(operationsHealth.scheduled.lastSucceededAt) }}</dd>
                    </div>
                    <div>
                      <dt>最近失败</dt>
                      <dd>{{ optionalDate(operationsHealth.scheduled.lastFailedAt) }}</dd>
                    </div>
                    <div>
                      <dt>需人工处理</dt>
                      <dd>{{ operationsHealth.scheduled.needsAttentionTaskCount }}</dd>
                    </div>
                    <div>
                      <dt>逾期任务</dt>
                      <dd>{{ operationsHealth.scheduled.overdueTaskCount }}</dd>
                    </div>
                  </dl>
                </article>
              </div>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'receiving'"
              class="account-settings-section"
              aria-labelledby="inbound-control-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="inbound-control-title">收信控制</h2>
                  <p>管理暂停收信、全域收信和基础拒收规则</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="inboundControlLoading || inboundControlAction !== null"
                  @click="refreshInboundControl"
                >
                  {{ inboundControlLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="inboundControlError" class="form-alert" role="alert">
                {{ inboundControlError }}
              </p>
              <p v-if="inboundControlNotice" class="form-success" role="status">
                {{ inboundControlNotice }}
              </p>

              <div class="inbound-control-subsection">
                <div class="section-heading"><h3>域名与全域收信</h3></div>
                <div v-if="inboundControl?.domains.length" class="inbound-control-list">
                  <article v-for="domain in inboundControl.domains" :key="domain.id">
                    <div class="inbound-control-primary">
                      <div class="managed-domain-title">
                        <strong>{{ domain.displayName }}</strong>
                        <span
                          class="status-label"
                          :class="{ 'status-label--disabled': domain.receiveStatus === 'paused' }"
                        >
                          {{ domain.receiveStatus === 'accepting' ? '正在收信' : '已暂停收信' }}
                        </span>
                      </div>
                      <small> {{ domain.unallocatedMessageCount }} 封当前未分配来信 </small>
                    </div>
                    <label class="field field--compact">
                      <span>未知地址</span>
                      <select
                        :value="domain.catchAllMode"
                        :disabled="
                          inboundControlAction !== null || domain.domainStatus !== 'active'
                        "
                        @change="handleDomainCatchAllChange(domain.id, $event)"
                      >
                        <option value="reject">拒收未创建地址</option>
                        <option value="unallocated">保存为未分配来信</option>
                      </select>
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="inboundControlAction !== null"
                      @click="toggleInboundReceiveStatus('domain', domain.id, domain.receiveStatus)"
                    >
                      {{ domain.receiveStatus === 'accepting' ? '暂停收信' : '恢复收信' }}
                    </button>
                    <fieldset
                      v-if="domain.catchAllMode === 'unallocated'"
                      class="inbound-access-fieldset"
                    >
                      <legend>可查看未分配来信的用户</legend>
                      <label v-for="user in inboundActiveUsers" :key="user.id">
                        <input
                          type="checkbox"
                          :checked="domain.unallocatedAccessUserIds.includes(user.id)"
                          :disabled="inboundControlAction !== null"
                          @change="handleUnallocatedAccessChange(domain.id, user.id, $event)"
                        />
                        <span>{{ user.displayName }} · {{ user.primaryAddress }}</span>
                      </label>
                      <small v-if="inboundActiveUsers.length === 0"
                        >当前没有可授权的启用用户。</small
                      >
                    </fieldset>
                  </article>
                </div>
                <p v-else-if="!inboundControlLoading" class="empty-state">没有可配置的邮件域名。</p>
              </div>

              <div class="inbound-control-subsection">
                <div class="section-heading"><h3>用户与地址收信状态</h3></div>
                <div class="inbound-scope-columns">
                  <div>
                    <h4>用户</h4>
                    <div class="inbound-compact-list">
                      <article v-for="user in inboundControl?.users ?? []" :key="user.id">
                        <span>
                          <strong>{{ user.displayName }}</strong>
                          <small>{{ user.primaryAddress }}</small>
                        </span>
                        <button
                          class="button button--secondary button--compact"
                          type="button"
                          :disabled="inboundControlAction !== null || user.userStatus !== 'active'"
                          @click="toggleInboundReceiveStatus('user', user.id, user.receiveStatus)"
                        >
                          {{ user.receiveStatus === 'accepting' ? '暂停' : '恢复' }}
                        </button>
                      </article>
                    </div>
                  </div>
                  <div>
                    <h4>邮箱地址</h4>
                    <div class="inbound-compact-list">
                      <article v-for="address in inboundControl?.addresses ?? []" :key="address.id">
                        <span>
                          <strong>{{ address.canonicalAddress }}</strong>
                          <small>{{ address.ownerName }}</small>
                        </span>
                        <button
                          class="button button--secondary button--compact"
                          type="button"
                          :disabled="inboundControlAction !== null"
                          @click="
                            toggleInboundReceiveStatus('address', address.id, address.receiveStatus)
                          "
                        >
                          {{ address.receiveStatus === 'accepting' ? '暂停' : '恢复' }}
                        </button>
                      </article>
                    </div>
                  </div>
                </div>
              </div>

              <div class="inbound-control-subsection">
                <div class="section-heading"><h3>拒收规则</h3></div>
                <form
                  class="account-form management-create-form"
                  @submit.prevent="submitInboundRejectionRule"
                >
                  <div class="form-grid">
                    <label class="field">
                      <span>匹配类型</span>
                      <select v-model="inboundRejectionRuleForm.ruleType">
                        <option value="sender_address">发件地址</option>
                        <option value="sender_domain">发件域名</option>
                        <option value="subject_keyword">主题关键词</option>
                        <option value="body_keyword">正文关键词</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>匹配内容</span>
                      <input
                        v-model="inboundRejectionRuleForm.matchValue"
                        maxlength="320"
                        required
                      />
                    </label>
                  </div>
                  <div class="form-actions form-actions--end">
                    <button
                      class="button button--primary"
                      type="submit"
                      :disabled="inboundControlAction !== null"
                    >
                      {{ inboundControlAction === 'rule:create' ? '正在添加' : '添加规则' }}
                    </button>
                  </div>
                </form>
                <div v-if="inboundControl?.rules.length" class="inbound-rule-list">
                  <article v-for="rule in inboundControl.rules" :key="rule.id">
                    <div>
                      <strong>{{ inboundRejectionRuleTypeLabel(rule.ruleType) }}</strong>
                      <span>{{ rule.matchValue }}</span>
                    </div>
                    <span
                      class="status-label"
                      :class="{ 'status-label--disabled': rule.status === 'paused' }"
                    >
                      {{ rule.status === 'active' ? '已启用' : '已暂停' }}
                    </span>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="inboundControlAction !== null"
                      @click="toggleInboundRejectionRule(rule.id, rule.status)"
                    >
                      {{ rule.status === 'active' ? '暂停' : '恢复' }}
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="inboundControlAction !== null"
                      @click="removeInboundRejectionRule(rule.id)"
                    >
                      删除
                    </button>
                  </article>
                </div>
                <p v-else-if="!inboundControlLoading" class="empty-state">当前没有拒收规则。</p>
              </div>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'resources'"
              class="account-settings-section"
              aria-labelledby="platform-resources-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="platform-resources-title">Cloudflare 免费资源</h2>
                  <p>达到停止线前阻止继续增加存储，现有邮件仍可阅读和清理。</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="platformResourceLoading || platformResourceAction !== null"
                  @click="refreshPlatformResourceUsage"
                >
                  {{ platformResourceAction === 'refresh' ? '正在刷新' : '刷新用量' }}
                </button>
              </div>

              <p v-if="platformResourceError" class="form-alert" role="alert">
                {{ platformResourceError }}
              </p>
              <p v-if="platformResourceNotice" class="form-success" role="status">
                {{ platformResourceNotice }}
              </p>

              <div v-if="platformResourceOverview" class="platform-resource-list">
                <article
                  v-for="resource in platformResourceOverview.resources"
                  :key="resource.resourceKind"
                  class="platform-resource-row"
                >
                  <div class="platform-resource-heading">
                    <div>
                      <strong>{{ platformResourceLabel(resource.resourceKind) }}</strong>
                      <small>{{ platformResourceSourceLabel(resource) }}</small>
                    </div>
                    <span
                      class="status-label"
                      :class="{ 'status-label--warning': resource.warningReached }"
                    >
                      {{ platformResourceStatusLabel(resource) }}
                    </span>
                  </div>
                  <progress :value="platformResourceUsagePercent(resource)" max="100"></progress>
                  <dl class="platform-resource-metrics">
                    <div>
                      <dt>账号已用 / 免费上限</dt>
                      <dd>
                        {{
                          resource.accountUsedBytes === null
                            ? '不可用'
                            : `${formatStorageSize(resource.accountUsedBytes)} / ${formatStorageSize(resource.freeLimitBytes)}`
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>当前资源已用 / 自身上限</dt>
                      <dd>
                        {{
                          resource.simlettraUsedBytes === null
                            ? '不可用'
                            : `${formatStorageSize(resource.simlettraUsedBytes)} / ${formatStorageSize(resource.currentResourceLimitBytes)}`
                        }}
                      </dd>
                    </div>
                    <div>
                      <dt>账号剩余</dt>
                      <dd>{{ formatOptionalStorageSize(resource.remainingBytes) }}</dd>
                    </div>
                    <div>
                      <dt>当前资源剩余</dt>
                      <dd>
                        {{ formatOptionalStorageSize(resource.currentResourceRemainingBytes) }}
                      </dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{{ formatDate(resource.fetchedAt) }}</dd>
                    </div>
                  </dl>
                  <form
                    class="platform-resource-thresholds"
                    @submit.prevent="submitPlatformResourceThreshold(resource.resourceKind)"
                  >
                    <label class="field field--compact">
                      <span>预警比例</span>
                      <input
                        v-model.number="
                          platformResourceThresholdDrafts[resource.resourceKind].warningPercent
                        "
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputmode="numeric"
                        required
                      />
                    </label>
                    <label class="field field--compact">
                      <span>停止比例</span>
                      <input
                        v-model.number="
                          platformResourceThresholdDrafts[resource.resourceKind].stopPercent
                        "
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        inputmode="numeric"
                        required
                      />
                    </label>
                    <div class="platform-resource-threshold-action">
                      <small v-if="resource.dataSource === 'local_estimate'">
                        仅本地估算时，有效停止比例最高为 80%。
                      </small>
                      <button
                        class="button button--secondary button--compact"
                        type="submit"
                        :disabled="platformResourceAction !== null"
                      >
                        {{
                          platformResourceAction === `threshold:${resource.resourceKind}`
                            ? '正在保存'
                            : '保存阈值'
                        }}
                      </button>
                    </div>
                  </form>
                </article>
              </div>

              <form
                class="account-form management-create-form platform-resource-configuration"
                @submit.prevent="submitPlatformResourceConfiguration"
              >
                <div class="section-heading"><h3>Cloudflare 只读配置</h3></div>
                <div class="form-grid">
                  <label class="field">
                    <span>Cloudflare 账号编号</span>
                    <input
                      v-model="platformResourceConfigurationForm.accountId"
                      autocomplete="off"
                      autocapitalize="none"
                      maxlength="64"
                      required
                    />
                  </label>
                  <label class="field">
                    <span>D1 数据库编号</span>
                    <input
                      v-model="platformResourceConfigurationForm.d1DatabaseId"
                      autocomplete="off"
                      autocapitalize="none"
                      maxlength="64"
                      required
                    />
                  </label>
                  <label class="field field--wide">
                    <span>
                      {{
                        platformResourceOverview?.storageMode === 'kv'
                          ? 'KV 命名空间编号'
                          : 'R2 存储桶名称'
                      }}
                    </span>
                    <input
                      v-model="platformResourceConfigurationForm.storageResourceReference"
                      autocomplete="off"
                      autocapitalize="none"
                      maxlength="256"
                      required
                    />
                  </label>
                  <label class="field field--wide">
                    <span>只读 API Token</span>
                    <input
                      v-model="platformResourceConfigurationForm.apiToken"
                      autocomplete="off"
                      autocapitalize="none"
                      maxlength="4096"
                      required
                    />
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    v-if="platformResourceOverview?.configuration.configured"
                    class="button button--danger-quiet"
                    type="button"
                    :disabled="platformResourceAction !== null"
                    @click="removePlatformResourceConfiguration"
                  >
                    删除配置
                  </button>
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="platformResourceAction !== null"
                  >
                    {{ platformResourceAction === 'configuration' ? '正在测试' : '保存并测试' }}
                  </button>
                </div>
              </form>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'organization-policy'"
              class="account-settings-section"
              aria-labelledby="organization-policy-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="organization-policy-title">组织创建额度</h2>
                  <p>新用户默认最多可以创建 5 个组织</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="organizationPolicyLoading || organizationPolicyActionId !== null"
                  @click="refreshAdministratorOrganizationPolicies"
                >
                  {{ organizationPolicyLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <div
                v-if="administratorOrganizationPolicies?.users.length"
                class="organization-policy-list"
              >
                <article
                  v-for="user in administratorOrganizationPolicies.users"
                  :key="user.userId"
                  class="organization-policy-row"
                >
                  <div class="alias-policy-identity">
                    <div class="managed-user-title">
                      <strong>{{ user.displayName }}</strong>
                      <span
                        class="status-label"
                        :class="{ 'status-label--disabled': user.userStatus === 'disabled' }"
                      >
                        {{ user.userStatus === 'active' ? '正常' : '已禁用' }}
                      </span>
                    </div>
                    <p>{{ user.primaryAddress }}</p>
                  </div>
                  <div class="organization-policy-controls">
                    <label class="field field--compact">
                      <span>组织上限</span>
                      <input
                        v-model.number="organizationPolicyDraft(user).organizationLimit"
                        :name="`organization-limit-${user.userId}`"
                        type="number"
                        min="0"
                        max="1000"
                        step="1"
                      />
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="organizationPolicyActionId !== null"
                      @click="saveOrganizationPolicy(user)"
                    >
                      {{ organizationPolicyActionId === user.userId ? '正在保存' : '保存额度' }}
                    </button>
                  </div>
                  <p
                    class="organization-policy-usage"
                    :class="{ 'status-label--disabled': user.policy.overLimit }"
                  >
                    已创建 {{ user.policy.ownedOrganizationCount }} /
                    {{ user.policy.organizationLimit }} 个组织
                  </p>
                </article>
              </div>
              <p v-else-if="!organizationPolicyLoading" class="empty-state">
                没有可显示的用户额度。
              </p>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'storage'"
              class="account-settings-section"
              aria-labelledby="storage-quota-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="storage-quota-title">用户与组织存储配额</h2>
                  <p>
                    当前模式：{{ storageQuotaOverview?.storageMode === 'kv' ? 'KV' : 'R2' }}；
                    用量按用户或组织计算，成员人数和个人别名不会重复计费。
                  </p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="storageQuotaLoading || storageQuotaAction !== null"
                  @click="refreshStorageQuotaManagement"
                >
                  {{ storageQuotaLoading ? '正在刷新' : '刷新配额' }}
                </button>
              </div>
              <p v-if="storageQuotaError" class="form-alert" role="alert">
                {{ storageQuotaError }}
              </p>
              <p v-if="storageQuotaNotice" class="form-success" role="status">
                {{ storageQuotaNotice }}
              </p>
              <div v-if="storageQuotaOverview" class="storage-quota-defaults">
                <article
                  v-for="item in storageQuotaOverview.defaults"
                  :key="`default-${item.ownerType}`"
                  class="storage-quota-row"
                >
                  <div>
                    <strong>{{
                      item.ownerType === 'user' ? '用户默认额度' : '组织默认额度'
                    }}</strong>
                    <small>当前策略版本 {{ item.policyVersion }}</small>
                  </div>
                  <div class="storage-quota-controls">
                    <label class="field field--compact">
                      <span>额度（字节）</span>
                      <input
                        v-model.number="storageQuotaDefaultDrafts[item.ownerType]"
                        type="number"
                        min="1000000"
                        step="1000000"
                        required
                      />
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="storageQuotaAction !== null"
                      @click="submitStorageQuotaDefault(item.ownerType)"
                    >
                      {{
                        storageQuotaAction === `default:${item.ownerType}`
                          ? '正在保存'
                          : '保存默认额度'
                      }}
                    </button>
                  </div>
                </article>
              </div>
              <div v-if="storageQuotaOverview" class="storage-quota-subject-list">
                <article
                  v-for="subject in [
                    ...storageQuotaOverview.users,
                    ...storageQuotaOverview.organizations,
                  ]"
                  :key="`${subject.ownerType}:${subject.ownerId}`"
                  class="storage-quota-row"
                >
                  <div>
                    <strong>{{ subject.displayName }}</strong>
                    <small
                      >{{ subject.ownerType === 'user' ? '用户' : '组织' }} ·
                      {{ subject.overLimit ? '当前已超额，仅允许清理' : '可继续增加' }}</small
                    >
                  </div>
                  <dl class="storage-quota-metrics">
                    <div>
                      <dt>已使用</dt>
                      <dd>{{ storageQuotaUsageLabel(subject.committedBytes) }}</dd>
                    </div>
                    <div>
                      <dt>已预留</dt>
                      <dd>{{ storageQuotaUsageLabel(subject.reservedBytes) }}</dd>
                    </div>
                    <div>
                      <dt>剩余</dt>
                      <dd>{{ storageQuotaUsageLabel(subject.remainingBytes) }}</dd>
                    </div>
                  </dl>
                  <div class="storage-quota-controls">
                    <label class="field field--compact">
                      <span>单独额度（留空使用默认）</span>
                      <input
                        v-model="
                          storageQuotaOverrideDrafts[`${subject.ownerType}:${subject.ownerId}`]
                        "
                        type="number"
                        min="1000000"
                        step="1000000"
                        placeholder="使用默认"
                      />
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="storageQuotaAction !== null"
                      @click="submitStorageQuotaOverride(subject.ownerType, subject.ownerId)"
                    >
                      {{
                        storageQuotaAction === `override:${subject.ownerType}:${subject.ownerId}`
                          ? '正在保存'
                          : '保存单独额度'
                      }}
                    </button>
                  </div>
                </article>
              </div>
              <p
                v-if="
                  storageQuotaOverview &&
                  !storageQuotaOverview.users.length &&
                  !storageQuotaOverview.organizations.length
                "
                class="empty-state"
              >
                暂无用户或组织用量。
              </p>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'address-policy'"
              class="account-settings-section"
              aria-labelledby="address-policy-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="address-policy-title">地址规则与保留期</h2>
                  <p>当前策略版本 {{ addressPolicy?.policyVersion ?? '—' }}</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="addressPolicyLoading || addressPolicySubmitting"
                  @click="refreshAddressPolicy"
                >
                  {{ addressPolicyLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <form class="account-form management-create-form" @submit.prevent="saveAddressPolicy">
                <div class="form-grid">
                  <label class="field">
                    <span>邮箱前缀最短长度</span>
                    <input
                      v-model.number="addressPolicyDraft.minimumLocalPartLength"
                      name="minimum-local-part-length"
                      type="number"
                      min="1"
                      max="64"
                      step="1"
                      required
                      :aria-invalid="Boolean(addressPolicyErrors.minimumLocalPartLength)"
                    />
                    <small v-if="addressPolicyErrors.minimumLocalPartLength" class="field-error">{{
                      addressPolicyErrors.minimumLocalPartLength
                    }}</small>
                  </label>
                  <label class="field">
                    <span>个人别名保留天数</span>
                    <input
                      v-model.number="addressPolicyDraft.aliasRetentionDays"
                      name="alias-retention-days"
                      type="number"
                      min="0"
                      max="30"
                      step="1"
                      required
                      :aria-invalid="Boolean(addressPolicyErrors.aliasRetentionDays)"
                    />
                    <small v-if="addressPolicyErrors.aliasRetentionDays" class="field-error">{{
                      addressPolicyErrors.aliasRetentionDays
                    }}</small>
                  </label>
                  <label class="field field--wide">
                    <span>禁止包含的文字（每行一项）</span>
                    <textarea
                      v-model="addressPolicyDraft.blockedSubstrings"
                      name="blocked-address-substrings"
                      rows="4"
                      spellcheck="false"
                      :aria-invalid="Boolean(addressPolicyErrors.blockedSubstrings)"
                    ></textarea>
                    <small v-if="addressPolicyErrors.blockedSubstrings" class="field-error">{{
                      addressPolicyErrors.blockedSubstrings
                    }}</small>
                  </label>
                  <label class="field field--wide">
                    <span>保留名称（每行一项）</span>
                    <textarea
                      v-model="addressPolicyDraft.reservedNames"
                      name="reserved-address-names"
                      rows="4"
                      spellcheck="false"
                      :aria-invalid="Boolean(addressPolicyErrors.reservedNames)"
                    ></textarea>
                    <small v-if="addressPolicyErrors.reservedNames" class="field-error">{{
                      addressPolicyErrors.reservedNames
                    }}</small>
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="addressPolicyLoading || addressPolicySubmitting || !addressPolicy"
                  >
                    {{ addressPolicySubmitting ? '正在保存' : '保存地址策略' }}
                  </button>
                </div>
              </form>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'outbound'"
              class="account-settings-section"
              aria-labelledby="outbound-management-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="outbound-management-title">域外发信与额度</h2>
                  <p>{{ outboundManagement?.providers.length ?? 0 }} 份发信服务配置</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="outboundLoading || outboundAction !== null"
                  @click="refreshOutboundManagement"
                >
                  {{ outboundLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="outboundError" class="form-alert" role="alert">{{ outboundError }}</p>
              <p v-if="outboundNotice" class="form-success" role="status">{{ outboundNotice }}</p>
              <p
                v-if="outboundManagement && !outboundManagement.encryptionConfigured"
                class="form-alert"
              >
                部署配置中尚未设置 CONFIG_KEY。
              </p>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitOutboundProvider"
              >
                <div class="form-grid">
                  <label class="field">
                    <span>配置名称</span>
                    <input
                      v-model="outboundProviderForm.displayName"
                      name="outbound-provider-name"
                      maxlength="120"
                      required
                    />
                  </label>
                  <label class="field">
                    <span>发信服务</span>
                    <select
                      v-model="outboundProviderForm.providerType"
                      name="outbound-provider-type"
                    >
                      <option value="resend">Resend</option>
                      <option value="smtp2go">SMTP2GO</option>
                    </select>
                  </label>
                  <label class="field field--wide">
                    <span>API Key</span>
                    <input
                      v-model="outboundProviderForm.credential"
                      name="outbound-provider-credential"
                      autocomplete="off"
                      required
                    />
                  </label>
                  <label v-if="outboundProviderForm.providerType === 'smtp2go'" class="field">
                    <span>回调 Basic Auth 用户名</span>
                    <input
                      v-model="outboundProviderForm.callbackUsername"
                      name="outbound-callback-username"
                      autocomplete="off"
                      required
                    />
                  </label>
                  <label
                    class="field"
                    :class="{ 'field--wide': outboundProviderForm.providerType === 'resend' }"
                  >
                    <span>{{
                      outboundProviderForm.providerType === 'resend'
                        ? 'Webhook Signing Secret'
                        : '回调 Basic Auth 密码'
                    }}</span>
                    <input
                      v-model="outboundProviderForm.callbackSecret"
                      name="outbound-callback-secret"
                      autocomplete="off"
                      required
                    />
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    v-if="outboundProviderForm.id"
                    class="button button--secondary"
                    type="button"
                    :disabled="outboundAction !== null"
                    @click="resetOutboundProviderForm"
                  >
                    取消编辑
                  </button>
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="outboundAction !== null || !outboundManagement?.encryptionConfigured"
                  >
                    {{
                      outboundAction === 'provider'
                        ? '正在保存'
                        : outboundProviderForm.id
                          ? '保存新版本'
                          : '添加发信服务'
                    }}
                  </button>
                </div>
              </form>

              <div v-if="outboundManagement?.providers.length" class="outbound-provider-list">
                <article v-for="provider in outboundManagement.providers" :key="provider.id">
                  <div class="managed-user-title">
                    <strong>{{ provider.displayName }}</strong>
                    <span class="status-label">{{
                      provider.providerType === 'resend' ? 'Resend' : 'SMTP2GO'
                    }}</span>
                  </div>
                  <label class="field field--compact">
                    <span>API Key</span>
                    <input :value="provider.credential" readonly />
                  </label>
                  <label class="field field--compact outbound-callback-field">
                    <span>回调地址</span>
                    <input :value="outboundCallbackUrl(provider)" readonly />
                  </label>
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="outboundAction !== null"
                    @click="editOutboundProvider(provider)"
                  >
                    编辑
                  </button>
                </article>
              </div>

              <div class="outbound-subsection">
                <div class="section-heading">
                  <h3>域名发信顺序</h3>
                </div>
                <div
                  v-if="outboundManagement?.domainMonthlyQuotas.length"
                  class="outbound-route-list"
                >
                  <article
                    v-for="domain in outboundManagement.domainMonthlyQuotas"
                    :key="domain.domainId"
                  >
                    <strong>{{ domain.domainName }}</strong>
                    <label class="field field--compact">
                      <span>默认服务</span>
                      <select v-model="outboundRouteDraft(domain.domainId).primaryProviderId">
                        <option value="" disabled>选择服务</option>
                        <option
                          v-for="provider in outboundManagement.providers"
                          :key="provider.id"
                          :value="provider.id"
                        >
                          {{ provider.displayName }}
                        </option>
                      </select>
                    </label>
                    <label class="field field--compact">
                      <span>备用服务</span>
                      <select v-model="outboundRouteDraft(domain.domainId).backupProviderId">
                        <option value="">不设置</option>
                        <option
                          v-for="provider in outboundManagement.providers"
                          :key="provider.id"
                          :value="provider.id"
                        >
                          {{ provider.displayName }}
                        </option>
                      </select>
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="
                        outboundAction !== null ||
                        !outboundRouteDraft(domain.domainId).primaryProviderId
                      "
                      @click="submitOutboundRoute(domain.domainId)"
                    >
                      {{ outboundAction === `route:${domain.domainId}` ? '正在保存' : '保存顺序' }}
                    </button>
                  </article>
                </div>
              </div>

              <div class="outbound-subsection">
                <div class="section-heading">
                  <h3>默认发件额度</h3>
                </div>
                <div class="outbound-default-quotas">
                  <label class="field field--compact">
                    <span>每人滚动 24 小时收件人数</span>
                    <input
                      v-model.number="outboundDailyDefaultDraft"
                      type="number"
                      min="1"
                      max="10000000"
                      step="1"
                    />
                  </label>
                  <label class="field field--compact">
                    <span>每个域名自然月收件人数</span>
                    <input
                      v-model="outboundDomainMonthlyDefaultDraft"
                      type="number"
                      min="1"
                      max="10000000"
                      step="1"
                      placeholder="不限制"
                    />
                  </label>
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="outboundAction !== null"
                    @click="submitOutboundDefaultQuotas"
                  >
                    {{ outboundAction === 'quota:defaults' ? '正在保存' : '保存默认额度' }}
                  </button>
                </div>
              </div>

              <div class="outbound-subsection">
                <div class="section-heading"><h3>用户每日额度</h3></div>
                <div class="outbound-quota-list">
                  <article
                    v-for="user in outboundManagement?.userDailyQuotas ?? []"
                    :key="user.userId"
                  >
                    <div>
                      <strong>{{ user.displayName }}</strong>
                      <small>{{ user.primaryAddress }} · 已使用 {{ user.usedInPast24Hours }}</small>
                    </div>
                    <label class="field field--compact">
                      <span>收件人数上限</span>
                      <input
                        v-model.number="outboundUserQuotaDrafts[user.userId]"
                        type="number"
                        min="1"
                        max="10000000"
                        step="1"
                      />
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="outboundAction !== null"
                      @click="submitOutboundUserQuota(user.userId)"
                    >
                      保存
                    </button>
                    <button
                      v-if="!user.usesDefault"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="outboundAction !== null"
                      @click="submitOutboundUserQuota(user.userId, true)"
                    >
                      使用默认值
                    </button>
                  </article>
                </div>
              </div>

              <div class="outbound-subsection">
                <div class="section-heading"><h3>域名月度额度</h3></div>
                <div class="outbound-quota-list">
                  <article
                    v-for="domain in outboundManagement?.domainMonthlyQuotas ?? []"
                    :key="domain.domainId"
                  >
                    <div>
                      <strong>{{ domain.domainName }}</strong>
                      <small
                        >已计入 {{ domain.committed }} · 预留 {{ domain.reserved }} · 待确认
                        {{ domain.unknownHeld }}</small
                      >
                    </div>
                    <label class="field field--compact">
                      <span>收件人数上限</span>
                      <input
                        v-model="outboundDomainQuotaDrafts[domain.domainId]"
                        type="number"
                        min="1"
                        max="10000000"
                        step="1"
                        placeholder="不限制"
                      />
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="outboundAction !== null"
                      @click="submitOutboundDomainQuota(domain.domainId)"
                    >
                      保存
                    </button>
                    <button
                      v-if="!domain.usesDefault"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="outboundAction !== null"
                      @click="submitOutboundDomainQuota(domain.domainId, true)"
                    >
                      使用默认值
                    </button>
                  </article>
                </div>
              </div>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'domains'"
              class="account-settings-section"
              aria-labelledby="domain-management-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="domain-management-title">邮件域名</h2>
                  <p>{{ domainManagement?.domains.length ?? 0 }} 个当前域名</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="domainManagementLoading || domainActionId !== null"
                  @click="refreshDomainManagement"
                >
                  {{ domainManagementLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitDomainCreation"
              >
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>添加邮件域名</span>
                    <input
                      v-model="domainForm.domainName"
                      name="new-mail-domain"
                      inputmode="url"
                      autocapitalize="none"
                      maxlength="253"
                      placeholder="example.com"
                      required
                      :aria-invalid="Boolean(domainErrors.domainName)"
                    />
                    <small v-if="domainErrors.domainName" class="field-error">{{
                      domainErrors.domainName
                    }}</small>
                  </label>
                </div>

                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="domainCreateSubmitting"
                  >
                    {{ domainCreateSubmitting ? '正在添加' : '添加域名' }}
                  </button>
                </div>
              </form>

              <div v-if="domainManagement?.domains.length" class="managed-domain-list">
                <article
                  v-for="domain in domainManagement.domains"
                  :key="domain.id"
                  class="managed-domain-row"
                >
                  <div class="managed-domain-primary">
                    <div class="managed-domain-title">
                      <strong>{{ domain.displayName }}</strong>
                      <span
                        class="status-label"
                        :class="{ 'status-label--disabled': domain.status === 'paused' }"
                      >
                        {{ domainStatusLabel(domain.status) }}
                      </span>
                    </div>
                    <p v-if="domain.displayName !== domain.canonicalName">
                      {{ domain.canonicalName }}
                    </p>
                    <dl class="managed-domain-details">
                      <div>
                        <dt>关联地址</dt>
                        <dd>{{ domain.addressCount }} 个</dd>
                      </div>
                      <div>
                        <dt>添加时间</dt>
                        <dd>{{ formatDate(domain.createdAt) }}</dd>
                      </div>
                    </dl>
                  </div>

                  <div class="managed-domain-actions">
                    <span v-if="domain.addressCount > 0" class="action-hint"
                      >有关联地址，不能删除</span
                    >
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="domainActionId !== null"
                      @click="toggleMailDomainStatus(domain)"
                    >
                      {{
                        domainActionId === `status:${domain.id}`
                          ? '正在处理'
                          : domain.status === 'active'
                            ? '暂停'
                            : '恢复'
                      }}
                    </button>
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="domainActionId !== null || domain.addressCount > 0"
                      @click="requestMailDomainDeletion(domain)"
                    >
                      删除
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!domainManagementLoading" class="empty-state">没有可显示的邮件域名。</p>

              <section
                v-if="domainPendingDeletion"
                class="destructive-confirmation"
                aria-labelledby="domain-deletion-title"
              >
                <h2 id="domain-deletion-title">永久删除邮件域名</h2>
                <p>
                  将永久删除 <strong>{{ domainPendingDeletion.canonicalName }}</strong
                  >。该域名当前没有关联地址，删除后需要重新添加才能再次使用。
                </p>
                <label class="checkbox-field">
                  <input v-model="domainDeletionConfirmed" type="checkbox" />
                  <span>我确认永久删除这个邮件域名</span>
                </label>
                <div class="confirmation-actions">
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="domainActionId !== null"
                    @click="cancelMailDomainDeletion"
                  >
                    取消
                  </button>
                  <button
                    class="button button--danger-quiet button--compact"
                    type="button"
                    :disabled="!domainDeletionConfirmed || domainActionId !== null"
                    @click="confirmMailDomainDeletion"
                  >
                    {{
                      domainActionId === `delete:${domainPendingDeletion.id}`
                        ? '正在删除'
                        : '永久删除'
                    }}
                  </button>
                </div>
              </section>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'alias-policy'"
              class="account-settings-section"
              aria-labelledby="alias-policy-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="alias-policy-title">个人别名策略</h2>
                  <p>新用户默认可自行创建，个人别名上限为 20</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="aliasPolicyLoading || aliasPolicyActionId !== null"
                  @click="refreshAdministratorAliasPolicies"
                >
                  {{ aliasPolicyLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitAdministratorAliasAssignment"
              >
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>分配给</span>
                    <select
                      v-model="administratorAliasForm.userId"
                      name="administrator-alias-user"
                      required
                      :aria-invalid="Boolean(administratorAliasErrors.userId)"
                    >
                      <option value="" disabled>选择用户</option>
                      <option
                        v-for="user in administratorAliasPolicies?.users.filter(
                          (item) => item.status === 'active',
                        ) ?? []"
                        :key="user.id"
                        :value="user.id"
                      >
                        {{ user.displayName }} · {{ user.primaryAddress }}
                      </option>
                    </select>
                    <small v-if="administratorAliasErrors.userId" class="field-error">{{
                      administratorAliasErrors.userId
                    }}</small>
                  </label>
                  <label class="field">
                    <span>邮箱前缀</span>
                    <input
                      v-model="administratorAliasForm.localPart"
                      name="administrator-alias-local-part"
                      inputmode="email"
                      autocapitalize="none"
                      maxlength="64"
                      required
                      :aria-invalid="Boolean(administratorAliasErrors.localPart)"
                    />
                    <small v-if="administratorAliasErrors.localPart" class="field-error">{{
                      administratorAliasErrors.localPart
                    }}</small>
                  </label>
                  <label class="field">
                    <span>邮件域名</span>
                    <select
                      v-model="administratorAliasForm.domainId"
                      name="administrator-alias-domain"
                      required
                      :aria-invalid="Boolean(administratorAliasErrors.domainId)"
                    >
                      <option value="" disabled>选择域名</option>
                      <option
                        v-for="domain in personalAddressOverview?.activeDomains ?? []"
                        :key="domain.id"
                        :value="domain.id"
                      >
                        {{ domain.canonicalName }}
                      </option>
                    </select>
                    <small v-if="administratorAliasErrors.domainId" class="field-error">{{
                      administratorAliasErrors.domainId
                    }}</small>
                  </label>
                </div>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      aliasPolicyActionId !== null ||
                      !(administratorAliasPolicies?.users.length ?? 0) ||
                      !(personalAddressOverview?.activeDomains.length ?? 0)
                    "
                  >
                    {{ aliasPolicyActionId === 'assign' ? '正在分配' : '分配个人别名' }}
                  </button>
                </div>
              </form>

              <div v-if="administratorAliasPolicies?.users.length" class="alias-policy-list">
                <article
                  v-for="user in administratorAliasPolicies.users"
                  :key="user.id"
                  class="alias-policy-row"
                >
                  <div class="alias-policy-identity">
                    <div class="managed-user-title">
                      <strong>{{ user.displayName }}</strong>
                      <span
                        class="status-label"
                        :class="{ 'status-label--disabled': user.status === 'disabled' }"
                      >
                        {{ user.status === 'active' ? '正常' : '已禁用' }}
                      </span>
                    </div>
                    <p>{{ user.primaryAddress }}</p>
                  </div>

                  <div class="alias-policy-controls">
                    <label class="field field--compact">
                      <span>别名上限</span>
                      <input
                        v-model.number="aliasPolicyDraft(user).aliasLimit"
                        :name="`alias-limit-${user.id}`"
                        type="number"
                        min="0"
                        max="1000"
                        step="1"
                      />
                    </label>
                    <label class="checkbox-field">
                      <input v-model="aliasPolicyDraft(user).selfCreationEnabled" type="checkbox" />
                      <span>允许自行创建</span>
                    </label>
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="aliasPolicyActionId !== null"
                      @click="saveAliasPolicy(user)"
                    >
                      {{ aliasPolicyActionId === `policy:${user.id}` ? '正在保存' : '保存策略' }}
                    </button>
                  </div>

                  <div class="alias-policy-usage">
                    <span :class="{ 'status-label--disabled': user.policy.overLimit }">
                      已使用 {{ user.policy.aliasUsed }} / {{ user.policy.aliasLimit }}
                    </span>
                    <div v-if="user.aliases.length" class="assigned-alias-list">
                      <div
                        v-for="alias in user.aliases"
                        :key="alias.id"
                        class="assigned-alias-item"
                      >
                        <span>{{ alias.address }}</span>
                        <button
                          class="button button--danger-quiet button--compact"
                          type="button"
                          :disabled="aliasPolicyActionId !== null"
                          @click="requestAdministratorAliasDeletion(user, alias)"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <small v-else>暂无个人别名</small>
                  </div>
                </article>
              </div>
              <p v-else-if="!aliasPolicyLoading" class="empty-state">没有可显示的用户策略。</p>

              <section
                v-if="aliasPendingDeletion?.administratorAction"
                class="destructive-confirmation"
                aria-labelledby="administrator-alias-deletion-title"
              >
                <h2 id="administrator-alias-deletion-title">删除成员个人别名</h2>
                <p>
                  将从 <strong>{{ aliasPendingDeletion.targetDisplayName }}</strong> 的账号中删除
                  <strong>{{ aliasPendingDeletion.address.address }}</strong
                  >。{{ aliasDeletionImpactText() }}
                </p>
                <label class="checkbox-field">
                  <input v-model="aliasDeletionConfirmed" type="checkbox" />
                  <span>{{ aliasDeletionConfirmationText() }}</span>
                </label>
                <div class="confirmation-actions">
                  <button
                    class="button button--secondary button--compact"
                    type="button"
                    :disabled="aliasPolicyActionId !== null"
                    @click="cancelAliasDeletion"
                  >
                    取消
                  </button>
                  <button
                    class="button button--danger-quiet button--compact"
                    type="button"
                    :disabled="!aliasDeletionConfirmed || aliasPolicyActionId !== null"
                    @click="confirmAliasDeletion"
                  >
                    {{
                      aliasPolicyActionId === `delete:${aliasPendingDeletion.address.id}`
                        ? '正在删除'
                        : '确认删除'
                    }}
                  </button>
                </div>
              </section>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'invitations'"
              class="account-settings-section"
              aria-labelledby="account-registration-invitations-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="account-registration-invitations-title">账号邀请码</h2>
                  <p>由管理员生成并自行转交，注册成功后立即失效</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="
                    accountRegistrationInvitationLoading ||
                    accountRegistrationInvitationAction !== null
                  "
                  @click="refreshAccountRegistrationInvitations"
                >
                  {{ accountRegistrationInvitationLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <p v-if="accountRegistrationInvitationError" class="form-alert" role="alert">
                {{ accountRegistrationInvitationError }}
              </p>
              <p v-if="accountRegistrationInvitationNotice" class="form-success" role="status">
                {{ accountRegistrationInvitationNotice }}
              </p>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitAccountRegistrationInvitationCreation"
              >
                <label
                  v-if="(accountRegistrationInvitations?.domains.length ?? 0) > 1"
                  class="field"
                >
                  <span>邮件域名</span>
                  <select
                    v-model="accountRegistrationInvitationDomainId"
                    name="account-registration-invitation-domain"
                    required
                  >
                    <option value="" disabled>选择域名</option>
                    <option
                      v-for="domain in accountRegistrationInvitations?.domains ?? []"
                      :key="domain.id"
                      :value="domain.id"
                    >
                      {{ domain.canonicalName }}
                    </option>
                  </select>
                </label>
                <p
                  v-else-if="accountRegistrationInvitations?.domains.length === 1"
                  class="form-notice"
                >
                  新账号将使用
                  <strong>{{ accountRegistrationInvitations.domains[0]?.canonicalName }}</strong>
                </p>
                <p v-else class="form-notice">当前没有可用于注册的已启用邮件域名。</p>
                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="
                      accountRegistrationInvitationAction !== null ||
                      !(accountRegistrationInvitations?.domains.length ?? 0)
                    "
                  >
                    {{
                      accountRegistrationInvitationAction === 'create' ? '正在生成' : '生成邀请码'
                    }}
                  </button>
                </div>
              </form>

              <div
                v-if="accountRegistrationInvitations?.invitations.length"
                class="managed-user-list"
              >
                <article
                  v-for="invitation in accountRegistrationInvitations.invitations"
                  :key="invitation.id"
                  class="managed-user-row invitation-row"
                >
                  <div class="managed-user-primary">
                    <div class="managed-user-title">
                      <strong>{{ invitation.domainName }}</strong>
                      <span
                        class="status-label"
                        :class="{
                          'status-label--disabled': invitation.status !== 'available',
                        }"
                      >
                        {{ accountRegistrationInvitationStatusLabel(invitation.status) }}
                      </span>
                    </div>
                    <div class="copy-field invitation-code-field">
                      <input :value="invitation.code" readonly aria-label="账号邀请码" />
                      <button
                        class="button button--secondary button--compact"
                        type="button"
                        @click="copyAccountRegistrationInvitationCode(invitation)"
                      >
                        复制
                      </button>
                    </div>
                    <dl class="managed-user-details">
                      <div>
                        <dt>生成时间</dt>
                        <dd>{{ formatDate(invitation.createdAt) }}</dd>
                      </div>
                      <div v-if="invitation.usedBy">
                        <dt>注册账号</dt>
                        <dd>{{ invitation.usedBy.primaryAddress }}</dd>
                      </div>
                      <div v-else-if="invitation.revokedAt">
                        <dt>撤销时间</dt>
                        <dd>{{ formatDate(invitation.revokedAt) }}</dd>
                      </div>
                    </dl>
                  </div>
                  <div v-if="invitation.status === 'available'" class="managed-user-actions">
                    <button
                      class="button button--danger-quiet button--compact"
                      type="button"
                      :disabled="accountRegistrationInvitationAction !== null"
                      @click="revokeManagedAccountRegistrationInvitation(invitation)"
                    >
                      {{
                        accountRegistrationInvitationAction === `revoke:${invitation.id}`
                          ? '正在撤销'
                          : '撤销'
                      }}
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!accountRegistrationInvitationLoading" class="empty-state">
                尚未生成账号邀请码。
              </p>
            </section>

            <section
              v-if="authentication.user.role === 'administrator'"
              v-show="settingsSection === 'users'"
              class="account-settings-section"
              aria-labelledby="user-management-title"
            >
              <div class="section-heading section-heading--row">
                <div>
                  <h2 id="user-management-title">用户管理</h2>
                  <p>{{ userManagement?.users.length ?? 0 }} 个当前账号</p>
                </div>
                <button
                  class="button button--secondary button--compact"
                  type="button"
                  :disabled="userManagementLoading || userActionId !== null"
                  @click="refreshUserManagement"
                >
                  {{ userManagementLoading ? '正在刷新' : '刷新' }}
                </button>
              </div>

              <form
                class="account-form management-create-form"
                @submit.prevent="submitUserCreation"
              >
                <div class="form-grid">
                  <label class="field field--wide">
                    <span>显示名称</span>
                    <input
                      v-model="userForm.displayName"
                      name="new-user-display-name"
                      autocomplete="off"
                      maxlength="80"
                      required
                      :aria-invalid="Boolean(userErrors.displayName)"
                    />
                    <small v-if="userErrors.displayName" class="field-error">{{
                      userErrors.displayName
                    }}</small>
                  </label>

                  <label class="field">
                    <span>邮箱前缀</span>
                    <input
                      v-model="userForm.localPart"
                      name="new-user-local-part"
                      inputmode="email"
                      autocapitalize="none"
                      maxlength="64"
                      required
                      :aria-invalid="Boolean(userErrors.localPart)"
                    />
                    <small v-if="userErrors.localPart" class="field-error">{{
                      userErrors.localPart
                    }}</small>
                  </label>

                  <label class="field">
                    <span>邮件域名</span>
                    <select
                      v-model="userForm.domainId"
                      name="new-user-domain"
                      required
                      :aria-invalid="Boolean(userErrors.domainId)"
                    >
                      <option value="" disabled>选择域名</option>
                      <option
                        v-for="domain in userManagement?.domains ?? []"
                        :key="domain.id"
                        :value="domain.id"
                      >
                        {{ domain.canonicalName }}
                      </option>
                    </select>
                    <small v-if="userErrors.domainId" class="field-error">{{
                      userErrors.domainId
                    }}</small>
                  </label>

                  <label class="field field--wide">
                    <span>初始时区</span>
                    <input
                      v-model="userForm.timezone"
                      name="new-user-timezone"
                      autocomplete="off"
                      maxlength="64"
                      required
                      :aria-invalid="Boolean(userErrors.timezone)"
                    />
                    <small v-if="userErrors.timezone" class="field-error">{{
                      userErrors.timezone
                    }}</small>
                  </label>
                </div>

                <div class="form-actions form-actions--end">
                  <button
                    class="button button--primary"
                    type="submit"
                    :disabled="userCreateSubmitting || !(userManagement?.domains.length ?? 0)"
                  >
                    {{ userCreateSubmitting ? '正在创建' : '创建用户' }}
                  </button>
                </div>
              </form>

              <div
                v-if="temporaryPasswordResult"
                class="temporary-password-result"
                aria-live="polite"
              >
                <p>
                  <strong>{{ temporaryPasswordHeading }}</strong>
                  <span
                    >{{ temporaryPasswordResult.user.displayName }} ·
                    {{ temporaryPasswordResult.user.primaryAddress }}</span
                  >
                </p>
                <label class="field">
                  <span>临时密码</span>
                  <div class="copy-field">
                    <input :value="temporaryPasswordResult.temporaryPassword" readonly />
                    <button
                      class="button button--secondary button--compact"
                      type="button"
                      @click="copyTemporaryPassword"
                    >
                      复制
                    </button>
                  </div>
                </label>
                <small
                  >有效至
                  {{
                    formatDate(temporaryPasswordResult.expiresAt)
                  }}；离开本页后不能再次查看。</small
                >
                <small v-if="temporaryPasswordNotice" class="copy-notice">{{
                  temporaryPasswordNotice
                }}</small>
              </div>

              <div v-if="userManagement?.users.length" class="managed-user-list">
                <article
                  v-for="user in userManagement.users"
                  :key="user.id"
                  class="managed-user-row"
                >
                  <div class="managed-user-primary">
                    <div class="managed-user-title">
                      <strong>{{ user.displayName }}</strong>
                      <span v-if="user.role === 'administrator'" class="status-label">
                        系统管理员
                      </span>
                      <span
                        v-else
                        class="status-label"
                        :class="{ 'status-label--disabled': user.status === 'disabled' }"
                      >
                        {{ userStatusLabel(user.status) }}
                      </span>
                    </div>
                    <p>{{ user.primaryAddress }}</p>
                    <dl class="managed-user-details">
                      <div>
                        <dt>时区</dt>
                        <dd>{{ user.timezone ?? '未设置' }}</dd>
                      </div>
                      <div>
                        <dt>创建时间</dt>
                        <dd>{{ formatDate(user.createdAt) }}</dd>
                      </div>
                    </dl>
                  </div>

                  <div v-if="user.role === 'user'" class="managed-user-actions">
                    <button
                      v-if="user.status === 'active'"
                      class="button button--secondary button--compact"
                      type="button"
                      :disabled="userActionId !== null"
                      @click="resetManagedUserPassword(user)"
                    >
                      {{ userActionId === `reset:${user.id}` ? '正在重置' : '重置密码' }}
                    </button>
                    <button
                      class="button button--compact"
                      :class="
                        user.status === 'active' ? 'button--danger-quiet' : 'button--secondary'
                      "
                      type="button"
                      :disabled="userActionId !== null"
                      @click="toggleManagedUserStatus(user)"
                    >
                      {{
                        userActionId === `status:${user.id}`
                          ? '正在处理'
                          : user.status === 'active'
                            ? '禁用'
                            : '重新启用'
                      }}
                    </button>
                  </div>
                </article>
              </div>
              <p v-else-if="!userManagementLoading" class="empty-state">没有可显示的用户。</p>
            </section>
          </div>
        </div>

        <nav
          v-if="
            workspaceView === 'mailbox' &&
            !selectedMessage &&
            !selectedUnallocatedMessage &&
            !selectedMessageLoading &&
            !selectedUnallocatedMessageLoading
          "
          class="mobile-bottom-navigation"
          aria-label="手机主要导航"
        >
          <button type="button" aria-current="page" @click="openWorkspace('mailbox')">
            <Inbox :size="20" />
            <span>邮件</span>
          </button>
          <button type="button" :disabled="draftAction !== null" @click="startNewDraft">
            <PenLine :size="20" />
            <span>写信</span>
          </button>
          <button type="button" @click="openSettings()">
            <Settings :size="20" />
            <span>设置</span>
          </button>
        </nav>
      </section>

      <section
        v-else-if="status?.data.initialization === 'initialized'"
        class="login-view"
        :aria-labelledby="
          accountRegistrationMode
            ? 'account-registration-title'
            : accountRecoveryMode
              ? 'account-recovery-title'
              : recoveryMode
                ? 'recovery-title'
                : 'login-title'
        "
      >
        <div class="login-heading">
          <template v-if="accountRegistrationMode">
            <p class="eyebrow">受邀注册</p>
            <h1 id="account-registration-title">创建澄笺账号</h1>
          </template>
          <template v-else-if="accountRecoveryMode">
            <p class="eyebrow">账号注销</p>
            <h1 id="account-recovery-title">恢复待注销账号</h1>
          </template>
          <template v-else-if="recoveryMode">
            <p class="eyebrow">系统管理员</p>
            <h1 id="recovery-title">恢复管理员密码</h1>
          </template>
          <template v-else>
            <p class="eyebrow">账号登录</p>
            <h1 id="login-title">登录澄笺</h1>
          </template>
        </div>

        <p v-if="authError" class="form-alert" role="alert">{{ authError }}</p>
        <p v-if="authNotice" class="form-success" role="status">{{ authNotice }}</p>

        <form
          v-if="accountRegistrationMode && !accountRegistrationDomain"
          class="login-form"
          @submit.prevent="submitAccountRegistrationInvitationVerification"
        >
          <label class="field">
            <span>邀请码</span>
            <input
              v-model="accountRegistrationForm.code"
              name="account-registration-code"
              autocomplete="one-time-code"
              autocapitalize="characters"
              maxlength="80"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.code)"
            />
            <small v-if="accountRegistrationErrors.code" class="field-error">
              {{ accountRegistrationErrors.code }}
            </small>
          </label>
          <div class="form-actions recovery-actions">
            <button
              class="button button--secondary"
              type="button"
              :disabled="accountRegistrationSubmitting"
              @click="closeAccountRegistration"
            >
              返回登录
            </button>
            <button
              class="button button--primary"
              type="submit"
              :disabled="accountRegistrationSubmitting"
            >
              {{ accountRegistrationSubmitting ? '正在验证' : '验证邀请码' }}
            </button>
          </div>
        </form>

        <form
          v-else-if="accountRegistrationMode"
          class="login-form"
          @submit.prevent="submitAccountRegistration"
        >
          <p class="recovery-subject">
            <span>邮件域名</span>
            <strong>{{ accountRegistrationDomain }}</strong>
          </p>
          <label class="field">
            <span>显示名称</span>
            <input
              v-model="accountRegistrationForm.displayName"
              name="account-registration-display-name"
              autocomplete="name"
              maxlength="80"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.displayName)"
            />
            <small v-if="accountRegistrationErrors.displayName" class="field-error">
              {{ accountRegistrationErrors.displayName }}
            </small>
          </label>
          <label class="field">
            <span>邮箱前缀</span>
            <input
              v-model="accountRegistrationForm.localPart"
              name="account-registration-local-part"
              inputmode="email"
              autocapitalize="none"
              maxlength="64"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.localPart)"
            />
            <small v-if="accountRegistrationForm.localPart.trim()" class="field-hint">
              {{ accountRegistrationForm.localPart.trim().toLowerCase() }}@{{
                accountRegistrationDomain
              }}
            </small>
            <small v-if="accountRegistrationErrors.localPart" class="field-error">
              {{ accountRegistrationErrors.localPart }}
            </small>
          </label>
          <label class="field">
            <span>密码</span>
            <input
              v-model="accountRegistrationForm.password"
              :type="accountRegistrationForm.showPassword ? 'text' : 'password'"
              name="account-registration-password"
              autocomplete="new-password"
              maxlength="128"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.password)"
            />
            <small v-if="accountRegistrationErrors.password" class="field-error">
              {{ accountRegistrationErrors.password }}
            </small>
          </label>
          <label class="field">
            <span>确认密码</span>
            <input
              v-model="accountRegistrationForm.confirmPassword"
              :type="accountRegistrationForm.showPassword ? 'text' : 'password'"
              name="account-registration-confirm-password"
              autocomplete="new-password"
              maxlength="128"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.confirmPassword)"
            />
            <small v-if="accountRegistrationErrors.confirmPassword" class="field-error">
              {{ accountRegistrationErrors.confirmPassword }}
            </small>
          </label>
          <label class="field">
            <span>时区</span>
            <input
              v-model="accountRegistrationForm.timezone"
              name="account-registration-timezone"
              autocomplete="off"
              maxlength="64"
              required
              :aria-invalid="Boolean(accountRegistrationErrors.timezone)"
            />
            <small v-if="accountRegistrationErrors.timezone" class="field-error">
              {{ accountRegistrationErrors.timezone }}
            </small>
          </label>
          <label class="checkbox-field">
            <input v-model="accountRegistrationForm.showPassword" type="checkbox" />
            <span>显示密码</span>
          </label>
          <div class="form-actions recovery-actions">
            <button
              class="button button--secondary"
              type="button"
              :disabled="accountRegistrationSubmitting"
              @click="changeAccountRegistrationInvitation"
            >
              更换邀请码
            </button>
            <button
              class="button button--primary"
              type="submit"
              :disabled="accountRegistrationSubmitting"
            >
              {{ accountRegistrationSubmitting ? '正在创建' : '创建账号' }}
            </button>
          </div>
        </form>

        <form
          v-else-if="accountRecoveryMode && !accountRecoverySession"
          class="login-form"
          @submit.prevent="submitAccountRecoveryLogin"
        >
          <p class="form-notice">仅适用于仍在七天冷静期内的待注销账号。</p>
          <label class="field">
            <span>主邮箱地址</span>
            <input
              v-model="accountRecoveryForm.email"
              type="email"
              name="account-recovery-email"
              autocomplete="username"
              inputmode="email"
              autocapitalize="none"
              required
              :aria-invalid="Boolean(accountRecoveryErrors.email)"
            />
            <small v-if="accountRecoveryErrors.email" class="field-error">
              {{ accountRecoveryErrors.email }}
            </small>
          </label>
          <label class="field">
            <span>密码</span>
            <input
              v-model="accountRecoveryForm.password"
              :type="accountRecoveryForm.showPassword ? 'text' : 'password'"
              name="account-recovery-password"
              autocomplete="current-password"
              required
              :aria-invalid="Boolean(accountRecoveryErrors.password)"
            />
            <small v-if="accountRecoveryErrors.password" class="field-error">
              {{ accountRecoveryErrors.password }}
            </small>
          </label>
          <label class="checkbox-field">
            <input v-model="accountRecoveryForm.showPassword" type="checkbox" />
            <span>显示密码</span>
          </label>
          <div class="form-actions recovery-actions">
            <button class="button button--secondary" type="button" @click="closeAccountRecovery">
              返回登录
            </button>
            <button
              class="button button--primary"
              type="submit"
              :disabled="accountRecoverySubmitting"
            >
              {{ accountRecoverySubmitting ? '正在验证' : '验证账号' }}
            </button>
          </div>
        </form>

        <div v-else-if="accountRecoveryMode" class="login-form">
          <p class="recovery-subject">
            <span>待注销账号</span>
            <strong>{{ accountRecoverySession?.primaryAddress }}</strong>
          </p>
          <dl class="account-recovery-summary">
            <div>
              <dt>显示名称</dt>
              <dd>{{ accountRecoverySession?.displayName }}</dd>
            </div>
            <div>
              <dt>永久删除时间</dt>
              <dd>{{ formatDate(accountRecoverySession?.deletionDueAt ?? '') }}</dd>
            </div>
          </dl>
          <p class="confirmation-note">
            取消注销后，账号恢复为可登录状态；离开组织期间产生的邮件不会自动补入个人邮箱。
          </p>
          <div class="form-actions recovery-actions">
            <button class="button button--secondary" type="button" @click="closeAccountRecovery">
              暂不恢复
            </button>
            <button
              class="button button--primary"
              type="button"
              :disabled="accountRecoverySubmitting"
              @click="cancelAccountDeletionFromRecovery"
            >
              {{ accountRecoverySubmitting ? '正在恢复' : '取消账号注销' }}
            </button>
          </div>
        </div>

        <form v-else-if="!recoveryMode" class="login-form" @submit.prevent="submitLogin">
          <label class="field">
            <span>主邮箱地址</span>
            <input
              v-model="loginForm.email"
              type="email"
              name="email"
              autocomplete="username"
              inputmode="email"
              autocapitalize="none"
              required
              :aria-invalid="Boolean(loginErrors.email)"
            />
            <small v-if="loginErrors.email" class="field-error">{{ loginErrors.email }}</small>
          </label>

          <label class="field">
            <span>密码</span>
            <input
              v-model="loginForm.password"
              :type="loginForm.showPassword ? 'text' : 'password'"
              name="password"
              autocomplete="current-password"
              required
              :aria-invalid="Boolean(loginErrors.password)"
            />
            <small v-if="loginErrors.password" class="field-error">{{
              loginErrors.password
            }}</small>
          </label>

          <label class="checkbox-field">
            <input v-model="loginForm.showPassword" type="checkbox" />
            <span>显示密码</span>
          </label>

          <button class="button button--primary login-submit" type="submit" :disabled="submitting">
            {{ submitting ? '正在登录' : '登录' }}
          </button>

          <button class="button button--text" type="button" @click="openRecovery">
            恢复管理员密码
          </button>
          <button class="button button--text" type="button" @click="openAccountRegistration">
            使用邀请码注册
          </button>
          <button class="button button--text" type="button" @click="openAccountRecovery">
            恢复待注销账号
          </button>
        </form>

        <form v-else-if="recoveryStep === 1" class="login-form" @submit.prevent="authorizeRecovery">
          <p class="form-notice">
            使用部署配置中的初始化密钥确认身份。该密钥不会被保存到系统数据中。
          </p>

          <label class="field">
            <span>初始化密钥</span>
            <input
              v-model="recoveryForm.initKey"
              type="password"
              name="recovery-init-key"
              autocomplete="off"
              required
              :aria-invalid="Boolean(recoveryErrors.initKey)"
            />
            <small v-if="recoveryErrors.initKey" class="field-error">{{
              recoveryErrors.initKey
            }}</small>
          </label>

          <div class="form-actions recovery-actions">
            <button class="button button--secondary" type="button" @click="closeRecovery">
              返回登录
            </button>
            <button class="button button--primary" type="submit" :disabled="recoverySubmitting">
              {{ recoverySubmitting ? '正在验证' : '验证初始化密钥' }}
            </button>
          </div>
        </form>

        <form v-else class="login-form" @submit.prevent="completeRecovery">
          <p class="recovery-subject">
            <span>恢复账号</span>
            <strong>{{ recoverySubject?.primaryAddress }}</strong>
          </p>

          <label class="field">
            <span>新密码</span>
            <input
              v-model="recoveryForm.newPassword"
              :type="recoveryForm.showPassword ? 'text' : 'password'"
              name="recovery-new-password"
              autocomplete="new-password"
              maxlength="128"
              required
              :aria-invalid="Boolean(recoveryErrors.newPassword)"
            />
            <small v-if="recoveryErrors.newPassword" class="field-error">{{
              recoveryErrors.newPassword
            }}</small>
          </label>

          <label class="field">
            <span>确认新密码</span>
            <input
              v-model="recoveryForm.confirmPassword"
              :type="recoveryForm.showPassword ? 'text' : 'password'"
              name="recovery-confirm-password"
              autocomplete="new-password"
              maxlength="128"
              required
              :aria-invalid="Boolean(recoveryErrors.confirmPassword)"
            />
            <small v-if="recoveryErrors.confirmPassword" class="field-error">{{
              recoveryErrors.confirmPassword
            }}</small>
          </label>

          <label class="checkbox-field">
            <input v-model="recoveryForm.showPassword" type="checkbox" />
            <span>显示密码</span>
          </label>

          <p class="confirmation-note">
            完成恢复后，管理员当前所有登录会话都会退出，需要使用新密码重新登录。
          </p>

          <div class="form-actions recovery-actions">
            <button
              class="button button--secondary"
              type="button"
              :disabled="recoverySubmitting"
              @click="returnToRecoveryAuthorization"
            >
              返回验证
            </button>
            <button class="button button--primary" type="submit" :disabled="recoverySubmitting">
              {{ recoverySubmitting ? '正在恢复' : '恢复管理员密码' }}
            </button>
          </div>
        </form>
      </section>

      <section v-else class="wizard" aria-labelledby="wizard-title">
        <div class="wizard-heading">
          <p class="eyebrow">首次设置</p>
          <h1 id="wizard-title">初始化澄笺</h1>
          <p class="lead">当前部署使用 {{ storageModeLabel }}。</p>
        </div>

        <ol class="stepper" aria-label="初始化进度">
          <li :class="{ active: step === 1, complete: step > 1 }"><span>1</span>部署鉴权</li>
          <li :class="{ active: step === 2, complete: step > 2 }"><span>2</span>管理员与域名</li>
          <li :class="{ active: step === 3 }"><span>3</span>确认建立</li>
        </ol>

        <p v-if="pageError" class="form-alert" role="alert">{{ pageError }}</p>

        <form v-if="step === 1" class="wizard-form" @submit.prevent="verifyInitializationKey">
          <div class="section-heading">
            <h2>验证部署配置</h2>
          </div>

          <label class="field">
            <span>初始化密钥</span>
            <input
              v-model="form.initKey"
              type="password"
              name="init-key"
              autocomplete="off"
              required
              :aria-invalid="Boolean(fieldErrors.initKey)"
              aria-describedby="init-key-error"
            />
            <small v-if="fieldErrors.initKey" id="init-key-error" class="field-error">{{
              fieldErrors.initKey
            }}</small>
          </label>

          <div class="form-actions form-actions--end">
            <button class="button button--primary" type="submit" :disabled="submitting">
              {{ submitting ? '正在验证' : '继续' }}
            </button>
          </div>
        </form>

        <form v-else-if="step === 2" class="wizard-form" @submit.prevent="reviewDetails">
          <div class="section-heading">
            <h2>建立唯一管理员</h2>
          </div>

          <div class="form-grid">
            <label class="field field--wide">
              <span>管理员显示名称</span>
              <input
                v-model="form.adminDisplayName"
                name="display-name"
                autocomplete="name"
                maxlength="80"
                required
                :aria-invalid="Boolean(fieldErrors.adminDisplayName)"
              />
              <small v-if="fieldErrors.adminDisplayName" class="field-error">{{
                fieldErrors.adminDisplayName
              }}</small>
            </label>

            <label class="field">
              <span>邮箱前缀</span>
              <input
                v-model="form.localPart"
                name="local-part"
                inputmode="email"
                autocapitalize="none"
                maxlength="64"
                required
                :aria-invalid="Boolean(fieldErrors.localPart)"
              />
              <small v-if="fieldErrors.localPart" class="field-error">{{
                fieldErrors.localPart
              }}</small>
            </label>

            <label class="field">
              <span>邮件域名</span>
              <input
                v-model="form.domainName"
                name="domain-name"
                inputmode="url"
                autocapitalize="none"
                maxlength="253"
                placeholder="example.com"
                required
                :aria-invalid="Boolean(fieldErrors.domainName)"
              />
              <small v-if="fieldErrors.domainName" class="field-error">{{
                fieldErrors.domainName
              }}</small>
            </label>

            <label class="field">
              <span>登录密码</span>
              <input
                v-model="form.password"
                :type="form.showPassword ? 'text' : 'password'"
                name="password"
                autocomplete="new-password"
                maxlength="128"
                required
                :aria-invalid="Boolean(fieldErrors.password)"
              />
              <small v-if="fieldErrors.password" class="field-error">{{
                fieldErrors.password
              }}</small>
            </label>

            <label class="field">
              <span>确认密码</span>
              <input
                v-model="form.confirmPassword"
                :type="form.showPassword ? 'text' : 'password'"
                name="confirm-password"
                autocomplete="new-password"
                maxlength="128"
                required
                :aria-invalid="Boolean(fieldErrors.confirmPassword)"
              />
              <small v-if="fieldErrors.confirmPassword" class="field-error">{{
                fieldErrors.confirmPassword
              }}</small>
            </label>

            <label class="checkbox-field field--wide">
              <input v-model="form.showPassword" type="checkbox" />
              <span>显示密码</span>
            </label>

            <label class="field field--wide">
              <span>时区</span>
              <input
                v-model="form.timezone"
                name="timezone"
                autocomplete="off"
                maxlength="64"
                required
                :aria-invalid="Boolean(fieldErrors.timezone)"
              />
              <small v-if="fieldErrors.timezone" class="field-error">{{
                fieldErrors.timezone
              }}</small>
            </label>
          </div>

          <div class="form-actions">
            <button class="button button--secondary" type="button" @click="step = 1">返回</button>
            <button class="button button--primary" type="submit">检查信息</button>
          </div>
        </form>

        <section v-else class="wizard-form" aria-labelledby="review-title">
          <div class="section-heading">
            <h2 id="review-title">确认初始化信息</h2>
          </div>

          <dl class="summary-list">
            <div>
              <dt>管理员</dt>
              <dd>{{ form.adminDisplayName.trim() }}</dd>
            </div>
            <div>
              <dt>主邮箱</dt>
              <dd>{{ primaryAddressPreview }}</dd>
            </div>
            <div>
              <dt>时区</dt>
              <dd>{{ form.timezone }}</dd>
            </div>
            <div>
              <dt>存储方式</dt>
              <dd>{{ storageModeLabel }}</dd>
            </div>
          </dl>

          <div class="confirmation-note">
            系统将一次性建立管理员、主邮箱和首个邮件域名。初始化完成后不能再次执行。
          </div>

          <div class="form-actions">
            <button
              class="button button--secondary"
              type="button"
              :disabled="submitting"
              @click="step = 2"
            >
              返回修改
            </button>
            <button
              class="button button--primary"
              type="button"
              :disabled="submitting"
              @click="finishInitialization"
            >
              {{ submitting ? '正在建立' : '完成初始化' }}
            </button>
          </div>
        </section>
      </section>
    </main>
  </div>
</template>
