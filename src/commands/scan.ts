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
import { buildAwsClientConfig } from "../awsClientConfig.js";
import { withRetry } from "../retry.js";
import {
  createAccessRoleName,
  writeStateFile,
  type AccountAssignmentState,
  type StateFile,
} from "../state.js";

export type ScanCommandInput = {
  profile?: string;
  region?: string;
  instanceArn?: string;
};

export type ScanCommandResult = {
  outputPath: string;
  state: StateFile;
};

export async function runScanCommand(
  input: ScanCommandInput,
): Promise<ScanCommandResult> {
  const outputPath = "state.json";
  const clientConfig = buildAwsClientConfig(input);
  const organizationsClient = new OrganizationsClient(clientConfig);
  const ssoAdminClient = new SSOAdminClient(clientConfig);

  console.log("Scanning organization...");
  const organization = await scanOrganization(organizationsClient);

  console.log("Scanning identity center...");
  const identityCenter = await scanIdentityCenter(
    ssoAdminClient,
    clientConfig,
    input.instanceArn,
  );

  const state: StateFile = {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization,
    identityCenter,
  };

  console.log("Writing state.json...");
  await writeStateFile(outputPath, state);

  return {
    outputPath,
    state,
  };
}

async function scanOrganization(
  client: OrganizationsClient,
): Promise<StateFile["organization"]> {
  const roots = await withRetry(() => client.send(new ListRootsCommand({})));
  const root = roots.Roots?.[0];
  if (!root?.Id) {
    throw new Error("No organization root found.");
  }

  const organizationalUnits: StateFile["organization"]["organizationalUnits"] =
    [];
  await collectOrganizationalUnits(client, root.Id, organizationalUnits);

  const accounts: StateFile["organization"]["accounts"] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(new ListAccountsCommand({ NextToken: nextToken })),
    );
    for (const account of response.Accounts ?? []) {
      if (
        !account.Id ||
        !account.Arn ||
        !account.Name ||
        !account.Email ||
        !account.Status
      ) {
        continue;
      }
      const parents = await withRetry(() =>
        client.send(new ListParentsCommand({ ChildId: account.Id })),
      );
      const parentId = parents.Parents?.[0]?.Id ?? root.Id;
      accounts.push({
        id: account.Id,
        arn: account.Arn,
        name: account.Name,
        email: account.Email,
        status: account.Status,
        parentId,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return {
    rootId: root.Id,
    organizationalUnits,
    accounts,
  };
}

async function collectOrganizationalUnits(
  client: OrganizationsClient,
  parentId: string,
  sink: StateFile["organization"]["organizationalUnits"],
): Promise<void> {
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(
        new ListOrganizationalUnitsForParentCommand({
          ParentId: parentId,
          NextToken: nextToken,
        }),
      ),
    );

    for (const ou of response.OrganizationalUnits ?? []) {
      if (!ou.Id || !ou.Arn || !ou.Name) {
        continue;
      }
      sink.push({
        id: ou.Id,
        parentId,
        arn: ou.Arn,
        name: ou.Name,
      });
      await collectOrganizationalUnits(client, ou.Id, sink);
    }
    nextToken = response.NextToken;
  } while (nextToken);
}

async function scanIdentityCenter(
  ssoAdminClient: SSOAdminClient,
  clientConfig: ReturnType<typeof buildAwsClientConfig>,
  requestedInstanceArn?: string,
): Promise<StateFile["identityCenter"]> {
  const instancesResponse = await withRetry(() =>
    ssoAdminClient.send(new ListInstancesCommand({})),
  );
  const instances = instancesResponse.Instances ?? [];
  if (instances.length === 0) {
    throw new Error("No IAM Identity Center instance found.");
  }

  const instance = selectIdentityCenterInstance(
    instances,
    requestedInstanceArn,
  );
  if (!instance.InstanceArn || !instance.IdentityStoreId) {
    throw new Error("IAM Identity Center instance is missing required fields.");
  }

  const identityStoreClient = new IdentitystoreClient(clientConfig);
  const users = await listIdentityStoreUsers(
    identityStoreClient,
    instance.IdentityStoreId,
  );
  const groups = await listIdentityStoreGroups(
    identityStoreClient,
    instance.IdentityStoreId,
  );
  const permissionSets = await listPermissionSets(
    ssoAdminClient,
    instance.InstanceArn,
  );
  const accountAssignments = await listAccountAssignments(
    ssoAdminClient,
    instance.InstanceArn,
    permissionSets,
  );
  const accessRoles = accountAssignments.map((assignment) => ({
    ...assignment,
    roleName: createAccessRoleName(assignment),
  }));

  return {
    instanceArn: instance.InstanceArn,
    identityStoreId: instance.IdentityStoreId,
    users,
    groups,
    permissionSets,
    accountAssignments,
    accessRoles,
  };
}

