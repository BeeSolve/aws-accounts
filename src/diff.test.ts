import assert from "node:assert/strict";
import test from "node:test";
import { diffStates } from "./diff.js";
import type { StateFile } from "./state.js";

test("diffStates returns empty plan for identical states", () => {
  const current = createBaseState();
  const next = cloneState(current);
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates detects single account move", () => {
  const current = createBaseState();
  const next = cloneState(current);
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "ou-data",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "moveAccount",
      accountId: "111111111111",
      accountName: "app-a",
      fromOuId: "ou-eng",
      fromOuName: "Engineering",
      toOuId: "ou-data",
      toOuName: "Data",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates sorts multiple account moves by accountName", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.accounts = [...next.organization.accounts].reverse();
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "ou-data",
  });
  setAccountParentId({
    state: next,
    accountName: "app-b",
    parentId: "ou-eng",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  const movedAccountNames = plan.operations
    .filter((operation) => operation.kind === "moveAccount")
    .map((operation) => operation.accountName);
  assert.deepEqual(movedAccountNames, ["app-a", "app-b"]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits createAccount operation for sentinel new account", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.accounts.push({
    id: "__pending_creation__",
    arn: "__pending_creation__",
    name: "app-c",
    email: "app-c@example.com",
    status: "ACTIVE",
    parentId: "ou-eng",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "createAccount",
      accountName: "app-c",
      accountEmail: "app-c@example.com",
      targetOuId: "ou-eng",
      targetOuName: "Engineering",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates classifies removed account and removed OU as destructive", () => {
  const current = createBaseState();
  const next = cloneState(current);
  removeAccount({
    state: next,
    accountName: "app-b",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Data",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "removedAccount",
      category: "destructive",
      description: 'removed account "app-b"',
    },
    {
      kind: "removedOu",
      category: "destructive",
      description: 'removed OU "Data"',
    },
  ]);
});

test("diffStates emits createOu and renameOu operations", () => {
  const current = createBaseState();

  const nextWithAddedOu = cloneState(current);
  addOrganizationalUnit({
    state: nextWithAddedOu,
    organizationalUnit: {
      id: "ou-sec",
      parentId: "r-root",
      arn: "arn:ou-sec",
      name: "Security",
    },
  });
  const addPlan = diffStates({
    current: current,
    next: nextWithAddedOu,
  });
  assert.deepEqual(addPlan.operations, [
    {
      kind: "createOu",
      ouName: "Security",
      parentOuId: "r-root",
      parentOuName: "root",
    },
  ]);
  assert.deepEqual(addPlan.unsupported, []);

  const nextWithRenamedOu = cloneState(current);
  renameOrganizationalUnit({
    state: nextWithRenamedOu,
    previousName: "Data",
    nextName: "DataPlatform",
    nextId: "ou-data-platform",
  });
  const renamePlan = diffStates({
    current: current,
    next: nextWithRenamedOu,
  });
  assert.deepEqual(renamePlan.operations, [
    {
      kind: "renameOu",
      ouId: "ou-data",
      fromOuName: "Data",
      toOuName: "DataPlatform",
      parentOuId: "r-root",
      parentOuName: "root",
    },
  ]);
  assert.deepEqual(renamePlan.unsupported, []);
});

test("diffStates reports OU reparent as unsupported mutation", () => {
  const current = createBaseState();
  const next = cloneState(current);
  setOrganizationalUnitParentId({
    state: next,
    organizationalUnitName: "Data",
    parentId: "ou-eng",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "reparentedOu",
      category: "unsupportedMutation",
      description: 'OU "Data" changed parent from "root" to "Engineering"',
    },
  ]);
});

test("diffStates reports ambiguous OU rename aggregated per parent", () => {
  const current = createBaseState();
  const next = cloneState(current);
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Engineering",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Data",
  });
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "ou-platform",
      parentId: "r-root",
      arn: "arn:ou-platform",
      name: "Platform",
    },
  });
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "ou-security",
      parentId: "r-root",
      arn: "arn:ou-security",
      name: "Security",
    },
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "ambiguousOuRename",
      category: "unsupportedMutation",
      description:
        'ambiguous OU rename under "root" (added: Platform, Security; removed: Data, Engineering)',
    },
  ]);
});

test("diffStates reports new OU with unresolved parent", () => {
  const current = createBaseState();
  const next = cloneState(current);
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "__pending_creation__",
      parentId: "__pending_creation__",
      arn: "__pending_creation__",
      name: "ChildOfUnknownParent",
    },
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "newOuWithUnknownParent",
      category: "unsupportedMutation",
      description:
        'new OU "ChildOfUnknownParent" has unresolved parent "ChildOfUnknownParent" (__pending_creation__)',
    },
  ]);
});

test("diffStates reports new account with unresolved target OU", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.accounts.push({
    id: "__pending_creation__",
    arn: "__pending_creation__",
    name: "app-d",
    email: "app-d@example.com",
    status: "ACTIVE",
    parentId: "__pending_creation__",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "newAccountWithUnknownOu",
      category: "unsupportedMutation",
      description:
        'new account "app-d" has unresolved target OU "unknown" (__pending_creation__)',
    },
  ]);
});

