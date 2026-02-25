import type { SecurityConfiguration } from "@/configuration/schema.ts";
import type { TriggerType } from "@/queue/schema.ts";
import type { ApprovalPolicy } from "@/queue/schema.ts";
import { APPROVAL_POLICY } from "@/queue/schema.ts";

export class ApprovalPolicyResolver {
  private securityConfiguration: SecurityConfiguration;

  constructor(securityConfiguration: SecurityConfiguration) {
    this.securityConfiguration = securityConfiguration;
  }

  resolveForTrigger(triggerType: TriggerType): ApprovalPolicy {
    const matchingRule = this.securityConfiguration.rules.find(
      (rule) => rule.trigger === triggerType,
    );

    if (matchingRule) {
      return matchingRule.policy as ApprovalPolicy;
    }

    return this.securityConfiguration.defaultPolicy as ApprovalPolicy;
  }

  requiresApproval(triggerType: TriggerType): boolean {
    return this.resolveForTrigger(triggerType) === APPROVAL_POLICY.reviewRequired;
  }
}
