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
  CreateGroupMembershipCommand,
  CreateGroupCommand,
  CreateUserCommand,
  DeleteGroupCommand,
  DeleteGroupMembershipCommand,
  DeleteUserCommand,
  GetGroupMembershipIdCommand,
  IdentitystoreClient,
} from "@aws-sdk/client-identitystore";
import {
  CreateAccountAssignmentCommand,
  AttachCustomerManagedPolicyReferenceToPermissionSetCommand,
  AttachManagedPolicyToPermissionSetCommand,
  CreatePermissionSetCommand,
  DeleteAccountAssignmentCommand,
  DeleteInlinePolicyFromPermissionSetCommand,
  DeletePermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  DescribePermissionSetProvisioningStatusCommand,
  DetachCustomerManagedPolicyReferenceFromPermissionSetCommand,
  DetachManagedPolicyFromPermissionSetCommand,
  ProvisionPermissionSetCommand,
  PutInlinePolicyToPermissionSetCommand,
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
import { applyReservedOuDeletionGuard } from "../reservedOuDeletion.js";
import {
  addGroupMembershipToWorkingState,
  addAccountAssignmentToWorkingState,
  createGroupMembershipKey,
  createWorkingState,
  materializeWorkingState,
  moveAccountInWorkingState,
  removeAccountAssignmentFromWorkingState,
  removeGroupMembershipFromWorkingState,
  removeIdcGroupFromWorkingState,
  removeIdcPermissionSetFromWorkingState,
  removeIdcUserFromWorkingState,
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
      progressedState = await applyOperation({
        state: progressedState,
        organizationsClient: props.organizationsClient,
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
          userName: operation.userName,
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
  if (operation.kind === "deleteIdcUser") {
    const user = resolveUserByName({
      state: props.state,
      userName: operation.userName,
    });
    props.logger.log(`Deleting IdC user "${operation.userName}"...`);
    await props.identityStoreClient.send(
      new DeleteUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserId: user.userId,
      }),
    );
    props.logger.log(`Done: "${operation.userName}"`);
    return removeIdcUserFromWorkingState({
      workingState: props.state,
      userName: operation.userName,
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
  if (operation.kind === "deleteIdcGroup") {
    const group = resolveGroupByDisplayName({
      state: props.state,
      groupDisplayName: operation.groupDisplayName,
    });
    props.logger.log(`Deleting IdC group "${operation.groupDisplayName}"...`);
    await props.identityStoreClient.send(
      new DeleteGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        GroupId: group.groupId,
      }),
    );
    props.logger.log(`Done: "${operation.groupDisplayName}"`);
    return removeIdcGroupFromWorkingState({
      workingState: props.state,
      groupDisplayName: operation.groupDisplayName,
    });
  }
  if (operation.kind === "addIdcGroupMembership") {
    const resolvedMembership = resolveGroupMembershipDependencies({
      state: props.state,
      groupDisplayName: operation.groupDisplayName,
      userName: operation.userName,
    });
    props.logger.log(
      `Adding user "${operation.userName}" to IdC group "${operation.groupDisplayName}"...`,
    );
    const response = await props.identityStoreClient.send(
      new CreateGroupMembershipCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        GroupId: resolvedMembership.groupId,
        MemberId: {
          UserId: resolvedMembership.userId,
        },
      }),
    );
    if (response.MembershipId == null) {
      throw new Error(
        `CreateGroupMembership for group "${operation.groupDisplayName}" and user "${operation.userName}" returned no membership id.`,
      );
    }
    props.logger.log(
      `Done: user "${operation.userName}" -> group "${operation.groupDisplayName}"`,
    );
    return addGroupMembershipToWorkingState({
      workingState: props.state,
      groupMembership: {
        membershipId: response.MembershipId,
        groupId: resolvedMembership.groupId,
        userId: resolvedMembership.userId,
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
        Description:
          operation.description.length > 0 ? operation.description : undefined,
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
        permissionSetArn,
        name: operation.permissionSetName,
        description: operation.description,
        inlinePolicy: null,
        awsManagedPolicies: [],
        customerManagedPolicies: [],
      },
    });
  }
  if (operation.kind === "deleteIdcPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Deleting IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DeletePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return removeIdcPermissionSetFromWorkingState({
      workingState: props.state,
      permissionSetName: operation.permissionSetName,
    });
  }
  if (operation.kind === "putIdcPermissionSetInlinePolicy") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Putting inline policy on IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new PutInlinePolicyToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        InlinePolicy: operation.inlinePolicy,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        inlinePolicy: operation.inlinePolicy,
      }),
    });
  }
  if (operation.kind === "deleteIdcPermissionSetInlinePolicy") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Deleting inline policy from IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DeleteInlinePolicyFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        inlinePolicy: null,
      }),
    });
  }
  if (operation.kind === "attachIdcManagedPolicyToPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Attaching managed policy "${operation.managedPolicyArn}" to IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new AttachManagedPolicyToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        ManagedPolicyArn: operation.managedPolicyArn,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        awsManagedPolicies: [
          ...currentPermissionSet.awsManagedPolicies,
          operation.managedPolicyArn,
        ],
      }),
    });
  }
  if (operation.kind === "detachIdcManagedPolicyFromPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Detaching managed policy "${operation.managedPolicyArn}" from IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DetachManagedPolicyFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        ManagedPolicyArn: operation.managedPolicyArn,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        awsManagedPolicies: currentPermissionSet.awsManagedPolicies.filter(
          (managedPolicyArn) => managedPolicyArn !== operation.managedPolicyArn,
        ),
      }),
    });
  }
  if (
    operation.kind === "attachIdcCustomerManagedPolicyReferenceToPermissionSet"
  ) {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Attaching customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" to IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new AttachCustomerManagedPolicyReferenceToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        CustomerManagedPolicyReference: {
          Name: operation.customerManagedPolicyName,
          Path: operation.customerManagedPolicyPath,
        },
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        customerManagedPolicies: [
          ...currentPermissionSet.customerManagedPolicies,
          {
            name: operation.customerManagedPolicyName,
            path: operation.customerManagedPolicyPath,
          },
        ],
      }),
    });
  }
  if (
    operation.kind === "detachIdcCustomerManagedPolicyReferenceFromPermissionSet"
  ) {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Detaching customer-managed policy "${operation.customerManagedPolicyPath}${operation.customerManagedPolicyName}" from IdC permission set "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DetachCustomerManagedPolicyReferenceFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        CustomerManagedPolicyReference: {
          Name: operation.customerManagedPolicyName,
          Path: operation.customerManagedPolicyPath,
        },
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        customerManagedPolicies: currentPermissionSet.customerManagedPolicies.filter(
          (customerManagedPolicy) =>
            customerManagedPolicy.name !== operation.customerManagedPolicyName ||
            customerManagedPolicy.path !== operation.customerManagedPolicyPath,
        ),
      }),
    });
  }
  if (operation.kind === "provisionIdcPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Provisioning IdC permission set "${operation.permissionSetName}" to all provisioned accounts...`,
    );
    const response = await props.ssoAdminClient.send(
      new ProvisionPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        TargetType: operation.targetScope,
      }),
    );
    const requestId =
      response.PermissionSetProvisioningStatus?.RequestId ?? undefined;
    if (requestId == null) {
      throw new Error(
        `ProvisionPermissionSet for "${operation.permissionSetName}" returned no request id.`,
      );
    }
    await waitForPermissionSetProvisioningSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId,
      timeoutInMs: props.runtime.permissionSetProvisioning.timeoutInMs,
      pollIntervalInMs: props.runtime.permissionSetProvisioning.pollIntervalInMs,
      operationLabel: `"${operation.permissionSetName}"`,
    });
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return props.state;
  }
  if (operation.kind === "removeIdcGroupMembership") {
    const resolvedMembership = resolveGroupMembershipDependencies({
      state: props.state,
      groupDisplayName: operation.groupDisplayName,
      userName: operation.userName,
    });
    const membershipId = await resolveGroupMembershipId({
      state: props.state,
      identityStoreClient: props.identityStoreClient,
      groupId: resolvedMembership.groupId,
      userId: resolvedMembership.userId,
    });
    props.logger.log(
      `Removing user "${operation.userName}" from IdC group "${operation.groupDisplayName}"...`,
    );
    await props.identityStoreClient.send(
      new DeleteGroupMembershipCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        MembershipId: membershipId,
      }),
    );
    props.logger.log(
      `Done: user "${operation.userName}" x group "${operation.groupDisplayName}"`,
    );
    return removeGroupMembershipFromWorkingState({
      workingState: props.state,
      groupMembership: {
        groupId: resolvedMembership.groupId,
        userId: resolvedMembership.userId,
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
      requestId,
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
      requestId,
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
  | { kind: "deleteIdcUser" }
  | { kind: "deleteIdcGroup" }
  | { kind: "deleteIdcPermissionSet" }
> {
  return (
    operation.kind === "deleteOu" ||
    operation.kind === "deleteIdcUser" ||
    operation.kind === "deleteIdcGroup" ||
    operation.kind === "deleteIdcPermissionSet"
  );
}

function describeDestructiveOperation(
  operation: Extract<
    Operation,
    | { kind: "deleteOu" }
    | { kind: "deleteIdcUser" }
    | { kind: "deleteIdcGroup" }
    | { kind: "deleteIdcPermissionSet" }
  >,
): string {
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
  if (operation.kind === "createIdcUser") {
    return `  create IdC user "${operation.userName}"`;
  }
  if (operation.kind === "deleteIdcUser") {
    return `  [destructive] delete IdC user "${operation.userName}"`;
  }
  if (operation.kind === "createIdcGroup") {
    return `  create IdC group "${operation.groupDisplayName}"`;
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

function resolveUserByName(props: {
  state: WorkingState;
  userName: string;
}) {
  const user = props.state.identityCenter.usersByUserName[props.userName];
  if (user == null) {
    throw new Error(
      `Could not resolve user "${props.userName}" in working state.`,
    );
  }
  return user;
}

function resolveGroupByDisplayName(props: {
  state: WorkingState;
  groupDisplayName: string;
}) {
  const group =
    props.state.identityCenter.groupsByDisplayName[props.groupDisplayName];
  if (group == null) {
    throw new Error(
      `Could not resolve group "${props.groupDisplayName}" in working state.`,
    );
  }
  return group;
}

function resolvePermissionSetByName(props: {
  state: WorkingState;
  permissionSetName: string;
}) {
  const permissionSet =
    props.state.identityCenter.permissionSetsByName[props.permissionSetName];
  if (permissionSet == null) {
    throw new Error(
      `Could not resolve permission set "${props.permissionSetName}" in working state.`,
    );
  }
  return permissionSet;
}

function upsertPermissionSetPolicyState(props: {
  state: WorkingState;
  permissionSetName: string;
  update: (
    permissionSet: WorkingState["identityCenter"]["permissionSets"][number],
  ) => WorkingState["identityCenter"]["permissionSets"][number];
}): WorkingState {
  const permissionSet = resolvePermissionSetByName({
    state: props.state,
    permissionSetName: props.permissionSetName,
  });
  const nextPermissionSet = props.update(permissionSet);
  return upsertIdcPermissionSetInWorkingState({
    workingState: props.state,
    permissionSet: {
      ...nextPermissionSet,
      awsManagedPolicies: [...new Set(nextPermissionSet.awsManagedPolicies)].sort(
        (left, right) => left.localeCompare(right),
      ),
      customerManagedPolicies: [
        ...nextPermissionSet.customerManagedPolicies,
      ].sort((left, right) => {
        const pathComparison = left.path.localeCompare(right.path);
        if (pathComparison !== 0) {
          return pathComparison;
        }
        return left.name.localeCompare(right.name);
      }),
    },
  });
}

function buildIdentityStoreUserName(props: {
  userName: string;
  displayName: string;
}): {
  Formatted: string;
  GivenName: string;
  FamilyName: string;
} {
  const normalizedDisplayName = props.displayName.trim();
  const fallbackName =
    normalizedDisplayName.length > 0 ? normalizedDisplayName : props.userName;
  const [givenName, ...familyNameParts] = fallbackName
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const familyName = familyNameParts.join(" ");

  return {
    Formatted: fallbackName,
    GivenName: givenName ?? fallbackName,
    FamilyName: familyName.length > 0 ? familyName : fallbackName,
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
      `Refusing to delete OU "${props.organizationalUnitName}": live AWS preflight failed [child-ou-present]: ${formatLivePreflightResource({
        resourceType: "child OU",
        name: childOrganizationalUnit.Name,
        id: childOrganizationalUnit.Id,
      })} is still attached.`,
    );
  }
  const account = await listFirstAccountForParent({
    organizationsClient: props.organizationsClient,
    parentId: props.organizationalUnitId,
  });
  if (account != null) {
    throw new Error(
      `Refusing to delete OU "${props.organizationalUnitName}": live AWS preflight failed [account-present]: ${formatLivePreflightResource({
        resourceType: "account",
        name: account.Name,
        id: account.Id,
      })} is still attached.`,
    );
  }
}

function formatLivePreflightResource(props: {
  resourceType: string;
  name?: string;
  id?: string;
}): string {
  const quotedName = props.name != null ? `"${props.name}"` : undefined;
  if (quotedName != null && props.id != null) {
    return `${props.resourceType} ${quotedName} (${props.id})`;
  }
  if (quotedName != null) {
    return `${props.resourceType} ${quotedName}`;
  }
  if (props.id != null) {
    return `${props.resourceType} (${props.id})`;
  }
  return `${props.resourceType} "unknown"`;
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

async function waitForPermissionSetProvisioningSuccess(props: {
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
      new DescribePermissionSetProvisioningStatusCommand({
        InstanceArn: props.instanceArn,
        ProvisionPermissionSetRequestId: props.requestId,
      }),
    );
    const status = response.PermissionSetProvisioningStatus;
    const state = status?.Status ?? "UNKNOWN";
    if (state !== lastStatus) {
      props.logger.log(`ProvisionPermissionSet status: ${state}`);
      lastStatus = state;
    }
    if (state === "SUCCEEDED") {
      return;
    }
    if (state === "FAILED") {
      throw new Error(
        `ProvisionPermissionSet failed for ${props.operationLabel}: ${status?.FailureReason ?? "unknown reason"}.`,
      );
    }
    await delay(props.pollIntervalInMs);
  }
  throw new Error(
    `ProvisionPermissionSet timed out after ${props.timeoutInMs}ms for ${props.operationLabel}.`,
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

function resolveGroupMembershipDependencies(props: {
  state: WorkingState;
  groupDisplayName: string;
  userName: string;
}): {
  groupId: string;
  userId: string;
} {
  const group = props.state.identityCenter.groupsByDisplayName[props.groupDisplayName];
  if (group == null) {
    throw new Error(
      `Could not resolve group "${props.groupDisplayName}" in working state.`,
    );
  }
  const user = props.state.identityCenter.usersByUserName[props.userName];
  if (user == null) {
    throw new Error(
      `Could not resolve user "${props.userName}" in working state.`,
    );
  }
  return {
    groupId: group.groupId,
    userId: user.userId,
  };
}

async function resolveGroupMembershipId(props: {
  state: WorkingState;
  identityStoreClient: IdentitystoreClient;
  groupId: string;
  userId: string;
}): Promise<string> {
  const existingMembership =
    props.state.identityCenter.groupMembershipsByKey[
      createGroupMembershipKey({
        groupId: props.groupId,
        userId: props.userId,
      })
    ];
  if (existingMembership?.membershipId != null) {
    return existingMembership.membershipId;
  }
  const response = await props.identityStoreClient.send(
    new GetGroupMembershipIdCommand({
      IdentityStoreId: props.state.identityCenter.identityStoreId,
      GroupId: props.groupId,
      MemberId: {
        UserId: props.userId,
      },
    }),
  );
  if (response.MembershipId == null) {
    throw new Error(
      `GetGroupMembershipId returned no membership id for group "${props.groupId}" and user "${props.userId}".`,
    );
  }
  return response.MembershipId;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
