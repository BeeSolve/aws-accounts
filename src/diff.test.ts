import assert from "node:assert/strict";
import test from "node:test";

import { diffStates } from "./diff.js";
import type { StateFile } from "./state.js";

test("diffStates returns empty plan for identical states", () => {
  const current = createBaseState();
  const next = cloneState(current);
  const plan = diffStates({
    current,
    next,
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
    current,
    next,
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
    current,
    next,
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
    state: "ACTIVE",
    tags: [],
    parentId: "ou-eng",
  });
  const plan = diffStates({
    current,
    next,
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

test("diffStates emits updateAccountTags when desired tags change", () => {
  const current = createBaseState();
  const next = cloneState(current);
  const account = next.organization.accounts.find((candidate) => candidate.name === "app-a");
  if (account == null) {
    throw new Error('Expected fixture account "app-a".');
  }
  account.tags = [
    { key: "owner", value: "platform" },
    { key: "cost-center", value: "eng" },
  ];
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "updateAccountTags",
      accountId: "111111111111",
      accountName: "app-a",
      tags: {
        "cost-center": "eng",
        owner: "platform",
      },
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits updateAccountName when desired name differs for the same account id", () => {
  const current = createBaseState();
  current.identityCenter.accountAssignments = [];
  current.identityCenter.accessRoles = [];
  const next = cloneState(current);
  const account = next.organization.accounts.find((candidate) => candidate.name === "app-a");
  if (account == null) {
    throw new Error('Expected fixture account "app-a".');
  }
  account.name = "app-a-renamed";
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "updateAccountName",
      accountId: "111111111111",
      fromAccountName: "app-a",
      toAccountName: "app-a-renamed",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates reports accountEmailChange as unsupported when email differs for an existing account", () => {
  const current = createBaseState();
  current.identityCenter.accountAssignments = [];
  current.identityCenter.accessRoles = [];
  const next = cloneState(current);
  const account = next.organization.accounts.find((candidate) => candidate.name === "app-a");
  if (account == null) {
    throw new Error('Expected fixture account "app-a".');
  }
  account.email = "new-email@example.com";
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "accountEmailChange",
      category: "unsupportedMutation",
      description: `account "app-a" email cannot be changed via API (from "app-a@example.com" to "new-email@example.com"); update it directly in the AWS account's root user settings`,
    },
  ]);
});

test("diffStates emits updateAccountName before moveAccount when renaming and moving together", () => {
  const current = createBaseState();
  current.identityCenter.accountAssignments = [];
  current.identityCenter.accessRoles = [];
  const next = cloneState(current);
  const account = next.organization.accounts.find((candidate) => candidate.name === "app-a");
  if (account == null) {
    throw new Error('Expected fixture account "app-a".');
  }
  account.name = "app-a-renamed";
  setAccountParentId({
    state: next,
    accountName: "app-a-renamed",
    parentId: "ou-data",
  });
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "updateAccountName",
      accountId: "111111111111",
      fromAccountName: "app-a",
      toAccountName: "app-a-renamed",
    },
    {
      kind: "moveAccount",
      accountId: "111111111111",
      accountName: "app-a-renamed",
      fromOuId: "ou-eng",
      fromOuName: "Engineering",
      toOuId: "ou-data",
      toOuName: "Data",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits removeAccount and classifies removed OU as destructive", () => {
  const current = createBaseState();
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-graveyard",
      parentId: "r-root",
      arn: "arn:ou-graveyard",
      name: "Graveyard",
    },
  });
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
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "removeAccount",
      accountId: "222222222222",
      accountName: "app-b",
      fromOuId: "ou-data",
      fromOuName: "Data",
      toOuId: "ou-graveyard",
      toOuName: "Graveyard",
    },
  ]);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "removedOu",
      category: "destructive",
      description: 'removed OU "Data"',
    },
  ]);
});

