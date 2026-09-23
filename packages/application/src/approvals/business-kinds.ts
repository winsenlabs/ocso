import type { DestinationEventRouting } from '@ocso/alerts';
import type { QueueAdapter } from '@ocso/queue';
import { escalationRuleApproval } from '../agents/escalation-rule-approval.js';
import { alertRuleApproval } from '../alerts/alert-rule-approval.js';
import { messageTemplateApproval } from '../channels/message-template-approval.js';
import type { TemplateProviderSource } from '../channels/message-templates.js';
import type { AuthMailer } from '../identity/auth-mailer.js';
import { permissionChangeApproval } from '../identity/approval/permission-change-approval.js';
import { userApproval } from '../identity/approval/user-approval.js';
import { agentToolGrantApproval } from '../mcp/agent-tool-grant-approval.js';
import type { ApprovalDescriptor } from './contract.js';

/** What the business and identity descriptors need from the process (the worker supplies what deferred activations use). */
export interface BusinessApprovalDeps {
  /** Message templates: the channel adapters' template methods (the provider submission and deletion run in the worker). */
  templateProviders?: TemplateProviderSource | undefined;
  /** Users: the invite sent once a new user's creation is approved (worker). */
  authMailer?: AuthMailer | null | undefined;
  /** Alert rules: which destination kinds receive RESOLVED when a deleted rule's alerts close (worker; default: built-in adapters). */
  alertRouting?: DestinationEventRouting | undefined;
  /** Alert rules: publishes those deliveries at once (worker; else the redispatch sweep sends them). */
  alertQueue?: QueueAdapter | undefined;
}

/**
 * COVERAGE-BUSINESS kinds (PM/research/11 §4): agent tool grants, escalation
 * rules, business and technical alert rules, message templates, users and
 * permission changes.
 */
export function businessApprovals(deps: BusinessApprovalDeps = {}): ApprovalDescriptor[] {
  return [
    agentToolGrantApproval,
    escalationRuleApproval,
    alertRuleApproval('BUSINESS', { alertRouting: deps.alertRouting, alertQueue: deps.alertQueue }),
    alertRuleApproval('TECHNICAL', { alertRouting: deps.alertRouting, alertQueue: deps.alertQueue }),
    messageTemplateApproval({ templateProviders: deps.templateProviders }),
    userApproval({ authMailer: deps.authMailer }),
    permissionChangeApproval,
  ];
}
