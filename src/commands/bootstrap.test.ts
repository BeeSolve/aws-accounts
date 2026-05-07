import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test(
  "runBootstrapCommand creates missing root OUs and writes context file",
  { concurrency: false },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-test-"));
    const previousDirectory = process.cwd();
    process.chdir(directory);
    try {
      const planLinesSeen: string[][] = [];
      const result = await runBootstrapCommand({
        organizationsClient: createOrganizationsClientMock({
          rootId: "r-root",
          initialRootChildren: [],
        }),
        ssoAdminClient: createSsoAdminClientMock(),
        profile: "default",
        region: "eu-central-1",
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

      const raw = await readFile("aws.context.json", "utf8");
      const parsed = JSON.parse(raw) as {
        organization: { pendingOuId: string; graveyardOuId: string };
      };
      assert.equal(parsed.organization.pendingOuId, "ou-pending");
      assert.equal(parsed.organization.graveyardOuId, "ou-graveyard");
    } finally {
      process.chdir(previousDirectory);
    }
  },
);

test(
  "runBootstrapCommand aborts when plan confirmation is rejected",
  { concurrency: false },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bootstrap-test-"));
    const previousDirectory = process.cwd();
    process.chdir(directory);
    try {
      await assert.rejects(
        () =>
          runBootstrapCommand({
            organizationsClient: createOrganizationsClientMock({
              rootId: "r-root",
              initialRootChildren: [],
            }),
            ssoAdminClient: createSsoAdminClientMock(),
            profile: "default",
            region: "eu-central-1",
            planConfirmation: async () => false,
          }),
        /Bootstrap aborted/,
      );
    } finally {
      process.chdir(previousDirectory);
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

function createSsoAdminClientMock(): SSOAdminClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListInstancesCommand) {
        return {
          Instances: [
            {
              InstanceArn: "arn:aws:sso:::instance/ssoins-123",
              IdentityStoreId: "d-1234567890",
            },
          ],
        };
      }
      throw new Error("Unexpected SSO Admin command in test.");
    },
  };
  return mock as SSOAdminClient;
}
