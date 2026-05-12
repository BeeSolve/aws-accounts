import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CreateGroupMembershipCommand,
  CreateGroupCommand,
  CreateUserCommand,
  DeleteGroupCommand,
  DeleteGroupMembershipCommand,
  DeleteUserCommand,
  GetGroupMembershipIdCommand,
  type IdentitystoreClient,
} from "@aws-sdk/client-identitystore";
import {
  AttachCustomerManagedPolicyReferenceToPermissionSetCommand,
  AttachManagedPolicyToPermissionSetCommand,
  CreateAccountAssignmentCommand,
  CreatePermissionSetCommand,
  DeleteAccountAssignmentCommand,
  DeleteInlinePolicyFromPermissionSetCommand,
  DeletePermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  DescribePermissionSetProvisioningStatusCommand,
  DetachCustomerManagedPolicyReferenceFromPermissionSetCommand,
  DetachManagedPolicyFromPermissionSetCommand,
  ProvisionPermissionSetCommand,
  PutInlinePolicyToPermissionSetCommand,
  type SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import {
  CreateOrganizationalUnitCommand,
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  MoveAccountCommand,
  DeleteOrganizationalUnitCommand,
  UpdateOrganizationalUnitCommand,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  loadAwsConfigModelFromTsFile,
  regenerateAwsConfigTypes,
  writeAwsConfigFromState,
} from "../awsConfig.js";
import { createTestWorkspace } from "../helpers.test.js";
import { noopLogger } from "../logger.js";
import { runApplyCommand } from "./apply.js";

test("runApplyCommand refuses destructive unsupported diffs regardless of flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error("Expected Pending OU.");
        }
        pending.accounts = [];
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: true,
          planConfirmation: async () => true,
        }),
      /destructive unsupported diffs/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses destructive unsupported diffs before createOu execution", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.organizationalUnits.push({
          name: "Platform",
          parentName: "Engineering",
          accounts: [],
        });
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        if (pending == null) {
          throw new Error("Expected Pending OU.");
        }
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );
      },
    });

    let createOuCalls = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            onCreateOu: async () => {
              createOuCalls += 1;
            },
          }),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: true,
          planConfirmation: async () => true,
        }),
      /destructive unsupported diffs/,
    );
    assert.equal(createOuCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses non-destructive unsupported diffs without flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU.");
        }
        engineering.parentName = "Pending";
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /Re-run with --ignore-unsupported/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand proceeds with ignoreUnsupported for supported operations", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.parentName = "Pending";
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    const seenMoveInputs: Array<{
      AccountId?: string;
      SourceParentId?: string;
      DestinationParentId?: string;
    }> = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onMoveAccount: async (input) => {
          seenMoveInputs.push(input);
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: true,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    assert.equal(seenMoveInputs.length, 2);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand returns cancelled when confirmation is rejected", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    let moveCalls = 0;
    const beforeState = await readFile(paths.statePath, "utf8");
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onMoveAccount: async () => {
          moveCalls += 1;
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => false,
    });
    const afterState = await readFile(paths.statePath, "utf8");
    assert.equal(result.status, "cancelled");
    assert.equal(moveCalls, 0);
    assert.equal(afterState, beforeState);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies one move and writes next state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...pending.accounts];
        pending.accounts = [];
      },
    });

    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: { accounts: Array<{ name: string; parentId: string }> };
    };
    const appAccount = persisted.organization.accounts.find(
      (account) => account.name === "AppAccount",
    );
    assert.equal(appAccount?.parentId, "ou-engineering");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies createAccount using shared helper and persists real account id", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU.");
        }
        engineering.accounts = [
          ...engineering.accounts,
          { name: "BrandNew", email: "brandnew@example.com" },
        ];
      },
    });

    let movedToTargetOu = false;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        createAccountResponse: {
          CreateAccountStatus: {
            Id: "car-123",
          },
        },
        describeStatuses: [
          {
            CreateAccountStatus: {
              Id: "car-123",
              State: "SUCCEEDED",
              AccountId: "555555555555",
            },
          },
        ],
        listAccountsPages: [
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
        onMoveAccount: async (input) => {
          assert.equal(input.AccountId, "555555555555");
          assert.equal(input.SourceParentId, "r-root");
          assert.equal(input.DestinationParentId, "ou-engineering");
          movedToTargetOu = true;
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(movedToTargetOu, true);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        accounts: Array<{
          id: string;
          name: string;
          parentId: string;
        }>;
      };
    };
    const brandNew = persisted.organization.accounts.find(
      (account) => account.name === "BrandNew",
    );
    assert.equal(brandNew?.id, "555555555555");
    assert.equal(brandNew?.parentId, "ou-engineering");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies createOu and persists created OU with AWS id", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.organizationalUnits.push({
          name: "Platform",
          parentName: "Engineering",
          accounts: [],
        });
      },
    });

    let createOuCalls = 0;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        createOuResponse: {
          OrganizationalUnit: {
            Id: "ou-platform",
            Arn: "arn:aws:organizations:::ou/platform",
            Name: "Platform",
          },
        },
        onCreateOu: async (input) => {
          createOuCalls += 1;
          assert.equal(input.ParentId, "ou-engineering");
          assert.equal(input.Name, "Platform");
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(createOuCalls, 1);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{
          id: string;
          parentId: string;
          name: string;
        }>;
      };
    };
    const createdOu = persisted.organization.organizationalUnits.find(
      (organizationalUnit) => organizationalUnit.name === "Platform",
    );
    assert.equal(createdOu?.id, "ou-platform");
    assert.equal(createdOu?.parentId, "ou-engineering");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies renameOu and persists renamed OU in state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU.");
        }
        engineering.name = "CoreEngineering";
      },
    });

    let renameCalls = 0;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onRenameOu: async (input) => {
          renameCalls += 1;
          assert.equal(input.OrganizationalUnitId, "ou-engineering");
          assert.equal(input.Name, "CoreEngineering");
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });
    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(renameCalls, 1);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{
          id: string;
          name: string;
        }>;
      };
    };
    const renamedOu = persisted.organization.organizationalUnits.find(
      (organizationalUnit) => organizationalUnit.id === "ou-engineering",
    );
    assert.equal(renamedOu?.name, "CoreEngineering");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses destructive deleteOu operations without flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
          (organizationalUnit) => organizationalUnit.name !== "Engineering",
        );
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /--allow-destructive/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand passes destructive warning into confirmation lines", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
          (organizationalUnit) => organizationalUnit.name !== "Engineering",
        );
      },
    });

    let confirmationProps:
      | { planLines: string[]; hasDestructiveChanges: boolean }
      | undefined;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      allowDestructive: true,
      ignoreUnsupported: false,
      planConfirmation: async (props) => {
        confirmationProps = props;
        return false;
      },
    });

    assert.equal(result.status, "cancelled");
    assert.equal(confirmationProps?.hasDestructiveChanges, true);
    assert.ok(
      confirmationProps?.planLines.some((line) =>
        line.includes("WARNING: this apply includes destructive operations."),
      ) ?? false,
    );
    assert.ok(
      confirmationProps?.planLines.some((line) =>
        line.includes('[destructive] delete OU "Engineering" from root'),
      ) ?? false,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses Pending OU deletion and explains it must be manual", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [...engineering.accounts, ...pending.accounts];
        config.organizationalUnits = config.organizationalUnits.filter(
          (organizationalUnit) => organizationalUnit.name !== "Pending",
        );
      },
    });

    let deleteCalls = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            onDeleteOu: async () => {
              deleteCalls += 1;
            },
          }),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          allowDestructive: true,
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /delete it manually in AWS/,
    );
    assert.equal(deleteCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand deletes empty leaf OU with allowDestructive and persists state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
          (organizationalUnit) => organizationalUnit.name !== "Engineering",
        );
      },
    });

    let deletedOuId: string | undefined;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onDeleteOu: async (input) => {
          deletedOuId = input.OrganizationalUnitId;
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      allowDestructive: true,
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(deletedOuId, "ou-engineering");
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{ id: string; name: string }>;
      };
    };
    assert.equal(
      persisted.organization.organizationalUnits.some(
        (organizationalUnit) => organizationalUnit.id === "ou-engineering",
      ),
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand moves the last account out and deletes the OU in the same batch", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    const rawState = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{
          id: string;
          parentId: string;
          arn: string;
          name: string;
        }>;
        accounts: Array<{
          id: string;
          name: string;
          parentId: string;
        }>;
      };
    };
    rawState.organization.organizationalUnits.push({
      id: "ou-legacy",
      parentId: "r-root",
      arn: "arn:aws:organizations:::ou/legacy",
      name: "Legacy",
    });
    const appAccount = rawState.organization.accounts.find(
      (account) => account.name === "AppAccount",
    );
    if (appAccount == null) {
      throw new Error("Expected AppAccount.");
    }
    appAccount.parentId = "ou-legacy";
    await writeFile(
      paths.statePath,
      `${JSON.stringify(rawState, null, 2)}\n`,
      "utf8",
    );
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
        const legacy = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Legacy",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (legacy == null || engineering == null) {
          throw new Error("Expected Legacy and Engineering OUs.");
        }
        engineering.accounts = [...engineering.accounts, ...legacy.accounts];
        config.organizationalUnits = config.organizationalUnits.filter(
          (organizationalUnit) => organizationalUnit.name !== "Legacy",
        );
      },
    });

    const callOrder: string[] = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onMoveAccount: async (input) => {
          callOrder.push(`move:${input.AccountId}`);
        },
        onDeleteOu: async (input) => {
          callOrder.push(`delete:${input.OrganizationalUnitId}`);
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      allowDestructive: true,
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    assert.deepEqual(callOrder, ["move:111111111111", "delete:ou-legacy"]);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{ id: string }>;
        accounts: Array<{ id: string; parentId: string }>;
      };
    };
    assert.equal(
      persisted.organization.organizationalUnits.some(
        (organizationalUnit) => organizationalUnit.id === "ou-legacy",
      ),
      false,
    );
    assert.equal(
      persisted.organization.accounts.find(
        (account) => account.id === "111111111111",
      )?.parentId,
      "ou-engineering",
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand deletes nested OUs deepest first", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    const rawState = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{
          id: string;
          parentId: string;
          arn: string;
          name: string;
        }>;
      };
    };
    rawState.organization.organizationalUnits.push({
      id: "ou-parent",
      parentId: "r-root",
      arn: "arn:aws:organizations:::ou/parent",
      name: "Parent",
    });
    rawState.organization.organizationalUnits.push({
      id: "ou-child",
      parentId: "ou-parent",
      arn: "arn:aws:organizations:::ou/child",
      name: "Child",
    });
    await writeFile(
      paths.statePath,
      `${JSON.stringify(rawState, null, 2)}\n`,
      "utf8",
    );
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
          (organizationalUnit) =>
            organizationalUnit.name !== "Parent" &&
            organizationalUnit.name !== "Child",
        );
      },
    });

    const callOrder: string[] = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        onDeleteOu: async (input) => {
          callOrder.push(`delete:${input.OrganizationalUnitId}`);
        },
      }),
      ssoAdminClient: createSsoAdminClientMock({}),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      allowDestructive: true,
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 2);
    assert.deepEqual(callOrder, ["delete:ou-child", "delete:ou-parent"]);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{ id: string }>;
      };
    };
    assert.equal(
      persisted.organization.organizationalUnits.some(
        (organizationalUnit) =>
          organizationalUnit.id === "ou-child" ||
          organizationalUnit.id === "ou-parent",
      ),
      false,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses deleteOu when live AWS still has child accounts", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
          (organizationalUnit) => organizationalUnit.name !== "Engineering",
        );
      },
    });

    let deleteCalls = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            listAccountsForParentPages: [
              {
                Accounts: [
                  {
                    Id: "333333333333",
                    Name: "StrayAccount",
                  },
                ],
              },
            ],
            onDeleteOu: async () => {
              deleteCalls += 1;
            },
          }),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          allowDestructive: true,
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /live AWS preflight failed \[account-present\]: account "StrayAccount" \(333333333333\) is still attached/,
    );
    assert.equal(deleteCalls, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand persists partial state on operation failure", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (pending == null || engineering == null) {
          throw new Error("Expected Pending and Engineering OUs.");
        }
        engineering.accounts = [
          ...engineering.accounts,
          ...pending.accounts.filter(
            (account) => account.name === "AppAccount",
          ),
        ];
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );

        const graveyard = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Graveyard",
        );
        if (graveyard == null) {
          throw new Error("Expected Graveyard OU.");
        }
        graveyard.accounts = [
          ...graveyard.accounts,
          ...pending.accounts.filter(
            (account) => account.name === "DataAccount",
          ),
        ];
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "DataAccount",
        );
      },
    });

    let moveCallCount = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            onMoveAccount: async () => {
              moveCallCount += 1;
              if (moveCallCount === 2) {
                throw new Error("synthetic move failure");
              }
            },
          }),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /Run 'npm run cli -- scan' to verify, then re-run apply/,
    );
    assert.equal(moveCallCount, 2);
    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: { accounts: Array<{ name: string; parentId: string }> };
    };
    const appAccount = persisted.organization.accounts.find(
      (account) => account.name === "AppAccount",
    );
    const dataAccount = persisted.organization.accounts.find(
      (account) => account.name === "DataAccount",
    );
    assert.equal(appAccount?.parentId, "ou-engineering");
    assert.equal(dataAccount?.parentId, "ou-pending");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand persists mixed successful operations before later failure", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.organizationalUnits.push({
          name: "Platform",
          parentName: "Engineering",
          accounts: [],
        });

        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        const pending = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Pending",
        );
        const graveyard = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Graveyard",
        );
        if (engineering == null || pending == null || graveyard == null) {
          throw new Error("Expected Engineering, Pending, and Graveyard OUs.");
        }

        engineering.accounts = [
          ...engineering.accounts,
          { name: "BrandNew", email: "brandnew@example.com" },
        ];
        graveyard.accounts = [
          ...graveyard.accounts,
          ...pending.accounts.filter(
            (account) => account.name === "AppAccount",
          ),
        ];
        pending.accounts = pending.accounts.filter(
          (account) => account.name !== "AppAccount",
        );
      },
    });

    let moveCallCount = 0;
    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({
            createAccountResponse: {
              CreateAccountStatus: {
                Id: "car-123",
              },
            },
            describeStatuses: [
              {
                CreateAccountStatus: {
                  Id: "car-123",
                  State: "SUCCEEDED",
                  AccountId: "555555555555",
                },
              },
            ],
            listAccountsPages: [
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
            createOuResponse: {
              OrganizationalUnit: {
                Id: "ou-platform",
                Arn: "arn:aws:organizations:::ou/platform",
                Name: "Platform",
              },
            },
            onMoveAccount: async (input) => {
              moveCallCount += 1;
              if (input.AccountId === "111111111111") {
                throw new Error("synthetic mixed failure");
              }
            },
          }),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /synthetic mixed failure/,
    );
    assert.equal(moveCallCount, 2);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        organizationalUnits: Array<{
          id: string;
          name: string;
          parentId: string;
        }>;
        accounts: Array<{
          id: string;
          name: string;
          parentId: string;
        }>;
      };
    };

    const createdOu = persisted.organization.organizationalUnits.find(
      (organizationalUnit) => organizationalUnit.id === "ou-platform",
    );
    const createdAccount = persisted.organization.accounts.find(
      (account) => account.id === "555555555555",
    );
    const appAccount = persisted.organization.accounts.find(
      (account) => account.id === "111111111111",
    );

    assert.equal(createdOu?.name, "Platform");
    assert.equal(createdOu?.parentId, "ou-engineering");
    assert.equal(createdAccount?.name, "BrandNew");
    assert.equal(createdAccount?.parentId, "ou-engineering");
    assert.equal(appAccount?.parentId, "ou-pending");
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies IdC entity creation and persists state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          email: "bob@example.com",
        });
        config.groups.push({
          displayName: "Operators",
          members: [],
        });
        config.permissionSets.push({
          name: "ReadOnly",
          description: "Read only",
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        });
      },
    });
    await regenerateAwsConfigTypes({
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        const operators = config.groups.find(
          (group) => group.displayName === "Operators",
        );
        if (operators == null) {
          throw new Error('Expected "Operators" group.');
        }
        operators.members = ["bob"];
      },
    });

    let sawCreateUser = false;
    let sawCreateGroup = false;
    let sawCreateGroupMembership = false;
    let sawCreatePermissionSet = false;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({
        onCreatePermissionSet: async (input) => {
          sawCreatePermissionSet = true;
          assert.equal(input.InstanceArn, "arn:aws:sso:::instance/ssoins-123");
          assert.equal(input.Name, "ReadOnly");
          assert.equal(input.Description, "Read only");
        },
        createPermissionSetResponse: {
          PermissionSet: {
            PermissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-2",
            Name: "ReadOnly",
            Description: "Read only",
          },
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({
        onCreateUser: async (input) => {
          sawCreateUser = true;
          assert.equal(input.IdentityStoreId, "d-123");
          assert.equal(input.UserName, "bob");
          assert.equal(input.DisplayName, "Bob");
          assert.deepEqual(input.Name, {
            Formatted: "Bob",
            GivenName: "Bob",
            FamilyName: "Bob",
          });
          assert.equal(input.Emails?.[0]?.Value, "bob@example.com");
        },
        onCreateGroup: async (input) => {
          sawCreateGroup = true;
          assert.equal(input.IdentityStoreId, "d-123");
          assert.equal(input.DisplayName, "Operators");
        },
        onCreateGroupMembership: async (input) => {
          sawCreateGroupMembership = true;
          assert.equal(input.IdentityStoreId, "d-123");
          assert.equal(input.GroupId, "g-ops");
          assert.equal(input.MemberId?.UserId, "u-bob");
        },
        createUserResponse: {
          UserId: "u-bob",
          IdentityStoreId: "d-123",
        },
        createGroupResponse: {
          GroupId: "g-ops",
        },
        createGroupMembershipResponse: {
          MembershipId: "gm-bob",
        },
      }),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 4);
    assert.equal(sawCreateUser, true);
    assert.equal(sawCreateGroup, true);
    assert.equal(sawCreateGroupMembership, true);
    assert.equal(sawCreatePermissionSet, true);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        users: Array<{ userId: string; userName: string }>;
        groups: Array<{ groupId: string; displayName: string }>;
        groupMemberships: Array<{
          membershipId: string;
          groupId: string;
          userId: string;
        }>;
        permissionSets: Array<{ permissionSetArn: string; name: string }>;
      };
    };
    assert.equal(
      persisted.identityCenter.users.some(
        (user) => user.userId === "u-bob" && user.userName === "bob",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.groups.some(
        (group) =>
          group.groupId === "g-ops" && group.displayName === "Operators",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.groupMemberships.some(
        (groupMembership) =>
          groupMembership.membershipId === "gm-bob" &&
          groupMembership.groupId === "g-ops" &&
          groupMembership.userId === "u-bob",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.permissionSets.some(
        (permissionSet) =>
          permissionSet.permissionSetArn.endsWith("/ps-2") &&
          permissionSet.name === "ReadOnly",
      ),
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand omits empty permission set description on create", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.permissionSets.push({
          name: "EmptyDescriptionSet",
          description: "",
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        });
      },
    });

    let sawCreatePermissionSet = false;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({
        onCreatePermissionSet: async (input) => {
          sawCreatePermissionSet = true;
          assert.equal(input.Name, "EmptyDescriptionSet");
          assert.equal(input.Description, undefined);
        },
        createPermissionSetResponse: {
          PermissionSet: {
            PermissionSetArn:
              "arn:aws:sso:::permissionSet/ssoins-123/ps-empty-description",
            Name: "EmptyDescriptionSet",
            Description: undefined,
          },
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(sawCreatePermissionSet, true);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        permissionSets: Array<{
          permissionSetArn: string;
          name: string;
          description: string;
        }>;
      };
    };
    assert.equal(
      persisted.identityCenter.permissionSets.some(
        (permissionSet) =>
          permissionSet.permissionSetArn.endsWith("/ps-empty-description") &&
          permissionSet.name === "EmptyDescriptionSet" &&
          permissionSet.description === "",
      ),
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies permission set policy updates and provisioning", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    const rawState = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        permissionSets: Array<{
          permissionSetArn: string;
          name: string;
          description: string;
          inlinePolicy: string | null;
          awsManagedPolicies: string[];
          customerManagedPolicies: Array<{ name: string; path: string }>;
        }>;
        accountAssignments: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: "GROUP" | "USER";
        }>;
      };
    };
    rawState.identityCenter.permissionSets[0] = {
      ...rawState.identityCenter.permissionSets[0],
      inlinePolicy:
        '{"Statement":[{"Action":["s3:GetObject"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
      awsManagedPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      customerManagedPolicies: [
        {
          name: "SupportReadOnly",
          path: "/beesolve/",
        },
      ],
    };
    rawState.identityCenter.accountAssignments.push({
      accountId: "111111111111",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      principalId: "g-123",
      principalType: "GROUP",
    });
    await writeFile(paths.statePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");
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
        const adminAccess = config.permissionSets.find(
          (permissionSet) => permissionSet.name === "AdminAccess",
        );
        if (adminAccess == null) {
          throw new Error('Expected "AdminAccess" permission set.');
        }
        adminAccess.inlinePolicy = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ec2:Describe*"],
              Resource: "*",
            },
          ],
        };
        adminAccess.awsManagedPolicies = [
          "arn:aws:iam::aws:policy/ViewOnlyAccess",
        ];
        adminAccess.customerManagedPolicies = [
          {
            name: "SupportReadWrite",
            path: "/beesolve/",
          },
        ];
      },
    });

    const seenCalls: string[] = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({
        onPutInlinePolicy: async (input) => {
          seenCalls.push("put-inline");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          );
        },
        onAttachManagedPolicy: async (input) => {
          seenCalls.push("attach-managed");
          assert.equal(
            input.ManagedPolicyArn,
            "arn:aws:iam::aws:policy/ViewOnlyAccess",
          );
        },
        onDetachManagedPolicy: async (input) => {
          seenCalls.push("detach-managed");
          assert.equal(
            input.ManagedPolicyArn,
            "arn:aws:iam::aws:policy/ReadOnlyAccess",
          );
        },
        onAttachCustomerManagedPolicyReference: async (input) => {
          seenCalls.push("attach-customer");
          assert.deepEqual(input.CustomerManagedPolicyReference, {
            Name: "SupportReadWrite",
            Path: "/beesolve/",
          });
        },
        onDetachCustomerManagedPolicyReference: async (input) => {
          seenCalls.push("detach-customer");
          assert.deepEqual(input.CustomerManagedPolicyReference, {
            Name: "SupportReadOnly",
            Path: "/beesolve/",
          });
        },
        onProvisionPermissionSet: async (input) => {
          seenCalls.push("provision");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          );
          assert.equal(input.TargetType, "ALL_PROVISIONED_ACCOUNTS");
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 6);
    assert.deepEqual(seenCalls, [
      "put-inline",
      "attach-managed",
      "detach-managed",
      "attach-customer",
      "detach-customer",
      "provision",
    ]);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        permissionSets: Array<{
          permissionSetArn: string;
          name: string;
          inlinePolicy: string | null;
          awsManagedPolicies: string[];
          customerManagedPolicies: Array<{ name: string; path: string }>;
        }>;
      };
    };
    const adminAccess = persisted.identityCenter.permissionSets.find(
      (permissionSet) => permissionSet.name === "AdminAccess",
    );
    assert.equal(
      adminAccess?.inlinePolicy,
      '{"Statement":[{"Action":["ec2:Describe*"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
    );
    assert.deepEqual(adminAccess?.awsManagedPolicies, [
      "arn:aws:iam::aws:policy/ViewOnlyAccess",
    ]);
    assert.deepEqual(adminAccess?.customerManagedPolicies, [
      {
        name: "SupportReadWrite",
        path: "/beesolve/",
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand resolves mixed dependency batches from working state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        const engineering = config.organizationalUnits.find(
          (organizationalUnit) => organizationalUnit.name === "Engineering",
        );
        if (engineering == null) {
          throw new Error("Expected Engineering OU.");
        }
        engineering.accounts = [
          ...engineering.accounts,
          { name: "BrandNew", email: "brandnew@example.com" },
        ];
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          email: "bob@example.com",
        });
        config.permissionSets.push({
          name: "ReadOnly",
          description: "Read only",
          awsManagedPolicies: [],
          customerManagedPolicies: [],
        });
      },
    });
    await regenerateAwsConfigTypes({
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        config.assignments.push({
          permissionSet: "ReadOnly",
          user: "bob",
          accounts: ["BrandNew"],
        });
      },
    });

    let sawGrant = false;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({
        createAccountResponse: {
          CreateAccountStatus: {
            Id: "car-123",
          },
        },
        describeStatuses: [
          {
            CreateAccountStatus: {
              Id: "car-123",
              State: "SUCCEEDED",
              AccountId: "555555555555",
            },
          },
        ],
        listAccountsPages: [
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
      }),
      ssoAdminClient: createSsoAdminClientMock({
        createPermissionSetResponse: {
          PermissionSet: {
            PermissionSetArn:
              "arn:aws:sso:::permissionSet/ssoins-123/ps-readonly",
            Name: "ReadOnly",
            Description: "Read only",
          },
        },
        onCreateAccountAssignment: async (input) => {
          sawGrant = true;
          assert.equal(input.TargetId, "555555555555");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-readonly",
          );
          assert.equal(input.PrincipalType, "USER");
          assert.equal(input.PrincipalId, "u-bob");
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({
        createUserResponse: {
          UserId: "u-bob",
          IdentityStoreId: "d-123",
        },
      }),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 4);
    assert.equal(sawGrant, true);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      organization: {
        accounts: Array<{ id: string; name: string }>;
      };
      identityCenter: {
        users: Array<{ userId: string; userName: string }>;
        permissionSets: Array<{ permissionSetArn: string; name: string }>;
        accountAssignments: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: string;
        }>;
      };
    };
    assert.equal(
      persisted.organization.accounts.some(
        (account) =>
          account.id === "555555555555" && account.name === "BrandNew",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.users.some(
        (user) => user.userId === "u-bob" && user.userName === "bob",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.permissionSets.some(
        (permissionSet) =>
          permissionSet.permissionSetArn.endsWith("/ps-readonly") &&
          permissionSet.name === "ReadOnly",
      ),
      true,
    );
    assert.equal(
      persisted.identityCenter.accountAssignments.some(
        (accountAssignment) =>
          accountAssignment.accountId === "555555555555" &&
          accountAssignment.permissionSetArn.endsWith("/ps-readonly") &&
          accountAssignment.principalId === "u-bob" &&
          accountAssignment.principalType === "USER",
      ),
      true,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand revokes IdC assignments and persists state", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    const rawState = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        accountAssignments: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: "GROUP" | "USER";
        }>;
        accessRoles: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: "GROUP" | "USER";
          roleName: string;
        }>;
      };
    };
    rawState.identityCenter.accountAssignments.push({
      accountId: "111111111111",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      principalId: "g-123",
      principalType: "GROUP",
    });
    rawState.identityCenter.accessRoles.push({
      accountId: "111111111111",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      principalId: "g-123",
      principalType: "GROUP",
      roleName: "AWSReservedSSO_ps-1_111111111111",
    });
    await writeFile(
      paths.statePath,
      `${JSON.stringify(rawState, null, 2)}\n`,
      "utf8",
    );
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
        config.assignments = [];
      },
    });

    let sawRevoke = false;
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({
        onDeleteAccountAssignment: async (input) => {
          sawRevoke = true;
          assert.equal(input.TargetId, "111111111111");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          );
          assert.equal(input.PrincipalId, "g-123");
          assert.equal(input.PrincipalType, "GROUP");
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({}),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 1);
    assert.equal(sawRevoke, true);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        accountAssignments: unknown[];
        accessRoles: unknown[];
      };
    };
    assert.equal(persisted.identityCenter.accountAssignments.length, 0);
    assert.equal(persisted.identityCenter.accessRoles.length, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand refuses destructive IdC delete operations without flag", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.users = [];
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          ssoAdminClient: createSsoAdminClientMock({}),
          identityStoreClient: createIdentityStoreClientMock({}),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /--allow-destructive/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand applies IdC entity removals with prerequisite cleanup", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
  try {
    const paths = getFixturePaths({ workspacePath: workspace.workspacePath });
    await writeFixtureFiles({
      statePath: paths.statePath,
      contextPath: paths.contextPath,
    });
    const rawState = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        users: Array<{ userId: string; userName: string }>;
        groups: Array<{ groupId: string; displayName: string }>;
        groupMemberships: Array<{
          membershipId: string;
          groupId: string;
          userId: string;
        }>;
        permissionSets: Array<{ permissionSetArn: string; name: string }>;
        accountAssignments: Array<{
          accountId: string;
          permissionSetArn: string;
          principalId: string;
          principalType: "GROUP" | "USER";
        }>;
      };
    };
    rawState.identityCenter.groupMemberships.push({
      membershipId: "gm-1",
      groupId: "g-123",
      userId: "u-123",
    });
    rawState.identityCenter.accountAssignments.push({
      accountId: "111111111111",
      permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
      principalId: "g-123",
      principalType: "GROUP",
    });
    await writeFile(paths.statePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf8");
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
        config.users = [];
        config.groups = [];
        config.permissionSets = [];
        config.assignments = [];
      },
    });

    const callOrder: string[] = [];
    const result = await runApplyCommand({
      organizationsClient: createOrganizationsClientMock({}),
      ssoAdminClient: createSsoAdminClientMock({
        onDeleteAccountAssignment: async (input) => {
          callOrder.push("delete-assignment");
          assert.equal(input.TargetId, "111111111111");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          );
          assert.equal(input.PrincipalId, "g-123");
          assert.equal(input.PrincipalType, "GROUP");
        },
        onDeletePermissionSet: async (input) => {
          callOrder.push("delete-permission-set");
          assert.equal(
            input.PermissionSetArn,
            "arn:aws:sso:::permissionSet/ssoins-123/ps-1",
          );
        },
      }),
      identityStoreClient: createIdentityStoreClientMock({
        onDeleteGroupMembership: async (input) => {
          callOrder.push("delete-membership");
          assert.equal(input.MembershipId, "gm-1");
        },
        onDeleteUser: async (input) => {
          callOrder.push("delete-user");
          assert.equal(input.UserId, "u-123");
        },
        onDeleteGroup: async (input) => {
          callOrder.push("delete-group");
          assert.equal(input.GroupId, "g-123");
        },
      }),
      logger: noopLogger,
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      statePath: paths.statePath,
      contextPath: paths.contextPath,
      runtime: createApplyRuntime(),
      allowDestructive: true,
      ignoreUnsupported: false,
      planConfirmation: async () => true,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.appliedOperations, 5);
    assert.deepEqual(callOrder, [
      "delete-membership",
      "delete-assignment",
      "delete-user",
      "delete-group",
      "delete-permission-set",
    ]);

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        users: unknown[];
        groups: unknown[];
        groupMemberships: unknown[];
        permissionSets: unknown[];
        accountAssignments: unknown[];
        accessRoles: unknown[];
      };
    };
    assert.equal(persisted.identityCenter.users.length, 0);
    assert.equal(persisted.identityCenter.groups.length, 0);
    assert.equal(persisted.identityCenter.groupMemberships.length, 0);
    assert.equal(persisted.identityCenter.permissionSets.length, 0);
    assert.equal(persisted.identityCenter.accountAssignments.length, 0);
    assert.equal(persisted.identityCenter.accessRoles.length, 0);
  } finally {
    await workspace.cleanup();
  }
});

