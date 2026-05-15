import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ListGroupsCommand,
  ListGroupMembershipsCommand,
  ListUsersCommand,
  type IdentitystoreClient,
} from "@aws-sdk/client-identitystore";
import {
  ListAccountsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  ListTagsForResourceCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListCustomerManagedPolicyReferencesInPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  type SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { runScanCommand } from "./scan.js";
import { createTestWorkspace } from "../helpers.test.js";
import { noopLogger } from "../logger.js";

test(
  "runScanCommand writes state with organization and identity center data",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "scan-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "state.json");
      const result = await runScanCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        }),
        identityStoreClient: createIdentityStoreClientMock(),
        logger: noopLogger,
        outputPath,
      });

      assert.equal(result.outputPath, outputPath);
      assert.equal(result.state.organization.rootId, "r-root");
      assert.equal(result.state.organization.organizationalUnits.length, 1);
      assert.equal(result.state.organization.accounts.length, 1);
      assert.deepEqual(result.state.organization.accounts[0]?.tags, [
        { key: "owner", value: "platform" },
      ]);
      assert.equal(result.state.identityCenter.users.length, 1);
      assert.equal(result.state.identityCenter.groups.length, 1);
      assert.equal(result.state.identityCenter.groupMemberships.length, 1);
      assert.equal(result.state.identityCenter.permissionSets.length, 1);
      assert.equal(result.state.identityCenter.accountAssignments.length, 1);
      assert.equal(result.state.identityCenter.accessRoles.length, 1);
      assert.equal(
        result.state.identityCenter.permissionSets[0]?.inlinePolicy,
        '{"Statement":[{"Action":["s3:GetObject"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
      );
      assert.deepEqual(
        result.state.identityCenter.permissionSets[0]?.awsManagedPolicies,
        ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      );
      assert.deepEqual(
        result.state.identityCenter.permissionSets[0]?.customerManagedPolicies,
        [
          {
            name: "SupportReadOnly",
            path: "/beesolve/",
          },
        ],
      );
      assert.match(
        result.state.identityCenter.accessRoles[0].roleName,
        /^AWSReservedSSO_/,
      );

      const raw = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw) as { organization: { rootId: string } };
      assert.equal(parsed.organization.rootId, "r-root");
    } finally {
      await workspace.cleanup();
    }
  },
);

test("runScanCommand fails when organization root is missing", async () => {
  await assert.rejects(
    () =>
      runScanCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: undefined,
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        }),
        identityStoreClient: createIdentityStoreClientMock(),
        logger: noopLogger,
      }),
    /No organization root found/,
  );
});

test("runScanCommand fails when multiple identity center instances exist without selection", async () => {
  await assert.rejects(
    () =>
      runScanCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-1",
              IdentityStoreId: "d-1",
            },
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-2",
              IdentityStoreId: "d-2",
            },
          ],
        }),
        identityStoreClient: createIdentityStoreClientMock(),
        logger: noopLogger,
      }),
    /Multiple IAM Identity Center instances found/,
  );
});

function createOrganizationsClientMock(props: {
  rootId: string | undefined;
}): OrganizationsClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListRootsCommand) {
        if (props.rootId == null) {
          return { Roots: [] };
        }
        return { Roots: [{ Id: props.rootId }] };
      }
      if (command instanceof ListOrganizationalUnitsForParentCommand) {
        if (command.input.ParentId === props.rootId) {
          return {
            OrganizationalUnits: [
              {
                Id: "ou-pending",
                Arn: "arn:aws:organizations:::ou/pending",
                Name: "Pending",
              },
            ],
          };
        }
        return { OrganizationalUnits: [] };
      }
      if (command instanceof ListAccountsCommand) {
        return {
          Accounts: [
            {
              Id: "111111111111",
              Arn: "arn:aws:organizations:::account/111111111111",
              Name: "Account A",
              Email: "a@example.com",
              Status: "ACTIVE",
            },
          ],
        };
      }
      if (command instanceof ListParentsCommand) {
        return {
          Parents: [{ Id: "ou-pending" }],
        };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return {
          Tags: [
            {
              Key: "owner",
              Value: "platform",
            },
          ],
        };
      }
      throw new Error("Unexpected Organizations command in test.");
    },
  };
  return mock as OrganizationsClient;
}

function createSsoAdminClientMock(props: {
  instances: Array<{ InstanceArn?: string; IdentityStoreId?: string }>;
}): SSOAdminClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListInstancesCommand) {
        return { Instances: props.instances };
      }
      if (command instanceof ListPermissionSetsCommand) {
        return {
          PermissionSets: ["arn:aws:sso:::permissionSet/ssoins-123/ps-abc"],
        };
      }
      if (command instanceof DescribePermissionSetCommand) {
        return {
          PermissionSet: {
            PermissionSetArn: command.input.PermissionSetArn,
            Name: "AdminAccess",
            Description: "Admin access",
          },
        };
      }
      if (command instanceof GetInlinePolicyForPermissionSetCommand) {
        return {
          InlinePolicy:
            '{"Statement":[{"Action":["s3:GetObject"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
        };
      }
      if (command instanceof ListManagedPoliciesInPermissionSetCommand) {
        return {
          AttachedManagedPolicies: [
            {
              Arn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
            },
          ],
        };
      }
      if (
        command instanceof ListCustomerManagedPolicyReferencesInPermissionSetCommand
      ) {
        return {
          CustomerManagedPolicyReferences: [
            {
              Name: "SupportReadOnly",
              Path: "/beesolve/",
            },
          ],
        };
      }
      if (command instanceof ListAccountsForProvisionedPermissionSetCommand) {
        return {
          AccountIds: ["111111111111"],
        };
      }
      if (command instanceof ListAccountAssignmentsCommand) {
        return {
          AccountAssignments: [
            {
              AccountId: "111111111111",
              PermissionSetArn: command.input.PermissionSetArn,
              PrincipalId: "u-123",
              PrincipalType: "USER",
            },
          ],
        };
      }
      throw new Error("Unexpected SSO Admin command in test.");
    },
  };
  return mock as SSOAdminClient;
}

function createIdentityStoreClientMock(): IdentitystoreClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListUsersCommand) {
        return {
          Users: [
            {
              UserId: "u-123",
              UserName: "alice",
              DisplayName: "Alice",
              Emails: [{ Value: "alice@example.com" }],
            },
          ],
        };
      }
      if (command instanceof ListGroupsCommand) {
        return {
          Groups: [
            {
              GroupId: "g-123",
              DisplayName: "Admins",
            },
          ],
        };
      }
      if (command instanceof ListGroupMembershipsCommand) {
        return {
          GroupMemberships: [
            {
              MembershipId: "gm-123",
              GroupId: command.input.GroupId,
              MemberId: {
                UserId: "u-123",
              },
            },
          ],
        };
      }
      throw new Error("Unexpected Identity Store command in test.");
    },
  };
  return mock as IdentitystoreClient;
}
