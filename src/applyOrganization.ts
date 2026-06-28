import type { AccountClient } from "@aws-sdk/client-account";
import {
  DeleteAlternateContactCommand,
  PutAccountNameCommand,
  PutAlternateContactCommand,
} from "@aws-sdk/client-account";
import type { OrganizationsClient } from "@aws-sdk/client-organizations";
import {
  CreateOrganizationalUnitCommand,
  DeleteOrganizationalUnitCommand,
  DeregisterDelegatedAdministratorCommand,
  EnableAWSServiceAccessCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  MoveAccountCommand,
  RegisterDelegatedAdministratorCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateOrganizationalUnitCommand,
} from "@aws-sdk/client-organizations";

import { createAccountAndMoveToOu } from "./accountCreation.js";
import { assertUnreachable } from "./helpers.js";
import type { Logger } from "./logger.js";
import type { Operation } from "./operations.js";
import {
  moveAccountInWorkingState,
  removeOrganizationalUnitFromWorkingState,
  removeDelegatedAdministratorFromWorkingState,
  renameOrganizationalUnitInWorkingState,
  upsertAccountInWorkingState,
  upsertDelegatedAdministratorInWorkingState,
  upsertOrganizationalUnitInWorkingState,
  type WorkingState,
} from "./state.js";

type OrganizationOperationKind =
  | "moveAccount"
  | "createOu"
  | "renameOu"
  | "deleteOu"
  | "createAccount"
  | "updateAccountTags"
  | "updateAccountName"
  | "removeAccount"
  | "putAlternateContact"
  | "deleteAlternateContact"
  | "registerDelegatedAdministrator"
  | "deregisterDelegatedAdministrator";

type OrganizationOperation = Extract<Operation, { kind: OrganizationOperationKind }>;

type ExecuteOrganizationOperationProps = {
  state: WorkingState;
  organizationsClient: OrganizationsClient;
  accountClient: AccountClient;
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
  };
  operation: OrganizationOperation;
};

export async function executeOrganizationOperation(
  props: ExecuteOrganizationOperationProps,
): Promise<WorkingState> {
  if (props.operation.kind === "moveAccount") {
    props.logger.log(
      `Moving "${props.operation.accountName}" (${props.operation.accountId}): ${props.operation.fromOuName} -> ${props.operation.toOuName}`,
    );
    const toOuId = resolveOrganizationalUnitId({
      state: props.state,
      organizationalUnitId: props.operation.toOuId,
      organizationalUnitName: props.operation.toOuName,
    });
    await props.organizationsClient.send(
      new MoveAccountCommand({
        AccountId: props.operation.accountId,
        SourceParentId: props.operation.fromOuId,
        DestinationParentId: toOuId,
      }),
    );
    props.logger.log(`Done: "${props.operation.accountName}"`);
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: props.operation.accountId,
      parentId: toOuId,
    });
  }
  if (props.operation.kind === "createOu") {
    props.logger.log(
      `Creating OU "${props.operation.ouName}" under ${props.operation.parentOuName}...`,
    );
    const parentOuId = resolveOrganizationalUnitId({
      state: props.state,
      organizationalUnitId: props.operation.parentOuId,
      organizationalUnitName: props.operation.parentOuName,
    });
    const response = await props.organizationsClient.send(
      new CreateOrganizationalUnitCommand({
        ParentId: parentOuId,
        Name: props.operation.ouName,
      }),
    );
    const createdOu = response.OrganizationalUnit;
    if (createdOu?.Id == null || createdOu.Arn == null || createdOu.Name == null) {
      throw new Error(
        `CreateOrganizationalUnit for "${props.operation.ouName}" returned incomplete OU data.`,
      );
    }
    props.logger.log(`Done: "${createdOu.Name}"`);
    return upsertOrganizationalUnitInWorkingState({
      workingState: props.state,
      organizationalUnit: {
        id: createdOu.Id,
        parentId: parentOuId,
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
    const targetOuId = resolveOrganizationalUnitId({
      state: props.state,
      organizationalUnitId: props.operation.targetOuId,
      organizationalUnitName: props.operation.targetOuName,
    });
    const result = await createAccountAndMoveToOu({
      organizationsClient: props.organizationsClient,
      logger: props.logger,
      accountName: props.operation.accountName,
      accountEmail: props.operation.accountEmail,
      sourceParentId: props.context.organization.rootId,
      destinationParentId: targetOuId,
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
        state: result.account.state,
        parentId: targetOuId,
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
    const currentTags = new Map((account.tags ?? []).map((tag) => [tag.key, tag.value] as const));
    const desiredTags = new Map(Object.entries(props.operation.tags));
    const tagsToApply = [...desiredTags.entries()]
      .filter(([key, value]) => currentTags.get(key) !== value)
      .map(([Key, Value]) => ({ Key, Value }));
    const tagKeysToRemove = [...currentTags.keys()].filter((key) => desiredTags.has(key) === false);

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
    props.logger.log(`Done: "${props.operation.accountName}" -> ${props.operation.toOuName}`);
    return moveAccountInWorkingState({
      workingState: props.state,
      accountId: props.operation.accountId,
      parentId: props.operation.toOuId,
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
    props.logger.log(`Done: ${contactType} contact for "${props.operation.accountName}"`);
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(`Could not resolve account (${props.operation.accountId}) in working state.`);
    }
    const updatedContacts = [
      ...(account.alternateContacts ?? []).filter((c) => c.contactType !== contactType),
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
    props.logger.log(`Done: removed ${contactType} contact for "${props.operation.accountName}"`);
    const account = props.state.organization.accountsById[props.operation.accountId];
    if (account == null) {
      throw new Error(`Could not resolve account (${props.operation.accountId}) in working state.`);
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
  if (props.operation.kind === "registerDelegatedAdministrator") {
    props.logger.log(
      `Registering delegated administrator "${props.operation.accountName}" (${props.operation.accountId}) for ${props.operation.servicePrincipal}...`,
    );
    await props.organizationsClient.send(
      new EnableAWSServiceAccessCommand({
        ServicePrincipal: props.operation.servicePrincipal,
      }),
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
  assertUnreachable(props.operation, "Unsupported organization operation kind.");
}

function resolveOrganizationalUnitId(props: {
  state: WorkingState;
  organizationalUnitId: string;
  organizationalUnitName: string;
}): string {
  if (props.organizationalUnitId !== "__pending_creation__") {
    return props.organizationalUnitId;
  }
  const ou = Object.values(props.state.organization.organizationalUnitsById).find(
    (ou) => ou.name === props.organizationalUnitName,
  );
  if (ou == null) {
    throw new Error(`Could not resolve OU "${props.organizationalUnitName}" in working state.`);
  }
  return ou.id;
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
