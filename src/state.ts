import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { toRecordByProperty } from "./helpers.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const principalTypeSchema = v.picklist(["GROUP", "USER"]);

const organizationalUnitSchema = v.strictObject({
  id: nonEmptyString,
  parentId: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString,
});

const accountTagSchema = v.strictObject({
  key: nonEmptyString,
  value: v.string(),
});

const accountSchema = v.strictObject({
  id: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString,
  email: nonEmptyString,
  status: nonEmptyString,
  parentId: nonEmptyString,
  tags: v.array(accountTagSchema),
});

const userSchema = v.strictObject({
  userId: nonEmptyString,
  userName: nonEmptyString,
  displayName: v.string(),
  email: v.string(),
});

const groupSchema = v.strictObject({
  groupId: nonEmptyString,
  displayName: nonEmptyString,
  description: v.optional(v.string()),
});

const groupMembershipSchema = v.strictObject({
  membershipId: nonEmptyString,
  groupId: nonEmptyString,
  userId: nonEmptyString,
});

const customerManagedPolicyReferenceSchema = v.strictObject({
  name: nonEmptyString,
  path: nonEmptyString,
});

const permissionSetSchema = v.strictObject({
  permissionSetArn: nonEmptyString,
  name: nonEmptyString,
  description: v.string(),
  sessionDuration: v.nullable(v.string()),
  inlinePolicy: v.nullable(nonEmptyString),
  awsManagedPolicies: v.array(nonEmptyString),
  customerManagedPolicies: v.array(customerManagedPolicyReferenceSchema),
});

const accountAssignmentSchema = v.strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: principalTypeSchema,
});

const accessRoleSchema = v.strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: principalTypeSchema,
  roleName: nonEmptyString,
});

export const stateSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: v.strictObject({
    rootId: nonEmptyString,
    organizationalUnits: v.array(organizationalUnitSchema),
    accounts: v.array(accountSchema),
  }),
  identityCenter: v.strictObject({
    instanceArn: nonEmptyString,
    identityStoreId: nonEmptyString,
    users: v.array(userSchema),
    groups: v.array(groupSchema),
    groupMemberships: v.array(groupMembershipSchema),
    permissionSets: v.array(permissionSetSchema),
    accountAssignments: v.array(accountAssignmentSchema),
    accessRoles: v.array(accessRoleSchema),
  }),
});

export type OrganizationalUnitState = v.InferOutput<
  typeof organizationalUnitSchema
>;
export type AccountState = v.InferOutput<typeof accountSchema>;
export type UserState = v.InferOutput<typeof userSchema>;
export type GroupState = v.InferOutput<typeof groupSchema>;
export type GroupMembershipState = v.InferOutput<typeof groupMembershipSchema>;
export type CustomerManagedPolicyReferenceState = v.InferOutput<
  typeof customerManagedPolicyReferenceSchema
>;
export type PermissionSetState = v.InferOutput<typeof permissionSetSchema>;
export type AccountAssignmentState = v.InferOutput<
  typeof accountAssignmentSchema
>;
export type AccessRoleState = v.InferOutput<typeof accessRoleSchema>;
export type StateFile = v.InferOutput<typeof stateSchema>;

type WorkingIdentityCenterState = {
  instanceArn: StateFile["identityCenter"]["instanceArn"];
  identityStoreId: StateFile["identityCenter"]["identityStoreId"];
  users: UserState[];
  usersByUserName: Record<string, UserState>;
  groups: GroupState[];
  groupsByDisplayName: Record<string, GroupState>;
  groupMemberships: GroupMembershipState[];
  groupMembershipsByKey: Record<string, GroupMembershipState>;
  permissionSets: PermissionSetState[];
  permissionSetsByName: Record<string, PermissionSetState>;
  accountAssignments: AccountAssignmentState[];
  accountAssignmentsByKey: Record<string, AccountAssignmentState>;
  accessRoles: AccessRoleState[];
};

export type WorkingState = {
  version: StateFile["version"];
  generatedAt: StateFile["generatedAt"];
  organization: {
    rootId: StateFile["organization"]["rootId"];
    organizationalUnitsById: Record<string, OrganizationalUnitState>;
    accountsById: Record<string, AccountState>;
    accountsByName: Record<string, AccountState>;
  };
  identityCenter: WorkingIdentityCenterState;
};

