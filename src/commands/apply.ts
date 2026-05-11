import {
  CreateOrganizationalUnitCommand,
  DeleteOrganizationalUnitCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  MoveAccountCommand,
  OrganizationsClient,
  UpdateOrganizationalUnitCommand,
} from "@aws-sdk/client-organizations";
import {
  CreateGroupCommand,
  CreateUserCommand,
  IdentitystoreClient,
} from "@aws-sdk/client-identitystore";
import {
  CreateAccountAssignmentCommand,
  CreatePermissionSetCommand,
  DeleteAccountAssignmentCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { createAccountAndMoveToOu } from "../accountCreation.js";
import {
  loadAwsConfigModelFromTsFile,
  mapAwsConfigToState,
  readAwsContextFromFile,
} from "../awsConfig.js";
import { diffStates } from "../diff.js";
import { assertUnreachable } from "../helpers.js";
import type { Operation, Plan } from "../operations.js";
import {
  addAccountAssignmentToWorkingState,
  createWorkingState,
  materializeWorkingState,
  moveAccountInWorkingState,
  removeAccountAssignmentFromWorkingState,
  removeOrganizationalUnitFromWorkingState,
  readStateFile,
  renameOrganizationalUnitInWorkingState,
  type StateFile,
  type WorkingState,
  upsertIdcGroupInWorkingState,
  upsertIdcPermissionSetInWorkingState,
  upsertIdcUserInWorkingState,
  upsertAccountInWorkingState,
  upsertOrganizationalUnitInWorkingState,
  writeStateFile,
} from "../state.js";
import type { Logger } from "../logger.js";

type ApplyCommandInput = {
  organizationsClient: OrganizationsClient;
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
  };
  allowDestructive: boolean;
  ignoreUnsupported: boolean;
  planConfirmation: (props: { planLines: string[] }) => Promise<boolean>;
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
    config: config,
    currentState: currentState,
    context: context,
  });
  const plan = diffStates({
    current: currentState,
    next: nextState,
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
    throw new Error(
      "Apply refused: destructive unsupported diffs are not supported.",
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
      plan: plan,
      appliedOperations: 0,
      statePath: props.statePath,
      status: "no-changes",
    };
  }

  const planLines = buildApplyPlanLines({
    plan: plan,
  });
  for (const line of planLines) {
    props.logger.log(line);
  }
  const confirmed = await props.planConfirmation({
    planLines: planLines,
  });
  if (confirmed !== true) {
    props.logger.log("Apply cancelled.");
    return {
      plan: plan,
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
      progressedState = await applyOperation({
        state: progressedState,
        organizationsClient: props.organizationsClient,
        ssoAdminClient: props.ssoAdminClient,
        identityStoreClient: props.identityStoreClient,
        logger: props.logger,
        context: context,
        runtime: props.runtime,
        operation: operation,
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
    plan: plan,
    appliedOperations: appliedOperations,
    statePath: props.statePath,
    status: "applied",
  };
}

async function applyOperation(props: {
  state: WorkingState;
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  context: Awaited<ReturnType<typeof readAwsContextFromFile>>;
  runtime: ApplyCommandInput["runtime"];
  operation: Operation;
}): Promise<WorkingState> {
  const operation = props.operation;
  if (operation.kind === "moveAccount") {
    props.logger.log(
      `Moving "${operation.accountName}" (${operation.accountId}): ${operation.fromOuName} -> ${operation.toOuName}`,
    );
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: operation.accountId,
        SourceParentId: operation.fromOuId,
        DestinationParentId: operation.toOuId,
      }),
    );
    props.logger.log(`Done: "${operation.accountName}"`);
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: operation.accountId,
      parentId: operation.toOuId,
    });
  }
  if (operation.kind === "createOu") {
    props.logger.log(
      `Creating OU "${operation.ouName}" under ${operation.parentOuName}...`,
    );
    const response = await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: operation.parentOuId,
        Name: operation.ouName,
      }),
    );
    const createdOu = response.OrganizationalUnit;
    if (
      createdOu?.Id == null ||
      createdOu.Arn == null ||
      createdOu.Name == null
    ) {
      throw new Error(
        `CreateOrganizationalUnit for "${operation.ouName}" returned incomplete OU data.`,
      );
    }
    props.logger.log(`Done: "${createdOu.Name}"`);
    return upsertOrganizationalUnitInWorkingState({
      workingState: props.state,
      organizationalUnit: {
        id: createdOu.Id,
        parentId: operation.parentOuId,
        arn: createdOu.Arn,
        name: createdOu.Name,
      },
    });
  }
  if (operation.kind === "renameOu") {
    props.logger.log(
      `Renaming OU "${operation.fromOuName}" -> "${operation.toOuName}"...`,
    );
    await props.organizationsClient.send(
      new UpdateOrganizationalUnitCommand({
        OrganizationalUnitId: operation.ouId,
        Name: operation.toOuName,
      }),
    );
    props.logger.log(`Done: "${operation.toOuName}"`);
    return renameOrganizationalUnitInWorkingState({
      workingState: props.state,
      organizationalUnitId: operation.ouId,
      name: operation.toOuName,
    });
  }
  if (operation.kind === "deleteOu") {
    props.logger.log(`Deleting OU "${operation.ouName}"...`);
    await assertOrganizationalUnitIsEmpty({
      organizationsClient: props.organizationsClient,
      organizationalUnitId: operation.ouId,
      organizationalUnitName: operation.ouName,
    });
    await props.organizationsClient.send(
      new DeleteOrganizationalUnitCommand({
        OrganizationalUnitId: operation.ouId,
      }),
    );
    props.logger.log(`Done: "${operation.ouName}"`);
    return removeOrganizationalUnitFromWorkingState({
      workingState: props.state,
      organizationalUnitId: operation.ouId,
    });
  }
  if (operation.kind === "createAccount") {
    const result = await createAccountAndMoveToOu({
      organizationsClient: props.organizationsClient,
      logger: props.logger,
      accountName: operation.accountName,
      accountEmail: operation.accountEmail,
      sourceParentId: props.context.organization.rootId,
      destinationParentId: operation.targetOuId,
      timeoutInMs: props.runtime.createAccount.timeoutInMs,
      pollIntervalInMs: props.runtime.createAccount.pollIntervalInMs,
    });
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        id: result.account.id,
        arn: result.account.arn,
        name: result.account.name,
        email: result.account.email,
        status: result.account.status,
        parentId: operation.targetOuId,
      },
    });
  }
  if (operation.kind === "createIdcUser") {
    props.logger.log(`Creating IdC user "${operation.userName}"...`);
    const response = await props.identityStoreClient.send(
      new CreateUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserName: operation.userName,
        DisplayName: operation.displayName,
        Name: buildIdentityStoreUserName({
          displayName: operation.displayName,
        }),
        Emails:
          operation.email.length > 0
            ? [
                {
                  Value: operation.email,
                  Type: "Work",
                  Primary: true,
                },
              ]
            : undefined,
      }),
    );
    if (response.UserId == null) {
      throw new Error(
        `CreateUser for "${operation.userName}" returned no user id.`,
      );
    }
    props.logger.log(`Done: "${operation.userName}"`);
    return upsertIdcUserInWorkingState({
      workingState: props.state,
      user: {
        userId: response.UserId,
        userName: operation.userName,
        displayName: operation.displayName,
        email: operation.email,
      },
    });
  }
  if (operation.kind === "createIdcGroup") {
    props.logger.log(`Creating IdC group "${operation.groupDisplayName}"...`);
    const response = await props.identityStoreClient.send(
      new CreateGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        DisplayName: operation.groupDisplayName,
      }),
    );
    if (response.GroupId == null) {
      throw new Error(
        `CreateGroup for "${operation.groupDisplayName}" returned no group id.`,
      );
    }
    props.logger.log(`Done: "${operation.groupDisplayName}"`);
    return upsertIdcGroupInWorkingState({
      workingState: props.state,
      group: {
        groupId: response.GroupId,
        displayName: operation.groupDisplayName,
      },
    });
  }
  if (operation.kind === "createIdcPermissionSet") {
    props.logger.log(
      `Creating IdC permission set "${operation.permissionSetName}"...`,
    );
    const response = await props.ssoAdminClient.send(
      new CreatePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        Name: operation.permissionSetName,
        Description: operation.description,
      }),
    );
    const permissionSetArn = response.PermissionSet?.PermissionSetArn;
    if (permissionSetArn == null) {
      throw new Error(
        `CreatePermissionSet for "${operation.permissionSetName}" returned no permission set arn.`,
      );
    }
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: {
        permissionSetArn: permissionSetArn,
        name: operation.permissionSetName,
        description: operation.description,
      },
    });
  }
  if (operation.kind === "grantIdcAccountAssignment") {
    const resolvedAssignment = resolveAssignmentDependencies({
      state: props.state,
      accountName: operation.accountName,
      permissionSetName: operation.permissionSetName,
      principalType: operation.principalType,
      principalName: operation.principalName,
    });
    props.logger.log(
      `Granting IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel(
        {
          principalType: operation.principalType,
          principalName: operation.principalName,
        },
      )} on "${operation.accountName}"...`,
    );
    const response = await props.ssoAdminClient.send(
      new CreateAccountAssignmentCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        TargetId: resolvedAssignment.accountId,
        TargetType: "AWS_ACCOUNT",
        PermissionSetArn: resolvedAssignment.permissionSetArn,
        PrincipalType: resolvedAssignment.principalType,
        PrincipalId: resolvedAssignment.principalId,
      }),
    );
    const requestId = response.AccountAssignmentCreationStatus?.RequestId;
    if (requestId == null) {
      throw new Error(
        `CreateAccountAssignment for "${operation.permissionSetName}" on "${operation.accountName}" returned no request id.`,
      );
    }
    await waitForAccountAssignmentCreationSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId: requestId,
      timeoutInMs: props.runtime.accountAssignment.timeoutInMs,
      pollIntervalInMs: props.runtime.accountAssignment.pollIntervalInMs,
      operationLabel: `"${operation.permissionSetName}" on "${operation.accountName}"`,
    });
    props.logger.log(
      `Done: "${operation.permissionSetName}" -> "${operation.accountName}"`,
    );
    return addAccountAssignmentToWorkingState({
      workingState: props.state,
      accountAssignment: {
        accountId: resolvedAssignment.accountId,
        permissionSetArn: resolvedAssignment.permissionSetArn,
        principalId: resolvedAssignment.principalId,
        principalType: resolvedAssignment.principalType,
      },
    });
  }
  if (operation.kind === "revokeIdcAccountAssignment") {
    const resolvedAssignment = resolveAssignmentDependencies({
      state: props.state,
      accountName: operation.accountName,
      permissionSetName: operation.permissionSetName,
      principalType: operation.principalType,
      principalName: operation.principalName,
    });
    props.logger.log(
      `Revoking IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel(
        {
          principalType: operation.principalType,
          principalName: operation.principalName,
        },
      )} on "${operation.accountName}"...`,
    );
    const response = await props.ssoAdminClient.send(
      new DeleteAccountAssignmentCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        TargetId: resolvedAssignment.accountId,
        TargetType: "AWS_ACCOUNT",
        PermissionSetArn: resolvedAssignment.permissionSetArn,
        PrincipalType: resolvedAssignment.principalType,
        PrincipalId: resolvedAssignment.principalId,
      }),
    );
    const requestId = response.AccountAssignmentDeletionStatus?.RequestId;
    if (requestId == null) {
      throw new Error(
        `DeleteAccountAssignment for "${operation.permissionSetName}" on "${operation.accountName}" returned no request id.`,
      );
    }
    await waitForAccountAssignmentDeletionSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId: requestId,
      timeoutInMs: props.runtime.accountAssignment.timeoutInMs,
      pollIntervalInMs: props.runtime.accountAssignment.pollIntervalInMs,
      operationLabel: `"${operation.permissionSetName}" on "${operation.accountName}"`,
    });
    props.logger.log(
      `Done: "${operation.permissionSetName}" x "${operation.accountName}"`,
    );
    return removeAccountAssignmentFromWorkingState({
      workingState: props.state,
      accountAssignment: {
        accountId: resolvedAssignment.accountId,
        permissionSetArn: resolvedAssignment.permissionSetArn,
        principalId: resolvedAssignment.principalId,
        principalType: resolvedAssignment.principalType,
      },
    });
  }
  assertUnreachable(operation, "Unsupported operation kind in apply.");
}

