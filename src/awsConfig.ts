import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuildBuild } from "esbuild";
import * as v from "valibot";
import {
  createAccessRoleName,
  readStateFile,
  type StateFile,
  validateState,
} from "./state.js";

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const pendingCreationId = "__pending_creation__" as const;

const awsContextSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: v.strictObject({
    managementAccountId: nonEmptyString,
    rootId: nonEmptyString,
    pendingOuId: nonEmptyString,
    graveyardOuId: nonEmptyString,
  }),
  identityCenter: v.strictObject({
    instanceArn: nonEmptyString,
    identityStoreId: nonEmptyString,
  }),
  deployment: v.strictObject({
    profile: v.string(),
    region: v.string(),
    lambdaArn: v.string(),
    stateBucketName: v.string(),
  }),
});

type AwsContextFile = v.InferOutput<typeof awsContextSchema>;

const awsConfigModelSchema = v.strictObject({
  organizationalUnits: v.array(
    v.strictObject({
      name: v.string(),
      parentName: v.nullable(v.string()),
      accounts: v.array(
        v.strictObject({
          name: v.string(),
          email: v.string(),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      emails: v.array(v.string()),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
    }),
  ),
  assignments: v.array(
    v.strictObject({
      permissionSet: v.string(),
      group: v.optional(v.string()),
      user: v.optional(v.string()),
      accounts: v.array(v.string()),
    }),
  ),
});

type AwsConfigModel = v.InferOutput<typeof awsConfigModelSchema>;

type WriteAwsConfigFromStateInput = {
  statePath: string;
  contextPath: string;
  configPath: string;
  typesPath: string;
  overwriteConfirmation: (props: {
    fileSummaries: string[];
  }) => Promise<boolean>;
};

type WriteAwsConfigFromStateResult = {
  configPath: string;
  typesPath: string;
  files: FileWriteResult[];
};

type RegenerateAwsConfigTypesInput = {
  configPath: string;
  typesPath: string;
  overwriteConfirmation: (props: {
    fileSummaries: string[];
  }) => Promise<boolean>;
};

type RegenerateAwsConfigTypesResult = {
  typesPath: string;
  changed: boolean;
  files: FileWriteResult[];
};

type AwsConfigTypesModule = {
  awsConfigSchema: v.GenericSchema;
};

const moduleDirectoryPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
);
const projectRootPath = resolve(moduleDirectoryPath, "..");

type ChangedFile = {
  path: string;
  previousBytes: number;
  nextBytes: number;
  content: string;
};

type FileWriteStatus = "written" | "unchanged" | "would-write";

type FileWriteResult = {
  path: string;
  status: FileWriteStatus;
};

type MapAssignmentPrincipalResult =
  | { kind: "group"; value: string }
  | { kind: "user"; value: string };

type MapAwsConfigToStateProps = {
  config: AwsConfigModel;
  currentState: StateFile;
  context: AwsContextFile;
};

export async function writeAwsConfigFromState(
  props: WriteAwsConfigFromStateInput,
): Promise<WriteAwsConfigFromStateResult> {
  const state = await readStateFile(props.statePath);
  const context = await readAwsContextFile(props.contextPath);
  assertStateMatchesContext({
    state: state,
    context: context,
  });

  const mappedConfig = mapStateToAwsConfig({
    state: state,
  });
  const sortedConfig = sortAwsConfigModel({
    config: mappedConfig,
  });
  const nextConfigContent = renderAwsConfigTs({
    config: sortedConfig,
  });
  const nextTypesContent = renderAwsConfigTypesTs({
    config: sortedConfig,
  });

  const [currentConfigContent, currentTypesContent] = await Promise.all([
    readIfExists(props.configPath),
    readIfExists(props.typesPath),
  ]);

  const changedFiles: ChangedFile[] = [];
  if (currentConfigContent !== nextConfigContent) {
    changedFiles.push({
      path: props.configPath,
      previousBytes: Buffer.byteLength(currentConfigContent ?? "", "utf8"),
      nextBytes: Buffer.byteLength(nextConfigContent, "utf8"),
      content: nextConfigContent,
    });
  }
  if (currentTypesContent !== nextTypesContent) {
    changedFiles.push({
      path: props.typesPath,
      previousBytes: Buffer.byteLength(currentTypesContent ?? "", "utf8"),
      nextBytes: Buffer.byteLength(nextTypesContent, "utf8"),
      content: nextTypesContent,
    });
  }

  if (changedFiles.length === 0) {
    console.log("No changes.");
    return {
      configPath: props.configPath,
      typesPath: props.typesPath,
      files: [
        {
          path: props.configPath,
          status: "unchanged",
        },
        {
          path: props.typesPath,
          status: "unchanged",
        },
      ],
    };
  }

  const fileSummaries = changedFiles.map(
    (file) => `${file.path}: ${file.previousBytes} -> ${file.nextBytes} bytes`,
  );
  for (const fileSummary of fileSummaries) {
    console.log(fileSummary);
  }
  console.log(`Review with: git diff ${props.configPath} ${props.typesPath}`);

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries: fileSummaries,
  });
  if (!shouldWrite) {
    console.log("Config write cancelled.");
    return {
      configPath: props.configPath,
      typesPath: props.typesPath,
      files: [
        {
          path: props.configPath,
          status:
            currentConfigContent === nextConfigContent
              ? "unchanged"
              : "would-write",
        },
        {
          path: props.typesPath,
          status:
            currentTypesContent === nextTypesContent
              ? "unchanged"
              : "would-write",
        },
      ],
    };
  }

  await Promise.all(
    changedFiles.map((file) => writeFile(file.path, file.content, "utf8")),
  );
  return {
    configPath: props.configPath,
    typesPath: props.typesPath,
    files: [
      {
        path: props.configPath,
        status:
          currentConfigContent === nextConfigContent ? "unchanged" : "written",
      },
      {
        path: props.typesPath,
        status:
          currentTypesContent === nextTypesContent ? "unchanged" : "written",
      },
    ],
  };
}