export function validateState(value: unknown): StateFile {
  return v.parse(stateSchema, value);
}

export function createWorkingState(props: { state: StateFile }): WorkingState {
  return {
    version: props.state.version,
    generatedAt: props.state.generatedAt,
    organization: {
      rootId: props.state.organization.rootId,
      organizationalUnitsById: toRecordByProperty(
        props.state.organization.organizationalUnits,
        "id",
      ),
      accountsById: toRecordByProperty(props.state.organization.accounts, "id"),
      accountsByName: toRecordByProperty(
        props.state.organization.accounts,
        "name",
      ),
    },
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: props.state.identityCenter,
    }),
  };
}

export function materializeWorkingState(props: {
  workingState: WorkingState;
}): StateFile {
  return {
    version: props.workingState.version,
    generatedAt: props.workingState.generatedAt,
    organization: {
      rootId: props.workingState.organization.rootId,
      organizationalUnits: Object.values(
        props.workingState.organization.organizationalUnitsById,
      ),
      accounts: Object.values(props.workingState.organization.accountsById),
    },
    identityCenter: {
      instanceArn: props.workingState.identityCenter.instanceArn,
      identityStoreId: props.workingState.identityCenter.identityStoreId,
      users: structuredClone(props.workingState.identityCenter.users),
      groups: structuredClone(props.workingState.identityCenter.groups),
      groupMemberships: structuredClone(
        props.workingState.identityCenter.groupMemberships,
      ),
      permissionSets: structuredClone(
        props.workingState.identityCenter.permissionSets,
      ),
      accountAssignments: structuredClone(
        props.workingState.identityCenter.accountAssignments,
      ),
      accessRoles: structuredClone(
        props.workingState.identityCenter.accessRoles,
      ),
    },
  };
}

export function moveAccountInWorkingState(props: {
  workingState: WorkingState;
  accountId: string;
  parentId: string;
}): WorkingState {
  const currentAccount =
    props.workingState.organization.accountsById[props.accountId];
  if (currentAccount == null || currentAccount.parentId === props.parentId) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      accountsById: {
        ...props.workingState.organization.accountsById,
        [props.accountId]: {
          ...currentAccount,
          parentId: props.parentId,
        },
      },
      accountsByName: {
        ...props.workingState.organization.accountsByName,
        [currentAccount.name]: {
          ...currentAccount,
          parentId: props.parentId,
        },
      },
    },
  };
}

export function upsertAccountInWorkingState(props: {
  workingState: WorkingState;
  account: AccountState;
}): WorkingState {
  const currentAccount =
    props.workingState.organization.accountsById[props.account.id];
  if (
    currentAccount != null &&
    currentAccount.id === props.account.id &&
    currentAccount.arn === props.account.arn &&
    currentAccount.name === props.account.name &&
    currentAccount.email === props.account.email &&
    currentAccount.status === props.account.status &&
    currentAccount.parentId === props.account.parentId &&
    JSON.stringify(normalizeAccountTags(currentAccount.tags)) ===
      JSON.stringify(normalizeAccountTags(props.account.tags))
  ) {
    return props.workingState;
  }
  let accountsByName = {
    ...props.workingState.organization.accountsByName,
  };
  if (currentAccount != null && currentAccount.name !== props.account.name) {
    const { [currentAccount.name]: _removed, ...rest } = accountsByName;
    accountsByName = rest;
  }
  accountsByName = {
    ...accountsByName,
    [props.account.name]: props.account,
  };
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      accountsById: {
        ...props.workingState.organization.accountsById,
        [props.account.id]: props.account,
      },
      accountsByName,
    },
  };
}

export function upsertOrganizationalUnitInWorkingState(props: {
  workingState: WorkingState;
  organizationalUnit: OrganizationalUnitState;
}): WorkingState {
  const currentOrganizationalUnit =
    props.workingState.organization.organizationalUnitsById[
      props.organizationalUnit.id
    ];
  if (
    currentOrganizationalUnit != null &&
    currentOrganizationalUnit.id === props.organizationalUnit.id &&
    currentOrganizationalUnit.parentId === props.organizationalUnit.parentId &&
    currentOrganizationalUnit.arn === props.organizationalUnit.arn &&
    currentOrganizationalUnit.name === props.organizationalUnit.name
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      organizationalUnitsById: {
        ...props.workingState.organization.organizationalUnitsById,
        [props.organizationalUnit.id]: props.organizationalUnit,
      },
    },
  };
}