test("diffStates keeps removed account destructive-unsupported without Graveyard OU", () => {
  const current = createBaseState();
  const next = cloneState(current);
  removeAccount({
    state: next,
    accountName: "app-b",
  });
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "removedOu",
      category: "destructive",
      description:
        'removed account "app-b" cannot be reconciled because reserved OU "Graveyard" was not found in state',
    },
  ]);
});

test("diffStates emits deleteOu for removed empty leaf OU", () => {
  const current = createBaseState();
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-empty",
      parentId: "r-root",
      arn: "arn:ou-empty",
      name: "Empty",
    },
  });
  const next = cloneState(current);
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Empty",
  });

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "deleteOu",
      ouId: "ou-empty",
      ouName: "Empty",
      parentOuId: "r-root",
      parentOuName: "root",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits moveAccount and deleteOu when the last account leaves in the same batch", () => {
  const current = createBaseState();
  const next = cloneState(current);
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "ou-data",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Engineering",
  });

  const plan = diffStates({
    current,
    next,
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
    {
      kind: "deleteOu",
      ouId: "ou-eng",
      ouName: "Engineering",
      parentOuId: "r-root",
      parentOuName: "root",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates keeps OU delete unsupported when same-batch moves do not empty it completely", () => {
  const current = createBaseState();
  current.organization.accounts.push({
    id: "333333333333",
    arn: "arn:acct-app-c",
    name: "app-c",
    email: "app-c@example.com",
    state: "ACTIVE",
    tags: [],
    parentId: "ou-eng",
  });
  const next = cloneState(current);
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "ou-data",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Engineering",
  });

  const plan = diffStates({
    current,
    next,
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
  assert.deepEqual(plan.unsupported, [
    {
      kind: "removedOu",
      category: "destructive",
      description: 'removed OU "Engineering"',
    },
  ]);
});

test("diffStates emits nested deleteOu operations deepest first", () => {
  const current = createBaseState();
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-parent",
      parentId: "r-root",
      arn: "arn:ou-parent",
      name: "Parent",
    },
  });
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-child",
      parentId: "ou-parent",
      arn: "arn:ou-child",
      name: "Child",
    },
  });
  const next = cloneState(current);
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Parent",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Child",
  });

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "deleteOu",
      ouId: "ou-child",
      ouName: "Child",
      parentOuId: "ou-parent",
      parentOuName: "Parent",
    },
    {
      kind: "deleteOu",
      ouId: "ou-parent",
      ouName: "Parent",
      parentOuId: "r-root",
      parentOuName: "root",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates keeps nested OU delete unsupported when a descendant is not safe to delete", () => {
  const current = createBaseState();
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-parent",
      parentId: "r-root",
      arn: "arn:ou-parent",
      name: "Parent",
    },
  });
  addOrganizationalUnit({
    state: current,
    organizationalUnit: {
      id: "ou-child",
      parentId: "ou-parent",
      arn: "arn:ou-child",
      name: "Child",
    },
  });
  current.organization.accounts.push({
    id: "333333333333",
    arn: "arn:acct-app-c",
    name: "app-c",
    email: "app-c@example.com",
    state: "ACTIVE",
    tags: [],
    parentId: "ou-child",
  });
  const next = cloneState(current);
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Parent",
  });
  removeOrganizationalUnit({
    state: next,
    organizationalUnitName: "Child",
  });

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "removedOu",
      category: "destructive",
      description: 'removed OU "Child"',
    },
    {
      kind: "removedOu",
      category: "destructive",
      description: 'removed OU "Parent"',
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
    current,
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
    current,
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
    current,
    next,
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
    current,
    next,
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
    current,
    next,
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
    state: "ACTIVE",
    tags: [],
    parentId: "__pending_creation__",
  });
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "newAccountWithUnknownOu",
      category: "unsupportedMutation",
      description: 'new account "app-d" has unresolved target OU "unknown" (__pending_creation__)',
    },
  ]);
});