export async function regenerateAwsConfigTypes(
  props: RegenerateAwsConfigTypesInput,
): Promise<RegenerateAwsConfigTypesResult> {
  const typesModule = await loadAwsConfigTypesModule({
    typesPath: props.typesPath,
  });
  const loadedConfig = await loadAwsConfigFromTsFile({
    configPath: props.configPath,
    schema: typesModule.awsConfigSchema,
  });
  const sortedConfig = sortAwsConfigModel({
    config: loadedConfig,
  });
  const nextTypesContent = renderAwsConfigTypesTs({
    config: sortedConfig,
  });
  const currentTypesContent = await readIfExists(props.typesPath);
  if (currentTypesContent === nextTypesContent) {
    console.log("No changes.");
    return {
      typesPath: props.typesPath,
      changed: false,
      files: [
        {
          path: props.typesPath,
          status: "unchanged",
        },
      ],
    };
  }

  const fileSummary = `${props.typesPath}: ${Buffer.byteLength(currentTypesContent ?? "", "utf8")} -> ${Buffer.byteLength(nextTypesContent, "utf8")} bytes`;
  console.log(fileSummary);
  console.log(`Review with: git diff ${props.typesPath}`);

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries: [fileSummary],
  });
  if (!shouldWrite) {
    console.log("Types write cancelled.");
    return {
      typesPath: props.typesPath,
      changed: false,
      files: [
        {
          path: props.typesPath,
          status: "would-write",
        },
      ],
    };
  }

  await writeFile(props.typesPath, nextTypesContent, "utf8");
  return {
    typesPath: props.typesPath,
    changed: true,
    files: [
      {
        path: props.typesPath,
        status: "written",
      },
    ],
  };
}

