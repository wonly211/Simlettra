export type OrganizationStatus = 'active' | 'deletion_pending'
export type OrganizationInvitationPolicy = 'reject_all' | 'manual' | 'auto_accept'
export type OrganizationInvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked'

export interface OrganizationPolicySummary {
  organizationLimit: number
  ownedOrganizationCount: number
  remainingOrganizationCount: number
  overLimit: boolean
}

export interface OrganizationDomainSummary {
  id: string
  displayName: string
  canonicalName: string
}

export interface OrganizationMemberSummary {
  membershipId: string
  userId: string
  displayName: string
  primaryAddress: string
  role: 'creator' | 'member'
  joinedAt: string
}

export interface OrganizationInvitationSummary {
  id: string
  organizationId: string
  organizationName: string
  sharedAddress: string
  invitedUserId: string
  invitedUserDisplayName: string
  invitedUserPrimaryAddress: string
  invitedByUserId: string
  invitedByDisplayName: string
  status: OrganizationInvitationStatus
  createdAt: string
  resolvedAt: string | null
}

export interface OrganizationSummary {
  id: string
  name: string
  status: OrganizationStatus
  sharedAddress: string
  addressId: string
  creatorUserId: string
  isCreator: boolean
  membersCanSend: boolean
  canSendAsOrganization: boolean
  memberCount: number
  members: OrganizationMemberSummary[]
  pendingInvitations: OrganizationInvitationSummary[]
  createdAt: string
  deletionDueAt: string | null
}

export interface OrganizationOverviewResponse {
  data: {
    invitationPolicy: OrganizationInvitationPolicy
    policy: OrganizationPolicySummary
    activeDomains: OrganizationDomainSummary[]
    organizations: OrganizationSummary[]
    pendingInvitations: OrganizationInvitationSummary[]
  }
}

export interface CreateOrganizationRequest {
  name: string
  localPart: string
  domainId: string
}

export interface CreateOrganizationResponse {
  data: { organization: OrganizationSummary }
}

export interface UpdateOrganizationInvitationPolicyRequest {
  invitationPolicy: OrganizationInvitationPolicy
}

export interface UpdateOrganizationInvitationPolicyResponse {
  data: { invitationPolicy: OrganizationInvitationPolicy }
}

export interface CreateOrganizationInvitationRequest {
  primaryAddress: string
}

export interface CreateOrganizationInvitationResponse {
  data: {
    invitation: OrganizationInvitationSummary
    outcome: 'pending' | 'accepted' | 'rejected'
  }
}

export interface ResolveOrganizationInvitationResponse {
  data: {
    invitationId: string
    status: 'accepted' | 'rejected' | 'revoked'
  }
}

export interface UpdateOrganizationSendingPermissionRequest {
  membersCanSend: boolean
}

export interface UpdateOrganizationSendingPermissionResponse {
  data: { organization: OrganizationSummary }
}

export interface LeaveOrganizationRequest {
  successorUserId: string | null
  confirmed: boolean
}

export interface LeaveOrganizationResponse {
  data: {
    organizationId: string
    outcome: 'left' | 'transferred' | 'deletion_pending'
    successorUserId: string | null
    deletionDueAt: string | null
  }
}

export interface DeleteOrganizationRequest {
  confirmed: boolean
}

export interface DeleteOrganizationResponse {
  data: {
    organizationId: string
    deletionDueAt: string
  }
}

export interface RestoreOrganizationResponse {
  data: { organization: OrganizationSummary }
}

export interface AdministratorOrganizationPolicyUser {
  userId: string
  displayName: string
  primaryAddress: string
  userStatus: 'active' | 'disabled'
  policy: OrganizationPolicySummary
}

export interface AdministratorOrganizationPolicyOverviewResponse {
  data: { users: AdministratorOrganizationPolicyUser[] }
}

export interface UpdateUserOrganizationPolicyRequest {
  organizationLimit: number
}

export interface UpdateUserOrganizationPolicyResponse {
  data: { user: AdministratorOrganizationPolicyUser }
}
