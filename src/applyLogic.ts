import type { AccountClient } from "@aws-sdk/client-account";
import type { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import type { SSOAdminClient } from "@aws-sdk/client-sso-admin";

import { executeIdentityCenterOperation } from "./applyIdentityCenter.js";
import { executeOrganizationOperation } from "./applyOrganization.js";
import { executePolicyOperation } from "./applyPolicies.js";
import type { Logger } from "./logger.js";
import type { Operation } from "./operations.js";
import type { WorkingState } from "./state.js";

export type ExecuteOperationInput = {
  state: WorkingState;
  organizationsClient: OrganizationsClient;
  accountClient: AccountClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  context: {
    organization: {
      organizationId: string;
      rootId: string;
    };
  };
  runtime: {
    createAccount: {
      timeoutInMs: number;
      pollIntervalInMs: number;
    };
    accountAssignment: {
      timeoutInMs: number;
      pollIntervalInMs: number;
    };
    permissionSetProvisioning: {
      timeoutInMs: number;
      pollIntervalInMs: number;
    };
  };
  operation: Operation;
};

const organizationKinds = new Set([
  "moveAccount",
  "createOu",
  "renameOu",
  "deleteOu",
  "createAccount",
  "updateAccountTags",
  "updateAccountName",
  "removeAccount",
  "putAlternateContact",
  "deleteAlternateContact",
  "registerDelegatedAdministrator",
  "deregisterDelegatedAdministrator",
]);

const policyKinds = new Set([
  "createOrgPolicy",
  "updateOrgPolicyContent",
  "updateOrgPolicyDescription",
  "attachOrgPolicy",
  "detachOrgPolicy",
  "deleteOrgPolicy",
]);

export async function executeOperation(props: ExecuteOperationInput): Promise<WorkingState> {
  if (organizationKinds.has(props.operation.kind)) {
    return executeOrganizationOperation({
      state: props.state,
      organizationsClient: props.organizationsClient,
      accountClient: props.accountClient,
      logger: props.logger,
      context: props.context,
      runtime: { createAccount: props.runtime.createAccount },
      operation: props.operation as Parameters<typeof executeOrganizationOperation>[0]["operation"],
    });
  }
  if (policyKinds.has(props.operation.kind)) {
    return executePolicyOperation({
      state: props.state,
      organizationsClient: props.organizationsClient,
      logger: props.logger,
      context: props.context,
      operation: props.operation as Parameters<typeof executePolicyOperation>[0]["operation"],
    });
  }
  return executeIdentityCenterOperation({
    state: props.state,
    ssoAdminClient: props.ssoAdminClient,
    identityStoreClient: props.identityStoreClient,
    logger: props.logger,
    runtime: {
      accountAssignment: props.runtime.accountAssignment,
      permissionSetProvisioning: props.runtime.permissionSetProvisioning,
    },
    operation: props.operation as Parameters<typeof executeIdentityCenterOperation>[0]["operation"],
  });
}
