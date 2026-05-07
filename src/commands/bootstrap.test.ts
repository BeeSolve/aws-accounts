import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CreateOrganizationalUnitCommand,
  DescribeOrganizationCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { ListInstancesCommand, type SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { runBootstrapCommand } from "./bootstrap.js";
import { createTestWorkspace } from "../helpers.test.js";

test(
  "runBootstrapCommand creates missing root OUs and writes context file",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      const planLinesSeen: string[][] = [];
      const result = await runBootstrapCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
          initialRootChildren: [],
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        }),
        profile: "default",
        region: "eu-central-1",
        outputPath: outputPath,
        planConfirmation: async (props: { planLines: string[] }) => {
          planLinesSeen.push([...props.planLines]);
          return true;
        },
      });

      assert.equal(result.pendingCreated, true);
      assert.equal(result.graveyardCreated, true);
      assert.equal(result.identityCenterCaptured, true);
      assert.equal(result.pendingOuId, "ou-pending");
      assert.equal(result.graveyardOuId, "ou-graveyard");
      assert.equal(planLinesSeen.length, 1);
      assert.equal(planLinesSeen[0].length, 3);

      const raw = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw) as {
        organization: { pendingOuId: string; graveyardOuId: string };
      };
      assert.equal(parsed.organization.pendingOuId, "ou-pending");
      assert.equal(parsed.organization.graveyardOuId, "ou-graveyard");
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand aborts when plan confirmation is rejected",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      await assert.rejects(
        () =>
          runBootstrapCommand({
            organizationsClient: createOrganizationsClientMock({
              rootId: "r-root",
              initialRootChildren: [],
            }),
            ssoAdminClient: createSsoAdminClientMock({
              instances: [
                {
                  InstanceArn: "arn:aws:sso:::instance/ssoins-123",
                  IdentityStoreId: "d-1234567890",
                },
              ],
            }),
            profile: "default",
            region: "eu-central-1",
            outputPath: outputPath,
            planConfirmation: async () => false,
          }),
        /Bootstrap aborted/,
      );
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand reuses existing Pending and Graveyard OUs",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      let confirmationCalls = 0;
      const result = await runBootstrapCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
          initialRootChildren: [
            {
              id: "ou-pending",
              name: "Pending",
              arn: "arn:aws:organizations:::ou/pending",
            },
            {
              id: "ou-graveyard",
              name: "Graveyard",
              arn: "arn:aws:organizations:::ou/graveyard",
            },
          ],
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        }),
        profile: "default",
        region: "eu-central-1",
        outputPath: outputPath,
        planConfirmation: async () => {
          confirmationCalls += 1;
          return true;
        },
      });

      assert.equal(result.pendingCreated, false);
      assert.equal(result.graveyardCreated, false);
      assert.equal(result.pendingOuId, "ou-pending");
      assert.equal(result.graveyardOuId, "ou-graveyard");
      assert.equal(confirmationCalls, 0);

      const raw = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw) as {
        organization: { pendingOuId: string; graveyardOuId: string };
      };
      assert.equal(parsed.organization.pendingOuId, "ou-pending");
      assert.equal(parsed.organization.graveyardOuId, "ou-graveyard");
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand creates only the missing Graveyard OU when Pending exists",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      const planLinesSeen: string[][] = [];
      const result = await runBootstrapCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
          initialRootChildren: [
            {
              id: "ou-pending",
              name: "Pending",
              arn: "arn:aws:organizations:::ou/pending",
            },
          ],
        }),
        ssoAdminClient: createSsoAdminClientMock({
          instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        }),
        profile: "default",
        region: "eu-central-1",
        outputPath: outputPath,
        planConfirmation: async (props: { planLines: string[] }) => {
          planLinesSeen.push([...props.planLines]);
          return true;
        },
      });

      assert.equal(result.pendingCreated, false);
      assert.equal(result.graveyardCreated, true);
      assert.equal(result.pendingOuId, "ou-pending");
      assert.equal(result.graveyardOuId, "ou-graveyard");
      assert.equal(planLinesSeen.length, 1);
      const planLines = planLinesSeen[0];
      assert.equal(planLines.length, 2);
      assert.equal(planLines.some((line) => line.includes("Graveyard")), true);
      assert.equal(
        planLines.some((line) => line.includes(`Will create OU "Pending"`)),
        false,
      );
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand fails when multiple Pending OUs exist under root",
  async () => {
    await assert.rejects(
      () =>
        runBootstrapCommand({
          organizationsClient: createOrganizationsClientMock({
            rootId: "r-root",
            initialRootChildren: [
              {
                id: "ou-pending-1",
                name: "Pending",
                arn: "arn:aws:organizations:::ou/pending-1",
              },
              {
                id: "ou-pending-2",
                name: "Pending",
                arn: "arn:aws:organizations:::ou/pending-2",
              },
            ],
          }),
          ssoAdminClient: createSsoAdminClientMock({
            instances: [
              {
                InstanceArn: "arn:aws:sso:::instance/ssoins-123",
                IdentityStoreId: "d-1234567890",
              },
            ],
          }),
          profile: "default",
          region: "eu-central-1",
          planConfirmation: async () => true,
        }),
      /Multiple organizational units named "Pending"/,
    );
  },
);