function mapStateToAwsConfig(props: { state: StateFile }): AwsConfigModel {
  const organizationalUnits: AwsConfigModel["organizationalUnits"] = [
    {
      name: "root",
      parentName: null,
      accounts: [],
    },
  ];
  const organizationalUnitById = new Map(
    props.state.organization.organizationalUnits.map((ou) => [ou.id, ou]),
  );
  for (const organizationalUnit of props.state.organization
    .organizationalUnits) {
    const parentName =
      organizationalUnit.parentId === props.state.organization.rootId
        ? "root"
        : organizationalUnitById.get(organizationalUnit.parentId)?.name;
    if (parentName == null) {
      throw new Error(
        `Organizational unit "${organizationalUnit.name}" has unknown parentId "${organizationalUnit.parentId}".`,
      );
    }
    organizationalUnits.push({
      name: organizationalUnit.name,
      parentName: parentName,
      accounts: [],
    });
  }

  const organizationalUnitByName = new Map(
    organizationalUnits.map((ou) => [ou.name, ou]),
  );
  for (const account of props.state.organization.accounts) {
    const ownerOuName =
      account.parentId === props.state.organization.rootId
        ? "root"
        : organizationalUnitById.get(account.parentId)?.name;
    if (ownerOuName == null) {
      throw new Error(
        `Account "${account.name}" has unknown parentId "${account.parentId}".`,
      );
    }
    const ownerOu = organizationalUnitByName.get(ownerOuName);
    if (ownerOu == null) {
      throw new Error(
        `Could not map account "${account.name}" to organizational unit "${ownerOuName}".`,
      );
    }
    ownerOu.accounts.push({
      name: account.name,
      email: account.email,
    });
  }

  const permissionSetNameByArn = new Map(
    props.state.identityCenter.permissionSets.map((permissionSet) => [
      permissionSet.permissionSetArn,
      permissionSet.name,
    ]),
  );
  const groupDisplayNameById = new Map(
    props.state.identityCenter.groups.map((group) => [
      group.groupId,
      group.displayName,
    ]),
  );
  const userNameById = new Map(
    props.state.identityCenter.users.map((user) => [
      user.userId,
      user.userName,
    ]),
  );
  const accountNameById = new Map(
    props.state.organization.accounts.map((account) => [
      account.id,
      account.name,
    ]),
  );

  const assignmentsByKey = new Map<
    string,
    AwsConfigModel["assignments"][number]
  >();
  for (const assignment of props.state.identityCenter.accountAssignments) {
    const permissionSetName = permissionSetNameByArn.get(
      assignment.permissionSetArn,
    );
    if (permissionSetName == null) {
      throw new Error(
        `Could not resolve permission set name for assignment permissionSetArn "${assignment.permissionSetArn}".`,
      );
    }
    const accountName = accountNameById.get(assignment.accountId);
    if (accountName == null) {
      throw new Error(
        `Could not resolve account name for assignment accountId "${assignment.accountId}".`,
      );
    }
    const principal = mapAssignmentPrincipal({
      assignment: assignment,
      groupDisplayNameById: groupDisplayNameById,
      userNameById: userNameById,
    });

    const assignmentKey = `${principal.kind}:${principal.value}|${permissionSetName}`;
    const existingAssignment = assignmentsByKey.get(assignmentKey);
    if (existingAssignment == null) {
      assignmentsByKey.set(assignmentKey, {
        permissionSet: permissionSetName,
        group: principal.kind === "group" ? principal.value : undefined,
        user: principal.kind === "user" ? principal.value : undefined,
        accounts: [accountName],
      });
      continue;
    }
    if (existingAssignment.accounts.includes(accountName) === false) {
      existingAssignment.accounts.push(accountName);
    }
  }

  const mapped: AwsConfigModel = {
    organizationalUnits: organizationalUnits,
    users: props.state.identityCenter.users.map((user) => ({
      userName: user.userName,
      displayName: user.displayName,
      emails: [...user.emails],
    })),
    groups: props.state.identityCenter.groups.map((group) => ({
      displayName: group.displayName,
    })),
    permissionSets: props.state.identityCenter.permissionSets.map(
      (permissionSet) => ({
        name: permissionSet.name,
        description: permissionSet.description,
      }),
    ),
    assignments: [...assignmentsByKey.values()],
  };

  assertUniqueNames({
    values: mapped.organizationalUnits.map((ou) => ou.name),
    entityName: "organizational unit",
  });
  assertUniqueNames({
    values: mapped.organizationalUnits.flatMap((ou) =>
      ou.accounts.map((account) => account.name),
    ),
    entityName: "account",
  });
  assertUniqueNames({
    values: mapped.groups.map((group) => group.displayName),
    entityName: "group",
  });
  assertUniqueNames({
    values: mapped.users.map((user) => user.userName),
    entityName: "user",
  });
  assertUniqueNames({
    values: mapped.permissionSets.map((permissionSet) => permissionSet.name),
    entityName: "permission set",
  });

  return v.parse(awsConfigModelSchema, mapped);
}

