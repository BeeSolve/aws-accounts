import {
  IdentitystoreClient,
  ListGroupsCommand,
  ListUsersCommand,
} from "@aws-sdk/client-identitystore";
import {
  ListAccountsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import {
  createAccessRoleName,
  writeStateFile,
  type AccountAssignmentState,
  type StateFile,
} from "../state.js";
import type { Logger } from "../logger.js";

const outputPath = "state.json";

type ScanCommandInput = {
  organizationsClient: OrganizationsClient;
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  logger: Logger;
  instanceArn?: string;
  outputPath?: string;
};

type ScanCommandResult = {
  outputPath: string;
  state: StateFile;
};

export async function runScanCommand(
  props: ScanCommandInput,
): Promise<ScanCommandResult> {
  props.logger.log("Scanning organization and identity center...");
  const [organization, identityCenter] = await Promise.all([
    scanOrganization({
      organizationsClient: props.organizationsClient,
    }),
    scanIdentityCenter({
      ssoAdminClient: props.ssoAdminClient,
      identityStoreClient: props.identityStoreClient,
      requestedInstanceArn: props.instanceArn,
    }),
  ]);

  const state: StateFile = {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: organization,
    identityCenter: identityCenter,
  };

  const resolvedOutputPath = props.outputPath ?? outputPath;
  props.logger.log(`Writing ${resolvedOutputPath}...`);
  await writeStateFile(resolvedOutputPath, state);
  return { outputPath: resolvedOutputPath, state };
}

async function scanOrganization(props: {
  organizationsClient: OrganizationsClient;
}): Promise<StateFile["organization"]> {
  const roots = await props.organizationsClient.send(new ListRootsCommand({}));
  const root = roots.Roots?.[0];
  if (root?.Id == null) {
    throw new Error("No organization root found.");
  }

  const organizationalUnits = await collectOrganizationalUnits({
    organizationsClient: props.organizationsClient,
    parentId: root.Id,
  });

  const accounts: StateFile["organization"]["accounts"] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListAccountsCommand({ NextToken: nextToken }),
    );
    for (const account of response.Accounts ?? []) {
      if (
        account.Id == null ||
        account.Arn == null ||
        account.Name == null ||
        account.Email == null ||
        account.Status == null
      ) {
        continue;
      }
      const parents = await props.organizationsClient.send(
        new ListParentsCommand({ ChildId: account.Id }),
      );
      const parentId = parents.Parents?.[0]?.Id ?? root.Id;
      accounts.push({
        id: account.Id,
        arn: account.Arn,
        name: account.Name,
        email: account.Email,
        status: account.Status,
        parentId: parentId,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken != null);

  return {
    rootId: root.Id,
    organizationalUnits: organizationalUnits,
    accounts: accounts,
  };
}

async function collectOrganizationalUnits(props: {
  organizationsClient: OrganizationsClient;
  parentId: string;
}): Promise<StateFile["organization"]["organizationalUnits"]> {
  const children: StateFile["organization"]["organizationalUnits"] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListOrganizationalUnitsForParentCommand({
        ParentId: props.parentId,
        NextToken: nextToken,
      }),
    );

    for (const ou of response.OrganizationalUnits ?? []) {
      if (ou.Id == null || ou.Arn == null || ou.Name == null) {
        continue;
      }
      children.push({
        id: ou.Id,
        parentId: props.parentId,
        arn: ou.Arn,
        name: ou.Name,
      });
      const descendants = await collectOrganizationalUnits({
        organizationsClient: props.organizationsClient,
        parentId: ou.Id,
      });
      children.push(...descendants);
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return children;
}

async function scanIdentityCenter(props: {
  ssoAdminClient: SSOAdminClient;
  identityStoreClient: IdentitystoreClient;
  requestedInstanceArn?: string;
}): Promise<StateFile["identityCenter"]> {
  const instancesResponse = await props.ssoAdminClient.send(
    new ListInstancesCommand({}),
  );
  const instances = instancesResponse.Instances ?? [];
  if (instances.length === 0) {
    throw new Error("No IAM Identity Center instance found.");
  }

  const instance = selectIdentityCenterInstance({
    instances: instances,
    requestedInstanceArn: props.requestedInstanceArn,
  });
  if (instance.InstanceArn == null || instance.IdentityStoreId == null) {
    throw new Error("IAM Identity Center instance is missing required fields.");
  }

  const [users, groups, permissionSets] = await Promise.all([
    listIdentityStoreUsers({
      identityStoreClient: props.identityStoreClient,
      identityStoreId: instance.IdentityStoreId,
    }),
    listIdentityStoreGroups({
      identityStoreClient: props.identityStoreClient,
      identityStoreId: instance.IdentityStoreId,
    }),
    listPermissionSets({
      ssoAdminClient: props.ssoAdminClient,
      instanceArn: instance.InstanceArn,
    }),
  ]);
  const accountAssignments = await listAccountAssignments({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: instance.InstanceArn,
    permissionSets: permissionSets,
  });
  const accessRoles = accountAssignments.map((assignment) => ({
    ...assignment,
    roleName: createAccessRoleName(assignment),
  }));

  return {
    instanceArn: instance.InstanceArn,
    identityStoreId: instance.IdentityStoreId,
    users: users,
    groups: groups,
    permissionSets: permissionSets,
    accountAssignments: accountAssignments,
    accessRoles: accessRoles,
  };
}

type IdentityCenterInstance = {
  InstanceArn?: string;
  IdentityStoreId?: string;
};

function selectIdentityCenterInstance(props: {
  instances: IdentityCenterInstance[];
  requestedInstanceArn?: string;
}): IdentityCenterInstance {
  if (props.requestedInstanceArn != null) {
    const selected = props.instances.find(
      (instance) => instance.InstanceArn === props.requestedInstanceArn,
    );
    if (selected == null) {
      throw new Error(
        `Identity Center instance not found for --instance-arn: ${props.requestedInstanceArn}`,
      );
    }
    return selected;
  }

  if (props.instances.length > 1) {
    const knownArns = props.instances
      .map((instance) => instance.InstanceArn)
      .filter((value): value is string => value != null)
      .join(", ");
    throw new Error(
      `Multiple IAM Identity Center instances found. Re-run scan with --instance-arn. Available: ${knownArns}`,
    );
  }

  return props.instances[0];
}

async function listIdentityStoreUsers(props: {
  identityStoreClient: IdentitystoreClient;
  identityStoreId: string;
}): Promise<StateFile["identityCenter"]["users"]> {
  const users: StateFile["identityCenter"]["users"] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.identityStoreClient.send(
      new ListUsersCommand({
        IdentityStoreId: props.identityStoreId,
        NextToken: nextToken,
      }),
    );
    for (const user of response.Users ?? []) {
      if (user.UserId == null || user.UserName == null) {
        continue;
      }
      users.push({
        userId: user.UserId,
        userName: user.UserName,
        displayName: user.DisplayName ?? "",
        emails: (user.Emails ?? [])
          .map((email) => email.Value ?? "")
          .filter((value) => value.length > 0),
      });
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return users;
}

async function listIdentityStoreGroups(props: {
  identityStoreClient: IdentitystoreClient;
  identityStoreId: string;
}): Promise<StateFile["identityCenter"]["groups"]> {
  const groups: StateFile["identityCenter"]["groups"] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.identityStoreClient.send(
      new ListGroupsCommand({
        IdentityStoreId: props.identityStoreId,
        NextToken: nextToken,
      }),
    );
    for (const group of response.Groups ?? []) {
      if (group.GroupId == null || group.DisplayName == null) {
        continue;
      }
      groups.push({
        groupId: group.GroupId,
        displayName: group.DisplayName,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return groups;
}

async function listPermissionSets(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
}): Promise<StateFile["identityCenter"]["permissionSets"]> {
  const permissionSetArns: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.ssoAdminClient.send(
      new ListPermissionSetsCommand({
        InstanceArn: props.instanceArn,
        NextToken: nextToken,
      }),
    );
    permissionSetArns.push(...(response.PermissionSets ?? []));
    nextToken = response.NextToken;
  } while (nextToken != null);

  const permissionSets: StateFile["identityCenter"]["permissionSets"] = [];
  const describeResponses = await Promise.all(
    permissionSetArns.map((permissionSetArn) =>
      props.ssoAdminClient.send(
        new DescribePermissionSetCommand({
          InstanceArn: props.instanceArn,
          PermissionSetArn: permissionSetArn,
        }),
      ),
    ),
  );
  for (const response of describeResponses) {
    const permissionSet = response.PermissionSet;
    if (permissionSet?.PermissionSetArn == null || permissionSet.Name == null) {
      continue;
    }
    permissionSets.push({
      permissionSetArn: permissionSet.PermissionSetArn,
      name: permissionSet.Name,
      description: permissionSet.Description ?? "",
    });
  }
  return permissionSets;
}

async function listAccountAssignments(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSets: StateFile["identityCenter"]["permissionSets"];
}): Promise<AccountAssignmentState[]> {
  const assignments: AccountAssignmentState[] = [];
  for (const permissionSet of props.permissionSets) {
    const accountIds = await listAccountsForPermissionSet({
      ssoAdminClient: props.ssoAdminClient,
      instanceArn: props.instanceArn,
      permissionSetArn: permissionSet.permissionSetArn,
    });
    for (const accountId of accountIds) {
      let nextToken: string | undefined;
      do {
        const response = await props.ssoAdminClient.send(
          new ListAccountAssignmentsCommand({
            InstanceArn: props.instanceArn,
            AccountId: accountId,
            PermissionSetArn: permissionSet.permissionSetArn,
            NextToken: nextToken,
          }),
        );
        for (const assignment of response.AccountAssignments ?? []) {
          if (
            assignment.AccountId == null ||
            assignment.PermissionSetArn == null ||
            assignment.PrincipalId == null ||
            assignment.PrincipalType == null
          ) {
            continue;
          }
          assignments.push({
            accountId: assignment.AccountId,
            permissionSetArn: assignment.PermissionSetArn,
            principalId: assignment.PrincipalId,
            principalType: assignment.PrincipalType,
          });
        }
        nextToken = response.NextToken;
      } while (nextToken != null);
    }
  }
  return assignments;
}

async function listAccountsForPermissionSet(props: {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSetArn: string;
}): Promise<string[]> {
  const accountIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await props.ssoAdminClient.send(
      new ListAccountsForProvisionedPermissionSetCommand({
        InstanceArn: props.instanceArn,
        PermissionSetArn: props.permissionSetArn,
        NextToken: nextToken,
      }),
    );
    accountIds.push(...(response.AccountIds ?? []));
    nextToken = response.NextToken;
  } while (nextToken != null);
  return accountIds;
}
