import test from "node:test";
import assert from "node:assert/strict";
import { normalizeState, validateState } from "./state.ts";

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
        { accountId: "222222222222", permissionSetArn: "arn2", principalId: "p2", principalType: "USER" },
        { accountId: "111111111111", permissionSetArn: "arn1", principalId: "p1", principalType: "USER" }
      ],
      accessRoles: [
        {
          accountId: "222222222222",
          permissionSetArn: "arn2",
          principalId: "p2",
          principalType: "USER",
          roleName: "role2"
        },
        {
          accountId: "111111111111",
          permissionSetArn: "arn1",
          principalId: "p1",
          principalType: "USER",
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
