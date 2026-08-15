export {
  changeForwardingRuleStatus,
  createExternalEmailTarget,
  deleteExternalEmailTarget,
  deleteForwardingRule,
  ForwardingAccessError,
  ForwardingInputError,
  getForwardingOverview,
  saveForwardingRule,
  verifyExternalEmailTarget,
} from './application/forwarding-management'
export {
  prepareForwardingWork,
  processMailForwardTask,
  type ForwardingDeliveryCandidate,
  type PreparedForwardingWork,
} from './application/forwarding-delivery'