test("runApplyCommand persists successful IdC operations before later assignment failure", async () => {
  const workspace = await createTestWorkspace({ prefix: "apply-test-" });
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
        config.users.push({
          userName: "bob",
          displayName: "Bob",
          email: "bob@example.com",
        });
      },
    });
    await regenerateAwsConfigTypes({
      configPath: paths.configPath,
      typesPath: paths.typesPath,
      logger: noopLogger,
      overwriteConfirmation: async () => true,
    });
    await updateConfigModel({
      configPath: paths.configPath,
      update: (config) => {
        config.assignments.push({
          permissionSet: "AdminAccess",
          user: "bob",
          accounts: ["AppAccount"],
        });
      },
    });

    await assert.rejects(
      () =>
        runApplyCommand({
          organizationsClient: createOrganizationsClientMock({}),
          ssoAdminClient: createSsoAdminClientMock({
            creationStatuses: [
              {
                AccountAssignmentCreationStatus: {
                  Status: "FAILED",
                  RequestId: "caa-1",
                  FailureReason: "synthetic assignment failure",
                },
              },
            ],
          }),
          identityStoreClient: createIdentityStoreClientMock({
            createUserResponse: {
              UserId: "u-bob",
              IdentityStoreId: "d-123",
            },
          }),
          logger: noopLogger,
          configPath: paths.configPath,
          typesPath: paths.typesPath,
          statePath: paths.statePath,
          contextPath: paths.contextPath,
          runtime: createApplyRuntime(),
          ignoreUnsupported: false,
          planConfirmation: async () => true,
        }),
      /synthetic assignment failure/,
    );

    const persisted = JSON.parse(await readFile(paths.statePath, "utf8")) as {
      identityCenter: {
        users: Array<{ userId: string; userName: string }>;
        accountAssignments: unknown[];
      };
    };
    assert.equal(
      persisted.identityCenter.users.some(
        (user) => user.userId === "u-bob" && user.userName === "bob",
      ),
      true,
    );
    assert.equal(persisted.identityCenter.accountAssignments.length, 0);
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

