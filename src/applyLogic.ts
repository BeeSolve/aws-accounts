import {
  AccountClient,
  PutAccountNameCommand,
} from "@aws-sdk/client-account";
import {
  CreateOrganizationalUnitCommand,
  DeleteOrganizationalUnitCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  MoveAccountCommand,
  OrganizationsClient,
  TagResourceCommand,
  UntagResourceCommand,
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
  type AttributeOperation,
  UpdateGroupCommand,
  UpdateUserCommand,
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
  UpdatePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import { createAccountAndMoveToOu } from "./accountCreation.js";
import { assertUnreachable } from "./helpers.js";
import type { Operation } from "./operations.js";
import {
  addGroupMembershipToWorkingState,
  addAccountAssignmentToWorkingState,
  createGroupMembershipKey,
  moveAccountInWorkingState,
  removeAccountAssignmentFromWorkingState,
  removeGroupMembershipFromWorkingState,
  removeIdcGroupFromWorkingState,
  removeIdcPermissionSetFromWorkingState,
  removeIdcUserFromWorkingState,
  removeOrganizationalUnitFromWorkingState,
  renameOrganizationalUnitInWorkingState,
  type WorkingState,
  upsertIdcGroupInWorkingState,
  upsertIdcPermissionSetInWorkingState,
  upsertIdcUserInWorkingState,
  upsertAccountInWorkingState,
  upsertOrganizationalUnitInWorkingState,
} from "./state.js";
import type { Logger } from "./logger.js";

export type ExecuteOperationInput = {
  state: WorkingState;
  organizationsClient: OrganizationsClient;
  accountClient: AccountClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  context: {
    organization: {
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

export async function executeOperation(
  props: ExecuteOperationInput,
): Promise<WorkingState> {
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
        tags: [],
      },
    });
  }
  if (operation.kind === "updateAccountTags") {
    const account = props.state.organization.accountsById[operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account "${operation.accountName}" (${operation.accountId}) in working state.`,
      );
    }
    const currentTags = new Map(
      (account.tags ?? []).map((tag) => [tag.key, tag.value] as const),
    );
    const desiredTags = new Map(Object.entries(operation.tags));
    const tagsToApply = [...desiredTags.entries()]
      .filter(([key, value]) => currentTags.get(key) !== value)
      .map(([Key, Value]) => ({ Key, Value }));
    const tagKeysToRemove = [...currentTags.keys()].filter(
      (key) => desiredTags.has(key) === false,
    );

    props.logger.log(
      `Updating account tags "${operation.accountName}" (${operation.accountId})...`,
    );
    if (tagsToApply.length > 0) {
      await props.organizationsClient.send(
        new TagResourceCommand({
          ResourceId: operation.accountId,
          Tags: tagsToApply,
        }),
      );
    }
    if (tagKeysToRemove.length > 0) {
      await props.organizationsClient.send(
        new UntagResourceCommand({
          ResourceId: operation.accountId,
          TagKeys: tagKeysToRemove,
        }),
      );
    }
    props.logger.log(`Done: tags updated for "${operation.accountName}"`);
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        ...account,
        tags: Object.entries(operation.tags).map(([key, value]) => ({ key, value })),
      },
    });
  }
  if (operation.kind === "updateAccountName") {
    props.logger.log(
      `Renaming account (${operation.accountId}): "${operation.fromAccountName}" -> "${operation.toAccountName}"...`,
    );
    await props.accountClient.send(
      new PutAccountNameCommand({
        AccountId: operation.accountId,
        AccountName: operation.toAccountName,
      }),
    );
    props.logger.log(
      `Done: account "${operation.toAccountName}" (${operation.accountId})`,
    );
    const account = props.state.organization.accountsById[operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account (${operation.accountId}) in working state after rename.`,
      );
    }
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        ...account,
        name: operation.toAccountName,
      },
    });
  }
  if (operation.kind === "removeAccount") {
    props.logger.log(
      `Moving removed account "${operation.accountName}" (${operation.accountId}) to ${operation.toOuName}...`,
    );
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: operation.accountId,
        SourceParentId: operation.fromOuId,
        DestinationParentId: operation.toOuId,
      }),
    );
    props.logger.log(`Done: "${operation.accountName}" -> ${operation.toOuName}`);
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: operation.accountId,
      parentId: operation.toOuId,
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
  if (operation.kind === "updateIdcUser") {
    const user = resolveUserByName({
      state: props.state,
      userName: operation.userName,
    });
    const operations: AttributeOperation[] = [];
    if (user.displayName !== operation.displayName) {
      operations.push({
        AttributePath: "displayName",
        AttributeValue: operation.displayName,
      });
      operations.push({
        AttributePath: "name",
        AttributeValue: buildIdentityStoreUserName({
          userName: operation.userName,
          displayName: operation.displayName,
        }),
      });
    }
    if (user.email !== operation.email && operation.email.length > 0) {
      operations.push({
        AttributePath: "emails",
        AttributeValue: [
          {
            Value: operation.email,
            Type: "Work",
            Primary: true,
          },
        ],
      });
    }
    if (operations.length === 0) {
      return props.state;
    }
    props.logger.log(`Updating IdC user "${operation.userName}"...`);
    await props.identityStoreClient.send(
      new UpdateUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserId: user.userId,
        Operations: operations,
      }),
    );
    props.logger.log(`Done: "${operation.userName}"`);
    return upsertIdcUserInWorkingState({
      workingState: props.state,
      user: {
        ...user,
        displayName: operation.displayName,
        email: operation.email.length > 0 ? operation.email : user.email,
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
        Description:
          operation.description.trim().length > 0
            ? operation.description
            : undefined,
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
        description: operation.description,
      },
    });
  }
  if (operation.kind === "updateIdcGroupDescription") {
    const group = resolveGroupByDisplayName({
      state: props.state,
      groupDisplayName: operation.groupDisplayName,
    });
    props.logger.log(
      `Updating IdC group description for "${operation.groupDisplayName}"...`,
    );
    await props.identityStoreClient.send(
      new UpdateGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        GroupId: group.groupId,
        Operations: [
          {
            AttributePath: "description",
            AttributeValue: operation.description,
          },
        ],
      }),
    );
    props.logger.log(`Done: group "${operation.groupDisplayName}"`);
    return upsertIdcGroupInWorkingState({
      workingState: props.state,
      group: {
        ...group,
        description: operation.description,
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
  if (operation.kind === "updateIdcPermissionSetDescription") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: operation.permissionSetName,
    });
    props.logger.log(
      `Updating IdC permission set description for "${operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new UpdatePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        Description:
          operation.description.trim().length > 0
            ? operation.description
            : undefined,
      }),
    );
    props.logger.log(`Done: "${operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: {
        ...permissionSet,
        description: operation.description,
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
