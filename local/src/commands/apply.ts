import type { AccountClient } from "@aws-sdk/client-account";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import type { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import type { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { executeOperation } from "../applyLogic.js";
import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { assertUnreachable } from "../helpers.js";
import type { Operation, Plan } from "../operations.js";
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";
import {
  createWorkingState,
  materializeWorkingState,
  readStateFile,
  type StateFile,
  writeStateFile,
} from "../state.js";
import type { Logger } from "../logger.js";

type ApplyCommandInput = {
  organizationsClient: OrganizationsClient;
  accountClient: AccountClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  configPath: string;
  typesPath: string;
  statePath: string;
  contextPath: string;
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
  allowDestructive: boolean;
  ignoreUnsupported: boolean;
  planConfirmation: (props: {
    planLines: string[];
    hasDestructiveChanges: boolean;
  }) => Promise<boolean>;
};

type ApplyCommandResult = {
  plan: Plan;
  appliedOperations: number;
  statePath: string;
  status: "applied" | "no-changes" | "cancelled" | "refused";
};

export async function runApplyCommand(
  props: Omit<ApplyCommandInput, "allowDestructive"> & {
    allowDestructive?: boolean;
  },
): Promise<ApplyCommandResult> {
  const allowDestructive = props.allowDestructive ?? false;
  const [config, currentState, context] = await Promise.all([
    loadAwsConfigModelFromTsFile({
      configPath: props.configPath,
      typesPath: props.typesPath,
    }),
    readStateFile(props.statePath),
    readAwsContextFromFile(props.contextPath),
  ]);
  const nextState = mapAwsConfigToState({
    config,
    currentState,
    context,
  });
  const plan = applyReservedOuDeletionGuard({
    plan: diffStates({
      current: currentState,
      next: nextState,
    }),
    context,
  });

  const destructiveUnsupported = plan.unsupported.filter(
    (unsupportedDiff) => unsupportedDiff.category === "destructive",
  );
  if (destructiveUnsupported.length > 0) {
    props.logger.log("Unsupported diffs:");
    for (const unsupportedDiff of destructiveUnsupported) {
      props.logger.log(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
    const destructiveDescriptions = destructiveUnsupported
      .map((unsupportedDiff) => unsupportedDiff.description)
      .join("; ");
    throw new Error(
      `Apply refused: destructive unsupported diffs are not supported. ${destructiveDescriptions}`,
    );
  }

  if (plan.unsupported.length > 0 && props.ignoreUnsupported === false) {
    props.logger.log("Unsupported diffs:");
    for (const unsupportedDiff of plan.unsupported) {
      props.logger.log(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
    throw new Error(
      "Apply refused: unsupported diffs detected. Re-run with --ignore-unsupported to apply supported operations only.",
    );
  }
  if (plan.unsupported.length > 0 && props.ignoreUnsupported) {
    props.logger.log(
      "Proceeding with supported operations only; unsupported diffs are skipped.",
    );
  }

  const destructiveOperations = plan.operations.filter((operation) =>
    isDestructiveOperation(operation),
  );
  const hasDestructiveChanges = destructiveOperations.length > 0;
  if (destructiveOperations.length > 0 && allowDestructive !== true) {
    props.logger.log("Destructive operations:");
    for (const operation of destructiveOperations) {
      props.logger.log(`  - ${describeDestructiveOperation(operation)}`);
    }
    throw new Error(
      "Apply refused: destructive operations detected. Re-run with --allow-destructive to apply supported destructive changes.",
    );
  }

  if (plan.operations.length === 0) {
    props.logger.log("No changes.");
    return {
      plan,
      appliedOperations: 0,
      statePath: props.statePath,
      status: "no-changes",
    };
  }

  const planLines = buildApplyPlanLines({
    plan,
    hasDestructiveChanges,
  });
  for (const line of planLines) {
    props.logger.log(line);
  }
  const confirmed = await props.planConfirmation({
    planLines,
    hasDestructiveChanges,
  });
  if (confirmed !== true) {
    props.logger.log("Apply cancelled.");
    return {
      plan,
      appliedOperations: 0,
      statePath: props.statePath,
      status: "cancelled",
    };
  }

  let progressedState = createWorkingState({
    state: currentState,
  });
  let appliedOperations = 0;
  try {
    for (const operation of plan.operations) {
      progressedState = await executeOperation({
        state: progressedState,
        organizationsClient: props.organizationsClient,
        accountClient: props.accountClient,
        ssoAdminClient: props.ssoAdminClient,
        identityStoreClient: props.identityStoreClient,
        logger: props.logger,
        context,
        runtime: props.runtime,
        operation,
      });
      appliedOperations += 1;
    }
  } catch (error) {
    const progressedStateFile = materializeWorkingState({
      workingState: progressedState,
    });
    if (statesAreDifferent(currentState, progressedStateFile)) {
      await writeStateFile(props.statePath, progressedStateFile);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Aborted after ${appliedOperations} of ${plan.operations.length} operations. state.json updated for successful operations. Run 'npm run cli -- scan' to verify, then re-run apply. Original error: ${message}`,
    );
  }
  const progressedStateFile = materializeWorkingState({
    workingState: progressedState,
  });
  if (statesAreDifferent(currentState, progressedStateFile)) {
    await writeStateFile(props.statePath, progressedStateFile);
  }

  props.logger.log(
    `Apply complete. Applied ${appliedOperations} operation(s).`,
  );
  return {
    plan,
    appliedOperations,
    statePath: props.statePath,
    status: "applied",
  };
}

function statesAreDifferent(current: StateFile, next: StateFile): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}

function buildApplyPlanLines(props: {
  plan: Plan;
  hasDestructiveChanges: boolean;
}): string[] {
  const lines = [
    `Apply: ${props.plan.operations.length} operation(s), ${props.plan.unsupported.length} unsupported diff(s)`,
  ];
  if (props.hasDestructiveChanges) {
    lines.push(
      "WARNING: this apply includes destructive operations. Review carefully before confirming.",
    );
  }
  for (const operation of props.plan.operations) {
    lines.push(formatApplyOperationLine(operation));
  }
  if (props.plan.unsupported.length > 0) {
    lines.push("Unsupported diffs:");
    for (const unsupportedDiff of props.plan.unsupported) {
      lines.push(
        `  - ${unsupportedDiff.description} [${unsupportedDiff.category}]`,
      );
    }
  }
  return lines;
}

function isDestructiveOperation(
  operation: Operation,
): operation is Extract<
  Operation,
  | { kind: "deleteOu" }
  | { kind: "removeAccount" }
  | { kind: "deleteIdcUser" }
  | { kind: "deleteIdcGroup" }
  | { kind: "deleteIdcPermissionSet" }
> {
  return (
    operation.kind === "deleteOu" ||
    operation.kind === "removeAccount" ||
    operation.kind === "deleteIdcUser" ||
    operation.kind === "deleteIdcGroup" ||
    operation.kind === "deleteIdcPermissionSet"
  );
}

function describeDestructiveOperation(
  operation: Extract<
    Operation,
    | { kind: "deleteOu" }
    | { kind: "removeAccount" }
    | { kind: "deleteIdcUser" }
    | { kind: "deleteIdcGroup" }
    | { kind: "deleteIdcPermissionSet" }
  >,
): string {
  if (operation.kind === "removeAccount") {
    return [
      `move removed account "${operation.accountName}" (${operation.accountId}) to ${operation.toOuName}`,
      "WARNING: this tool does not close AWS accounts.",
      `Manual action required: open AWS Organizations -> "${operation.toOuName}" and close "${operation.accountName}" when safe.`,
      "Review parked accounts anytime: npm run cli -- graveyard",
      `Suggested AWS CLI close command: aws organizations close-account --account-id ${operation.accountId}`,
    ].join("\n");
  }
  if (operation.kind === "deleteIdcUser") {
    return `delete IdC user "${operation.userName}"`;
  }
  if (operation.kind === "deleteIdcGroup") {
    return `delete IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSet") {
    return `delete IdC permission set "${operation.permissionSetName}"`;
  }
  return `delete OU "${operation.ouName}"`;
}

function formatApplyOperationLine(operation: Operation): string {
  if (operation.kind === "moveAccount") {
    return `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`;
  }
  if (operation.kind === "createOu") {
    return `  create OU "${operation.ouName}" under ${operation.parentOuName}`;
  }
  if (operation.kind === "renameOu") {
    return `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`;
  }
  if (operation.kind === "deleteOu") {
    return `  [destructive] delete OU "${operation.ouName}" from ${operation.parentOuName}`;
  }
  if (operation.kind === "createAccount") {
    return `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`;
  }
  if (operation.kind === "updateAccountTags") {
    return `  update account tags "${operation.accountName}" (${operation.accountId})`;
  }
  if (operation.kind === "updateAccountName") {
    return `  rename account (${operation.accountId}): "${operation.fromAccountName}" -> "${operation.toAccountName}"`;
  }
  if (operation.kind === "removeAccount") {
    return [
      `  [destructive] move removed account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`,
      "    WARNING: this tool does not close AWS accounts.",
      `    Manual action required: open AWS Organizations -> "${operation.toOuName}" and close "${operation.accountName}" when safe.`,
      "    Review parked accounts anytime: npm run cli -- graveyard",
      `    Suggested AWS CLI close command: aws organizations close-account --account-id ${operation.accountId}`,
    ].join("\n");
  }
  if (operation.kind === "createIdcUser") {
    return `  create IdC user "${operation.userName}"`;
  }
  if (operation.kind === "updateIdcUser") {
    return `  update IdC user "${operation.userName}"`;
  }
  if (operation.kind === "deleteIdcUser") {
    return `  [destructive] delete IdC user "${operation.userName}"`;
  }
  if (operation.kind === "createIdcGroup") {
    return `  create IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "updateIdcGroupDescription") {
    return `  update IdC group description for "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "deleteIdcGroup") {
    return `  [destructive] delete IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "addIdcGroupMembership") {
    return `  add user "${operation.userName}" to IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "createIdcPermissionSet") {
    return `  create IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "updateIdcPermissionSetDescription") {
    return `  update IdC permission set description for "${operation.permissionSetName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSet") {
    return `  [destructive] delete IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "putIdcPermissionSetInlinePolicy") {
    return `  put inline policy on IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "deleteIdcPermissionSetInlinePolicy") {
    return `  delete inline policy from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "attachIdcManagedPolicyToPermissionSet") {
    return `  attach managed policy "${operation.managedPolicyArn}" to IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "detachIdcManagedPolicyFromPermissionSet") {
    return `  detach managed policy "${operation.managedPolicyArn}" from IdC permission set "${operation.permissionSetName}"`;
  }
  if (
    operation.kind === "attachIdcCustomerManagedPolicyReferenceToPermissionSet"
  ) {
    return `  attach customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" to IdC permission set "${operation.permissionSetName}"`;
  }
  if (
    operation.kind === "detachIdcCustomerManagedPolicyReferenceFromPermissionSet"
  ) {
    return `  detach customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" from IdC permission set "${operation.permissionSetName}"`;
  }
  if (operation.kind === "provisionIdcPermissionSet") {
    return `  provision IdC permission set "${operation.permissionSetName}" to all provisioned accounts`;
  }
  if (operation.kind === "removeIdcGroupMembership") {
    return `  remove user "${operation.userName}" from IdC group "${operation.groupDisplayName}"`;
  }
  if (operation.kind === "grantIdcAccountAssignment") {
    return `  grant IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel(
      {
        principalType: operation.principalType,
        principalName: operation.principalName,
      },
    )} on "${operation.accountName}"`;
  }
  if (operation.kind === "revokeIdcAccountAssignment") {
    return `  revoke IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel(
      {
        principalType: operation.principalType,
        principalName: operation.principalName,
      },
    )} on "${operation.accountName}"`;
  }
  assertUnreachable(operation, "Unsupported operation kind in apply plan lines.");
}

function formatPrincipalLabel(props: {
  principalType: "GROUP" | "USER";
  principalName: string;
}): string {
  if (props.principalType === "GROUP") {
    return `group "${props.principalName}"`;
  }
  return `user "${props.principalName}"`;
}
