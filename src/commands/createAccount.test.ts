import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  MoveAccountCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  loadAwsConfigModelFromTsFile,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { noopLogger, type Logger } from "../logger.js";
import { runCreateAccountCommand } from "./createAccount.js";

test("runCreateAccountCommand rejects invalid required inputs", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });

    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: " ",
          accountEmail: "test@example.com",
          timeoutInMs: 1000,
          pollIntervalInMs: 100,
        }),
      /non-empty accountName/,
    );
    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "NewAccount",
          accountEmail: " ",
          timeoutInMs: 1000,
          pollIntervalInMs: 100,
        }),
      /non-empty accountEmail/,
    );
    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "NewAccount",
          accountEmail: "new@example.com",
          timeoutInMs: 0,
          pollIntervalInMs: 100,
        }),
      /timeoutInMs > 0/,
    );
    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "NewAccount",
          accountEmail: "new@example.com",
          timeoutInMs: 1000,
          pollIntervalInMs: 0,
        }),
      /pollIntervalInMs > 0/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runCreateAccountCommand fails when Pending OU is missing in config", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        config.organizationalUnits = config.organizationalUnits.filter(
          (organizationalUnit) => organizationalUnit.name !== "Pending",
        );
      },
    });

    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "NewAccount",
          accountEmail: "new@example.com",
          timeoutInMs: 1000,
          pollIntervalInMs: 100,
        }),
      /Could not find "Pending" OU/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runCreateAccountCommand does not mutate files when account already exists in AWS but missing locally", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    const logger = createCollectingLogger();
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error("Expected Pending OU.");
        }
        pending.accounts = [];
      },
    });
    const beforeConfig = await readFile(paths.configPath, "utf8");
    const beforeTypes = await readFile(paths.typesPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");
    let createCalls = 0;
    let moveCalls = 0;

    const result = await runCreateAccountCommand({
      organizationsClient: createOrganizationsClientMock({
        listAccountsPages: [
          {
            Accounts: [
              {
                Id: "444444444444",
                Name: "RecoveredAccount",
                Email: "recovered@example.com",
              },
            ],
          },
        ],
        onCreateAccount: async () => {
          createCalls += 1;
        },
        onMoveAccount: async () => {
          moveCalls += 1;
        },
      }),
      logger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      accountName: "RecoveredAccount",
      accountEmail: "recovered@example.com",
      timeoutInMs: 1000,
      pollIntervalInMs: 10,
    });

    assert.equal(result.status, "alreadyExists");
    assert.equal(result.stateUpdated, false);
    assert.equal(result.configUpdated, false);
    assert.equal(result.typesUpdated, false);
    assert.equal(createCalls, 0);
    assert.equal(moveCalls, 0);
    assert.equal(await readFile(paths.configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(paths.typesPath, "utf8"), beforeTypes);
    assert.equal(await readFile(paths.statePath, "utf8"), beforeState);
    assert.equal(
      logger.logs.some((line) => line.includes("Local config was not changed.")),
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runCreateAccountCommand creates account, waits for success, and updates config/types", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    const logger = createCollectingLogger();
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger,
      overwriteConfirmation: async () => true,
    });

    const beforeState = await readFile(paths.statePath, "utf8");
    let movedToPending = false;
    const result = await runCreateAccountCommand({
      organizationsClient: createOrganizationsClientMock({
        listAccountsPages: [
          { Accounts: [] },
          {
            Accounts: [
              {
                Id: "555555555555",
                Arn: "arn:aws:organizations:::account/555555555555",
                Name: "BrandNew",
                Email: "brandnew@example.com",
                Status: "ACTIVE",
              },
            ],
          },
        ],
        createAccountResponse: {
          CreateAccountStatus: {
            Id: "car-123",
          },
        },
        describeStatuses: [
          {
            CreateAccountStatus: {
              Id: "car-123",
              State: "IN_PROGRESS",
            },
          },
          {
            CreateAccountStatus: {
              Id: "car-123",
              State: "SUCCEEDED",
              AccountId: "555555555555",
            },
          },
        ],
        onMoveAccount: async (input) => {
          assert.equal(input.AccountId, "555555555555");
          assert.equal(input.SourceParentId, "r-root");
          assert.equal(input.DestinationParentId, "ou-pending");
          movedToPending = true;
        },
      }),
      logger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      accountName: "BrandNew",
      accountEmail: "brandnew@example.com",
      timeoutInMs: 5000,
      pollIntervalInMs: 1,
    });

    assert.equal(result.status, "created");
    assert.equal(result.accountId, "555555555555");
    assert.equal(result.stateUpdated, true);
    assert.equal(result.configUpdated, true);
    assert.equal(result.typesUpdated, true);
    assert.equal(movedToPending, true);
    const configRaw = await readFile(paths.configPath, "utf8");
    const typesRaw = await readFile(paths.typesPath, "utf8");
    const stateRaw = await readFile(paths.statePath, "utf8");
    assert.match(configRaw, /\bname: "BrandNew"/);
    assert.match(typesRaw, /BrandNew/);
    assert.notEqual(stateRaw, beforeState);
    assert.match(stateRaw, /"id": "555555555555"/);
    assert.match(stateRaw, /"parentId": "ou-pending"/);
  } finally {
    await workspace.cleanup();
  }
});

