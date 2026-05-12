import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { toRecordByProperty } from "./helpers.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const principalTypeSchema = v.picklist(["GROUP", "USER"]);

const organizationalUnitSchema = v.strictObject({
  id: nonEmptyString,
  parentId: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString
});

const accountSchema = v.strictObject({
  id: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString,
  email: nonEmptyString,
  status: nonEmptyString,
  parentId: nonEmptyString
});

const userSchema = v.strictObject({
  userId: nonEmptyString,
  userName: nonEmptyString,
  displayName: v.string(),
  email: v.string()
});

const groupSchema = v.strictObject({
  groupId: nonEmptyString,
  displayName: nonEmptyString
});

const permissionSetSchema = v.strictObject({
  permissionSetArn: nonEmptyString,
  name: nonEmptyString,
  description: v.string()
});

const accountAssignmentSchema = v.strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: principalTypeSchema
});

const accessRoleSchema = v.strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: principalTypeSchema,
  roleName: nonEmptyString
});

const stateSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: v.strictObject({
    rootId: nonEmptyString,
    organizationalUnits: v.array(organizationalUnitSchema),
    accounts: v.array(accountSchema)
  }),
  identityCenter: v.strictObject({
    instanceArn: nonEmptyString,
    identityStoreId: nonEmptyString,
    users: v.array(userSchema),
    groups: v.array(groupSchema),
    permissionSets: v.array(permissionSetSchema),
    accountAssignments: v.array(accountAssignmentSchema),
    accessRoles: v.array(accessRoleSchema)
  })
});

export type OrganizationalUnitState = v.InferOutput<typeof organizationalUnitSchema>;
export type AccountState = v.InferOutput<typeof accountSchema>;
export type UserState = v.InferOutput<typeof userSchema>;
export type GroupState = v.InferOutput<typeof groupSchema>;
export type PermissionSetState = v.InferOutput<typeof permissionSetSchema>;
export type AccountAssignmentState = v.InferOutput<typeof accountAssignmentSchema>;
export type AccessRoleState = v.InferOutput<typeof accessRoleSchema>;
export type StateFile = v.InferOutput<typeof stateSchema>;

type WorkingIdentityCenterState = {
  instanceArn: StateFile["identityCenter"]["instanceArn"];
  identityStoreId: StateFile["identityCenter"]["identityStoreId"];
  users: UserState[];
  usersByUserName: Record<string, UserState>;
  groups: GroupState[];
  groupsByDisplayName: Record<string, GroupState>;
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

export function normalizeState(state: StateFile): StateFile {
  return {
    ...state,
    organization: {
      ...state.organization,
      organizationalUnits: [...state.organization.organizationalUnits].sort((a, b) =>
        compareByKeys(a.id, b.id, a.arn, b.arn, a.name, b.name)
      ),
      accounts: [...state.organization.accounts].sort((a, b) =>
        compareByKeys(a.id, b.id, a.arn, b.arn, a.name, b.name)
      )
    },
    identityCenter: {
      ...state.identityCenter,
      users: [...state.identityCenter.users].sort((a, b) =>
        compareByKeys(a.userId, b.userId, a.userName, b.userName, a.displayName, b.displayName)
      ),
      groups: [...state.identityCenter.groups].sort((a, b) => compareByKeys(a.groupId, b.groupId, a.displayName, b.displayName)),
      permissionSets: [...state.identityCenter.permissionSets].sort((a, b) =>
        compareByKeys(a.permissionSetArn, b.permissionSetArn, a.name, b.name)
      ),
      accountAssignments: [...state.identityCenter.accountAssignments].sort((a, b) =>
        compareByKeys(
          a.accountId,
          b.accountId,
          a.permissionSetArn,
          b.permissionSetArn,
          a.principalId,
          b.principalId,
          a.principalType,
          b.principalType
        )
      ),
      accessRoles: [...state.identityCenter.accessRoles].sort((a, b) =>
        compareByKeys(
          a.accountId,
          b.accountId,
          a.permissionSetArn,
          b.permissionSetArn,
          a.principalId,
          b.principalId,
          a.principalType,
          b.principalType,
          a.roleName,
          b.roleName
        )
      )
    }
  };
}

export function createWorkingState(props: { state: StateFile }): WorkingState {
  return {
    version: props.state.version,
    generatedAt: props.state.generatedAt,
    organization: {
      rootId: props.state.organization.rootId,
      organizationalUnitsById: toRecordByProperty(
        props.state.organization.organizationalUnits,
        "id"
      ),
      accountsById: toRecordByProperty(props.state.organization.accounts, "id"),
      accountsByName: toRecordByProperty(props.state.organization.accounts, "name")
    },
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: props.state.identityCenter,
    })
  };
}

export function materializeWorkingState(props: { workingState: WorkingState }): StateFile {
  return {
    version: props.workingState.version,
    generatedAt: props.workingState.generatedAt,
    organization: {
      rootId: props.workingState.organization.rootId,
      organizationalUnits: Object.values(props.workingState.organization.organizationalUnitsById),
      accounts: Object.values(props.workingState.organization.accountsById)
    },
    identityCenter: {
      instanceArn: props.workingState.identityCenter.instanceArn,
      identityStoreId: props.workingState.identityCenter.identityStoreId,
      users: structuredClone(props.workingState.identityCenter.users),
      groups: structuredClone(props.workingState.identityCenter.groups),
      permissionSets: structuredClone(props.workingState.identityCenter.permissionSets),
      accountAssignments: structuredClone(
        props.workingState.identityCenter.accountAssignments,
      ),
      accessRoles: structuredClone(props.workingState.identityCenter.accessRoles),
    }
  };
}

