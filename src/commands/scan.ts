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
import { type AwsClientConfig } from "../awsClientConfig.js";
import {
  createAccessRoleName,
  writeStateFile,
  type AccountAssignmentState,
  type StateFile,
} from "../state.js";

export type ScanCommandInput = {
  clientConfig: AwsClientConfig;
  instanceArn?: string;
};

export type ScanCommandResult = {
  outputPath: string;
  state: StateFile;
};

type IdentityCenterInstance = {
  InstanceArn?: string;
  IdentityStoreId?: string;
};

export async function runScanCommand(
  props: ScanCommandInput,
): Promise<ScanCommandResult> {
  const outputPath = "state.json";
  const organizationsClient = new OrganizationsClient(props.clientConfig);
  const ssoAdminClient = new SSOAdminClient(props.clientConfig);

  console.log("Scanning organization...");
  const organization = await scanOrganization({
    organizationsClient: organizationsClient,
  });

  console.log("Scanning identity center...");
  const identityCenter = await scanIdentityCenter({
    ssoAdminClient: ssoAdminClient,
    clientConfig: props.clientConfig,
    requestedInstanceArn: props.instanceArn,
  });

  const state: StateFile = {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: organization,
    identityCenter: identityCenter,
  };

  console.log("Writing state.json...");
  await writeStateFile(outputPath, state);
  return { outputPath, state };
}

type ScanOrganizationProps = {
  organizationsClient: OrganizationsClient;
};

async function scanOrganization(props: ScanOrganizationProps): Promise<StateFile["organization"]> {
  const roots = await props.organizationsClient.send(new ListRootsCommand({}));
  const root = roots.Roots?.[0];
  if (root?.Id == null) {
    throw new Error("No organization root found.");
  }

  const organizationalUnits: StateFile["organization"]["organizationalUnits"] = [];
  await collectOrganizationalUnits({
    organizationsClient: props.organizationsClient,
    parentId: root.Id,
    sink: organizationalUnits,
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

type CollectOrganizationalUnitsProps = {
  organizationsClient: OrganizationsClient;
  parentId: string;
  sink: StateFile["organization"]["organizationalUnits"];
};

async function collectOrganizationalUnits(props: CollectOrganizationalUnitsProps): Promise<void> {
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
      props.sink.push({
        id: ou.Id,
        parentId: props.parentId,
        arn: ou.Arn,
        name: ou.Name,
      });
      await collectOrganizationalUnits({
        organizationsClient: props.organizationsClient,
        parentId: ou.Id,
        sink: props.sink,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
}

type ScanIdentityCenterProps = {
  ssoAdminClient: SSOAdminClient;
  clientConfig: AwsClientConfig;
  requestedInstanceArn?: string;
};

async function scanIdentityCenter(props: ScanIdentityCenterProps): Promise<StateFile["identityCenter"]> {
  const instancesResponse = await props.ssoAdminClient.send(new ListInstancesCommand({}));
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

  const identityStoreClient = new IdentitystoreClient(props.clientConfig);
  const users = await listIdentityStoreUsers({
    identityStoreClient: identityStoreClient,
    identityStoreId: instance.IdentityStoreId,
  });
  const groups = await listIdentityStoreGroups({
    identityStoreClient: identityStoreClient,
    identityStoreId: instance.IdentityStoreId,
  });
  const permissionSets = await listPermissionSets({
    ssoAdminClient: props.ssoAdminClient,
    instanceArn: instance.InstanceArn,
  });
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

type SelectIdentityCenterInstanceProps = {
  instances: IdentityCenterInstance[];
  requestedInstanceArn?: string;
};

function selectIdentityCenterInstance(props: SelectIdentityCenterInstanceProps): IdentityCenterInstance {
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

type ListIdentityStoreUsersProps = {
  identityStoreClient: IdentitystoreClient;
  identityStoreId: string;
};

async function listIdentityStoreUsers(props: ListIdentityStoreUsersProps): Promise<StateFile["identityCenter"]["users"]> {
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

type ListIdentityStoreGroupsProps = {
  identityStoreClient: IdentitystoreClient;
  identityStoreId: string;
};

async function listIdentityStoreGroups(props: ListIdentityStoreGroupsProps): Promise<StateFile["identityCenter"]["groups"]> {
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

type ListPermissionSetsProps = {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
};

async function listPermissionSets(props: ListPermissionSetsProps): Promise<StateFile["identityCenter"]["permissionSets"]> {
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
  for (const permissionSetArn of permissionSetArns) {
    const response = await props.ssoAdminClient.send(
      new DescribePermissionSetCommand({
        InstanceArn: props.instanceArn,
        PermissionSetArn: permissionSetArn,
      }),
    );
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

type ListAccountAssignmentsProps = {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSets: StateFile["identityCenter"]["permissionSets"];
};

async function listAccountAssignments(props: ListAccountAssignmentsProps): Promise<AccountAssignmentState[]> {
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

type ListAccountsForPermissionSetProps = {
  ssoAdminClient: SSOAdminClient;
  instanceArn: string;
  permissionSetArn: string;
};

async function listAccountsForPermissionSet(props: ListAccountsForPermissionSetProps): Promise<string[]> {
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
