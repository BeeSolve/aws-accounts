import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

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
  emails: v.array(v.string())
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
  principalType: nonEmptyString
});

const accessRoleSchema = v.strictObject({
  accountId: nonEmptyString,
  permissionSetArn: nonEmptyString,
  principalId: nonEmptyString,
  principalType: nonEmptyString,
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