type IdentityCenterInstance = {
  InstanceArn?: string;
  IdentityStoreId?: string;
};

function selectIdentityCenterInstance(
  instances: IdentityCenterInstance[],
  requestedInstanceArn?: string,
): IdentityCenterInstance {
  if (requestedInstanceArn) {
    const selected = instances.find(
      (instance) => instance.InstanceArn === requestedInstanceArn,
    );
    if (!selected) {
      throw new Error(
        `Identity Center instance not found for --instance-arn: ${requestedInstanceArn}`,
      );
    }
    return selected;
  }

  if (instances.length > 1) {
    const knownArns = instances
      .map((instance) => instance.InstanceArn)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Multiple IAM Identity Center instances found. Re-run scan with --instance-arn. Available: ${knownArns}`,
    );
  }

  return instances[0];
}

async function listIdentityStoreUsers(
  client: IdentitystoreClient,
  identityStoreId: string,
): Promise<StateFile["identityCenter"]["users"]> {
  const users: StateFile["identityCenter"]["users"] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(
        new ListUsersCommand({
          IdentityStoreId: identityStoreId,
          NextToken: nextToken,
        }),
      ),
    );
    for (const user of response.Users ?? []) {
      if (!user.UserId || !user.UserName) {
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
  } while (nextToken);
  return users;
}

async function listIdentityStoreGroups(
  client: IdentitystoreClient,
  identityStoreId: string,
): Promise<StateFile["identityCenter"]["groups"]> {
  const groups: StateFile["identityCenter"]["groups"] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(
        new ListGroupsCommand({
          IdentityStoreId: identityStoreId,
          NextToken: nextToken,
        }),
      ),
    );
    for (const group of response.Groups ?? []) {
      if (!group.GroupId || !group.DisplayName) {
        continue;
      }
      groups.push({
        groupId: group.GroupId,
        displayName: group.DisplayName,
      });
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return groups;
}

async function listPermissionSets(
  client: SSOAdminClient,
  instanceArn: string,
): Promise<StateFile["identityCenter"]["permissionSets"]> {
  const permissionSetArns: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(
        new ListPermissionSetsCommand({
          InstanceArn: instanceArn,
          NextToken: nextToken,
        }),
      ),
    );
    permissionSetArns.push(...(response.PermissionSets ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  const permissionSets: StateFile["identityCenter"]["permissionSets"] = [];
  for (const permissionSetArn of permissionSetArns) {
    const response = await withRetry(() =>
      client.send(
        new DescribePermissionSetCommand({
          InstanceArn: instanceArn,
          PermissionSetArn: permissionSetArn,
        }),
      ),
    );
    const permissionSet = response.PermissionSet;
    if (!permissionSet?.PermissionSetArn || !permissionSet.Name) {
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

async function listAccountAssignments(
  client: SSOAdminClient,
  instanceArn: string,
  permissionSets: StateFile["identityCenter"]["permissionSets"],
): Promise<AccountAssignmentState[]> {
  const assignments: AccountAssignmentState[] = [];
  for (const permissionSet of permissionSets) {
    const accountIds = await listAccountsForPermissionSet(
      client,
      instanceArn,
      permissionSet.permissionSetArn,
    );
    for (const accountId of accountIds) {
      let nextToken: string | undefined;
      do {
        const response = await withRetry(() =>
          client.send(
            new ListAccountAssignmentsCommand({
              InstanceArn: instanceArn,
              AccountId: accountId,
              PermissionSetArn: permissionSet.permissionSetArn,
              NextToken: nextToken,
            }),
          ),
        );
        for (const assignment of response.AccountAssignments ?? []) {
          if (
            !assignment.AccountId ||
            !assignment.PermissionSetArn ||
            !assignment.PrincipalId ||
            !assignment.PrincipalType
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
      } while (nextToken);
    }
  }
  return assignments;
}

async function listAccountsForPermissionSet(
  client: SSOAdminClient,
  instanceArn: string,
  permissionSetArn: string,
): Promise<string[]> {
  const accountIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await withRetry(() =>
      client.send(
        new ListAccountsForProvisionedPermissionSetCommand({
          InstanceArn: instanceArn,
          PermissionSetArn: permissionSetArn,
          NextToken: nextToken,
        }),
      ),
    );
    accountIds.push(...(response.AccountIds ?? []));
    nextToken = response.NextToken;
  } while (nextToken);
  return accountIds;
}