test("diffStates classifies IdC entity additions as unsupported mutations", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.users.push({
    userId: "u-2",
    userName: "bob",
    displayName: "Bob",
    emails: ["bob@example.com"],
  });
  next.identityCenter.groups.push({
    groupId: "g-2",
    displayName: "Security",
  });
  next.identityCenter.permissionSets.push({
    permissionSetArn: "arn:ps-readonly",
    name: "ReadOnly",
    description: "Read only",
  });
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "idcGroupAdded",
      category: "unsupportedMutation",
      description: 'new IdC group "Security"',
    },
    {
      kind: "idcPermissionSetAdded",
      category: "unsupportedMutation",
      description: 'new IdC permission set "ReadOnly"',
    },
    {
      kind: "idcUserAdded",
      category: "unsupportedMutation",
      description: 'new IdC user "bob"',
    },
  ]);
});

test("diffStates classifies IdC assignment changes as unsupported mutations", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.accountAssignments = [
    {
      accountId: "222222222222",
      permissionSetArn: "arn:ps-admin",
      principalId: "g-1",
      principalType: "GROUP",
    },
  ];
  const plan = diffStates({
    current: current,
    next: next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "idcAssignmentChanged",
      category: "unsupportedMutation",
      description: "IdC account assignments changed",
    },
  ]);
});

function createBaseState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      rootId: "r-root",
      organizationalUnits: [
        {
          id: "ou-eng",
          parentId: "r-root",
          arn: "arn:ou-eng",
          name: "Engineering",
        },
        {
          id: "ou-data",
          parentId: "r-root",
          arn: "arn:ou-data",
          name: "Data",
        },
      ],
      accounts: [
        {
          id: "111111111111",
          arn: "arn:acct-app-a",
          name: "app-a",
          email: "app-a@example.com",
          status: "ACTIVE",
          parentId: "ou-eng",
        },
        {
          id: "222222222222",
          arn: "arn:acct-app-b",
          name: "app-b",
          email: "app-b@example.com",
          status: "ACTIVE",
          parentId: "ou-data",
        },
      ],
    },
    identityCenter: {
      instanceArn: "arn:sso-instance",
      identityStoreId: "d-123",
      users: [
        {
          userId: "u-1",
          userName: "alice",
          displayName: "Alice",
          emails: ["alice@example.com"],
        },
      ],
      groups: [
        {
          groupId: "g-1",
          displayName: "Platform",
        },
      ],
      permissionSets: [
        {
          permissionSetArn: "arn:ps-admin",
          name: "Admin",
          description: "Admin access",
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
    },
  };
}

function cloneState(state: StateFile): StateFile {
  return structuredClone(state);
}

function setAccountParentId(props: {
  state: StateFile;
  accountName: string;
  parentId: string;
}): void {
  const account = props.state.organization.accounts.find(
    (currentAccount) => currentAccount.name === props.accountName,
  );
  if (account == null) {
    throw new Error(`Could not find account "${props.accountName}" in test state.`);
  }
  account.parentId = props.parentId;
}

function removeAccount(props: { state: StateFile; accountName: string }): void {
  props.state.organization.accounts = props.state.organization.accounts.filter(
    (account) => account.name !== props.accountName,
  );
}

function addOrganizationalUnit(props: {
  state: StateFile;
  organizationalUnit: StateFile["organization"]["organizationalUnits"][number];
}): void {
  props.state.organization.organizationalUnits.push(props.organizationalUnit);
}

function setOrganizationalUnitParentId(props: {
  state: StateFile;
  organizationalUnitName: string;
  parentId: string;
}): void {
  const organizationalUnit = props.state.organization.organizationalUnits.find(
    (currentOrganizationalUnit) =>
      currentOrganizationalUnit.name === props.organizationalUnitName,
  );
  if (organizationalUnit == null) {
    throw new Error(
      `Could not find OU "${props.organizationalUnitName}" in test state.`,
    );
  }
  organizationalUnit.parentId = props.parentId;
}

function removeOrganizationalUnit(props: {
  state: StateFile;
  organizationalUnitName: string;
}): void {
  props.state.organization.organizationalUnits =
    props.state.organization.organizationalUnits.filter(
      (organizationalUnit) => organizationalUnit.name !== props.organizationalUnitName,
    );
}

function renameOrganizationalUnit(props: {
  state: StateFile;
  previousName: string;
  nextName: string;
  nextId: string;
}): void {
  props.state.organization.organizationalUnits =
    props.state.organization.organizationalUnits.flatMap((organizationalUnit) => {
      if (organizationalUnit.name !== props.previousName) {
        return [organizationalUnit];
      }
      return [
        {
          ...organizationalUnit,
          id: props.nextId,
          arn: `arn:${props.nextId}`,
          name: props.nextName,
        },
      ];
    });
}