test("diffStates emits createOu and createAccount in same plan when new account targets new OU", () => {
  const current = createBaseState();
  const next = cloneState(current);
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "__pending_creation__",
      parentId: "r-root",
      arn: "__pending_creation__",
      name: "integration",
    },
  });
  next.organization.accounts.push({
    id: "__pending_creation__",
    arn: "__pending_creation__",
    name: "kit-lambda-test",
    email: "kit-lambda-test@example.com",
    state: "ACTIVE",
    tags: [],
    parentId: "__pending_creation__",
  });
  const plan = diffStates({ current, next });
  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(plan.operations, [
    {
      kind: "createOu",
      ouName: "integration",
      parentOuId: "r-root",
      parentOuName: "root",
    },
    {
      kind: "createAccount",
      accountName: "kit-lambda-test",
      accountEmail: "kit-lambda-test@example.com",
      targetOuId: "__pending_creation__",
      targetOuName: "integration",
    },
  ]);
});

test("diffStates emits createOu and moveAccount in same plan when existing account targets new OU", () => {
  const current = createBaseState();
  const next = cloneState(current);
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "__pending_creation__",
      parentId: "r-root",
      arn: "__pending_creation__",
      name: "integration",
    },
  });
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "__pending_creation__",
  });
  const plan = diffStates({ current, next });
  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(plan.operations, [
    {
      kind: "createOu",
      ouName: "integration",
      parentOuId: "r-root",
      parentOuName: "root",
    },
    {
      kind: "moveAccount",
      accountId: "111111111111",
      accountName: "app-a",
      fromOuId: "ou-eng",
      fromOuName: "Engineering",
      toOuId: "__pending_creation__",
      toOuName: "integration",
    },
  ]);
});

test("diffStates topologically sorts createOu ops when parent and child OU are both new", () => {
  const current = createBaseState();
  const next = cloneState(current);
  // The child must be pushed before the parent so that the Map built in
  // normalizeOrganizationState maps __pending_creation__ → "platform" (last-wins),
  // allowing diffStates to resolve the child's parent name correctly.
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "__pending_creation__",
      parentId: "__pending_creation__",
      arn: "__pending_creation__",
      name: "platform-dev",
    },
  });
  addOrganizationalUnit({
    state: next,
    organizationalUnit: {
      id: "__pending_creation__",
      parentId: "r-root",
      arn: "__pending_creation__",
      name: "platform",
    },
  });
  const plan = diffStates({ current, next });
  assert.deepEqual(plan.unsupported, []);
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.operations[0]!.kind, "createOu");
  assert.equal((plan.operations[0] as { ouName: string }).ouName, "platform");
  assert.equal(plan.operations[1]!.kind, "createOu");
  assert.equal((plan.operations[1] as { ouName: string }).ouName, "platform-dev");
});

test("diffStates reports existing account with truly unknown target OU", () => {
  const current = createBaseState();
  const next = cloneState(current);
  setAccountParentId({
    state: next,
    accountName: "app-a",
    parentId: "__pending_creation__",
  });
  const plan = diffStates({ current, next });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, [
    {
      kind: "existingAccountWithUnknownTargetOu",
      category: "unsupportedMutation",
      description:
        'existing account "app-a" has unresolved target OU "unknown" (__pending_creation__)',
    },
  ]);
});