function statesAreDifferent(current: StateFile, next: StateFile): boolean {
  return JSON.stringify(current) !== JSON.stringify(next);
}

function buildApplyPlanLines(props: { plan: Plan }): string[] {
  const lines = [
    `Apply: ${props.plan.operations.length} operation(s), ${props.plan.unsupported.length} unsupported diff(s)`,
  ];
  for (const operation of props.plan.operations) {
    if (operation.kind === "moveAccount") {
      lines.push(
        `  move account "${operation.accountName}" (${operation.accountId}) from ${operation.fromOuName} -> ${operation.toOuName}`,
      );
      continue;
    }
    if (operation.kind === "createOu") {
      lines.push(
        `  create OU "${operation.ouName}" under ${operation.parentOuName}`,
      );
      continue;
    }
    if (operation.kind === "renameOu") {
      lines.push(
        `  rename OU "${operation.fromOuName}" -> "${operation.toOuName}"`,
      );
      continue;
    }
    if (operation.kind === "deleteOu") {
      lines.push(
        `  delete OU "${operation.ouName}" from ${operation.parentOuName}`,
      );
      continue;
    }
    if (operation.kind === "createAccount") {
      lines.push(
        `  create account "${operation.accountName}" (${operation.accountEmail}) in ${operation.targetOuName}`,
      );
      continue;
    }
    if (operation.kind === "createIdcUser") {
      lines.push(`  create IdC user "${operation.userName}"`);
      continue;
    }
    if (operation.kind === "createIdcGroup") {
      lines.push(`  create IdC group "${operation.groupDisplayName}"`);
      continue;
    }
    if (operation.kind === "createIdcPermissionSet") {
      lines.push(
        `  create IdC permission set "${operation.permissionSetName}"`,
      );
      continue;
    }
    if (operation.kind === "grantIdcAccountAssignment") {
      lines.push(
        `  grant IdC assignment "${operation.permissionSetName}" to ${formatPrincipalLabel(
          {
            principalType: operation.principalType,
            principalName: operation.principalName,
          },
        )} on "${operation.accountName}"`,
      );
      continue;
    }
    if (operation.kind === "revokeIdcAccountAssignment") {
      lines.push(
        `  revoke IdC assignment "${operation.permissionSetName}" from ${formatPrincipalLabel(
          {
            principalType: operation.principalType,
            principalName: operation.principalName,
          },
        )} on "${operation.accountName}"`,
      );
      continue;
    }
    assertUnreachable(
      operation,
      "Unsupported operation kind in apply plan lines.",
    );
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
): operation is Extract<Operation, { kind: "deleteOu" }> {
  return operation.kind === "deleteOu";
}

function describeDestructiveOperation(
  operation: Extract<Operation, { kind: "deleteOu" }>,
): string {
  return `delete OU "${operation.ouName}"`;
}

function resolveAssignmentDependencies(props: {
  state: WorkingState;
  accountName: string;
  permissionSetName: string;
  principalType: "GROUP" | "USER";
  principalName: string;
}): {
  accountId: string;
  permissionSetArn: string;
  principalId: string;
  principalType: "GROUP" | "USER";
} {
  const account = props.state.organization.accountsByName[props.accountName];
  if (account == null) {
    throw new Error(
      `Could not resolve account "${props.accountName}" in working state.`,
    );
  }
  const permissionSet =
    props.state.identityCenter.permissionSetsByName[props.permissionSetName];
  if (permissionSet == null) {
    throw new Error(
      `Could not resolve permission set "${props.permissionSetName}" in working state.`,
    );
  }
  if (props.principalType === "GROUP") {
    const group =
      props.state.identityCenter.groupsByDisplayName[props.principalName];
    if (group == null) {
      throw new Error(
        `Could not resolve group "${props.principalName}" in working state.`,
      );
    }
    return {
      accountId: account.id,
      permissionSetArn: permissionSet.permissionSetArn,
      principalId: group.groupId,
      principalType: props.principalType,
    };
  }
  const user = props.state.identityCenter.usersByUserName[props.principalName];
  if (user == null) {
    throw new Error(
      `Could not resolve user "${props.principalName}" in working state.`,
    );
  }
  return {
    accountId: account.id,
    permissionSetArn: permissionSet.permissionSetArn,
    principalId: user.userId,
    principalType: props.principalType,
  };
}

function buildIdentityStoreUserName(props: { displayName: string }): {
  Formatted: string;
  GivenName: string;
} {
  return {
    Formatted: props.displayName,
    GivenName: props.displayName,
  };
}

async function assertOrganizationalUnitIsEmpty(props: {
  organizationsClient: OrganizationsClient;
  organizationalUnitId: string;
  organizationalUnitName: string;
}): Promise<void> {
  const childOrganizationalUnit = await listFirstChildOrganizationalUnit({
    organizationsClient: props.organizationsClient,
    parentId: props.organizationalUnitId,
  });
  if (childOrganizationalUnit != null) {
    throw new Error(
      `Refusing to delete OU "${props.organizationalUnitName}": it still contains child OU "${childOrganizationalUnit.Name ?? childOrganizationalUnit.Id ?? "unknown"}".`,
    );
  }
  const account = await listFirstAccountForParent({
    organizationsClient: props.organizationsClient,
    parentId: props.organizationalUnitId,
  });
  if (account != null) {
    throw new Error(
      `Refusing to delete OU "${props.organizationalUnitName}": it still contains account "${account.Name ?? account.Id ?? "unknown"}".`,
    );
  }
}

async function listFirstChildOrganizationalUnit(props: {
  organizationsClient: OrganizationsClient;
  parentId: string;
}): Promise<{ Id?: string; Name?: string } | undefined> {
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListOrganizationalUnitsForParentCommand({
        ParentId: props.parentId,
        NextToken: nextToken,
      }),
    );
    const organizationalUnit = response.OrganizationalUnits?.[0];
    if (organizationalUnit != null) {
      return organizationalUnit;
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return undefined;
}

async function listFirstAccountForParent(props: {
  organizationsClient: OrganizationsClient;
  parentId: string;
}): Promise<{ Id?: string; Name?: string } | undefined> {
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListAccountsForParentCommand({
        ParentId: props.parentId,
        NextToken: nextToken,
      }),
    );
    const account = response.Accounts?.[0];
    if (account != null) {
      return account;
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return undefined;
}

async function waitForAccountAssignmentCreationSuccess(props: {
  ssoAdminClient: SSOAdminClient;
  logger: Logger;
  instanceArn: string;
  requestId: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
  operationLabel: string;
}): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: string | undefined;
  while (Date.now() - startedAt < props.timeoutInMs) {
    const response = await props.ssoAdminClient.send(
      new DescribeAccountAssignmentCreationStatusCommand({
        InstanceArn: props.instanceArn,
        AccountAssignmentCreationRequestId: props.requestId,
      }),
    );
    const status = response.AccountAssignmentCreationStatus;
    const state = status?.Status ?? "UNKNOWN";
    if (state !== lastStatus) {
      props.logger.log(`CreateAccountAssignment status: ${state}`);
      lastStatus = state;
    }
    if (state === "SUCCEEDED") {
      return;
    }
    if (state === "FAILED") {
      throw new Error(
        `CreateAccountAssignment failed for ${props.operationLabel}: ${status?.FailureReason ?? "unknown reason"}.`,
      );
    }
    await delay(props.pollIntervalInMs);
  }
  throw new Error(
    `CreateAccountAssignment timed out after ${props.timeoutInMs}ms for ${props.operationLabel}.`,
  );
}

async function waitForAccountAssignmentDeletionSuccess(props: {
  ssoAdminClient: SSOAdminClient;
  logger: Logger;
  instanceArn: string;
  requestId: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
  operationLabel: string;
}): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: string | undefined;
  while (Date.now() - startedAt < props.timeoutInMs) {
    const response = await props.ssoAdminClient.send(
      new DescribeAccountAssignmentDeletionStatusCommand({
        InstanceArn: props.instanceArn,
        AccountAssignmentDeletionRequestId: props.requestId,
      }),
    );
    const status = response.AccountAssignmentDeletionStatus;
    const state = status?.Status ?? "UNKNOWN";
    if (state !== lastStatus) {
      props.logger.log(`DeleteAccountAssignment status: ${state}`);
      lastStatus = state;
    }
    if (state === "SUCCEEDED") {
      return;
    }
    if (state === "FAILED") {
      throw new Error(
        `DeleteAccountAssignment failed for ${props.operationLabel}: ${status?.FailureReason ?? "unknown reason"}.`,
      );
    }
    await delay(props.pollIntervalInMs);
  }
  throw new Error(
    `DeleteAccountAssignment timed out after ${props.timeoutInMs}ms for ${props.operationLabel}.`,
  );
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