function createApplyRuntime(): {
  createAccount: { timeoutInMs: number; pollIntervalInMs: number };
  accountAssignment: { timeoutInMs: number; pollIntervalInMs: number };
  permissionSetProvisioning: { timeoutInMs: number; pollIntervalInMs: number };
} {
  return {
    createAccount: {
      timeoutInMs: 5000,
      pollIntervalInMs: 1,
    },
    accountAssignment: {
      timeoutInMs: 5000,
      pollIntervalInMs: 1,
    },
    permissionSetProvisioning: {
      timeoutInMs: 5000,
      pollIntervalInMs: 1,
    },
  };
}

function createOrganizationsClientMock(props: {
  onMoveAccount?: (input: {
    AccountId?: string;
    SourceParentId?: string;
    DestinationParentId?: string;
  }) => Promise<void>;
  onCreateAccount?: (input: {
    AccountName?: string;
    Email?: string;
  }) => Promise<void>;
  onCreateOu?: (input: { ParentId?: string; Name?: string }) => Promise<void>;
  onDeleteOu?: (input: { OrganizationalUnitId?: string }) => Promise<void>;
  onRenameOu?: (input: {
    OrganizationalUnitId?: string;
    Name?: string;
  }) => Promise<void>;
  createAccountResponse?: { CreateAccountStatus?: { Id?: string } };
  createOuResponse?: {
    OrganizationalUnit?: { Id?: string; Arn?: string; Name?: string };
  };
  describeStatuses?: Array<{
    CreateAccountStatus?: {
      Id?: string;
      State?: string;
      AccountId?: string;
      FailureReason?: string;
    };
  }>;
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
  listAccountsForParentPages?: Array<{
    Accounts?: Array<{
      Id?: string;
      Name?: string;
    }>;
    NextToken?: string;
  }>;
  listOrganizationalUnitsForParentPages?: Array<{
    OrganizationalUnits?: Array<{
      Id?: string;
      Arn?: string;
      Name?: string;
    }>;
    NextToken?: string;
  }>;
}): OrganizationsClient {
  const describeStatuses = props.describeStatuses ?? [];
  const listAccountsPages = props.listAccountsPages ?? [{ Accounts: [] }];
  const listAccountsForParentPages = props.listAccountsForParentPages ?? [
    { Accounts: [] },
  ];
  const listOrganizationalUnitsForParentPages =
    props.listOrganizationalUnitsForParentPages ?? [
      { OrganizationalUnits: [] },
    ];
  let describeIndex = 0;
  let listIndex = 0;
  let listAccountsForParentIndex = 0;
  let listOrganizationalUnitsForParentIndex = 0;
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListAccountsCommand) {
        const page =
          listAccountsPages[Math.min(listIndex, listAccountsPages.length - 1)];
        listIndex += 1;
        return page;
      }
      if (command instanceof ListAccountsForParentCommand) {
        const page =
          listAccountsForParentPages[
            Math.min(
              listAccountsForParentIndex,
              listAccountsForParentPages.length - 1,
            )
          ];
        listAccountsForParentIndex += 1;
        return page;
      }
      if (command instanceof ListOrganizationalUnitsForParentCommand) {
        const page =
          listOrganizationalUnitsForParentPages[
            Math.min(
              listOrganizationalUnitsForParentIndex,
              listOrganizationalUnitsForParentPages.length - 1,
            )
          ];
        listOrganizationalUnitsForParentIndex += 1;
        return page;
      }
      if (command instanceof CreateAccountCommand) {
        if (props.onCreateAccount != null) {
          await props.onCreateAccount({
            AccountName: command.input.AccountName,
            Email: command.input.Email,
          });
        }
        return (
          props.createAccountResponse ?? {
            CreateAccountStatus: { Id: "car-1" },
          }
        );
      }
      if (command instanceof CreateOrganizationalUnitCommand) {
        if (props.onCreateOu != null) {
          await props.onCreateOu({
            ParentId: command.input.ParentId,
            Name: command.input.Name,
          });
        }
        return (
          props.createOuResponse ?? {
            OrganizationalUnit: {
              Id: "ou-created",
              Arn: "arn:aws:organizations:::ou/created",
              Name: command.input.Name,
            },
          }
        );
      }
      if (command instanceof UpdateOrganizationalUnitCommand) {
        if (props.onRenameOu != null) {
          await props.onRenameOu({
            OrganizationalUnitId: command.input.OrganizationalUnitId,
            Name: command.input.Name,
          });
        }
        return {};
      }
      if (command instanceof DeleteOrganizationalUnitCommand) {
        if (props.onDeleteOu != null) {
          await props.onDeleteOu({
            OrganizationalUnitId: command.input.OrganizationalUnitId,
          });
        }
        return {};
      }
      if (command instanceof DescribeCreateAccountStatusCommand) {
        const response = describeStatuses[
          Math.min(describeIndex, describeStatuses.length - 1)
        ] ?? {
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
          await props.onMoveAccount(command.input);
        }
        return {};
      }
      throw new Error("Unexpected Organizations command in test.");
    },
  };
  return mock as OrganizationsClient;
}