function mapAwsConfigToState(props: MapAwsConfigToStateProps): StateFile {
  const organizationalUnitByName = new Map(
    props.currentState.organization.organizationalUnits.map((ou) => [ou.name, ou]),
  );
  const accountByName = new Map(
    props.currentState.organization.accounts.map((account) => [account.name, account]),
  );
  const userByUserName = new Map(
    props.currentState.identityCenter.users.map((user) => [user.userName, user]),
  );
  const groupByDisplayName = new Map(
    props.currentState.identityCenter.groups.map((group) => [group.displayName, group]),
  );
  const permissionSetByName = new Map(
    props.currentState.identityCenter.permissionSets.map((permissionSet) => [
      permissionSet.name,
      permissionSet,
    ]),
  );
  const configOrganizationalUnitNameSet = new Set(
    props.config.organizationalUnits.map((organizationalUnit) => organizationalUnit.name),
  );
  const mappedOrganizationalUnitIdByName = new Map<string, string>();

  for (const organizationalUnit of props.config.organizationalUnits) {
    if (
      organizationalUnit.name !== "root" &&
      organizationalUnit.parentName != null &&
      configOrganizationalUnitNameSet.has(organizationalUnit.parentName) === false
    ) {
      throw new Error(
        `Organizational unit "${organizationalUnit.name}" references unknown parentName "${organizationalUnit.parentName}".`,
      );
    }
    const mappedId = resolveOrganizationalUnitId({
      organizationalUnitName: organizationalUnit.name,
      matchedOrganizationalUnit: organizationalUnitByName.get(organizationalUnit.name),
      context: props.context,
    });
    mappedOrganizationalUnitIdByName.set(organizationalUnit.name, mappedId);
  }

  const mappedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] = [];
  for (const organizationalUnit of props.config.organizationalUnits) {
    if (organizationalUnit.name === "root") {
      continue;
    }
    const mappedId = mappedOrganizationalUnitIdByName.get(organizationalUnit.name);
    if (mappedId == null) {
      throw new Error(
        `Could not resolve mapped id for organizational unit "${organizationalUnit.name}".`,
      );
    }
    const parentId =
      organizationalUnit.parentName == null
        ? props.context.organization.rootId
        : (mappedOrganizationalUnitIdByName.get(organizationalUnit.parentName) ??
          pendingCreationId);
    const matchedOrganizationalUnit = organizationalUnitByName.get(
      organizationalUnit.name,
    );
    mappedOrganizationalUnits.push({
      id: mappedId,
      parentId: parentId,
      arn: matchedOrganizationalUnit?.arn ?? pendingCreationId,
      name: organizationalUnit.name,
    });
  }

  const mappedAccountIdByName = new Map<string, string>();
  const mappedAccounts: StateFile["organization"]["accounts"] = [];
  for (const organizationalUnit of props.config.organizationalUnits) {
    const ownerParentId = mappedOrganizationalUnitIdByName.get(organizationalUnit.name);
    if (ownerParentId == null) {
      throw new Error(
        `Could not resolve mapped parent id for organizational unit "${organizationalUnit.name}".`,
      );
    }
    for (const account of organizationalUnit.accounts) {
      const matchedAccount = accountByName.get(account.name);
      const mappedId = matchedAccount?.id ?? pendingCreationId;
      mappedAccounts.push({
        id: mappedId,
        arn: matchedAccount?.arn ?? pendingCreationId,
        name: account.name,
        email: account.email,
        status: matchedAccount?.status ?? "ACTIVE",
        parentId: ownerParentId,
      });
      mappedAccountIdByName.set(account.name, mappedId);
    }
  }

  const mappedUsers: StateFile["identityCenter"]["users"] = props.config.users.map(
    (user) => {
      const matchedUser = userByUserName.get(user.userName);
      return {
        userId: matchedUser?.userId ?? pendingCreationId,
        userName: user.userName,
        displayName: user.displayName,
        emails: [...user.emails],
      };
    },
  );
  const mappedUserIdByUserName = new Map(
    mappedUsers.map((user) => [user.userName, user.userId]),
  );

  const mappedGroups: StateFile["identityCenter"]["groups"] = props.config.groups.map(
    (group) => {
      const matchedGroup = groupByDisplayName.get(group.displayName);
      return {
        groupId: matchedGroup?.groupId ?? pendingCreationId,
        displayName: group.displayName,
      };
    },
  );
  const mappedGroupIdByDisplayName = new Map(
    mappedGroups.map((group) => [group.displayName, group.groupId]),
  );

  const mappedPermissionSets: StateFile["identityCenter"]["permissionSets"] =
    props.config.permissionSets.map((permissionSet) => {
      const matchedPermissionSet = permissionSetByName.get(permissionSet.name);
      return {
        permissionSetArn:
          matchedPermissionSet?.permissionSetArn ?? pendingCreationId,
        name: permissionSet.name,
        description: permissionSet.description,
      };
    });
  const mappedPermissionSetArnByName = new Map(
    mappedPermissionSets.map((permissionSet) => [
      permissionSet.name,
      permissionSet.permissionSetArn,
    ]),
  );

  const mappedAccountAssignments: StateFile["identityCenter"]["accountAssignments"] = [];
  for (const assignment of props.config.assignments) {
    const hasGroupPrincipal = assignment.group != null;
    const hasUserPrincipal = assignment.user != null;
    if (hasGroupPrincipal === hasUserPrincipal) {
      throw new Error(
        `Assignment for permission set "${assignment.permissionSet}" must include exactly one principal (group or user).`,
      );
    }
    const mappedPrincipal =
      hasGroupPrincipal === true
        ? {
            principalId:
              mappedGroupIdByDisplayName.get(assignment.group ?? "") ??
              pendingCreationId,
            principalType: "GROUP" as const,
          }
        : {
            principalId:
              mappedUserIdByUserName.get(assignment.user ?? "") ??
              pendingCreationId,
            principalType: "USER" as const,
          };
    const permissionSetArn =
      mappedPermissionSetArnByName.get(assignment.permissionSet) ??
      pendingCreationId;
    for (const accountName of assignment.accounts) {
      mappedAccountAssignments.push({
        accountId: mappedAccountIdByName.get(accountName) ?? pendingCreationId,
        permissionSetArn: permissionSetArn,
        principalId: mappedPrincipal.principalId,
        principalType: mappedPrincipal.principalType,
      });
    }
  }

  const mapped: StateFile = {
    version: props.currentState.version,
    generatedAt: props.currentState.generatedAt,
    organization: {
      rootId: props.context.organization.rootId,
      organizationalUnits: mappedOrganizationalUnits,
      accounts: mappedAccounts,
    },
    identityCenter: {
      instanceArn: props.context.identityCenter.instanceArn,
      identityStoreId: props.context.identityCenter.identityStoreId,
      users: mappedUsers,
      groups: mappedGroups,
      permissionSets: mappedPermissionSets,
      accountAssignments: mappedAccountAssignments,
      accessRoles: mappedAccountAssignments.map((assignment) => ({
        accountId: assignment.accountId,
        permissionSetArn: assignment.permissionSetArn,
        principalId: assignment.principalId,
        principalType: assignment.principalType,
        roleName: createAccessRoleName(assignment),
      })),
    },
  };

  assertUniqueNames({
    values: props.config.organizationalUnits.map((organizationalUnit) =>
      organizationalUnit.name,
    ),
    entityName: "organizational unit",
  });
  assertUniqueNames({
    values: props.config.organizationalUnits.flatMap((organizationalUnit) =>
      organizationalUnit.accounts.map((account) => account.name),
    ),
    entityName: "account",
  });
  assertUniqueNames({
    values: props.config.groups.map((group) => group.displayName),
    entityName: "group",
  });
  assertUniqueNames({
    values: props.config.users.map((user) => user.userName),
    entityName: "user",
  });
  assertUniqueNames({
    values: props.config.permissionSets.map((permissionSet) => permissionSet.name),
    entityName: "permission set",
  });

  return validateState(mapped);
}

