export type NotificationChannelType = 'ntfy' | 'gotify' | 'wxpusher' | 'telegram' | 'bark'

export type NotificationSubscriptionStatus = 'active' | 'paused' | 'deleted'

export type NotificationOperationStatus =
  'pending' | 'submitting' | 'submitted' | 'failed' | 'unknown' | 'cancelled'

export type NotificationScopeInput =
  | { kind: 'all_personal' }
  | { kind: 'personal_address' | 'organization_address'; addressId: string }

export interface CreateNotificationSubscriptionRequest {
  displayName: string
  channelType: NotificationChannelType
  baseUrl: string
  destination: string
  credential: string
  scopes: NotificationScopeInput[]
}

export interface ChangeNotificationSubscriptionStatusRequest {
  status: 'active' | 'paused'
}

export interface NotificationAvailableScope {
  kind: 'personal_address' | 'organization_address'
  addressId: string
  label: string
  address: string
}

export interface NotificationSubscriptionScopeSummary {
  kind: NotificationScopeInput['kind']
  addressId: string | null
  label: string
}

export interface NotificationSubscriptionSummary {
  id: string
  displayName: string
  channelType: NotificationChannelType
  status: NotificationSubscriptionStatus
  baseUrl: string | null
  destination: string | null
  credentialConfigured: boolean
  scopes: NotificationSubscriptionScopeSummary[]
  createdAt: string
  updatedAt: string
}

export interface NotificationOperationSummary {
  id: string
  subscriptionId: string
  subscriptionName: string
  channelType: NotificationChannelType
  subject: string
  status: NotificationOperationStatus
  errorCode: string | null
  errorSummary: string | null
  createdAt: string
  completedAt: string | null
}

export interface NotificationOverviewResponse {
  data: {
    encryptionConfigured: boolean
    subscriptions: NotificationSubscriptionSummary[]
    availableScopes: NotificationAvailableScope[]
    recentOperations: NotificationOperationSummary[]
  }
}

export interface CreateNotificationSubscriptionResponse {
  data: { subscription: NotificationSubscriptionSummary }
}

export interface ChangeNotificationSubscriptionStatusResponse {
  data: { subscription: NotificationSubscriptionSummary }
}

export interface DeleteNotificationSubscriptionResponse {
  data: { deletedSubscriptionId: string }
}