function createIdentityStoreClientMock(props: {
  onCreateUser?: (input: {
    IdentityStoreId?: string;
    UserName?: string;
    DisplayName?: string;
    Name?: {
      Formatted?: string;
      GivenName?: string;
      FamilyName?: string;
    };
    Emails?: Array<{ Value?: string; Type?: string; Primary?: boolean }>;
  }) => Promise<void>;
  onCreateGroup?: (input: {
    IdentityStoreId?: string;
    DisplayName?: string;
  }) => Promise<void>;
  onCreateGroupMembership?: (input: {
    IdentityStoreId?: string;
    GroupId?: string;
    MemberId?: { UserId?: string };
  }) => Promise<void>;
  onDeleteUser?: (input: {
    IdentityStoreId?: string;
    UserId?: string;
  }) => Promise<void>;
  onDeleteGroup?: (input: {
    IdentityStoreId?: string;
    GroupId?: string;
  }) => Promise<void>;
  onDeleteGroupMembership?: (input: {
    IdentityStoreId?: string;
    MembershipId?: string;
  }) => Promise<void>;
  getGroupMembershipIdResponse?: { MembershipId?: string };
  createUserResponse?: { UserId?: string; IdentityStoreId?: string };
  createGroupResponse?: { GroupId?: string };
  createGroupMembershipResponse?: { MembershipId?: string };
}): IdentitystoreClient {
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof CreateUserCommand) {
        if (props.onCreateUser != null) {
          await props.onCreateUser({
            IdentityStoreId: command.input.IdentityStoreId,
            UserName: command.input.UserName,
            DisplayName: command.input.DisplayName,
            Name:
              command.input.Name != null
                ? {
                    Formatted: command.input.Name.Formatted,
                    GivenName: command.input.Name.GivenName,
                    FamilyName: command.input.Name.FamilyName,
                  }
                : undefined,
            Emails: command.input.Emails?.map((email) => ({
              Value: email.Value,
              Type: email.Type,
              Primary: email.Primary,
            })),
          });
        }
        return (
          props.createUserResponse ?? {
            UserId: "u-created",
            IdentityStoreId: command.input.IdentityStoreId,
          }
        );
      }
      if (command instanceof CreateGroupCommand) {
        if (props.onCreateGroup != null) {
          await props.onCreateGroup({
            IdentityStoreId: command.input.IdentityStoreId,
            DisplayName: command.input.DisplayName,
          });
        }
        return (
          props.createGroupResponse ?? {
            GroupId: "g-created",
          }
        );
      }
      if (command instanceof CreateGroupMembershipCommand) {
        if (props.onCreateGroupMembership != null) {
          await props.onCreateGroupMembership({
            IdentityStoreId: command.input.IdentityStoreId,
            GroupId: command.input.GroupId,
            MemberId:
              command.input.MemberId?.UserId != null
                ? { UserId: command.input.MemberId.UserId }
                : undefined,
          });
        }
        return (
          props.createGroupMembershipResponse ?? { MembershipId: "gm-created" }
        );
      }
      if (command instanceof DeleteUserCommand) {
        if (props.onDeleteUser != null) {
          await props.onDeleteUser({
            IdentityStoreId: command.input.IdentityStoreId,
            UserId: command.input.UserId,
          });
        }
        return {};
      }
      if (command instanceof DeleteGroupCommand) {
        if (props.onDeleteGroup != null) {
          await props.onDeleteGroup({
            IdentityStoreId: command.input.IdentityStoreId,
            GroupId: command.input.GroupId,
          });
        }
        return {};
      }
      if (command instanceof GetGroupMembershipIdCommand) {
        return props.getGroupMembershipIdResponse ?? { MembershipId: "gm-created" };
      }
      if (command instanceof DeleteGroupMembershipCommand) {
        if (props.onDeleteGroupMembership != null) {
          await props.onDeleteGroupMembership({
            IdentityStoreId: command.input.IdentityStoreId,
            MembershipId: command.input.MembershipId,
          });
        }
        return {};
      }
      throw new Error("Unexpected Identity Store command in test.");
    },
  };
  return mock as IdentitystoreClient;
}