export function renameOrganizationalUnitInWorkingState(props: {
  workingState: WorkingState;
  organizationalUnitId: string;
  name: string;
}): WorkingState {
  const currentOrganizationalUnit =
    props.workingState.organization.organizationalUnitsById[
      props.organizationalUnitId
    ];
  if (
    currentOrganizationalUnit == null ||
    currentOrganizationalUnit.name === props.name
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      organizationalUnitsById: {
        ...props.workingState.organization.organizationalUnitsById,
        [props.organizationalUnitId]: {
          ...currentOrganizationalUnit,
          name: props.name,
        },
      },
    },
  };
}

export function removeOrganizationalUnitFromWorkingState(props: {
  workingState: WorkingState;
  organizationalUnitId: string;
}): WorkingState {
  if (
    props.workingState.organization.organizationalUnitsById[
      props.organizationalUnitId
    ] == null
  ) {
    return props.workingState;
  }
  const nextOrganizationalUnitsById = {
    ...props.workingState.organization.organizationalUnitsById,
  };
  delete nextOrganizationalUnitsById[props.organizationalUnitId];
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      organizationalUnitsById: nextOrganizationalUnitsById,
    },
  };
}

function createAccountAssignmentKey(props: {
  accountId: string;
  permissionSetArn: string;
  principalId: string;
  principalType: AccountAssignmentState["principalType"];
}): string {
  return [
    props.accountId,
    props.permissionSetArn,
    props.principalId,
    props.principalType,
  ].join("|");
}

export function createGroupMembershipKey(props: {
  groupId: string;
  userId: string;
}): string {
  return [props.groupId, props.userId].join("|");
}

export function upsertIdcUserInWorkingState(props: {
  workingState: WorkingState;
  user: UserState;
}): WorkingState {
  const currentUser =
    props.workingState.identityCenter.usersByUserName[props.user.userName];
  if (
    currentUser != null &&
    currentUser.userId === props.user.userId &&
    currentUser.displayName === props.user.displayName &&
    currentUser.userName === props.user.userName &&
    currentUser.email === props.user.email
  ) {
    return props.workingState;
  }
  const remainingUsers = props.workingState.identityCenter.users.filter(
    (user) => user.userName !== props.user.userName,
  );
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        users: [...remainingUsers, props.user],
      },
    }),
  };
}

export function removeIdcUserFromWorkingState(props: {
  workingState: WorkingState;
  userName: string;
}): WorkingState {
  const user =
    props.workingState.identityCenter.usersByUserName[props.userName];
  if (user == null) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        users: props.workingState.identityCenter.users.filter(
          (currentUser) => currentUser.userName !== props.userName,
        ),
        groupMemberships: props.workingState.identityCenter.groupMemberships.filter(
          (groupMembership) => groupMembership.userId !== user.userId,
        ),
        accountAssignments:
          props.workingState.identityCenter.accountAssignments.filter(
            (accountAssignment) =>
              accountAssignment.principalType !== "USER" ||
              accountAssignment.principalId !== user.userId,
          ),
      },
    }),
  };
}

export function upsertIdcGroupInWorkingState(props: {
  workingState: WorkingState;
  group: GroupState;
}): WorkingState {
  const currentGroup =
    props.workingState.identityCenter.groupsByDisplayName[
      props.group.displayName
    ];
  if (
    currentGroup != null &&
    currentGroup.groupId === props.group.groupId &&
    currentGroup.displayName === props.group.displayName &&
    (currentGroup.description ?? "") === (props.group.description ?? "")
  ) {
    return props.workingState;
  }
  const remainingGroups = props.workingState.identityCenter.groups.filter(
    (group) => group.displayName !== props.group.displayName,
  );
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        groups: [...remainingGroups, props.group],
      },
    }),
  };
}

export function removeIdcGroupFromWorkingState(props: {
  workingState: WorkingState;
  groupDisplayName: string;
}): WorkingState {
  const group =
    props.workingState.identityCenter.groupsByDisplayName[
      props.groupDisplayName
    ];
  if (group == null) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        groups: props.workingState.identityCenter.groups.filter(
          (currentGroup) =>
            currentGroup.displayName !== props.groupDisplayName,
        ),
        groupMemberships: props.workingState.identityCenter.groupMemberships.filter(
          (groupMembership) => groupMembership.groupId !== group.groupId,
        ),
        accountAssignments:
          props.workingState.identityCenter.accountAssignments.filter(
            (accountAssignment) =>
              accountAssignment.principalType !== "GROUP" ||
              accountAssignment.principalId !== group.groupId,
          ),
      },
    }),
  };
}

