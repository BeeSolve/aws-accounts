import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import {
  AttachPolicyCommand,
  CreatePolicyCommand,
  DeletePolicyCommand,
  DetachPolicyCommand,
  UpdatePolicyCommand,
} from "@aws-sdk/client-organizations";

import { assertUnreachable } from "./helpers.js";
import type { Logger } from "./logger.js";
import type { Operation } from "./operations.js";
import {
  addOrgPolicyAttachmentToWorkingState,
  removeOrgPolicyAttachmentFromWorkingState,
  removeOrgPolicyFromWorkingState,
  upsertOrgPolicyInWorkingState,
  type WorkingState,
} from "./state.js";

type PolicyOperationKind =
  | "createOrgPolicy"
  | "updateOrgPolicyContent"
  | "updateOrgPolicyDescription"
  | "attachOrgPolicy"
  | "detachOrgPolicy"
  | "deleteOrgPolicy";

type PolicyOperation = Extract<Operation, { kind: PolicyOperationKind }>;

type ExecutePolicyOperationProps = {
  state: WorkingState;
  organizationsClient: OrganizationsClient;
  logger: Logger;
  context: {
    organization: {
      organizationId: string;
      rootId: string;
    };
  };
  operation: PolicyOperation;
};

export async function executePolicyOperation(
  props: ExecutePolicyOperationProps,
): Promise<WorkingState> {
  if (props.operation.kind === "createOrgPolicy") {
    props.logger.log(
      `Creating org policy "${props.operation.policyName}" (${props.operation.policyType})...`,
    );
    const response = await props.organizationsClient.send(
      new CreatePolicyCommand({
        Name: props.operation.policyName,
        Description:
          props.operation.description.length > 0 ? props.operation.description : undefined,
        Content: props.operation.content,
        Type: props.operation.policyType,
        Tags: [{ Key: "ManagedBy", Value: "beesolve-aws-accounts" }],
      }),
    );
    const policy = response.Policy?.PolicySummary;
    if (policy?.Id == null || policy.Arn == null) {
      throw new Error(`CreatePolicy for "${props.operation.policyName}" returned incomplete data.`);
    }
    props.logger.log(`Done: "${props.operation.policyName}"`);
    return upsertOrgPolicyInWorkingState({
      workingState: props.state,
      policy: {
        id: policy.Id,
        arn: policy.Arn,
        name: props.operation.policyName,
        description: props.operation.description,
        type: props.operation.policyType,
        content: props.operation.content,
      },
    });
  }
  if (props.operation.kind === "updateOrgPolicyContent") {
    props.logger.log(`Updating org policy content "${props.operation.policyName}"...`);
    await props.organizationsClient.send(
      new UpdatePolicyCommand({
        PolicyId: props.operation.policyId,
        Content: props.operation.content,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}"`);
    const currentPolicy = props.state.organization.policiesById[props.operation.policyId];
    if (currentPolicy == null) {
      return props.state;
    }
    return upsertOrgPolicyInWorkingState({
      workingState: props.state,
      policy: { ...currentPolicy, content: props.operation.content },
    });
  }
  if (props.operation.kind === "updateOrgPolicyDescription") {
    props.logger.log(`Updating org policy description "${props.operation.policyName}"...`);
    await props.organizationsClient.send(
      new UpdatePolicyCommand({
        PolicyId: props.operation.policyId,
        Description: props.operation.description,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}"`);
    const currentPolicy = props.state.organization.policiesById[props.operation.policyId];
    if (currentPolicy == null) {
      return props.state;
    }
    return upsertOrgPolicyInWorkingState({
      workingState: props.state,
      policy: { ...currentPolicy, description: props.operation.description },
    });
  }
  if (props.operation.kind === "attachOrgPolicy") {
    props.logger.log(
      `Attaching org policy "${props.operation.policyName}" to "${props.operation.targetName}"...`,
    );
    const resolvedPolicyId = resolvePolicyId({
      state: props.state,
      policyId: props.operation.policyId,
      policyName: props.operation.policyName,
    });
    await props.organizationsClient.send(
      new AttachPolicyCommand({
        PolicyId: resolvedPolicyId,
        TargetId: props.operation.targetId,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}" -> "${props.operation.targetName}"`);
    const targetType =
      props.operation.targetId === props.context.organization.rootId
        ? ("ROOT" as const)
        : props.state.organization.organizationalUnitsById[props.operation.targetId] != null
          ? ("ORGANIZATIONAL_UNIT" as const)
          : ("ACCOUNT" as const);
    return addOrgPolicyAttachmentToWorkingState({
      workingState: props.state,
      attachment: {
        policyId: resolvedPolicyId,
        targetId: props.operation.targetId,
        targetType,
      },
    });
  }
  if (props.operation.kind === "detachOrgPolicy") {
    props.logger.log(
      `Detaching org policy "${props.operation.policyName}" from "${props.operation.targetName}"...`,
    );
    await props.organizationsClient.send(
      new DetachPolicyCommand({
        PolicyId: props.operation.policyId,
        TargetId: props.operation.targetId,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}" x "${props.operation.targetName}"`);
    return removeOrgPolicyAttachmentFromWorkingState({
      workingState: props.state,
      policyId: props.operation.policyId,
      targetId: props.operation.targetId,
    });
  }
  if (props.operation.kind === "deleteOrgPolicy") {
    props.logger.log(`Deleting org policy "${props.operation.policyName}"...`);
    await props.organizationsClient.send(
      new DeletePolicyCommand({ PolicyId: props.operation.policyId }),
    );
    props.logger.log(`Done: "${props.operation.policyName}"`);
    return removeOrgPolicyFromWorkingState({
      workingState: props.state,
      policyId: props.operation.policyId,
    });
  }
  assertUnreachable(props.operation, "Unsupported policy operation kind.");
}

function resolvePolicyId(props: {
  state: WorkingState;
  policyId: string;
  policyName: string;
}): string {
  if (props.policyId !== "__pending_creation__") return props.policyId;
  const policy = props.state.organization.policiesByName[props.policyName];
  if (policy == null) {
    throw new Error(`Could not resolve policy "${props.policyName}" in working state.`);
  }
  return policy.id;
}