function sortAwsConfigModel(props: { config: AwsConfigModel }): AwsConfigModel {
  const childrenByParentName = new Map<
    string | null,
    AwsConfigModel["organizationalUnits"]
  >();
  for (const organizationalUnit of props.config.organizationalUnits) {
    const existingChildren =
      childrenByParentName.get(organizationalUnit.parentName) ?? [];
    existingChildren.push(organizationalUnit);
    childrenByParentName.set(organizationalUnit.parentName, existingChildren);
  }

  const orderedOrganizationalUnits: AwsConfigModel["organizationalUnits"] = [];
  const root = props.config.organizationalUnits.find(
    (ou) => ou.name === "root",
  );
  if (root == null || root.parentName !== null) {
    throw new Error(
      "Config model must include a synthetic root organizational unit with parentName set to null.",
    );
  }
  orderedOrganizationalUnits.push({
    ...root,
    accounts: [...root.accounts].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  });

  const queue: string[] = [root.name];
  while (queue.length > 0) {
    const currentParentName = queue.shift();
    if (currentParentName == null) {
      continue;
    }
    const children = (childrenByParentName.get(currentParentName) ?? [])
      .filter((ou) => ou.name !== "root")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      orderedOrganizationalUnits.push({
        ...child,
        accounts: [...child.accounts].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      });
      queue.push(child.name);
    }
  }

  return {
    organizationalUnits: orderedOrganizationalUnits,
    users: [...props.config.users].sort((left, right) =>
      left.userName.localeCompare(right.userName),
    ),
    groups: [...props.config.groups].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
    permissionSets: [...props.config.permissionSets].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    assignments: [...props.config.assignments]
      .map((assignment) => ({
        ...assignment,
        accounts: [...assignment.accounts].sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort((left, right) => {
        const leftPrincipal = left.group ?? left.user ?? "";
        const rightPrincipal = right.group ?? right.user ?? "";
        const principalComparison = leftPrincipal.localeCompare(rightPrincipal);
        if (principalComparison !== 0) {
          return principalComparison;
        }
        return left.permissionSet.localeCompare(right.permissionSet);
      }),
  };
}

function renderAwsConfigTs(props: { config: AwsConfigModel }): string {
  const serializedConfig = JSON.stringify(props.config, null, 2);
  return `import * as v from "valibot";
import { awsConfigSchema, type AwsConfig } from "./aws.config.types.js";

/**
 * Human-editable AWS config.
 * Generated by "init"; refresh picklists after edits with "regenerate".
 * The synthetic { name: "root", parentName: null } entry represents organization root.
 * "Pending" and "Graveyard" are bootstrap-managed and tracked in aws.context.json.
 */
const awsConfig: AwsConfig = v.parse(awsConfigSchema, ${serializedConfig} satisfies AwsConfig);

export default awsConfig;
`;
}

function renderAwsConfigTypesTs(props: { config: AwsConfigModel }): string {
  const organizationalUnitNames = props.config.organizationalUnits.map(
    (ou) => ou.name,
  );
  const accountNames = props.config.organizationalUnits.flatMap((ou) =>
    ou.accounts.map((account) => account.name),
  );
  const permissionSetNames = props.config.permissionSets.map(
    (permissionSet) => permissionSet.name,
  );
  const groupNames = props.config.groups.map((group) => group.displayName);
  const userNames = props.config.users.map((user) => user.userName);

  const organizationalUnitNameSchema = renderPicklistSchema({
    values: organizationalUnitNames,
  });
  const accountNameSchema = renderPicklistSchema({
    values: accountNames,
  });
  const permissionSetNameSchema = renderPicklistSchema({
    values: permissionSetNames,
  });
  const groupNameSchema = renderPicklistSchema({
    values: groupNames,
  });
  const userNameSchema = renderPicklistSchema({
    values: userNames,
  });

  return `import * as v from "valibot";

/**
 * Generated file. Do not edit by hand.
 */
const organizationalUnitNameSchema = ${organizationalUnitNameSchema};
const accountNameSchema = ${accountNameSchema};
const permissionSetNameSchema = ${permissionSetNameSchema};
const groupNameSchema = ${groupNameSchema};
const userNameSchema = ${userNameSchema};

export const awsConfigSchema = v.strictObject({
  organizationalUnits: v.array(
    v.strictObject({
      name: v.string(),
      parentName: v.union([organizationalUnitNameSchema, v.null_()]),
      accounts: v.array(
        v.strictObject({
          name: v.string(),
          email: v.string(),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      emails: v.array(v.string()),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
    }),
  ),
  assignments: v.array(
    v.strictObject({
      permissionSet: permissionSetNameSchema,
      group: v.optional(groupNameSchema),
      user: v.optional(userNameSchema),
      accounts: v.array(accountNameSchema),
    }),
  ),
});

export type AwsConfig = v.InferOutput<typeof awsConfigSchema>;
`;
}

function assertStateMatchesContext(props: {
  state: StateFile;
  context: AwsContextFile;
}): void {
  if (props.state.organization.rootId !== props.context.organization.rootId) {
    throw new Error(
      `state/context mismatch for organization.rootId: state has "${props.state.organization.rootId}" but context has "${props.context.organization.rootId}".`,
    );
  }

  const pendingOrganizationalUnit =
    props.state.organization.organizationalUnits.find(
      (ou) => ou.name === "Pending",
    );
  if (
    pendingOrganizationalUnit?.id !== props.context.organization.pendingOuId
  ) {
    throw new Error(
      `state/context mismatch for Pending OU id: state has "${pendingOrganizationalUnit?.id ?? "<missing>"}" but context has "${props.context.organization.pendingOuId}".`,
    );
  }

  const graveyardOrganizationalUnit =
    props.state.organization.organizationalUnits.find(
      (ou) => ou.name === "Graveyard",
    );
  if (
    graveyardOrganizationalUnit?.id !== props.context.organization.graveyardOuId
  ) {
    throw new Error(
      `state/context mismatch for Graveyard OU id: state has "${graveyardOrganizationalUnit?.id ?? "<missing>"}" but context has "${props.context.organization.graveyardOuId}".`,
    );
  }

  if (
    props.state.identityCenter.instanceArn !==
      props.context.identityCenter.instanceArn ||
    props.state.identityCenter.identityStoreId !==
      props.context.identityCenter.identityStoreId
  ) {
    throw new Error(
      "state/context mismatch for identityCenter.instanceArn or identityCenter.identityStoreId.",
    );
  }
}

function assertUniqueNames(props: {
  values: string[];
  entityName: string;
}): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of props.values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate ${props.entityName} names detected: ${[...duplicates.values()].join(", ")}.`,
    );
  }
}

function mapAssignmentPrincipal(props: {
  assignment: StateFile["identityCenter"]["accountAssignments"][number];
  groupDisplayNameById: Map<string, string>;
  userNameById: Map<string, string>;
}): MapAssignmentPrincipalResult {
  if (props.assignment.principalType === "GROUP") {
    const groupDisplayName = props.groupDisplayNameById.get(
      props.assignment.principalId,
    );
    if (groupDisplayName == null) {
      throw new Error(
        `Could not resolve group display name for principalId "${props.assignment.principalId}".`,
      );
    }
    return {
      kind: "group",
      value: groupDisplayName,
    };
  }
  if (props.assignment.principalType === "USER") {
    const userName = props.userNameById.get(props.assignment.principalId);
    if (userName == null) {
      throw new Error(
        `Could not resolve user name for principalId "${props.assignment.principalId}".`,
      );
    }
    return {
      kind: "user",
      value: userName,
    };
  }
  throw new Error(
    `Unsupported principal type "${props.assignment.principalType}" in account assignment.`,
  );
}

function resolveOrganizationalUnitId(props: {
  organizationalUnitName: string;
  matchedOrganizationalUnit?: StateFile["organization"]["organizationalUnits"][number];
  context: AwsContextFile;
}): string {
  if (props.organizationalUnitName === "root") {
    return props.context.organization.rootId;
  }
  if (props.organizationalUnitName === "Pending") {
    return props.context.organization.pendingOuId;
  }
  if (props.organizationalUnitName === "Graveyard") {
    return props.context.organization.graveyardOuId;
  }
  return props.matchedOrganizationalUnit?.id ?? pendingCreationId;
}

function renderPicklistSchema(props: { values: string[] }): string {
  if (props.values.length === 0) {
    return 'v.picklist(["__EMPTY_PICKLIST__"])';
  }
  const literals = props.values
    .map((value) => JSON.stringify(value))
    .join(", ");
  return `v.picklist([${literals}])`;
}

async function readAwsContextFile(path: string): Promise<AwsContextFile> {
  const rawContent = await readFile(path, "utf8");
  const parsed = JSON.parse(rawContent) as unknown;
  return v.parse(awsContextSchema, parsed);
}

async function loadAwsConfigTypesModule(props: {
  typesPath: string;
}): Promise<AwsConfigTypesModule> {
  const loadedModule = await loadTsModule({
    modulePath: props.typesPath,
  });
  if (
    loadedModule == null ||
    typeof loadedModule !== "object" ||
    "awsConfigSchema" in loadedModule === false
  ) {
    throw new Error(
      `Types module "${props.typesPath}" does not export awsConfigSchema.`,
    );
  }
  const moduleWithSchema = loadedModule as {
    awsConfigSchema?: v.GenericSchema;
  };
  if (moduleWithSchema.awsConfigSchema == null) {
    throw new Error(
      `Types module "${props.typesPath}" does not export awsConfigSchema.`,
    );
  }
  return {
    awsConfigSchema: moduleWithSchema.awsConfigSchema,
  };
}

async function loadAwsConfigFromTsFile(props: {
  configPath: string;
  schema: v.GenericSchema;
}): Promise<AwsConfigModel> {
  const loadedModule = await loadTsModule({
    modulePath: props.configPath,
  });
  if (
    loadedModule == null ||
    typeof loadedModule !== "object" ||
    "default" in loadedModule === false
  ) {
    throw new Error(
      `Config module "${props.configPath}" must export a default config object.`,
    );
  }
  const moduleWithDefault = loadedModule as { default?: unknown };
  if (moduleWithDefault.default == null) {
    throw new Error(
      `Config module "${props.configPath}" must export a default config object.`,
    );
  }
  try {
    const validatedConfig = v.parse(props.schema, moduleWithDefault.default);
    return v.parse(awsConfigModelSchema, validatedConfig);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new Error(
        `aws.config.ts validation failed: ${error.message}. If you recently edited names/references, re-run regenerate after fixing the config.`,
      );
    }
    throw error;
  }
}

async function loadTsModule(props: { modulePath: string }): Promise<unknown> {
  const resolvedModulePath = resolve(props.modulePath);
  const temporaryOutputPath = join(`aws-accounts-${randomUUID()}.mjs`);
  const temporaryOutputAtProjectRoot = join(
    projectRootPath,
    temporaryOutputPath,
  );
  try {
    await esbuildBuild({
      entryPoints: [resolvedModulePath],
      outfile: temporaryOutputAtProjectRoot,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      absWorkingDir: projectRootPath,
      nodePaths: [join(projectRootPath, "node_modules")],
      write: true,
    });
    const moduleUrl = pathToFileURL(temporaryOutputAtProjectRoot).href;
    return await import(moduleUrl);
  } finally {
    await safeUnlink(temporaryOutputAtProjectRoot);
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}