test("diffStates emits IdC entity creation operations", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.users.push({
    userId: "u-2",
    userName: "bob",
    displayName: "Bob",
    email: "bob@example.com",
  });
  next.identityCenter.groups.push({
    groupId: "g-2",
    displayName: "Security",
  });
  next.identityCenter.permissionSets.push({
    permissionSetArn: "arn:ps-readonly",
    name: "ReadOnly",
    description: "Read only",
    sessionDuration: null,
    inlinePolicy: null,
    awsManagedPolicies: [],
    customerManagedPolicies: [],
    permissionsBoundary: null,
  });
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "createIdcUser",
      userName: "bob",
      displayName: "Bob",
      email: "bob@example.com",
    },
    {
      kind: "createIdcGroup",
      groupDisplayName: "Security",
      description: "",
    },
    {
      kind: "createIdcPermissionSet",
      permissionSetName: "ReadOnly",
      description: "Read only",
      sessionDuration: null,
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits IdC metadata update operations", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.users[0] = {
    ...next.identityCenter.users[0],
    displayName: "Alice Updated",
    email: "alice-new@example.com",
  };
  next.identityCenter.groups[0] = {
    ...next.identityCenter.groups[0],
    description: "Platform access",
  };
  next.identityCenter.permissionSets[0] = {
    ...next.identityCenter.permissionSets[0],
    description: "Updated admin access",
  };

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "updateIdcUser",
      userName: "alice",
      displayName: "Alice Updated",
      email: "alice-new@example.com",
    },
    {
      kind: "updateIdcGroupDescription",
      groupDisplayName: "Platform",
      description: "Platform access",
    },
    {
      kind: "updateIdcPermissionSetDescription",
      permissionSetName: "Admin",
      description: "Updated admin access",
    },
    {
      kind: "provisionIdcPermissionSet",
      permissionSetName: "Admin",
      targetScope: "ALL_PROVISIONED_ACCOUNTS",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits permission set policy operations and provisioning", () => {
  const current = createBaseState();
  current.identityCenter.permissionSets[0] = {
    ...current.identityCenter.permissionSets[0],
    inlinePolicy:
      '{"Statement":[{"Action":["s3:GetObject"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
    awsManagedPolicies: [
      "arn:aws:iam::aws:policy/SecurityAudit",
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ],
    customerManagedPolicies: [
      {
        name: "SupportReadOnly",
        path: "/beesolve/",
      },
    ],
  };
  const next = cloneState(current);
  next.identityCenter.permissionSets[0] = {
    ...next.identityCenter.permissionSets[0],
    inlinePolicy:
      '{"Statement":[{"Action":["ec2:Describe*"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
    awsManagedPolicies: [
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
      "arn:aws:iam::aws:policy/ViewOnlyAccess",
    ],
    customerManagedPolicies: [
      {
        name: "SupportReadWrite",
        path: "/beesolve/",
      },
    ],
  };

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "putIdcPermissionSetInlinePolicy",
      permissionSetName: "Admin",
      inlinePolicy:
        '{"Statement":[{"Action":["ec2:Describe*"],"Effect":"Allow","Resource":"*"}],"Version":"2012-10-17"}',
    },
    {
      kind: "attachIdcManagedPolicyToPermissionSet",
      permissionSetName: "Admin",
      managedPolicyArn: "arn:aws:iam::aws:policy/ViewOnlyAccess",
    },
    {
      kind: "detachIdcManagedPolicyFromPermissionSet",
      permissionSetName: "Admin",
      managedPolicyArn: "arn:aws:iam::aws:policy/SecurityAudit",
    },
    {
      kind: "attachIdcCustomerManagedPolicyReferenceToPermissionSet",
      permissionSetName: "Admin",
      customerManagedPolicyName: "SupportReadWrite",
      customerManagedPolicyPath: "/beesolve/",
    },
    {
      kind: "detachIdcCustomerManagedPolicyReferenceFromPermissionSet",
      permissionSetName: "Admin",
      customerManagedPolicyName: "SupportReadOnly",
      customerManagedPolicyPath: "/beesolve/",
    },
    {
      kind: "provisionIdcPermissionSet",
      permissionSetName: "Admin",
      targetScope: "ALL_PROVISIONED_ACCOUNTS",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits additive IdC group membership operations", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.groupMemberships.push({
    membershipId: "gm-1",
    groupId: "g-1",
    userId: "u-1",
  });

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "addIdcGroupMembership",
      groupDisplayName: "Platform",
      userName: "alice",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits additive IdC assignment grants", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.accountAssignments = [
    ...next.identityCenter.accountAssignments,
    {
      accountId: "222222222222",
      permissionSetArn: "arn:ps-admin",
      principalId: "g-1",
      principalType: "GROUP",
    },
  ];
  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "grantIdcAccountAssignment",
      accountName: "app-b",
      permissionSetName: "Admin",
      principalType: "GROUP",
      principalName: "Platform",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits IdC assignment revokes when entities remain supported", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.identityCenter.accountAssignments = [];

  const plan = diffStates({
    current,
    next,
  });
  assert.deepEqual(plan.operations, [
    {
      kind: "revokeIdcAccountAssignment",
      accountName: "app-a",
      permissionSetName: "Admin",
      principalType: "GROUP",
      principalName: "Platform",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits IdC removal operations with prerequisite cleanup", () => {
  const current = createBaseState();
  const next = cloneState(current);
  current.identityCenter.groupMemberships.push({
    membershipId: "gm-1",
    groupId: "g-1",
    userId: "u-1",
  });
  next.identityCenter.users = [];
  next.identityCenter.groups = [];
  next.identityCenter.groupMemberships = [];
  next.identityCenter.permissionSets = [];
  next.identityCenter.accountAssignments = [];

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "removeIdcGroupMembership",
      groupDisplayName: "Platform",
      userName: "alice",
    },
    {
      kind: "revokeIdcAccountAssignment",
      accountName: "app-a",
      permissionSetName: "Admin",
      principalType: "GROUP",
      principalName: "Platform",
    },
    {
      kind: "deleteIdcUser",
      userName: "alice",
    },
    {
      kind: "deleteIdcGroup",
      groupDisplayName: "Platform",
    },
    {
      kind: "deleteIdcPermissionSet",
      permissionSetName: "Admin",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits IdC group membership removals when entities remain", () => {
  const current = createBaseState();
  current.identityCenter.groupMemberships.push({
    membershipId: "gm-1",
    groupId: "g-1",
    userId: "u-1",
  });
  const next = cloneState(current);
  next.identityCenter.groupMemberships = [];

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(plan.operations, [
    {
      kind: "removeIdcGroupMembership",
      groupDisplayName: "Platform",
      userName: "alice",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits registerDelegatedAdministrator when a new delegated admin is added", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.delegatedAdministrators = [
    { accountId: "111111111111", servicePrincipal: "sso.amazonaws.com" },
  ];

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, [
    {
      kind: "registerDelegatedAdministrator",
      accountId: "111111111111",
      accountName: "app-a",
      servicePrincipal: "sso.amazonaws.com",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits deregisterDelegatedAdministrator when a delegated admin is removed", () => {
  const current = createBaseState();
  current.organization.delegatedAdministrators = [
    { accountId: "111111111111", servicePrincipal: "sso.amazonaws.com" },
  ];
  const next = cloneState(current);
  next.organization.delegatedAdministrators = [];

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, [
    {
      kind: "deregisterDelegatedAdministrator",
      accountId: "111111111111",
      accountName: "app-a",
      servicePrincipal: "sso.amazonaws.com",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits no delegated admin operations when state is unchanged", () => {
  const current = createBaseState();
  current.organization.delegatedAdministrators = [
    { accountId: "111111111111", servicePrincipal: "sso.amazonaws.com" },
  ];
  const next = cloneState(current);

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits createOrgPolicy and attachOrgPolicy when a new backup policy is added", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.policies = [
    {
      id: "p-backup1",
      arn: "arn:aws:organizations::123456789012:policy/p-backup1",
      name: "DailyBackup",
      description: "Daily backup plan",
      type: "BACKUP_POLICY",
      content: JSON.stringify({ plans: {} }),
    },
  ];
  next.organization.policyAttachments = [
    { policyId: "p-backup1", targetId: "r-root", targetType: "ROOT" },
  ];

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, [
    {
      kind: "createOrgPolicy",
      policyName: "DailyBackup",
      policyType: "BACKUP_POLICY",
      description: "Daily backup plan",
      content: JSON.stringify({ plans: {} }),
    },
    {
      kind: "attachOrgPolicy",
      policyId: "p-backup1",
      policyName: "DailyBackup",
      targetId: "r-root",
      targetName: "root",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits detachOrgPolicy and deleteOrgPolicy when a backup policy is removed", () => {
  const current = createBaseState();
  current.organization.policies = [
    {
      id: "p-backup1",
      arn: "arn:aws:organizations::123456789012:policy/p-backup1",
      name: "DailyBackup",
      description: "Daily backup plan",
      type: "BACKUP_POLICY",
      content: JSON.stringify({ plans: {} }),
    },
  ];
  current.organization.policyAttachments = [
    { policyId: "p-backup1", targetId: "r-root", targetType: "ROOT" },
  ];
  const next = cloneState(current);
  next.organization.policies = [];
  next.organization.policyAttachments = [];

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, [
    {
      kind: "detachOrgPolicy",
      policyId: "p-backup1",
      policyName: "DailyBackup",
      targetId: "r-root",
      targetName: "root",
    },
    {
      kind: "deleteOrgPolicy",
      policyId: "p-backup1",
      policyName: "DailyBackup",
    },
  ]);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates emits no operations when backup policy state is unchanged", () => {
  const current = createBaseState();
  current.organization.policies = [
    {
      id: "p-backup1",
      arn: "arn:aws:organizations::123456789012:policy/p-backup1",
      name: "DailyBackup",
      description: "Daily backup plan",
      type: "BACKUP_POLICY",
      content: JSON.stringify({ plans: {} }),
    },
  ];
  current.organization.policyAttachments = [
    { policyId: "p-backup1", targetId: "r-root", targetType: "ROOT" },
  ];
  const next = cloneState(current);

  const plan = diffStates({ current, next });

  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.unsupported, []);
});

test("diffStates keeps deterministic mixed Organizations and IdC ordering", () => {
  const current = createBaseState();
  const next = cloneState(current);
  next.organization.accounts.push({
    id: "__pending_creation__",
    arn: "__pending_creation__",
    name: "app-c",
    email: "app-c@example.com",
    state: "ACTIVE",
    tags: [],
    parentId: "ou-eng",
  });
  next.identityCenter.users.push({
    userId: "__pending_creation__",
    userName: "bob",
    displayName: "Bob",
    email: "bob@example.com",
  });
  next.identityCenter.permissionSets.push({
    permissionSetArn: "__pending_creation__",
    name: "ReadOnly",
    description: "Read only",
    sessionDuration: null,
    inlinePolicy: null,
    awsManagedPolicies: [],
    customerManagedPolicies: [],
    permissionsBoundary: null,
  });
  next.identityCenter.accountAssignments.push({
    accountId: "__pending_creation__",
    permissionSetArn: "__pending_creation__",
    principalId: "__pending_creation__",
    principalType: "USER",
  });

  const plan = diffStates({
    current,
    next,
  });

  assert.deepEqual(
    plan.operations.map((operation) => operation.kind),
    ["createAccount", "createIdcUser", "createIdcPermissionSet", "grantIdcAccountAssignment"],
  );
});

function createBaseState(): StateFile {
  return {
    version: "1",
    generatedAt: "2026-05-01T00:00:00.000Z",
    organization: {
      organizationId: "o-test123",
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
          state: "ACTIVE",
          tags: [],
          parentId: "ou-eng",
        },
        {
          id: "222222222222",
          arn: "arn:acct-app-b",
          name: "app-b",
          email: "app-b@example.com",
          state: "ACTIVE",
          tags: [],
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
          email: "alice@example.com",
        },
      ],
      groups: [
        {
          groupId: "g-1",
          displayName: "Platform",
        },
      ],
      groupMemberships: [],
      permissionSets: [
        {
          permissionSetArn: "arn:ps-admin",
          name: "Admin",
          description: "Admin access",
          sessionDuration: null,
          inlinePolicy: null,
          awsManagedPolicies: [],
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
    (currentOrganizationalUnit) => currentOrganizationalUnit.name === props.organizationalUnitName,
  );
  if (organizationalUnit == null) {
    throw new Error(`Could not find OU "${props.organizationalUnitName}" in test state.`);
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
