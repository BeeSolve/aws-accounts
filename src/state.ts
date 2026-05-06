import { readFile, writeFile } from "node:fs/promises";
import { strictObject, array, string, pipe, minLength, parse } from "valibot";

const nonEmptyString = pipe(string(), minLength(1));

const organizationalUnitSchema = strictObject({
  id: nonEmptyString,
  parentId: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString
});

const accountSchema = strictObject({
  id: nonEmptyString,
  arn: nonEmptyString,
  name: nonEmptyString,
  email: nonEmptyString,
  status: nonEmptyString,
  parentId: nonEmptyString
});

const userSchema = strictObject({
  userId: nonEmptyString,
  userName: nonEmptyString,
  displayName: string(),
  emails: array(string())
});

const groupSchema = strictObject({
  groupId: nonEmptyString,
  displayName: nonEmptyString
});

const permissionSetSchema = strictObject({
  permissionSetArn: nonEmptyString,
  name: nonEmptyString,
  description: string()
});

const accountAssignmentSchema = strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: nonEmptyString
});

const accessRoleSchema = strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: nonEmptyString,
  roleName: nonEmptyString
});

const stateSchema = strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: strictObject({
    rootId: nonEmptyString,
    organizationalUnits: array(organizationalUnitSchema),
    accounts: array(accountSchema)
  }),
  identityCenter: strictObject({
    instanceArn: nonEmptyString,
    identityStoreId: nonEmptyString,
    users: array(userSchema),
    groups: array(groupSchema),
    permissionSets: array(permissionSetSchema),
    accountAssignments: array(accountAssignmentSchema),
    accessRoles: array(accessRoleSchema)
  })
});

export type OrganizationalUnitState = {
  id: string;
  parentId: string;
  arn: string;
  name: string;
};

export type AccountState = {
  id: string;
  arn: string;
  name: string;
  email: string;
  status: string;
  parentId: string;
};

export type UserState = {
  userId: string;
  userName: string;
  displayName: string;
  emails: string[];
};

export type GroupState = {
  groupId: string;
  displayName: string;
};

export type PermissionSetState = {
  permissionSetArn: string;
  name: string;
  description: string;
};

export type AccountAssignmentState = {
  accountId: string;
  permissionSetArn: string;
  principalId: string;
  principalType: string;
};

export type AccessRoleState = {
  accountId: string;
  permissionSetArn: string;
  principalId: string;
  principalType: string;
  roleName: string;
};

export type StateFile = {
  version: string;
  generatedAt: string;
  organization: {
    rootId: string;
    organizationalUnits: OrganizationalUnitState[];
    accounts: AccountState[];
  };
  identityCenter: {
    instanceArn: string;
    identityStoreId: string;
    users: UserState[];
    groups: GroupState[];
    permissionSets: PermissionSetState[];
    accountAssignments: AccountAssignmentState[];
    accessRoles: AccessRoleState[];
  };
};

export function validateState(value: unknown): StateFile {
  return parse(stateSchema, value);
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