test("runCreateAccountCommand throws on terminal failed status and does not mutate files", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    const beforeConfig = await readFile(paths.configPath, "utf8");
    const beforeTypes = await readFile(paths.typesPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");
    let moveCalls = 0;

    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({
            listAccountsPages: [{ Accounts: [] }],
            createAccountResponse: {
              CreateAccountStatus: {
                Id: "car-123",
              },
            },
            describeStatuses: [
              {
                CreateAccountStatus: {
                  Id: "car-123",
                  State: "FAILED",
                  FailureReason: "EMAIL_ALREADY_EXISTS",
                },
              },
            ],
            onMoveAccount: async () => {
              moveCalls += 1;
            },
          }),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "BrandNew",
          accountEmail: "brandnew@example.com",
          timeoutInMs: 5000,
          pollIntervalInMs: 1,
        }),
      /CreateAccount failed: EMAIL_ALREADY_EXISTS/,
    );
    assert.equal(moveCalls, 0);
    assert.equal(await readFile(paths.configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(paths.typesPath, "utf8"), beforeTypes);
    assert.equal(await readFile(paths.statePath, "utf8"), beforeState);
  } finally {
    await workspace.cleanup();
  }
});

test("runCreateAccountCommand times out when status never becomes terminal", async () => {
  const workspace = await createTestWorkspace({ prefix: "create-account-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    await writeAwsConfigFromState({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    const beforeConfig = await readFile(paths.configPath, "utf8");
    const beforeTypes = await readFile(paths.typesPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");
    let moveCalls = 0;

    await assert.rejects(
      () =>
        runCreateAccountCommand({
          organizationsClient: createOrganizationsClientMock({
            listAccountsPages: [{ Accounts: [] }],
            createAccountResponse: {
              CreateAccountStatus: {
                Id: "car-123",
              },
            },
            describeStatuses: [
              {
                CreateAccountStatus: {
                  Id: "car-123",
                  State: "IN_PROGRESS",
                },
              },
            ],
            onMoveAccount: async () => {
              moveCalls += 1;
            },
          }),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          accountName: "BrandNew",
          accountEmail: "brandnew@example.com",
          timeoutInMs: 5,
          pollIntervalInMs: 1,
        }),
      /timed out/,
    );
    assert.equal(moveCalls, 0);
    assert.equal(await readFile(paths.configPath, "utf8"), beforeConfig);
    assert.equal(await readFile(paths.typesPath, "utf8"), beforeTypes);
    assert.equal(await readFile(paths.statePath, "utf8"), beforeState);
  } finally {
    await workspace.cleanup();
  }
});

function getFixturePaths(props: { workspacePath: string }): {
  statePath: string;
  contextPath: string;
  configPath: string;
  typesPath: string;
} {
  return {
    statePath: join(props.workspacePath, "state.json"),
    contextPath: join(props.workspacePath, "aws.context.json"),
    configPath: join(props.workspacePath, "aws.config.ts"),
    typesPath: join(props.workspacePath, "aws.config.types.ts"),
  };
}

function createCollectingLogger(): Logger & { logs: string[] } {
  const logs: string[] = [];
  const write = (...args: any[]): void => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    log: write,
    info: write,
    warn: write,
    error: write,
    debug: write,
    trace: write,
    logs,
  };
}

type OrganizationsMockProps = {
  listAccountsPages?: Array<{
    Accounts?: Array<{
      Id?: string;
      Arn?: string;
      Name?: string;
      Email?: string;
      Status?: string;
    }>;
    NextToken?: string;
  }>;
  createAccountResponse?: { CreateAccountStatus?: { Id?: string } };
  describeStatuses?: Array<{
    CreateAccountStatus?: {
      Id?: string;
      State?: string;
      AccountId?: string;
      FailureReason?: string;
    };
  }>;
  onCreateAccount?: (input: { AccountName?: string; Email?: string }) => Promise<void>;
  onMoveAccount?: (input: {
    AccountId?: string;
    SourceParentId?: string;
    DestinationParentId?: string;
  }) => Promise<void>;
};

function createOrganizationsClientMock(props: OrganizationsMockProps): OrganizationsClient {
  const listAccountsPages = props.listAccountsPages ?? [{ Accounts: [] }];
  const describeStatuses = props.describeStatuses ?? [];
  let listIndex = 0;
  let describeIndex = 0;
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListAccountsCommand) {
        const page =
          listAccountsPages[Math.min(listIndex, listAccountsPages.length - 1)];
        listIndex += 1;
        return page;
      }
      if (command instanceof CreateAccountCommand) {
        if (props.onCreateAccount != null) {
          await props.onCreateAccount({
            AccountName: command.input.AccountName,
            Email: command.input.Email,
          });
        }
        return props.createAccountResponse ?? { CreateAccountStatus: { Id: "car-1" } };
      }
      if (command instanceof DescribeCreateAccountStatusCommand) {
        const response =
          describeStatuses[Math.min(describeIndex, describeStatuses.length - 1)] ??
          {
            CreateAccountStatus: {
              Id: command.input.CreateAccountRequestId,
              State: "IN_PROGRESS",
            },
          };
        describeIndex += 1;
        return response;
      }
      if (command instanceof MoveAccountCommand) {
        if (props.onMoveAccount != null) {
          await props.onMoveAccount({
            AccountId: command.input.AccountId,
            SourceParentId: command.input.SourceParentId,
            DestinationParentId: command.input.DestinationParentId,
          });
        }
        return {};
      }
      throw new Error("Unexpected Organizations command in create-account test.");
    },
  };
  return mock as OrganizationsClient;
}