export function moveAccountInWorkingState(props: {
  workingState: WorkingState;
  accountId: string;
  parentId: string;
}): WorkingState {
  const currentAccount = props.workingState.organization.accountsById[props.accountId];
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
          parentId: props.parentId
        }
      },
      accountsByName: {
        ...props.workingState.organization.accountsByName,
        [currentAccount.name]: {
          ...currentAccount,
          parentId: props.parentId
        }
      }
    }
  };
}

export function upsertAccountInWorkingState(props: {
  workingState: WorkingState;
  account: AccountState;
}): WorkingState {
  const currentAccount = props.workingState.organization.accountsById[props.account.id];
  if (
    currentAccount != null &&
    currentAccount.id === props.account.id &&
    currentAccount.arn === props.account.arn &&
    currentAccount.name === props.account.name &&
    currentAccount.email === props.account.email &&
    currentAccount.status === props.account.status &&
    currentAccount.parentId === props.account.parentId
  ) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    organization: {
      ...props.workingState.organization,
      accountsById: {
        ...props.workingState.organization.accountsById,
        [props.account.id]: props.account
      },
      accountsByName: {
        ...props.workingState.organization.accountsByName,
        [props.account.name]: props.account
      }
    }
  };
}

export function upsertOrganizationalUnitInWorkingState(props: {
  workingState: WorkingState;
  organizationalUnit: OrganizationalUnitState;
}): WorkingState {
  const currentOrganizationalUnit =
    props.workingState.organization.organizationalUnitsById[props.organizationalUnit.id];
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
        [props.organizationalUnit.id]: props.organizationalUnit
      }
    }
  };
}

export function renameOrganizationalUnitInWorkingState(props: {
  workingState: WorkingState;
  organizationalUnitId: string;
  name: string;
}): WorkingState {
  const currentOrganizationalUnit =
    props.workingState.organization.organizationalUnitsById[props.organizationalUnitId];
  if (currentOrganizationalUnit == null || currentOrganizationalUnit.name === props.name) {
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
          name: props.name
        }
      }
    }
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

export function createAccountAssignmentKey(props: {
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

export function upsertIdcGroupInWorkingState(props: {
  workingState: WorkingState;
  group: GroupState;
}): WorkingState {
  const currentGroup =
    props.workingState.identityCenter.groupsByDisplayName[props.group.displayName];
  if (
    currentGroup != null &&
    currentGroup.groupId === props.group.groupId &&
    currentGroup.displayName === props.group.displayName
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
    currentPermissionSet.permissionSetArn === props.permissionSet.permissionSetArn &&
    currentPermissionSet.name === props.permissionSet.name &&
    currentPermissionSet.description === props.permissionSet.description
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
  if (props.workingState.identityCenter.accountAssignmentsByKey[assignmentKey] != null) {
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
  if (props.workingState.identityCenter.accountAssignmentsByKey[assignmentKey] == null) {
    return props.workingState;
  }
  return {
    ...props.workingState,
    identityCenter: createWorkingIdentityCenterState({
      identityCenter: {
        ...materializeWorkingIdentityCenterState({
          identityCenter: props.workingState.identityCenter,
        }),
        accountAssignments: props.workingState.identityCenter.accountAssignments.filter(
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

export function buildEmptyState(): StateFile {
  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    organization: {
      rootId: "",
      organizationalUnits: [],
      accounts: []
    },
    identityCenter: {
      instanceArn: "",
      identityStoreId: "",
      users: [],
      groups: [],
      permissionSets: [],
      accountAssignments: [],
      accessRoles: []
    }
  };
}

export async function readStateFile(path: string): Promise<StateFile> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return validateState(parsed);
}

export async function writeStateFile(path: string, state: StateFile): Promise<void> {
  const validated = validateState(state);
  const normalized = normalizeState(validated);
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  await writeFile(path, content, "utf8");
}

export function createAccessRoleName(assignment: AccountAssignmentState): string {
  return `AWSReservedSSO_${assignment.permissionSetArn.split("/").at(-1) ?? "PermissionSet"}_${assignment.accountId}`;
}

function createWorkingIdentityCenterState(props: {
  identityCenter: StateFile["identityCenter"];
}): WorkingIdentityCenterState {
  const users = structuredClone(props.identityCenter.users);
  const groups = structuredClone(props.identityCenter.groups);
  const permissionSets = structuredClone(props.identityCenter.permissionSets);
  const accountAssignments = structuredClone(props.identityCenter.accountAssignments);
  return {
    instanceArn: props.identityCenter.instanceArn,
    identityStoreId: props.identityCenter.identityStoreId,
    users,
    usersByUserName: toRecordByProperty(users, "userName"),
    groups,
    groupsByDisplayName: toRecordByProperty(groups, "displayName"),
    permissionSets,
    permissionSetsByName: toRecordByProperty(permissionSets, "name"),
    accountAssignments,
    accountAssignmentsByKey: Object.fromEntries(
      accountAssignments.map((accountAssignment) => [
        createAccountAssignmentKey({
          accountId: accountAssignment.accountId,
          permissionSetArn: accountAssignment.permissionSetArn,
          principalId: accountAssignment.principalId,
          principalType: accountAssignment.principalType,
        }),
        accountAssignment,
      ]),
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
    permissionSets: structuredClone(props.identityCenter.permissionSets),
    accountAssignments: structuredClone(props.identityCenter.accountAssignments),
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