export function upsertIdcPermissionSetInWorkingState(props: {
  workingState: WorkingState;
  permissionSet: PermissionSetState;
}): WorkingState {
  const currentPermissionSet =
    props.workingState.identityCenter.permissionSetsByName[
      props.permissionSet.name
    ];
  if (
    currentPermissionSet != null &&
    currentPermissionSet.permissionSetArn ===
      props.permissionSet.permissionSetArn &&
    currentPermissionSet.name === props.permissionSet.name &&
    currentPermissionSet.description === props.permissionSet.description &&
    currentPermissionSet.sessionDuration === props.permissionSet.sessionDuration &&
    currentPermissionSet.inlinePolicy === props.permissionSet.inlinePolicy &&
    JSON.stringify(currentPermissionSet.awsManagedPolicies) ===
      JSON.stringify(props.permissionSet.awsManagedPolicies) &&
    JSON.stringify(currentPermissionSet.customerManagedPolicies) ===
      JSON.stringify(props.permissionSet.customerManagedPolicies)
  ) {
    return props.workingState;
  }
  const remainingPermissionSets =
    props.workingState.identityCenter.permissionSets.filter(
      (permissionSet) => permissionSet.name !== props.permissionSet.name,
    );
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        permissionSets: [...remainingPermissionSets, props.permissionSet],
      },
    }),
  };
}

export function removeIdcPermissionSetFromWorkingState(props: {
  workingState: WorkingState;
  permissionSetName: string;
}): WorkingState {
  const permissionSet =
    props.workingState.identityCenter.permissionSetsByName[
      props.permissionSetName
    ];
  if (permissionSet == null) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        permissionSets: props.workingState.identityCenter.permissionSets.filter(
          (currentPermissionSet) =>
            currentPermissionSet.name !== props.permissionSetName,
        ),
        accountAssignments:
          props.workingState.identityCenter.accountAssignments.filter(
            (accountAssignment) =>
              accountAssignment.permissionSetArn !==
              permissionSet.permissionSetArn,
          ),
      },
    }),
  };
}

export function addAccountAssignmentToWorkingState(props: {
  workingState: WorkingState;
  accountAssignment: AccountAssignmentState;
}): WorkingState {
  const assignmentKey = createAccountAssignmentKey({
    accountId: props.accountAssignment.accountId,
    permissionSetArn: props.accountAssignment.permissionSetArn,
    principalId: props.accountAssignment.principalId,
    principalType: props.accountAssignment.principalType,
  });
  if (
    props.workingState.identityCenter.accountAssignmentsByKey[assignmentKey] !=
    null
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        accountAssignments: [
          ...props.workingState.identityCenter.accountAssignments,
          props.accountAssignment,
        ],
      },
    }),
  };
}

export function addGroupMembershipToWorkingState(props: {
  workingState: WorkingState;
  groupMembership: GroupMembershipState;
}): WorkingState {
  const membershipKey = createGroupMembershipKey({
    groupId: props.groupMembership.groupId,
    userId: props.groupMembership.userId,
  });
  if (
    props.workingState.identityCenter.groupMembershipsByKey[membershipKey] !=
    null
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        groupMemberships: [
          ...props.workingState.identityCenter.groupMemberships,
          props.groupMembership,
        ],
      },
    }),
  };
}

export function removeGroupMembershipFromWorkingState(props: {
  workingState: WorkingState;
  groupMembership: Pick<GroupMembershipState, "groupId" | "userId">;
}): WorkingState {
  const membershipKey = createGroupMembershipKey({
    groupId: props.groupMembership.groupId,
    userId: props.groupMembership.userId,
  });
  if (
    props.workingState.identityCenter.groupMembershipsByKey[membershipKey] ==
    null
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        groupMemberships:
          props.workingState.identityCenter.groupMemberships.filter(
            (groupMembership) =>
              createGroupMembershipKey({
                groupId: groupMembership.groupId,
                userId: groupMembership.userId,
              }) !== membershipKey,
          ),
      },
    }),
  };
}

