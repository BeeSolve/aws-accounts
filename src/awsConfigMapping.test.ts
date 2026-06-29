import assert from "node:assert/strict";
import test from "node:test";

import type { AwsContextFile } from "./awsConfig.js";
import { mapAwsConfigToState, mapStateToAwsConfig } from "./awsConfigMapping.js";
import type { StateFile } from "./state.js";

function createMinimalState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test123",
      rootId: "r-root",
      organizationalUnits: [
        { id: "ou-eng", parentId: "r-root", arn: "arn:ou-eng", name: "Engineering" },
      ],
      accounts: [
        {
          id: "111111111111",
          arn: "arn:acct-1",
          name: "app-prod",
          email: "prod@example.com",
          state: "ACTIVE",
          tags: [{ key: "env", value: "prod" }],
          parentId: "ou-eng",
        },
      ],
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
      users: [{ userId: "u-1", userName: "alice", displayName: "Alice", email: "alice@ex.com" }],
      groups: [{ groupId: "g-1", displayName: "Admins" }],
      groupMemberships: [{ membershipId: "m-1", groupId: "g-1", userId: "u-1" }],
      permissionSets: [
        {
          permissionSetArn: "arn:ps-admin",
          name: "AdminAccess",
          description: "Full access",
          sessionDuration: "PT8H",
          inlinePolicy: null,
          awsManagedPolicies: ["arn:aws:iam::aws:policy/AdministratorAccess"],
          customerManagedPolicies: [],
          permissionsBoundary: null,
        },
      ],
      accountAssignments: [
        {
          accountId: "111111111111",
          permissionSetArn: "arn:ps-admin",
          principalId: "g-1",
          principalType: "GROUP",
        },
      ],
      accessRoles: [],
      accessControlAttributes: [],
    },
  };
}

function createMinimalContext(): AwsContextFile {
  return {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      managementAccountId: "000000000000",
      rootId: "r-root",
      graveyardOuId: "pending",
    },
    identityCenter: {
      instanceArn: "arn:aws:sso:::instance/ssoins-123",
      identityStoreId: "d-123",
    },
  };
}

test("mapStateToAwsConfig and mapAwsConfigToState round-trip preserves state", () => {
  const state = createMinimalState();
  const context = createMinimalContext();

  const config = mapStateToAwsConfig({ state });
  const roundTripped = mapAwsConfigToState({ config, currentState: state, context });

  assert.equal(roundTripped.organization.organizationId, state.organization.organizationId);
  assert.equal(roundTripped.organization.rootId, state.organization.rootId);
  const engineeringOu = roundTripped.organization.organizationalUnits.find(
    (ou) => ou.name === "Engineering",
  );
  assert.ok(engineeringOu != null);
  assert.equal(engineeringOu.id, "ou-eng");
  assert.equal(roundTripped.organization.accounts.length, 1);
  assert.equal(roundTripped.organization.accounts[0].name, "app-prod");
  assert.equal(roundTripped.organization.accounts[0].parentId, "ou-eng");
  assert.deepEqual(roundTripped.organization.accounts[0].tags, [{ key: "env", value: "prod" }]);
  assert.equal(roundTripped.identityCenter.users.length, 1);
  assert.equal(roundTripped.identityCenter.users[0].userName, "alice");
  assert.equal(roundTripped.identityCenter.groups.length, 1);
  assert.equal(roundTripped.identityCenter.groups[0].displayName, "Admins");
  assert.equal(roundTripped.identityCenter.groupMemberships.length, 1);
  assert.equal(roundTripped.identityCenter.permissionSets.length, 1);
  assert.equal(roundTripped.identityCenter.permissionSets[0].name, "AdminAccess");
  assert.equal(roundTripped.identityCenter.accountAssignments.length, 1);
  assert.equal(roundTripped.identityCenter.accountAssignments[0].accountId, "111111111111");
});

test("mapStateToAwsConfig excludes Graveyard OU and its accounts", () => {
  const state = createMinimalState();
  state.organization.organizationalUnits.push({
    id: "ou-graveyard",
    parentId: "r-root",
    arn: "arn:ou-graveyard",
    name: "Graveyard",
  });
  state.organization.accounts.push({
    id: "222222222222",
    arn: "arn:acct-2",
    name: "dead-account",
    email: "dead@example.com",
    state: "ACTIVE",
    tags: [],
    parentId: "ou-graveyard",
  });

  const config = mapStateToAwsConfig({ state });
  const ouNames = config.organizationalUnits.map((ou) => ou.name);
  assert.ok(!ouNames.includes("Graveyard"));
  const accountNames = config.organizationalUnits.flatMap((ou) => ou.accounts.map((a) => a.name));
  assert.ok(!accountNames.includes("dead-account"));
});