test(
  "runBootstrapCommand fails when aws.context.json disagrees with live AWS",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      const staleContext = {
        version: "1",
        generatedAt: "2026-01-01T00:00:00.000Z",
        organization: {
          managementAccountId: "111111111111",
          rootId: "r-different",
          pendingOuId: "ou-pending-stale",
          graveyardOuId: "ou-graveyard-stale",
        },
        identityCenter: {
          instanceArn: "arn:aws:sso:::instance/ssoins-123",
          identityStoreId: "d-1234567890",
        },
        deployment: {
          profile: "default",
          region: "eu-central-1",
          lambdaArn: "",
          stateBucketName: "",
        },
      };
      await writeFile(
        outputPath,
        `${JSON.stringify(staleContext, null, 2)}\n`,
        "utf8",
      );

      await assert.rejects(
        () =>
          runBootstrapCommand({
            organizationsClient: createOrganizationsClientMock({
              rootId: "r-root",
              initialRootChildren: [
                {
                  id: "ou-pending",
                  name: "Pending",
                  arn: "arn:aws:organizations:::ou/pending",
                },
                {
                  id: "ou-graveyard",
                  name: "Graveyard",
                  arn: "arn:aws:organizations:::ou/graveyard",
                },
              ],
            }),
            ssoAdminClient: createSsoAdminClientMock({
              instances: [
                {
                  InstanceArn: "arn:aws:sso:::instance/ssoins-123",
                  IdentityStoreId: "d-1234567890",
                },
              ],
            }),
            profile: "default",
            region: "eu-central-1",
            outputPath: outputPath,
            planConfirmation: async () => true,
          }),
        /aws\.context\.json conflicts with live AWS resolution/,
      );
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand fails when multiple Identity Center instances exist without --instance-arn",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      await assert.rejects(
        () =>
          runBootstrapCommand({
            organizationsClient: createOrganizationsClientMock({
              rootId: "r-root",
              initialRootChildren: [
                {
                  id: "ou-pending",
                  name: "Pending",
                  arn: "arn:aws:organizations:::ou/pending",
                },
                {
                  id: "ou-graveyard",
                  name: "Graveyard",
                  arn: "arn:aws:organizations:::ou/graveyard",
                },
              ],
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
            profile: "default",
            region: "eu-central-1",
            outputPath: outputPath,
            planConfirmation: async () => true,
          }),
        /Multiple IAM Identity Center instances/,
      );
    } finally {
      await workspace.cleanup();
    }
  },
);

test(
  "runBootstrapCommand selects the requested Identity Center instance when multiple exist",
  async () => {
    const workspace = await createTestWorkspace({ prefix: "bootstrap-test-" });
    try {
      const outputPath = join(workspace.workspacePath, "aws.context.json");
      const result = await runBootstrapCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
          initialRootChildren: [
            {
              id: "ou-pending",
              name: "Pending",
              arn: "arn:aws:organizations:::ou/pending",
            },
            {
              id: "ou-graveyard",
              name: "Graveyard",
              arn: "arn:aws:organizations:::ou/graveyard",
            },
          ],
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
        profile: "default",
        region: "eu-central-1",
        instanceArn: "arn:aws:sso:::instance/ssoins-2",
        outputPath: outputPath,
        planConfirmation: async () => true,
      });

      assert.equal(result.identityCenterCaptured, true);
      const raw = await readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw) as {
        identityCenter: { instanceArn: string; identityStoreId: string };
      };
      assert.equal(
        parsed.identityCenter.instanceArn,
        "arn:aws:sso:::instance/ssoins-2",
      );
      assert.equal(parsed.identityCenter.identityStoreId, "d-2");
    } finally {
      await workspace.cleanup();
    }
  },
);

function createOrganizationsClientMock(props: {
  rootId: string;
  initialRootChildren: Array<{ id: string; name: string; arn: string }>;
}): OrganizationsClient {
  const rootChildren = [...props.initialRootChildren];
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof DescribeOrganizationCommand) {
        return {
          Organization: {
            MasterAccountId: "111111111111",
          },
        };
      }
      if (command instanceof ListRootsCommand) {
        return {
          Roots: [{ Id: props.rootId }],
        };
      }
      if (command instanceof ListOrganizationalUnitsForParentCommand) {
        if (command.input.ParentId !== props.rootId) {
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
        const name = command.input.Name;
        if (name == null) {
          throw new Error("Missing OU name.");
        }
        rootChildren.push({
          id: `ou-${name.toLowerCase()}`,
          name: name,
          arn: `arn:aws:organizations:::ou/${name.toLowerCase()}`,
        });
        return {};
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
        return {
          Instances: props.instances,
        };
      }
      throw new Error("Unexpected SSO Admin command in test.");
    },
  };
  return mock as SSOAdminClient;
}
