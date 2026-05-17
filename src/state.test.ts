import test from "node:test";
import assert from "node:assert/strict";
import {
  addGroupMembershipToWorkingState,
  addAccountAssignmentToWorkingState,
  createWorkingState,
  materializeWorkingState,
  moveAccountInWorkingState,
  removeAccountAssignmentFromWorkingState,
  removeGroupMembershipFromWorkingState,
  removeIdcGroupFromWorkingState,
  removeIdcPermissionSetFromWorkingState,
  removeIdcUserFromWorkingState,
  removeOrganizationalUnitFromWorkingState,
  renameOrganizationalUnitInWorkingState,
  upsertIdcGroupInWorkingState,
  upsertIdcPermissionSetInWorkingState,
  upsertIdcUserInWorkingState,
  upsertAccountInWorkingState,
  upsertOrganizationalUnitInWorkingState,
  validateState,
} from "./state.js";

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
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
      accessControlAttributes: []
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
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [
        {
          accountId: "111111111111",
          permissionSetArn: "arn:ps-1",
          principalId: "p-1",
          principalType: "ROLE"
        }
      ],
      accessRoles: [],
      accessControlAttributes: []
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
    workingState
  });

  assert.deepEqual(materialized, input);
});

test("working state helpers update organization records immutably", () => {
  const input = createSampleState();

  const workingState = createWorkingState({
    state: input
  });
  const movedState = moveAccountInWorkingState({
    workingState,
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
      tags: [],
      parentId: "ou-c"
    }
  });
  const withoutBetaOu = removeOrganizationalUnitFromWorkingState({
    workingState: withCreatedAccount,
    organizationalUnitId: "ou-b",
  });
  const materialized = materializeWorkingState({
    workingState: withoutBetaOu
  });

  assert.equal(input.organization.accounts[0]?.parentId, "ou-a");
  assert.equal(input.organization.organizationalUnits[0]?.name, "Alpha");
  assert.equal(materialized.organization.accounts.find((account) => account.id === "111111111111")?.parentId, "ou-b");
  assert.equal(materialized.organization.organizationalUnits.find((organizationalUnit) => organizationalUnit.id === "ou-a")?.name, "AlphaRenamed");
  assert.equal(materialized.organization.organizationalUnits.find((organizationalUnit) => organizationalUnit.id === "ou-c")?.name, "Gamma");
  assert.equal(
    materialized.organization.organizationalUnits.some(
      (organizationalUnit) => organizationalUnit.id === "ou-b",
    ),
    false,
  );
  assert.equal(materialized.organization.accounts.find((account) => account.id === "333333333333")?.parentId, "ou-c");
});

