import {
  AccountClient,
  DeleteAlternateContactCommand,
  PutAccountNameCommand,
  PutAlternateContactCommand,
} from "@aws-sdk/client-account";
import {
  AttachPolicyCommand,
  CreateOrganizationalUnitCommand,
  CreatePolicyCommand,
  DeregisterDelegatedAdministratorCommand,
  DeleteOrganizationalUnitCommand,
  DeletePolicyCommand,
  DetachPolicyCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  MoveAccountCommand,
  OrganizationsClient,
  RegisterDelegatedAdministratorCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateOrganizationalUnitCommand,
  UpdatePolicyCommand,
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
  DeletePermissionsBoundaryFromPermissionSetCommand,
  DeletePermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  DescribePermissionSetProvisioningStatusCommand,
  DetachCustomerManagedPolicyReferenceFromPermissionSetCommand,
  DetachManagedPolicyFromPermissionSetCommand,
  ProvisionPermissionSetCommand,
  PutInlinePolicyToPermissionSetCommand,
  PutPermissionsBoundaryToPermissionSetCommand,
  SSOAdminClient,
  UpdateInstanceAccessControlAttributeConfigurationCommand,
  UpdatePermissionSetCommand,
} from "@aws-sdk/client-sso-admin";
import { createAccountAndMoveToOu } from "./accountCreation.js";
import { assertUnreachable, delay } from "./helpers.js";
import type { Operation } from "./operations.js";
import {
  addGroupMembershipToWorkingState,
  addAccountAssignmentToWorkingState,
  addOrgPolicyAttachmentToWorkingState,
  createGroupMembershipKey,
  moveAccountInWorkingState,
  removeAccountAssignmentFromWorkingState,
  removeDelegatedAdministratorFromWorkingState,
  removeGroupMembershipFromWorkingState,
  removeIdcGroupFromWorkingState,
  removeIdcPermissionSetFromWorkingState,
  removeIdcUserFromWorkingState,
  removeOrganizationalUnitFromWorkingState,
  removeOrgPolicyAttachmentFromWorkingState,
  removeOrgPolicyFromWorkingState,
  renameOrganizationalUnitInWorkingState,
  type WorkingState,
  upsertDelegatedAdministratorInWorkingState,
  upsertIdcGroupInWorkingState,
  upsertIdcPermissionSetInWorkingState,
  upsertIdcUserInWorkingState,
  upsertAccountInWorkingState,
  upsertOrganizationalUnitInWorkingState,
  upsertOrgPolicyInWorkingState,
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
  if (props.operation.kind === "moveAccount") {
    props.logger.log(
      `Moving "${props.operation.accountName}" (${props.operation.accountId}): ${props.operation.fromOuName} -> ${props.operation.toOuName}`,
    );
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: props.operation.accountId,
        SourceParentId: props.operation.fromOuId,
        DestinationParentId: props.operation.toOuId,
      }),
    );
    props.logger.log(`Done: "${props.operation.accountName}"`);
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: props.operation.accountId,
      parentId: props.operation.toOuId,
    });
  }
  if (props.operation.kind === "createOu") {
    props.logger.log(
      `Creating OU "${props.operation.ouName}" under ${props.operation.parentOuName}...`,
    );
    const response = await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: props.operation.parentOuId,
        Name: props.operation.ouName,
      }),
    );
    const createdOu = response.OrganizationalUnit;
    if (
      createdOu?.Id == null ||
      createdOu.Arn == null ||
      createdOu.Name == null
    ) {
      throw new Error(
        `CreateOrganizationalUnit for "${props.operation.ouName}" returned incomplete OU data.`,
      );
    }
    props.logger.log(`Done: "${createdOu.Name}"`);
    return upsertOrganizationalUnitInWorkingState({
      workingState: props.state,
      organizationalUnit: {
        id: createdOu.Id,
        parentId: props.operation.parentOuId,
        arn: createdOu.Arn,
        name: createdOu.Name,
      },
    });
  }
  if (props.operation.kind === "renameOu") {
    props.logger.log(
      `Renaming OU "${props.operation.fromOuName}" -> "${props.operation.toOuName}"...`,
    );
    await props.organizationsClient.send(
      new UpdateOrganizationalUnitCommand({
        OrganizationalUnitId: props.operation.ouId,
        Name: props.operation.toOuName,
      }),
    );
    props.logger.log(`Done: "${props.operation.toOuName}"`);
    return renameOrganizationalUnitInWorkingState({
      workingState: props.state,
      organizationalUnitId: props.operation.ouId,
      name: props.operation.toOuName,
    });
  }
  if (props.operation.kind === "deleteOu") {
    props.logger.log(`Deleting OU "${props.operation.ouName}"...`);
    await assertOrganizationalUnitIsEmpty({
      organizationsClient: props.organizationsClient,
      organizationalUnitId: props.operation.ouId,
      organizationalUnitName: props.operation.ouName,
    });
    await props.organizationsClient.send(
      new DeleteOrganizationalUnitCommand({
        OrganizationalUnitId: props.operation.ouId,
      }),
    );
    props.logger.log(`Done: "${props.operation.ouName}"`);
    return removeOrganizationalUnitFromWorkingState({
      workingState: props.state,
      organizationalUnitId: props.operation.ouId,
    });
  }
  if (props.operation.kind === "createAccount") {
    const result = await createAccountAndMoveToOu({
      organizationsClient: props.organizationsClient,
      logger: props.logger,
      accountName: props.operation.accountName,
      accountEmail: props.operation.accountEmail,
      sourceParentId: props.context.organization.rootId,
      destinationParentId: props.operation.targetOuId,
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
        parentId: props.operation.targetOuId,
        tags: [],
      },
    });
  }
  if (props.operation.kind === "updateAccountTags") {
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account "${props.operation.accountName}" (${props.operation.accountId}) in working state.`,
      );
    }
    const currentTags = new Map(
      (account.tags ?? []).map((tag) => [tag.key, tag.value] as const),
    );
    const desiredTags = new Map(Object.entries(props.operation.tags));
    const tagsToApply = [...desiredTags.entries()]
      .filter(([key, value]) => currentTags.get(key) !== value)
      .map(([Key, Value]) => ({ Key, Value }));
    const tagKeysToRemove = [...currentTags.keys()].filter(
      (key) => desiredTags.has(key) === false,
    );

    props.logger.log(
      `Updating account tags "${props.operation.accountName}" (${props.operation.accountId})...`,
    );
    if (tagsToApply.length > 0) {
      await props.organizationsClient.send(
        new TagResourceCommand({
          ResourceId: props.operation.accountId,
          Tags: tagsToApply,
        }),
      );
    }
    if (tagKeysToRemove.length > 0) {
      await props.organizationsClient.send(
        new UntagResourceCommand({
          ResourceId: props.operation.accountId,
          TagKeys: tagKeysToRemove,
        }),
      );
    }
    props.logger.log(`Done: tags updated for "${props.operation.accountName}"`);
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        ...account,
        tags: Object.entries(props.operation.tags).map(([key, value]) => ({
          key,
          value,
        })),
      },
    });
  }
  if (props.operation.kind === "updateAccountName") {
    props.logger.log(
      `Renaming account (${props.operation.accountId}): "${props.operation.fromAccountName}" -> "${props.operation.toAccountName}"...`,
    );
    await props.accountClient.send(
      new PutAccountNameCommand({
        AccountId: props.operation.accountId,
        AccountName: props.operation.toAccountName,
      }),
    );
    props.logger.log(
      `Done: account "${props.operation.toAccountName}" (${props.operation.accountId})`,
    );
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account (${props.operation.accountId}) in working state after rename.`,
      );
    }
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        ...account,
        name: props.operation.toAccountName,
      },
    });
  }
  if (props.operation.kind === "removeAccount") {
    props.logger.log(
      `Moving removed account "${props.operation.accountName}" (${props.operation.accountId}) to ${props.operation.toOuName}...`,
    );
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: props.operation.accountId,
        SourceParentId: props.operation.fromOuId,
        DestinationParentId: props.operation.toOuId,
      }),
    );
    props.logger.log(
      `Done: "${props.operation.accountName}" -> ${props.operation.toOuName}`,
    );
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: props.operation.accountId,
      parentId: props.operation.toOuId,
    });
  }
  if (props.operation.kind === "createIdcUser") {
    props.logger.log(`Creating IdC user "${props.operation.userName}"...`);
    const response = await props.identityStoreClient.send(
      new CreateUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserName: props.operation.userName,
        DisplayName: props.operation.displayName,
        Name: buildIdentityStoreUserName({
          userName: props.operation.userName,
          displayName: props.operation.displayName,
        }),
        Emails:
          props.operation.email.length > 0
            ? [
                {
                  Value: props.operation.email,
                  Type: "Work",
                  Primary: true,
                },
              ]
            : undefined,
      }),
    );
    if (response.UserId == null) {
      throw new Error(
        `CreateUser for "${props.operation.userName}" returned no user id.`,
      );
    }
    props.logger.log(`Done: "${props.operation.userName}"`);
    return upsertIdcUserInWorkingState({
      workingState: props.state,
      user: {
        userId: response.UserId,
        userName: props.operation.userName,
        displayName: props.operation.displayName,
        email: props.operation.email,
      },
    });
  }
  if (props.operation.kind === "updateIdcUser") {
    const user = resolveUserByName({
      state: props.state,
      userName: props.operation.userName,
    });
    const operations: AttributeOperation[] = [];
    if (user.displayName !== props.operation.displayName) {
      operations.push({
        AttributePath: "displayName",
        AttributeValue: props.operation.displayName,
      });
      operations.push({
        AttributePath: "name",
        AttributeValue: buildIdentityStoreUserName({
          userName: props.operation.userName,
          displayName: props.operation.displayName,
        }),
      });
    }
    if (user.email !== props.operation.email && props.operation.email.length > 0) {
      operations.push({
        AttributePath: "emails",
        AttributeValue: [
          {
            Value: props.operation.email,
            Type: "Work",
            Primary: true,
          },
        ],
      });
    }
    if (operations.length === 0) {
      return props.state;
    }
    props.logger.log(`Updating IdC user "${props.operation.userName}"...`);
    await props.identityStoreClient.send(
      new UpdateUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserId: user.userId,
        Operations: operations,
      }),
    );
    props.logger.log(`Done: "${props.operation.userName}"`);
    return upsertIdcUserInWorkingState({
      workingState: props.state,
      user: {
        ...user,
        displayName: props.operation.displayName,
        email: props.operation.email.length > 0 ? props.operation.email : user.email,
      },
    });
  }
  if (props.operation.kind === "deleteIdcUser") {
    const user = resolveUserByName({
      state: props.state,
      userName: props.operation.userName,
    });
    props.logger.log(`Deleting IdC user "${props.operation.userName}"...`);
    await props.identityStoreClient.send(
      new DeleteUserCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        UserId: user.userId,
      }),
    );
    props.logger.log(`Done: "${props.operation.userName}"`);
    return removeIdcUserFromWorkingState({
      workingState: props.state,
      userName: props.operation.userName,
    });
  }
  if (props.operation.kind === "createIdcGroup") {
    props.logger.log(`Creating IdC group "${props.operation.groupDisplayName}"...`);
    const response = await props.identityStoreClient.send(
      new CreateGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        DisplayName: props.operation.groupDisplayName,
        Description:
          props.operation.description.trim().length > 0
            ? props.operation.description
            : undefined,
      }),
    );
    if (response.GroupId == null) {
      throw new Error(
        `CreateGroup for "${props.operation.groupDisplayName}" returned no group id.`,
      );
    }
    props.logger.log(`Done: "${props.operation.groupDisplayName}"`);
    return upsertIdcGroupInWorkingState({
      workingState: props.state,
      group: {
        groupId: response.GroupId,
        displayName: props.operation.groupDisplayName,
        description: props.operation.description,
      },
    });
  }
  if (props.operation.kind === "updateIdcGroupDescription") {
    const group = resolveGroupByDisplayName({
      state: props.state,
      groupDisplayName: props.operation.groupDisplayName,
    });
    props.logger.log(
      `Updating IdC group description for "${props.operation.groupDisplayName}"...`,
    );
    await props.identityStoreClient.send(
      new UpdateGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        GroupId: group.groupId,
        Operations: [
          {
            AttributePath: "description",
            AttributeValue: props.operation.description,
          },
        ],
      }),
    );
    props.logger.log(`Done: group "${props.operation.groupDisplayName}"`);
    return upsertIdcGroupInWorkingState({
      workingState: props.state,
      group: {
        ...group,
        description: props.operation.description,
      },
    });
  }
  if (props.operation.kind === "deleteIdcGroup") {
    const group = resolveGroupByDisplayName({
      state: props.state,
      groupDisplayName: props.operation.groupDisplayName,
    });
    props.logger.log(`Deleting IdC group "${props.operation.groupDisplayName}"...`);
    await props.identityStoreClient.send(
      new DeleteGroupCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        GroupId: group.groupId,
      }),
    );
    props.logger.log(`Done: "${props.operation.groupDisplayName}"`);
    return removeIdcGroupFromWorkingState({
      workingState: props.state,
      groupDisplayName: props.operation.groupDisplayName,
    });
  }
  if (props.operation.kind === "addIdcGroupMembership") {
    const resolvedMembership = resolveGroupMembershipDependencies({
      state: props.state,
      groupDisplayName: props.operation.groupDisplayName,
      userName: props.operation.userName,
    });
    props.logger.log(
      `Adding user "${props.operation.userName}" to IdC group "${props.operation.groupDisplayName}"...`,
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
        `CreateGroupMembership for group "${props.operation.groupDisplayName}" and user "${props.operation.userName}" returned no membership id.`,
      );
    }
    props.logger.log(
      `Done: user "${props.operation.userName}" -> group "${props.operation.groupDisplayName}"`,
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
  if (props.operation.kind === "createIdcPermissionSet") {
    props.logger.log(
      `Creating IdC permission set "${props.operation.permissionSetName}"...`,
    );
    const response = await props.ssoAdminClient.send(
      new CreatePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        Name: props.operation.permissionSetName,
        Description:
          props.operation.description.length > 0 ? props.operation.description : undefined,
        SessionDuration: props.operation.sessionDuration ?? undefined,
      }),
    );
    const permissionSetArn = response.PermissionSet?.PermissionSetArn;
    if (permissionSetArn == null) {
      throw new Error(
        `CreatePermissionSet for "${props.operation.permissionSetName}" returned no permission set arn.`,
      );
    }
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: {
        permissionSetArn,
        name: props.operation.permissionSetName,
        description: props.operation.description,
        sessionDuration: props.operation.sessionDuration,
        inlinePolicy: null,
        awsManagedPolicies: [],
        customerManagedPolicies: [],
        permissionsBoundary: null,
      },
    });
  }
  if (props.operation.kind === "updateIdcPermissionSetDescription") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Updating IdC permission set description for "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new UpdatePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        Description:
          props.operation.description.trim().length > 0
            ? props.operation.description
            : undefined,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: {
        ...permissionSet,
        description: props.operation.description,
      },
    });
  }
  if (props.operation.kind === "updateIdcPermissionSetSessionDuration") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Updating IdC permission set session duration for "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new UpdatePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        SessionDuration: props.operation.sessionDuration ?? undefined,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: {
        ...permissionSet,
        sessionDuration: props.operation.sessionDuration,
      },
    });
  }
  if (props.operation.kind === "deleteIdcPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Deleting IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DeletePermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return removeIdcPermissionSetFromWorkingState({
      workingState: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
  }
  if (props.operation.kind === "putIdcPermissionSetInlinePolicy") {
    const { inlinePolicy } = props.operation;
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Putting inline policy on IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new PutInlinePolicyToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        InlinePolicy: inlinePolicy,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        inlinePolicy,
      }),
    });
  }
  if (props.operation.kind === "deleteIdcPermissionSetInlinePolicy") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Deleting inline policy from IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DeleteInlinePolicyFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        inlinePolicy: null,
      }),
    });
  }
  if (props.operation.kind === "attachIdcManagedPolicyToPermissionSet") {
    const { managedPolicyArn } = props.operation;
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Attaching managed policy "${managedPolicyArn}" to IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new AttachManagedPolicyToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        ManagedPolicyArn: managedPolicyArn,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        awsManagedPolicies: [
          ...currentPermissionSet.awsManagedPolicies,
          managedPolicyArn,
        ],
      }),
    });
  }
  if (props.operation.kind === "detachIdcManagedPolicyFromPermissionSet") {
    const { managedPolicyArn } = props.operation;
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Detaching managed policy "${managedPolicyArn}" from IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DetachManagedPolicyFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        ManagedPolicyArn: managedPolicyArn,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        awsManagedPolicies: currentPermissionSet.awsManagedPolicies.filter(
          (arn) => arn !== managedPolicyArn,
        ),
      }),
    });
  }
  if (
    props.operation.kind === "attachIdcCustomerManagedPolicyReferenceToPermissionSet"
  ) {
    const { customerManagedPolicyName, customerManagedPolicyPath } =
      props.operation;
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Attaching customer-managed policy "${customerManagedPolicyPath}${customerManagedPolicyName}" to IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new AttachCustomerManagedPolicyReferenceToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        CustomerManagedPolicyReference: {
          Name: customerManagedPolicyName,
          Path: customerManagedPolicyPath,
        },
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        customerManagedPolicies: [
          ...currentPermissionSet.customerManagedPolicies,
          {
            name: customerManagedPolicyName,
            path: customerManagedPolicyPath,
          },
        ],
      }),
    });
  }
  if (
    props.operation.kind ===
    "detachIdcCustomerManagedPolicyReferenceFromPermissionSet"
  ) {
    const { customerManagedPolicyName, customerManagedPolicyPath } =
      props.operation;
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Detaching customer-managed policy "${customerManagedPolicyPath}${customerManagedPolicyName}" from IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DetachCustomerManagedPolicyReferenceFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        CustomerManagedPolicyReference: {
          Name: customerManagedPolicyName,
          Path: customerManagedPolicyPath,
        },
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertPermissionSetPolicyState({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
      update: (currentPermissionSet) => ({
        ...currentPermissionSet,
        customerManagedPolicies:
          currentPermissionSet.customerManagedPolicies.filter(
            (policy) =>
              policy.name !== customerManagedPolicyName ||
              policy.path !== customerManagedPolicyPath,
          ),
      }),
    });
  }
  if (props.operation.kind === "provisionIdcPermissionSet") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Provisioning IdC permission set "${props.operation.permissionSetName}" to all provisioned accounts...`,
    );
    const response = await props.ssoAdminClient.send(
      new ProvisionPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        TargetType: props.operation.targetScope,
      }),
    );
    const requestId =
      response.PermissionSetProvisioningStatus?.RequestId ?? undefined;
    if (requestId == null) {
      throw new Error(
        `ProvisionPermissionSet for "${props.operation.permissionSetName}" returned no request id.`,
      );
    }
    await waitForPermissionSetProvisioningSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId,
      timeoutInMs: props.runtime.permissionSetProvisioning.timeoutInMs,
      pollIntervalInMs:
        props.runtime.permissionSetProvisioning.pollIntervalInMs,
      operationLabel: `"${props.operation.permissionSetName}"`,
    });
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return props.state;
  }
  if (props.operation.kind === "putIdcPermissionSetPermissionsBoundary") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Putting permissions boundary on IdC permission set "${props.operation.permissionSetName}"...`,
    );
    const boundary = props.operation.permissionsBoundary;
    await props.ssoAdminClient.send(
      new PutPermissionsBoundaryToPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
        PermissionsBoundary:
          "managedPolicyArn" in boundary
            ? { ManagedPolicyArn: boundary.managedPolicyArn }
            : {
                CustomerManagedPolicyReference: {
                  Name: boundary.customerManagedPolicyName,
                  Path: boundary.customerManagedPolicyPath,
                },
              },
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: { ...permissionSet, permissionsBoundary: boundary },
    });
  }
  if (props.operation.kind === "deleteIdcPermissionSetPermissionsBoundary") {
    const permissionSet = resolvePermissionSetByName({
      state: props.state,
      permissionSetName: props.operation.permissionSetName,
    });
    props.logger.log(
      `Deleting permissions boundary from IdC permission set "${props.operation.permissionSetName}"...`,
    );
    await props.ssoAdminClient.send(
      new DeletePermissionsBoundaryFromPermissionSetCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        PermissionSetArn: permissionSet.permissionSetArn,
      }),
    );
    props.logger.log(`Done: "${props.operation.permissionSetName}"`);
    return upsertIdcPermissionSetInWorkingState({
      workingState: props.state,
      permissionSet: { ...permissionSet, permissionsBoundary: null },
    });
  }
  if (props.operation.kind === "removeIdcGroupMembership") {
    const resolvedMembership = resolveGroupMembershipDependencies({
      state: props.state,
      groupDisplayName: props.operation.groupDisplayName,
      userName: props.operation.userName,
    });
    const membershipId = await resolveGroupMembershipId({
      state: props.state,
      identityStoreClient: props.identityStoreClient,
      groupId: resolvedMembership.groupId,
      userId: resolvedMembership.userId,
    });
    props.logger.log(
      `Removing user "${props.operation.userName}" from IdC group "${props.operation.groupDisplayName}"...`,
    );
    await props.identityStoreClient.send(
      new DeleteGroupMembershipCommand({
        IdentityStoreId: props.state.identityCenter.identityStoreId,
        MembershipId: membershipId,
      }),
    );
    props.logger.log(
      `Done: user "${props.operation.userName}" x group "${props.operation.groupDisplayName}"`,
    );
    return removeGroupMembershipFromWorkingState({
      workingState: props.state,
      groupMembership: {
        groupId: resolvedMembership.groupId,
        userId: resolvedMembership.userId,
      },
    });
  }
  if (props.operation.kind === "grantIdcAccountAssignment") {
    const resolvedAssignment = resolveAssignmentDependencies({
      state: props.state,
      accountName: props.operation.accountName,
      permissionSetName: props.operation.permissionSetName,
      principalType: props.operation.principalType,
      principalName: props.operation.principalName,
    });
    props.logger.log(
      `Granting IdC assignment "${props.operation.permissionSetName}" to ${formatPrincipalLabel(
        {
          principalType: props.operation.principalType,
          principalName: props.operation.principalName,
        },
      )} on "${props.operation.accountName}"...`,
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
        `CreateAccountAssignment for "${props.operation.permissionSetName}" on "${props.operation.accountName}" returned no request id.`,
      );
    }
    await waitForAccountAssignmentCreationSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId,
      timeoutInMs: props.runtime.accountAssignment.timeoutInMs,
      pollIntervalInMs: props.runtime.accountAssignment.pollIntervalInMs,
      operationLabel: `"${props.operation.permissionSetName}" on "${props.operation.accountName}"`,
    });
    props.logger.log(
      `Done: "${props.operation.permissionSetName}" -> "${props.operation.accountName}"`,
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
  if (props.operation.kind === "revokeIdcAccountAssignment") {
    const resolvedAssignment = resolveAssignmentDependencies({
      state: props.state,
      accountName: props.operation.accountName,
      permissionSetName: props.operation.permissionSetName,
      principalType: props.operation.principalType,
      principalName: props.operation.principalName,
    });
    props.logger.log(
      `Revoking IdC assignment "${props.operation.permissionSetName}" from ${formatPrincipalLabel(
        {
          principalType: props.operation.principalType,
          principalName: props.operation.principalName,
        },
      )} on "${props.operation.accountName}"...`,
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
        `DeleteAccountAssignment for "${props.operation.permissionSetName}" on "${props.operation.accountName}" returned no request id.`,
      );
    }
    await waitForAccountAssignmentDeletionSuccess({
      ssoAdminClient: props.ssoAdminClient,
      logger: props.logger,
      instanceArn: props.state.identityCenter.instanceArn,
      requestId,
      timeoutInMs: props.runtime.accountAssignment.timeoutInMs,
      pollIntervalInMs: props.runtime.accountAssignment.pollIntervalInMs,
      operationLabel: `"${props.operation.permissionSetName}" on "${props.operation.accountName}"`,
    });
    props.logger.log(
      `Done: "${props.operation.permissionSetName}" x "${props.operation.accountName}"`,
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
      }),
    );
    const policy = response.Policy?.PolicySummary;
    if (policy?.Id == null || policy.Arn == null) {
      throw new Error(
        `CreatePolicy for "${props.operation.policyName}" returned incomplete data.`,
      );
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
    props.logger.log(
      `Updating org policy content "${props.operation.policyName}"...`,
    );
    await props.organizationsClient.send(
      new UpdatePolicyCommand({
        PolicyId: props.operation.policyId,
        Content: props.operation.content,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}"`);
    const currentPolicy =
      props.state.organization.policiesById[props.operation.policyId];
    if (currentPolicy == null) {
      return props.state;
    }
    return upsertOrgPolicyInWorkingState({
      workingState: props.state,
      policy: { ...currentPolicy, content: props.operation.content },
    });
  }
  if (props.operation.kind === "updateOrgPolicyDescription") {
    props.logger.log(
      `Updating org policy description "${props.operation.policyName}"...`,
    );
    await props.organizationsClient.send(
      new UpdatePolicyCommand({
        PolicyId: props.operation.policyId,
        Description: props.operation.description,
      }),
    );
    props.logger.log(`Done: "${props.operation.policyName}"`);
    const currentPolicy =
      props.state.organization.policiesById[props.operation.policyId];
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
    props.logger.log(
      `Done: "${props.operation.policyName}" -> "${props.operation.targetName}"`,
    );
    const targetType =
      props.operation.targetId === props.context.organization.rootId
        ? ("ROOT" as const)
        : props.state.organization.organizationalUnitsById[
              props.operation.targetId
            ] != null
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
    props.logger.log(
      `Done: "${props.operation.policyName}" x "${props.operation.targetName}"`,
    );
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
  if (props.operation.kind === "putAlternateContact") {
    const { contactType } = props.operation;
    props.logger.log(
      `Setting ${contactType} alternate contact for "${props.operation.accountName}" (${props.operation.accountId})...`,
    );
    await props.accountClient.send(
      new PutAlternateContactCommand({
        AccountId: props.operation.accountId,
        AlternateContactType: contactType,
        Name: props.operation.name,
        EmailAddress: props.operation.email,
        PhoneNumber: props.operation.phone,
        Title: props.operation.title,
      }),
    );
    props.logger.log(
      `Done: ${contactType} contact for "${props.operation.accountName}"`,
    );
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account (${props.operation.accountId}) in working state.`,
      );
    }
    const updatedContacts = [
      ...(account.alternateContacts ?? []).filter(
        (c) => c.contactType !== contactType,
      ),
      {
        contactType,
        name: props.operation.name,
        email: props.operation.email,
        phone: props.operation.phone,
        title: props.operation.title,
      },
    ];
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: { ...account, alternateContacts: updatedContacts },
    });
  }
  if (props.operation.kind === "deleteAlternateContact") {
    const { contactType } = props.operation;
    props.logger.log(
      `Deleting ${contactType} alternate contact for "${props.operation.accountName}" (${props.operation.accountId})...`,
    );
    await props.accountClient.send(
      new DeleteAlternateContactCommand({
        AccountId: props.operation.accountId,
        AlternateContactType: contactType,
      }),
    );
    props.logger.log(
      `Done: removed ${contactType} contact for "${props.operation.accountName}"`,
    );
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(
        `Could not resolve account (${props.operation.accountId}) in working state.`,
      );
    }
    return upsertAccountInWorkingState({
      workingState: props.state,
      account: {
        ...account,
        alternateContacts: (account.alternateContacts ?? []).filter(
          (c) => c.contactType !== contactType,
        ),
      },
    });
  }
  if (props.operation.kind === "setIdcAccessControlAttributes") {
    props.logger.log(
      `Setting IdC access control attributes (${props.operation.attributes.length} attribute(s))...`,
    );
    await props.ssoAdminClient.send(
      new UpdateInstanceAccessControlAttributeConfigurationCommand({
        InstanceArn: props.state.identityCenter.instanceArn,
        InstanceAccessControlAttributeConfiguration: {
          AccessControlAttributes: props.operation.attributes.map((attr) => ({
            Key: attr.key,
            Value: { Source: attr.source },
          })),
        },
      }),
    );
    props.logger.log(`Done: access control attributes updated`);
    return {
      ...props.state,
      identityCenter: {
        ...props.state.identityCenter,
        accessControlAttributes: props.operation.attributes,
      },
    };
  }
  if (props.operation.kind === "registerDelegatedAdministrator") {
    props.logger.log(
      `Registering delegated administrator "${props.operation.accountName}" (${props.operation.accountId}) for ${props.operation.servicePrincipal}...`,
    );
    await props.organizationsClient.send(
      new RegisterDelegatedAdministratorCommand({
        AccountId: props.operation.accountId,
        ServicePrincipal: props.operation.servicePrincipal,
      }),
    );
    props.logger.log(
      `Done: "${props.operation.accountName}" for ${props.operation.servicePrincipal}`,
    );
    return upsertDelegatedAdministratorInWorkingState({
      workingState: props.state,
      delegatedAdministrator: {
        accountId: props.operation.accountId,
        servicePrincipal: props.operation.servicePrincipal,
      },
    });
  }
  if (props.operation.kind === "deregisterDelegatedAdministrator") {
    props.logger.log(
      `Deregistering delegated administrator "${props.operation.accountName}" (${props.operation.accountId}) for ${props.operation.servicePrincipal}...`,
    );
    await props.organizationsClient.send(
      new DeregisterDelegatedAdministratorCommand({
        AccountId: props.operation.accountId,
        ServicePrincipal: props.operation.servicePrincipal,
      }),
    );
    props.logger.log(
      `Done: removed "${props.operation.accountName}" for ${props.operation.servicePrincipal}`,
    );
    return removeDelegatedAdministratorFromWorkingState({
      workingState: props.state,
      accountId: props.operation.accountId,
      servicePrincipal: props.operation.servicePrincipal,
    });
  }
  assertUnreachable(props.operation, "Unsupported operation kind in apply.");
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

function resolveUserByName(props: { state: WorkingState; userName: string }) {
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

function resolvePolicyId(props: {
  state: WorkingState;
  policyId: string;
  policyName: string;
}): string {
  if (props.policyId !== "__pending_creation__") return props.policyId;
  const policy = props.state.organization.policiesByName[props.policyName];
  if (policy == null) {
    throw new Error(
      `Could not resolve policy "${props.policyName}" in working state.`,
    );
  }
  return policy.id;
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
      awsManagedPolicies: [
        ...new Set(nextPermissionSet.awsManagedPolicies),
      ].sort((left, right) => left.localeCompare(right)),
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
      `Refusing to delete OU "${props.organizationalUnitName}": live AWS preflight failed [child-ou-present]: ${formatLivePreflightResource(
        {
          resourceType: "child OU",
          name: childOrganizationalUnit.Name,
          id: childOrganizationalUnit.Id,
        },
      )} is still attached.`,
    );
  }
  const account = await listFirstAccountForParent({
    organizationsClient: props.organizationsClient,
    parentId: props.organizationalUnitId,
  });
  if (account != null) {
    throw new Error(
      `Refusing to delete OU "${props.organizationalUnitName}": live AWS preflight failed [account-present]: ${formatLivePreflightResource(
        {
          resourceType: "account",
          name: account.Name,
          id: account.Id,
        },
      )} is still attached.`,
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
  const group =
    props.state.identityCenter.groupsByDisplayName[props.groupDisplayName];
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