function createSsoAdminClientMock(props: {
  onCreatePermissionSet?: (input: {
    InstanceArn?: string;
    Name?: string;
    Description?: string;
  }) => Promise<void>;
  onPutInlinePolicy?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    InlinePolicy?: string;
  }) => Promise<void>;
  onDeleteInlinePolicy?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
  }) => Promise<void>;
  onAttachManagedPolicy?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    ManagedPolicyArn?: string;
  }) => Promise<void>;
  onDetachManagedPolicy?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    ManagedPolicyArn?: string;
  }) => Promise<void>;
  onAttachCustomerManagedPolicyReference?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    CustomerManagedPolicyReference?: { Name?: string; Path?: string };
  }) => Promise<void>;
  onDetachCustomerManagedPolicyReference?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    CustomerManagedPolicyReference?: { Name?: string; Path?: string };
  }) => Promise<void>;
  onProvisionPermissionSet?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
    TargetType?: string;
  }) => Promise<void>;
  onCreateAccountAssignment?: (input: {
    InstanceArn?: string;
    TargetId?: string;
    TargetType?: string;
    PermissionSetArn?: string;
    PrincipalType?: string;
    PrincipalId?: string;
  }) => Promise<void>;
  onDeleteAccountAssignment?: (input: {
    InstanceArn?: string;
    TargetId?: string;
    TargetType?: string;
    PermissionSetArn?: string;
    PrincipalType?: string;
    PrincipalId?: string;
  }) => Promise<void>;
  onDeletePermissionSet?: (input: {
    InstanceArn?: string;
    PermissionSetArn?: string;
  }) => Promise<void>;
  createPermissionSetResponse?: {
    PermissionSet?: {
      PermissionSetArn?: string;
      Name?: string;
      Description?: string;
    };
  };
  provisionPermissionSetResponse?: {
    PermissionSetProvisioningStatus?: { RequestId?: string };
  };
  createAccountAssignmentResponse?: {
    AccountAssignmentCreationStatus?: { RequestId?: string };
  };
  deleteAccountAssignmentResponse?: {
    AccountAssignmentDeletionStatus?: { RequestId?: string };
  };
  creationStatuses?: Array<{
    AccountAssignmentCreationStatus?: {
      Status?: string;
      RequestId?: string;
      FailureReason?: string;
    };
  }>;
  deletionStatuses?: Array<{
    AccountAssignmentDeletionStatus?: {
      Status?: string;
      RequestId?: string;
      FailureReason?: string;
    };
  }>;
  provisioningStatuses?: Array<{
    PermissionSetProvisioningStatus?: {
      Status?: string;
      RequestId?: string;
      FailureReason?: string;
    };
  }>;
}): SSOAdminClient {
  const creationStatuses = props.creationStatuses ?? [];
  const deletionStatuses = props.deletionStatuses ?? [];
  const provisioningStatuses = props.provisioningStatuses ?? [];
  let creationIndex = 0;
  let deletionIndex = 0;
  let provisioningIndex = 0;
  const mock = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof CreatePermissionSetCommand) {
        if (props.onCreatePermissionSet != null) {
          await props.onCreatePermissionSet({
            InstanceArn: command.input.InstanceArn,
            Name: command.input.Name,
            Description: command.input.Description,
          });
        }
        return (
          props.createPermissionSetResponse ?? {
            PermissionSet: {
              PermissionSetArn:
                "arn:aws:sso:::permissionSet/ssoins-123/ps-created",
              Name: command.input.Name,
              Description: command.input.Description,
            },
          }
        );
      }
      if (command instanceof PutInlinePolicyToPermissionSetCommand) {
        if (props.onPutInlinePolicy != null) {
          await props.onPutInlinePolicy({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            InlinePolicy: command.input.InlinePolicy,
          });
        }
        return {};
      }
      if (command instanceof DeleteInlinePolicyFromPermissionSetCommand) {
        if (props.onDeleteInlinePolicy != null) {
          await props.onDeleteInlinePolicy({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
          });
        }
        return {};
      }
      if (command instanceof AttachManagedPolicyToPermissionSetCommand) {
        if (props.onAttachManagedPolicy != null) {
          await props.onAttachManagedPolicy({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            ManagedPolicyArn: command.input.ManagedPolicyArn,
          });
        }
        return {};
      }
      if (command instanceof DetachManagedPolicyFromPermissionSetCommand) {
        if (props.onDetachManagedPolicy != null) {
          await props.onDetachManagedPolicy({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            ManagedPolicyArn: command.input.ManagedPolicyArn,
          });
        }
        return {};
      }
      if (
        command instanceof
        AttachCustomerManagedPolicyReferenceToPermissionSetCommand
      ) {
        if (props.onAttachCustomerManagedPolicyReference != null) {
          await props.onAttachCustomerManagedPolicyReference({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            CustomerManagedPolicyReference:
              command.input.CustomerManagedPolicyReference != null
                ? {
                    Name: command.input.CustomerManagedPolicyReference.Name,
                    Path: command.input.CustomerManagedPolicyReference.Path,
                  }
                : undefined,
          });
        }
        return {};
      }
      if (
        command instanceof
        DetachCustomerManagedPolicyReferenceFromPermissionSetCommand
      ) {
        if (props.onDetachCustomerManagedPolicyReference != null) {
          await props.onDetachCustomerManagedPolicyReference({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            CustomerManagedPolicyReference:
              command.input.CustomerManagedPolicyReference != null
                ? {
                    Name: command.input.CustomerManagedPolicyReference.Name,
                    Path: command.input.CustomerManagedPolicyReference.Path,
                  }
                : undefined,
          });
        }
        return {};
      }
      if (command instanceof ProvisionPermissionSetCommand) {
        if (props.onProvisionPermissionSet != null) {
          await props.onProvisionPermissionSet({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
            TargetType: command.input.TargetType,
          });
        }
        return (
          props.provisionPermissionSetResponse ?? {
            PermissionSetProvisioningStatus: {
              RequestId: "pps-1",
            },
          }
        );
      }
      if (command instanceof CreateAccountAssignmentCommand) {
        if (props.onCreateAccountAssignment != null) {
          await props.onCreateAccountAssignment({
            InstanceArn: command.input.InstanceArn,
            TargetId: command.input.TargetId,
            TargetType: command.input.TargetType,
            PermissionSetArn: command.input.PermissionSetArn,
            PrincipalType: command.input.PrincipalType,
            PrincipalId: command.input.PrincipalId,
          });
        }
        return (
          props.createAccountAssignmentResponse ?? {
            AccountAssignmentCreationStatus: {
              RequestId: "caa-1",
            },
          }
        );
      }
      if (command instanceof DeleteAccountAssignmentCommand) {
        if (props.onDeleteAccountAssignment != null) {
          await props.onDeleteAccountAssignment({
            InstanceArn: command.input.InstanceArn,
            TargetId: command.input.TargetId,
            TargetType: command.input.TargetType,
            PermissionSetArn: command.input.PermissionSetArn,
            PrincipalType: command.input.PrincipalType,
            PrincipalId: command.input.PrincipalId,
          });
        }
        return (
          props.deleteAccountAssignmentResponse ?? {
            AccountAssignmentDeletionStatus: {
              RequestId: "daa-1",
            },
          }
        );
      }
      if (command instanceof DeletePermissionSetCommand) {
        if (props.onDeletePermissionSet != null) {
          await props.onDeletePermissionSet({
            InstanceArn: command.input.InstanceArn,
            PermissionSetArn: command.input.PermissionSetArn,
          });
        }
        return {};
      }
      if (command instanceof DescribeAccountAssignmentCreationStatusCommand) {
        const response = creationStatuses[
          Math.min(creationIndex, creationStatuses.length - 1)
        ] ?? {
          AccountAssignmentCreationStatus: {
            Status: "SUCCEEDED",
            RequestId: command.input.AccountAssignmentCreationRequestId,
          },
        };
        creationIndex += 1;
        return response;
      }
      if (command instanceof DescribeAccountAssignmentDeletionStatusCommand) {
        const response = deletionStatuses[
          Math.min(deletionIndex, deletionStatuses.length - 1)
        ] ?? {
          AccountAssignmentDeletionStatus: {
            Status: "SUCCEEDED",
            RequestId: command.input.AccountAssignmentDeletionRequestId,
          },
        };
        deletionIndex += 1;
        return response;
      }
      if (command instanceof DescribePermissionSetProvisioningStatusCommand) {
        const response = provisioningStatuses[
          Math.min(provisioningIndex, provisioningStatuses.length - 1)
        ] ?? {
          PermissionSetProvisioningStatus: {
            Status: "SUCCEEDED",
            RequestId: command.input.ProvisionPermissionSetRequestId,
          },
        };
        provisioningIndex += 1;
        return response;
      }
      throw new Error("Unexpected SSO Admin command in test.");
    },
  };
  return mock as SSOAdminClient;
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
    permissionSets: Array<{
      name: string;
      description: string;
      inlinePolicy?: Record<string, unknown>;
      awsManagedPolicies: string[];
      customerManagedPolicies: Array<{ name: string; path: string }>;
    }>;
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
    permissionSets: Array<{
      name: string;
      description: string;
      inlinePolicy?: Record<string, unknown>;
      awsManagedPolicies: string[];
      customerManagedPolicies: Array<{ name: string; path: string }>;
    }>;
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
        {
          id: "ou-engineering",
          parentId: "r-root",
          arn: "arn:aws:organizations:::ou/engineering",
          name: "Engineering",
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
        {
          id: "222222222222",
          arn: "arn:aws:organizations:::account/222222222222",
          name: "DataAccount",
          email: "data@example.com",
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
      accountAssignments: [],
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
    writeFile(
      props.contextPath,
      `${JSON.stringify(context, null, 2)}\n`,
      "utf8",
    ),
  ]);
}