test("working state helpers update IdC records immutably and regenerate access roles", () => {
  const input = createSampleState();

  const workingState = createWorkingState({
    state: input
  });
  const withUser = upsertIdcUserInWorkingState({
    workingState,
    user: {
      userId: "u-1",
      userName: "alice",
      displayName: "Alice",
      email: "alice@example.com",
    },
  });
  const withGroup = upsertIdcGroupInWorkingState({
    workingState: withUser,
    group: {
      groupId: "g-1",
      displayName: "Admins",
    },
  });
  const withPermissionSet = upsertIdcPermissionSetInWorkingState({
    workingState: withGroup,
    permissionSet: {
      permissionSetArn: "arn:ps-1",
      name: "AdminAccess",
      description: "Admin",
      sessionDuration: null,
      inlinePolicy: null,
      awsManagedPolicies: [],
      customerManagedPolicies: [],
      permissionsBoundary: null,
    },
  });
  const withMembership = addGroupMembershipToWorkingState({
    workingState: withPermissionSet,
    groupMembership: {
      membershipId: "gm-1",
      groupId: "g-1",
      userId: "u-1",
    },
  });
  const withAssignment = addAccountAssignmentToWorkingState({
    workingState: withMembership,
    accountAssignment: {
      accountId: "111111111111",
      permissionSetArn: "arn:ps-1",
      principalId: "g-1",
      principalType: "GROUP",
    },
  });
  const withoutMembership = removeGroupMembershipFromWorkingState({
    workingState: withAssignment,
    groupMembership: {
      groupId: "g-1",
      userId: "u-1",
    },
  });
  const withoutAssignment = removeAccountAssignmentFromWorkingState({
    workingState: withoutMembership,
    accountAssignment: {
      accountId: "111111111111",
      permissionSetArn: "arn:ps-1",
      principalId: "g-1",
      principalType: "GROUP",
    },
  });
  const withoutUser = removeIdcUserFromWorkingState({
    workingState: withAssignment,
    userName: "alice",
  });
  const withoutGroup = removeIdcGroupFromWorkingState({
    workingState: withAssignment,
    groupDisplayName: "Admins",
  });
  const withoutPermissionSet = removeIdcPermissionSetFromWorkingState({
    workingState: withAssignment,
    permissionSetName: "AdminAccess",
  });

  const withAssignmentMaterialized = materializeWorkingState({
    workingState: withAssignment,
  });
  const withoutAssignmentMaterialized = materializeWorkingState({
    workingState: withoutAssignment,
  });
  const withoutUserMaterialized = materializeWorkingState({
    workingState: withoutUser,
  });
  const withoutGroupMaterialized = materializeWorkingState({
    workingState: withoutGroup,
  });
  const withoutPermissionSetMaterialized = materializeWorkingState({
    workingState: withoutPermissionSet,
  });

  assert.equal(input.identityCenter.users.length, 0);
  assert.equal(withAssignmentMaterialized.identityCenter.users[0]?.userName, "alice");
  assert.equal(withAssignmentMaterialized.identityCenter.groups[0]?.displayName, "Admins");
  assert.equal(
    withAssignmentMaterialized.identityCenter.permissionSets[0]?.name,
    "AdminAccess",
  );
  assert.equal(
    withAssignmentMaterialized.identityCenter.accountAssignments.length,
    1,
  );
  assert.equal(withAssignmentMaterialized.identityCenter.groupMemberships.length, 1);
  assert.equal(withAssignmentMaterialized.identityCenter.accessRoles.length, 1);
  assert.equal(withoutAssignmentMaterialized.identityCenter.groupMemberships.length, 0);
  assert.equal(withoutAssignmentMaterialized.identityCenter.accountAssignments.length, 0);
  assert.equal(withoutAssignmentMaterialized.identityCenter.accessRoles.length, 0);
  assert.equal(withoutUserMaterialized.identityCenter.users.length, 0);
  assert.equal(withoutUserMaterialized.identityCenter.groupMemberships.length, 0);
  assert.equal(withoutUserMaterialized.identityCenter.accountAssignments.length, 1);
  assert.equal(withoutGroupMaterialized.identityCenter.groups.length, 0);
  assert.equal(withoutGroupMaterialized.identityCenter.groupMemberships.length, 0);
  assert.equal(withoutGroupMaterialized.identityCenter.accountAssignments.length, 0);
  assert.equal(withoutGroupMaterialized.identityCenter.accessRoles.length, 0);
  assert.equal(withoutPermissionSetMaterialized.identityCenter.permissionSets.length, 0);
  assert.equal(
    withoutPermissionSetMaterialized.identityCenter.accountAssignments.length,
    0,
  );
  assert.equal(withoutPermissionSetMaterialized.identityCenter.accessRoles.length, 0);
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
        { id: "111111111111", arn: "arn:1", name: "A", email: "a@example.com", status: "ACTIVE", tags: [], parentId: "ou-a" },
        { id: "222222222222", arn: "arn:2", name: "B", email: "b@example.com", status: "ACTIVE", tags: [], parentId: "ou-b" }
      ],
      policies: [],
      policyAttachments: []
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
      accessControlAttributes: []
    }
  };
}