async function updateConfigModel(props: {
  configPath: string;
  typesPath?: string;
  update: (config: {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{ name: string; email: string }>;
    }>;
    users: Array<{ userName: string; displayName: string; email: string }>;
    groups: Array<{ displayName: string; members: string[] }>;
    permissionSets: Array<{ name: string; description: string }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  }) => void;
}): Promise<void> {
  const typesPath =
    props.typesPath ?? join(dirname(props.configPath), "aws.config.types.ts");
  const parsedConfig = (await loadAwsConfigModelFromTsFile({
    configPath: props.configPath,
    typesPath,
  })) as {
    organizationalUnits: Array<{
      name: string;
      parentName: string | null;
      accounts: Array<{ name: string; email: string }>;
    }>;
    users: Array<{ userName: string; displayName: string; email: string }>;
    groups: Array<{ displayName: string; members: string[] }>;
    permissionSets: Array<{ name: string; description: string }>;
    assignments: Array<{
      permissionSet: string;
      group?: string;
      user?: string;
      accounts: string[];
    }>;
  };
  props.update(parsedConfig);
  const nextConfig = `import * as v from "valibot";
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

const awsConfig: AwsConfig = v.parse(awsConfigSchema, ${JSON.stringify(parsedConfig, null, 2)} satisfies AwsConfig);

export default awsConfig;
`;
  await writeFile(props.configPath, nextConfig, "utf8");
}

async function writeFixtureFiles(props: {
  statePath: string;
  contextPath: string;
}): Promise<void> {
  const state = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        {
          id: "ou-pending",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/pending",
          name: "Pending",
        },
        {
          id: "ou-graveyard",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/graveyard",
          name: "Graveyard",
        },
      ],
      accounts: [
        {
          id: "111111111111",
          arn: "arn:aws:organizations:::account/111111111111",
          name: "AppAccount",
          email: "app@example.com",
          status: "ACTIVE",
          parentId: "ou-pending",
        },
      ],
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [
        {
          userId: "u-123",
          userName: "alice",
          displayName: "Alice",
          email: "alice@example.com",
        },
      ],
      groups: [
        {
          groupId: "g-123",
          displayName: "Admins",
        },
      ],
      groupMemberships: [],
      permissionSets: [
        {
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          name: "AdminAccess",
          description: "Admin",
          inlinePolicy: null,
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        },
      ],
      accountAssignments: [
        {
          accountId: "111111111111",
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          principalId: "g-123",
          principalType: "GROUP",
        },
      ],
      accessRoles: [],
    },
  };
  const context = {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      managementAccountId: "999999999999",
      rootId: "r-root",
      pendingOuId: "ou-pending",
      graveyardOuId: "ou-graveyard",
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
    },
    deployment: {
      profile: "default",
      region: "eu-central-1",
      lambdaArn: "",
      stateBucketName: "",
    },
  };
  await Promise.all([
    writeFile(props.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(props.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8"),
  ]);
}
