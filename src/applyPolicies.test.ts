import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { executePolicyOperation } from "./applyPolicies.js";
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
      organizationalUnits: [],
      accounts: [],
      policies: [],
      policyAttachments: [],
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

test("executePolicyOperation createOrgPolicy adds policy to state", async () => {
  const state = createWorkingState({ state: createBaseState() });
  const sendMock = mock.fn(async () => ({
    Policy: { PolicySummary: { Id: "p-123", Arn: "arn:policy:p-123" } },
  }));
  const organizationsClient = { send: sendMock } as any;

  const result = await executePolicyOperation({
    state,
    organizationsClient,
    logger: createNoopLogger(),
    context: { organization: { organizationId: "o-test", rootId: "r-root" } },
    operation: {
      kind: "createOrgPolicy",
      policyName: "DenyExpensive",
      policyType: "SERVICE_CONTROL_POLICY",
      description: "Block expensive resources",
      content: '{"Version":"2012-10-17","Statement":[]}',
    },
  });

  assert.equal(sendMock.mock.callCount(), 1);
  assert.ok(result.organization.policiesById["p-123"] != null);
  assert.equal(result.organization.policiesById["p-123"].name, "DenyExpensive");
  assert.equal(result.organization.policiesById["p-123"].type, "SERVICE_CONTROL_POLICY");
});

test("executePolicyOperation createOrgPolicy throws on incomplete response", async () => {
  const state = createWorkingState({ state: createBaseState() });
  const sendMock = mock.fn(async () => ({ Policy: { PolicySummary: { Id: null } } }));
  const organizationsClient = { send: sendMock } as any;

  await assert.rejects(
    () =>
      executePolicyOperation({
        state,
        organizationsClient,
        logger: createNoopLogger(),
        context: { organization: { organizationId: "o-test", rootId: "r-root" } },
        operation: {
          kind: "createOrgPolicy",
          policyName: "DenyExpensive",
          policyType: "SERVICE_CONTROL_POLICY",
          description: "",
          content: "{}",
        },
      }),
    { message: /incomplete data/i },
  );
});
