import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ListGroupsCommand, ListUsersCommand } from "@aws-sdk/client-identitystore";
import {
  CreateOrganizationalUnitCommand,
  DescribeOrganizationCommand,
  ListAccountsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  DescribePermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  type SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import type { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { runInitCommand } from "./init.js";
import { createTestWorkspace } from "../helpers.test.js";

test("runInitCommand writes context/state/config/types in sequence", async () => {
  const workspace = await createTestWorkspace({ prefix: "init-test-" });
  try {
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const statePath = join(workspace.workspacePath, "state.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    const result = await runInitCommand({
      organizationsClient: createOrganizationsClientMock(),
      ssoAdminClient: createSsoAdminClientMock(),
      identityStoreClient: createIdentityStoreClientMock(),
      profile: "default",
      region: "eu-central-1",
      contextPath: contextPath,
      statePath: statePath,
      configPath: configPath,
      typesPath: typesPath,
      planConfirmation: async () => true,
      overwriteConfirmation: async () => true,
    });

    assert.equal(result.contextPath, contextPath);
    assert.equal(result.statePath, statePath);
    assert.equal(result.configPath, configPath);
    assert.equal(result.typesPath, typesPath);
    assert.deepEqual(result.files, [
      { path: configPath, status: "written" },
      { path: typesPath, status: "written" },
    ]);

    const [contextRaw, stateRaw, configRaw, typesRaw] = await Promise.all([
      readFile(contextPath, "utf8"),
      readFile(statePath, "utf8"),
      readFile(configPath, "utf8"),
      readFile(typesPath, "utf8"),
    ]);
    assert.match(contextRaw, /"pendingOuId": "ou-pending"/);
    assert.match(stateRaw, /"rootId": "r-root"/);
    assert.match(configRaw, /const awsConfig:/);
    assert.match(typesRaw, /export const awsConfigSchema/);
  } finally {
    await workspace.cleanup();
  }
});

test("runInitCommand aborts when bootstrap confirmation is rejected", async () => {
  const workspace = await createTestWorkspace({ prefix: "init-test-" });
  try {
    const contextPath = join(workspace.workspacePath, "aws.context.json");
    const statePath = join(workspace.workspacePath, "state.json");
    const configPath = join(workspace.workspacePath, "aws.config.ts");
    const typesPath = join(workspace.workspacePath, "aws.config.types.ts");
    await assert.rejects(
      () =>
        runInitCommand({
          organizationsClient: createOrganizationsClientMock(),
          ssoAdminClient: createSsoAdminClientMock(),
          identityStoreClient: createIdentityStoreClientMock(),
          profile: "default",
          region: "eu-central-1",
          contextPath: contextPath,
          statePath: statePath,
          configPath: configPath,
          typesPath: typesPath,
          planConfirmation: async () => false,
          overwriteConfirmation: async () => true,
        }),
      /Bootstrap aborted/,
    );
  } finally {
    await workspace.cleanup();
  }
});

function createOrganizationsClientMock(): OrganizationsClient {
  const rootId = "r-root";
  const rootChildren: Array<{ id: string; name: string; arn: string }> = [];
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof DescribeOrganizationCommand) {
        return {
          Organization: {
            MasterAccountId: "999999999999",
          },
        };
      }
      if (command instanceof ListRootsCommand) {
        return {
          Roots: [{ Id: rootId }],
        };
      }
      if (command instanceof ListOrganizationalUnitsForParentCommand) {
        if (command.input.ParentId !== rootId) {
          return { OrganizationalUnits: [] };
        }
        return {
          OrganizationalUnits: rootChildren.map((child) => ({
            Id: child.id,
            Name: child.name,
            Arn: child.arn,
          })),
        };
      }
      if (command instanceof CreateOrganizationalUnitCommand) {
        const name = command.input.Name ?? "";
        const id = `ou-${name.toLowerCase()}`;
        rootChildren.push({
          id: id,
          name: name,
          arn: `arn:aws:organizations:::ou/${name.toLowerCase()}`,
        });
        return {};
      }
      if (command instanceof ListAccountsCommand) {
        return {
          Accounts: [
            {
              Id: "111111111111",
              Arn: "arn:aws:organizations:::account/111111111111",
              Name: "AppAccount",
              Email: "app@example.com",
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
      throw new Error("Unexpected Organizations command in init test.");
    },
  };
  return mock as OrganizationsClient;
}

function createSsoAdminClientMock(): SSOAdminClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListInstancesCommand) {
        return {
          Instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-123",
            },
          ],
        };
      }
      if (command instanceof ListPermissionSetsCommand) {
        return {
          PermissionSets: ["arn:aws:sso:::permissionSet/ssoins-123/ps-1"],
        };
      }
      if (command instanceof DescribePermissionSetCommand) {
        return {
          PermissionSet: {
            PermissionSetArn: command.input.PermissionSetArn,
            Name: "AdminAccess",
            Description: "Admin",
          },
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
              PermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
              PrincipalId: "g-123",
              PrincipalType: "GROUP",
            },
          ],
        };
      }
      throw new Error("Unexpected SSO Admin command in init test.");
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
      throw new Error("Unexpected Identity Store command in init test.");
    },
  };
  return mock as IdentitystoreClient;
}
