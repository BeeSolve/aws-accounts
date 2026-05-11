import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkingState,
  materializeWorkingState,
  moveAccountInWorkingState,
  normalizeState,
  renameOrganizationalUnitInWorkingState,
  upsertAccountInWorkingState,
  upsertOrganizationalUnitInWorkingState,
  validateState
} from "./state.js";

test("normalizeState sorts by ids/arns before names", () => {
  const input = {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        { id: "ou-b", parentId: "r-root", arn: "arn:2", name: "Zeta" },
        { id: "ou-a", parentId: "r-root", arn: "arn:1", name: "Alpha" }
      ],
      accounts: [
        { id: "222222222222", arn: "arn:2", name: "B", email: "b@example.com", status: "ACTIVE", parentId: "ou-b" },
        { id: "111111111111", arn: "arn:1", name: "A", email: "a@example.com", status: "ACTIVE", parentId: "ou-a" }
      ]
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [
        { userId: "u-2", userName: "zeta", displayName: "Z", emails: [] },
        { userId: "u-1", userName: "alpha", displayName: "A", emails: [] }
      ],
      groups: [
        { groupId: "g-2", displayName: "B" },
        { groupId: "g-1", displayName: "A" }
      ],
      permissionSets: [
        { permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-2", name: "PS2", description: "" },
        { permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1/ps-1", name: "PS1", description: "" }
      ],
      accountAssignments: [
        { accountId: "222222222222", permissionSetArn: "arn2", principalId: "p2", principalType: "USER" as const },
        { accountId: "111111111111", permissionSetArn: "arn1", principalId: "p1", principalType: "USER" as const }
      ],
      accessRoles: [
        {
          accountId: "222222222222",
          permissionSetArn: "arn2",
          principalId: "p2",
          principalType: "USER" as const,
          roleName: "role2"
        },
        {
          accountId: "111111111111",
          permissionSetArn: "arn1",
          principalId: "p1",
          principalType: "USER" as const,
          roleName: "role1"
        }
      ]
    }
  };

  const normalized = normalizeState(input);
  assert.equal(normalized.organization.organizationalUnits[0].id, "ou-a");
  assert.equal(normalized.organization.accounts[0].id, "111111111111");
  assert.equal(normalized.identityCenter.users[0].userId, "u-1");
  assert.equal(normalized.identityCenter.groups[0].groupId, "g-1");
  assert.equal(normalized.identityCenter.permissionSets[0].permissionSetArn.endsWith("ps-1"), true);
});

test("validateState rejects unknown fields", () => {
  const invalid = {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [],
      accounts: []
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [],
      groups: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: []
    },
    extra: true
  };

  assert.throws(() => validateState(invalid));
});

test("validateState rejects invalid principalType", () => {
  const invalid = {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [],
      accounts: []
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [],
      groups: [],
      permissionSets: [],
      accountAssignments: [
        {
          accountId: "111111111111",
          permissionSetArn: "arn:ps-1",
          principalId: "p-1",
          principalType: "ROLE"
        }
      ],
      accessRoles: []
    }
  };

  assert.throws(() => validateState(invalid));
});

test("working state materializes back to the original state", () => {
  const input = createSampleState();

  const workingState = createWorkingState({
    state: input
  });
  const materialized = materializeWorkingState({
    workingState: workingState
  });

  assert.deepEqual(materialized, input);
});

test("working state helpers update organization records immutably", () => {
  const input = createSampleState();

  const workingState = createWorkingState({
    state: input
  });
  const movedState = moveAccountInWorkingState({
    workingState: workingState,
    accountId: "111111111111",
    parentId: "ou-b"
  });
  const renamedState = renameOrganizationalUnitInWorkingState({
    workingState: movedState,
    organizationalUnitId: "ou-a",
    name: "AlphaRenamed"
  });
  const withCreatedOu = upsertOrganizationalUnitInWorkingState({
    workingState: renamedState,
    organizationalUnit: {
      id: "ou-c",
      parentId: "r-root",
      arn: "arn:3",
      name: "Gamma"
    }
  });
  const withCreatedAccount = upsertAccountInWorkingState({
    workingState: withCreatedOu,
    account: {
      id: "333333333333",
      arn: "arn:3",
      name: "C",
      email: "c@example.com",
      status: "ACTIVE",
      parentId: "ou-c"
    }
  });
  const materialized = materializeWorkingState({
    workingState: withCreatedAccount
  });

  assert.equal(input.organization.accounts[0]?.parentId, "ou-a");
  assert.equal(input.organization.organizationalUnits[0]?.name, "Alpha");
  assert.equal(materialized.organization.accounts.find((account) => account.id === "111111111111")?.parentId, "ou-b");
  assert.equal(materialized.organization.organizationalUnits.find((organizationalUnit) => organizationalUnit.id === "ou-a")?.name, "AlphaRenamed");
  assert.equal(materialized.organization.organizationalUnits.find((organizationalUnit) => organizationalUnit.id === "ou-c")?.name, "Gamma");
  assert.equal(materialized.organization.accounts.find((account) => account.id === "333333333333")?.parentId, "ou-c");
});

function createSampleState() {
  return {
    version: "1",
    generatedAt: "2026-05-06T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        { id: "ou-a", parentId: "r-root", arn: "arn:1", name: "Alpha" },
        { id: "ou-b", parentId: "r-root", arn: "arn:2", name: "Beta" }
      ],
      accounts: [
        { id: "111111111111", arn: "arn:1", name: "A", email: "a@example.com", status: "ACTIVE", parentId: "ou-a" },
        { id: "222222222222", arn: "arn:2", name: "B", email: "b@example.com", status: "ACTIVE", parentId: "ou-b" }
      ]
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [],
      groups: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: []
    }
  };
}