export function removeAccountAssignmentFromWorkingState(props: {
  workingState: WorkingState;
  accountAssignment: AccountAssignmentState;
}): WorkingState {
  const assignmentKey = createAccountAssignmentKey({
    accountId: props.accountAssignment.accountId,
    permissionSetArn: props.accountAssignment.permissionSetArn,
    principalId: props.accountAssignment.principalId,
    principalType: props.accountAssignment.principalType,
  });
  if (
    props.workingState.identityCenter.accountAssignmentsByKey[assignmentKey] ==
    null
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        accountAssignments:
          props.workingState.identityCenter.accountAssignments.filter(
            (accountAssignment) =>
              createAccountAssignmentKey({
                accountId: accountAssignment.accountId,
                permissionSetArn: accountAssignment.permissionSetArn,
                principalId: accountAssignment.principalId,
                principalType: accountAssignment.principalType,
              }) !== assignmentKey,
          ),
      },
    }),
  };
}

export async function readStateFile(path: string): Promise<StateFile> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return validateState(parsed);
}

export function createAccessRoleName(
  assignment: AccountAssignmentState,
): string {
  return `AWSReservedSSO_${assignment.permissionSetArn.split("/").at(-1) ?? "PermissionSet"}_${assignment.accountId}`;
}

function createWorkingIdentityCenterState(props: {
  identityCenter: StateFile["identityCenter"];
}): WorkingIdentityCenterState {
  const users = structuredClone(props.identityCenter.users);
  const groups = structuredClone(props.identityCenter.groups);
  const groupMemberships = structuredClone(
    props.identityCenter.groupMemberships,
  );
  const permissionSets = structuredClone(props.identityCenter.permissionSets);
  const accountAssignments = structuredClone(
    props.identityCenter.accountAssignments,
  );
  return {
    instanceArn: props.identityCenter.instanceArn,
    identityStoreId: props.identityCenter.identityStoreId,
    users,
    usersByUserName: toRecordByProperty(users, "userName"),
    groups,
    groupsByDisplayName: toRecordByProperty(groups, "displayName"),
    groupMemberships,
    groupMembershipsByKey: toRecordByProperty(
      groupMemberships,
      createGroupMembershipKey,
    ),
    permissionSets,
    permissionSetsByName: toRecordByProperty(permissionSets, "name"),
    accountAssignments,
    accountAssignmentsByKey: toRecordByProperty(
      accountAssignments,
      createAccountAssignmentKey,
    ),
    accessRoles: createAccessRoles({
      accountAssignments,
    }),
  };
}

function materializeWorkingIdentityCenterState(props: {
  identityCenter: WorkingIdentityCenterState;
}): StateFile["identityCenter"] {
  return {
    instanceArn: props.identityCenter.instanceArn,
    identityStoreId: props.identityCenter.identityStoreId,
    users: structuredClone(props.identityCenter.users),
    groups: structuredClone(props.identityCenter.groups),
    groupMemberships: structuredClone(props.identityCenter.groupMemberships),
    permissionSets: structuredClone(props.identityCenter.permissionSets),
    accountAssignments: structuredClone(
      props.identityCenter.accountAssignments,
    ),
    accessRoles: structuredClone(props.identityCenter.accessRoles),
  };
}

function createAccessRoles(props: {
  accountAssignments: AccountAssignmentState[];
}): AccessRoleState[] {
  return props.accountAssignments.map((accountAssignment) => ({
    accountId: accountAssignment.accountId,
    permissionSetArn: accountAssignment.permissionSetArn,
    principalId: accountAssignment.principalId,
    principalType: accountAssignment.principalType,
    roleName: createAccessRoleName(accountAssignment),
  }));
}

function compareByKeys(...values: string[]): number {
  for (let index = 0; index < values.length; index += 2) {
    const left = values[index] ?? "";
    const right = values[index + 1] ?? "";
    const compared = left.localeCompare(right);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function normalizeInlinePolicyString(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(sortJsonValue(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
}

function normalizeAccountTags(
  tags: Array<{ key: string; value: string }> | undefined,
): Array<{ key: string; value: string }> {
  if (tags == null || tags.length === 0) {
    return [];
  }
  return [...tags].sort((left, right) =>
    compareByKeys(left.key, right.key, left.value, right.value),
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
    );
  }
  return value;
}
