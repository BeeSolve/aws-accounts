import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { executeOrganizationOperation } from "./applyOrganization.js";
import type { Logger } from "./logger.js";
import { createWorkingState, type StateFile } from "./state.js";

function createNoopLogger(): Logger {
  return {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  };
}

function createBaseState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test",
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
          tags: [],
          parentId: "ou-eng",
        },
      ],
    },
    identityCenter: {
      instanceArn: "arn:sso",
      identityStoreId: "d-1",
      users: [],
      groups: [],
      groupMemberships: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: [],
      accessControlAttributes: [],
    },
  };
}

test("executeOrganizationOperation createOu adds OU to state", async () => {
  const state = createWorkingState({ state: createBaseState() });
  const sendMock = mock.fn(async () => ({
    OrganizationalUnit: { Id: "ou-new", Arn: "arn:ou-new", Name: "Data" },
  }));
  const organizationsClient = { send: sendMock } as any;
  const accountClient = {} as any;

  const result = await executeOrganizationOperation({
    state,
    organizationsClient,
    accountClient,
    logger: createNoopLogger(),
    context: { organization: { organizationId: "o-test", rootId: "r-root" } },
    runtime: { createAccount: { timeoutInMs: 5000, pollIntervalInMs: 100 } },
    operation: { kind: "createOu", ouName: "Data", parentOuId: "r-root", parentOuName: "root" },
  });

  assert.equal(sendMock.mock.callCount(), 1);
  assert.ok(result.organization.organizationalUnitsById["ou-new"] != null);
  assert.equal(result.organization.organizationalUnitsById["ou-new"].name, "Data");
  assert.equal(result.organization.organizationalUnitsById["ou-new"].parentId, "r-root");
});

test("executeOrganizationOperation createOu throws on incomplete response", async () => {
  const state = createWorkingState({ state: createBaseState() });
  const sendMock = mock.fn(async () => ({ OrganizationalUnit: { Id: null } }));
  const organizationsClient = { send: sendMock } as any;
  const accountClient = {} as any;

  await assert.rejects(
    () =>
      executeOrganizationOperation({
        state,
        organizationsClient,
        accountClient,
        logger: createNoopLogger(),
        context: { organization: { organizationId: "o-test", rootId: "r-root" } },
        runtime: { createAccount: { timeoutInMs: 5000, pollIntervalInMs: 100 } },
        operation: { kind: "createOu", ouName: "Data", parentOuId: "r-root", parentOuName: "root" },
      }),
    { message: /incomplete OU data/i },
  );
});

test("executeOrganizationOperation moveAccount updates account parentId", async () => {
  const state = createWorkingState({ state: createBaseState() });
  const sendMock = mock.fn(async () => ({}));
  const organizationsClient = { send: sendMock } as any;
  const accountClient = {} as any;

  const result = await executeOrganizationOperation({
    state,
    organizationsClient,
    accountClient,
    logger: createNoopLogger(),
    context: { organization: { organizationId: "o-test", rootId: "r-root" } },
    runtime: { createAccount: { timeoutInMs: 5000, pollIntervalInMs: 100 } },
    operation: {
      kind: "moveAccount",
      accountId: "111111111111",
      accountName: "app-prod",
      fromOuId: "ou-eng",
      fromOuName: "Engineering",
      toOuId: "r-root",
      toOuName: "root",
    },
  });

  assert.equal(sendMock.mock.callCount(), 1);
  assert.equal(result.organization.accountsById["111111111111"].parentId, "r-root");
});
