import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuildBuild } from "esbuild";
import * as v from "valibot";
import {
  assertIamPolicyDocument,
  iamActionCatalog,
  iamPolicyDocumentSchema,
  type IamPolicyDocument,
} from "@beesolve/iam-policy-ts";
import {
  createAccessRoleName,
  readStateFile,
  type StateFile,
  validateState,
} from "./state.js";
import { assertUnreachable, toRecordByProperty } from "./helpers.js";
import type { Logger } from "./logger.js";

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const pendingCreationId = "__pending_creation__" as const;

const awsContextSchema = v.strictObject({
  version: nonEmptyString,
  generatedAt: nonEmptyString,
  organization: v.strictObject({
    managementAccountId: nonEmptyString,
    rootId: nonEmptyString,
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

export type AwsContextFile = v.InferOutput<typeof awsContextSchema>;

const awsConfigModelSchema = v.strictObject({
  organizationalUnits: v.array(
    v.strictObject({
      name: v.string(),
      parentName: v.nullable(v.string()),
      accounts: v.array(
        v.strictObject({
          name: v.string(),
          email: v.string(),
          tags: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      email: v.string(),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
      description: v.optional(v.string()),
      members: v.array(v.string()),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
      inlinePolicy: v.optional(iamPolicyDocumentSchema),
      awsManagedPolicies: v.array(v.string()),
      customerManagedPolicies: v.array(
        v.strictObject({
          name: v.string(),
          path: v.string(),
        }),
      ),
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

export type AwsConfigModel = v.InferOutput<typeof awsConfigModelSchema>;

type WriteAwsConfigFromStateInput = {
  statePath: string;
  contextPath: string;
  configPath: string;
  typesPath: string;
  logger: Logger;
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
  logger: Logger;
  overwriteConfirmation: (props: {
    fileSummaries: string[];
  }) => Promise<boolean>;
};

type RegenerateAwsConfigTypesResult = {
  typesPath: string;
  changed: boolean;
  files: FileWriteResult[];
};

type WriteAwsConfigModelToFileInput = {
  config: AwsConfigModel;
  configPath: string;
};

type WriteAwsConfigModelToFileResult = {
  changed: boolean;
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
    state,
    context,
  });

  const mappedConfig = mapStateToAwsConfig({
    state,
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
    props.logger.log("No changes.");
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
    props.logger.log(fileSummary);
  }
  props.logger.log(
    `Review with: git diff ${props.configPath} ${props.typesPath}`,
  );

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries,
  });
  if (!shouldWrite) {
    props.logger.log("Config write cancelled.");
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
    props.logger.log("No changes.");
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
  props.logger.log(fileSummary);
  props.logger.log(`Review with: git diff ${props.typesPath}`);

  const shouldWrite = await props.overwriteConfirmation({
    fileSummaries: [fileSummary],
  });
  if (!shouldWrite) {
    props.logger.log("Types write cancelled.");
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

export async function writeAwsConfigModelToFile(
  props: WriteAwsConfigModelToFileInput,
): Promise<WriteAwsConfigModelToFileResult> {
  const sortedConfig = sortAwsConfigModel({
    config: props.config,
  });
  const nextConfigContent = renderAwsConfigTs({
    config: sortedConfig,
  });
  const currentConfigContent = await readIfExists(props.configPath);
  if (currentConfigContent === nextConfigContent) {
    return {
      changed: false,
    };
  }
  await writeFile(props.configPath, nextConfigContent, "utf8");
  return {
    changed: true,
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
  const organizationalUnitById = toRecordByProperty(
    props.state.organization.organizationalUnits,
    "id",
  );
  for (const organizationalUnit of props.state.organization
    .organizationalUnits) {
    if (organizationalUnit.name === "Graveyard") {
      continue;
    }
    const parentName =
      organizationalUnit.parentId === props.state.organization.rootId
        ? "root"
        : organizationalUnitById[organizationalUnit.parentId]?.name;
    if (parentName == null) {
      throw new Error(
        `Organizational unit "${organizationalUnit.name}" has unknown parentId "${organizationalUnit.parentId}".`,
      );
    }
    organizationalUnits.push({
      name: organizationalUnit.name,
      parentName,
      accounts: [],
    });
  }

  const organizationalUnitByName = toRecordByProperty(
    organizationalUnits,
    "name",
  );
  const graveyardOrganizationalUnit = props.state.organization.organizationalUnits.find(
    (organizationalUnit) => organizationalUnit.name === "Graveyard",
  );
  const graveyardOrganizationalUnitId = graveyardOrganizationalUnit?.id;
  for (const account of props.state.organization.accounts) {
    const ownerOuName =
      account.parentId === props.state.organization.rootId
        ? "root"
        : organizationalUnitById[account.parentId]?.name;
    if (ownerOuName == null) {
      throw new Error(
        `Account "${account.name}" has unknown parentId "${account.parentId}".`,
      );
    }
    if (ownerOuName === "Graveyard") {
      continue;
    }
    const ownerOu = organizationalUnitByName[ownerOuName];
    if (ownerOu == null) {
      throw new Error(
        `Could not map account "${account.name}" to organizational unit "${ownerOuName}".`,
      );
    }
    ownerOu.accounts.push({
      name: account.name,
      email: account.email,
      tags: account.tags ?? [],
    });
  }

  const permissionSetByArn = toRecordByProperty(
    props.state.identityCenter.permissionSets,
    "permissionSetArn",
  );
  const groupById = toRecordByProperty(
    props.state.identityCenter.groups,
    "groupId",
  );
  const userById = toRecordByProperty(
    props.state.identityCenter.users,
    "userId",
  );
  const accountById = toRecordByProperty(
    props.state.organization.accounts,
    "id",
  );
  const membersByGroupDisplayName = new Map(
    props.state.identityCenter.groups.map((group) => [
      group.displayName,
      [] as string[],
    ]),
  );

  const assignmentsByKey = new Map<
    string,
    AwsConfigModel["assignments"][number]
  >();
  for (const assignment of props.state.identityCenter.accountAssignments) {
    const permissionSetName = permissionSetByArn[assignment.permissionSetArn]?.name;
    if (permissionSetName == null) {
      throw new Error(
        `Could not resolve permission set name for assignment permissionSetArn "${assignment.permissionSetArn}".`,
      );
    }
    const accountName = accountById[assignment.accountId]?.name;
    if (accountName == null) {
      throw new Error(
        `Could not resolve account name for assignment accountId "${assignment.accountId}".`,
      );
    }
    const accountParentId = accountById[assignment.accountId]?.parentId;
    if (
      graveyardOrganizationalUnitId != null &&
      accountParentId === graveyardOrganizationalUnitId
    ) {
      continue;
    }
    const principal = mapAssignmentPrincipal({
      assignment,
      groupById,
      userById,
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
  for (const groupMembership of props.state.identityCenter.groupMemberships) {
    const groupDisplayName = groupById[groupMembership.groupId]?.displayName;
    if (groupDisplayName == null) {
      throw new Error(
        `Could not resolve group display name for membership groupId "${groupMembership.groupId}".`,
      );
    }
    const userName = userById[groupMembership.userId]?.userName;
    if (userName == null) {
      throw new Error(
        `Could not resolve user name for membership userId "${groupMembership.userId}".`,
      );
    }
    const members = membersByGroupDisplayName.get(groupDisplayName);
    if (members == null) {
      throw new Error(
        `Could not map membership for group "${groupDisplayName}".`,
      );
    }
    if (members.includes(userName) === false) {
      members.push(userName);
    }
  }

  const mapped: AwsConfigModel = {
    organizationalUnits,
    users: props.state.identityCenter.users.map((user) => ({
      userName: user.userName,
      displayName: user.displayName,
      email: user.email,
    })),
    groups: props.state.identityCenter.groups.map((group) => ({
      displayName: group.displayName,
      description: group.description ?? "",
      members: membersByGroupDisplayName.get(group.displayName) ?? [],
    })),
    permissionSets: props.state.identityCenter.permissionSets.map(
      (permissionSet) => ({
        name: permissionSet.name,
        description: permissionSet.description,
        inlinePolicy:
          permissionSet.inlinePolicy == null
            ? undefined
            : parseInlinePolicyForConfig({
                permissionSetName: permissionSet.name,
                inlinePolicy: permissionSet.inlinePolicy,
              }),
        awsManagedPolicies: [...permissionSet.awsManagedPolicies],
        customerManagedPolicies: permissionSet.customerManagedPolicies.map(
          (customerManagedPolicy) => ({
            name: customerManagedPolicy.name,
            path: customerManagedPolicy.path,
          }),
        ),
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

export function mapAwsConfigToState(
  props: MapAwsConfigToStateProps,
): StateFile {
  const organizationalUnitByName = toRecordByProperty(
    props.currentState.organization.organizationalUnits,
    "name",
  );
  const accountByName = toRecordByProperty(
    props.currentState.organization.accounts,
    "name",
  );
  const userByUserName = toRecordByProperty(
    props.currentState.identityCenter.users,
    "userName",
  );
  const userById = toRecordByProperty(
    props.currentState.identityCenter.users,
    "userId",
  );
  const groupByDisplayName = toRecordByProperty(
    props.currentState.identityCenter.groups,
    "displayName",
  );
  const groupById = toRecordByProperty(
    props.currentState.identityCenter.groups,
    "groupId",
  );
  const groupMembershipByNameKey = toRecordByProperty(
    props.currentState.identityCenter.groupMemberships,
    (groupMembership) => {
      const currentGroup = groupById[groupMembership.groupId];
      if (currentGroup == null) {
        throw new Error(
          `Could not resolve current group for membership groupId "${groupMembership.groupId}".`,
        );
      }
      const currentUser = userById[groupMembership.userId];
      if (currentUser == null) {
        throw new Error(
          `Could not resolve current user for membership userId "${groupMembership.userId}".`,
        );
      }
      return createGroupMembershipNameKey({
        groupDisplayName: currentGroup.displayName,
        userName: currentUser.userName,
      });
    },
  );
  const permissionSetByName = toRecordByProperty(
    props.currentState.identityCenter.permissionSets,
    "name",
  );
  const configOrganizationalUnitNameSet = new Set(
    props.config.organizationalUnits.map(
      (organizationalUnit) => organizationalUnit.name,
    ),
  );
  const mappedOrganizationalUnitIdByName = new Map<string, string>();

  for (const organizationalUnit of props.config.organizationalUnits) {
    if (
      organizationalUnit.name !== "root" &&
      organizationalUnit.parentName != null &&
      configOrganizationalUnitNameSet.has(organizationalUnit.parentName) ===
        false
    ) {
      throw new Error(
        `Organizational unit "${organizationalUnit.name}" references unknown parentName "${organizationalUnit.parentName}".`,
      );
    }
    const mappedId = resolveOrganizationalUnitId({
      organizationalUnitName: organizationalUnit.name,
      matchedOrganizationalUnit: organizationalUnitByName[organizationalUnit.name],
      context: props.context,
    });
    mappedOrganizationalUnitIdByName.set(organizationalUnit.name, mappedId);
  }

  const mappedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] =
    [];
  for (const organizationalUnit of props.config.organizationalUnits) {
    if (organizationalUnit.name === "root") {
      continue;
    }
    const mappedId = mappedOrganizationalUnitIdByName.get(
      organizationalUnit.name,
    );
    if (mappedId == null) {
      throw new Error(
        `Could not resolve mapped id for organizational unit "${organizationalUnit.name}".`,
      );
    }
    const parentId =
      organizationalUnit.parentName == null
        ? props.context.organization.rootId
        : (mappedOrganizationalUnitIdByName.get(
            organizationalUnit.parentName,
          ) ?? pendingCreationId);
    const matchedOrganizationalUnit =
      organizationalUnitByName[organizationalUnit.name];
    mappedOrganizationalUnits.push({
      id: mappedId,
      parentId,
      arn: matchedOrganizationalUnit?.arn ?? pendingCreationId,
      name: organizationalUnit.name,
    });
  }
  for (const managedOrganizationalUnitName of ["Graveyard"] as const) {
    const managedOuId = resolveOrganizationalUnitId({
      organizationalUnitName: managedOrganizationalUnitName,
      matchedOrganizationalUnit: organizationalUnitByName[managedOrganizationalUnitName],
      context: props.context,
    });
    mappedOrganizationalUnitIdByName.set(
      managedOrganizationalUnitName,
      managedOuId,
    );
    if (
      mappedOrganizationalUnits.some(
        (organizationalUnit) => organizationalUnit.id === managedOuId,
      )
    ) {
      continue;
    }
    const matchedManagedOrganizationalUnit =
      organizationalUnitByName[managedOrganizationalUnitName];
    mappedOrganizationalUnits.push({
      id: managedOuId,
      parentId: props.context.organization.rootId,
      arn: matchedManagedOrganizationalUnit?.arn ?? pendingCreationId,
      name: managedOrganizationalUnitName,
    });
  }

  const mappedAccountIdByName = new Map<string, string>();
  const mappedAccounts: StateFile["organization"]["accounts"] = [];
  for (const organizationalUnit of props.config.organizationalUnits) {
    const ownerParentId = mappedOrganizationalUnitIdByName.get(
      organizationalUnit.name,
    );
    if (ownerParentId == null) {
      throw new Error(
        `Could not resolve mapped parent id for organizational unit "${organizationalUnit.name}".`,
      );
    }
    for (const account of organizationalUnit.accounts) {
      const matchedAccount = accountByName[account.name];
      const mappedId = matchedAccount?.id ?? pendingCreationId;
      mappedAccounts.push({
        id: mappedId,
        arn: matchedAccount?.arn ?? pendingCreationId,
        name: account.name,
        email: account.email,
        status: matchedAccount?.status ?? "ACTIVE",
        parentId: ownerParentId,
        tags: account.tags,
      });
      mappedAccountIdByName.set(account.name, mappedId);
    }
  }

  const mappedUsers: StateFile["identityCenter"]["users"] =
    props.config.users.map((user) => {
      const matchedUser = userByUserName[user.userName];
      return {
        userId: matchedUser?.userId ?? pendingCreationId,
        userName: user.userName,
        displayName: user.displayName,
        email: user.email,
      };
    });
  const mappedUserByUserName = toRecordByProperty(
    mappedUsers,
    "userName",
  );

  const mappedGroups: StateFile["identityCenter"]["groups"] =
    props.config.groups.map((group) => {
      const matchedGroup = groupByDisplayName[group.displayName];
      return {
        groupId: matchedGroup?.groupId ?? pendingCreationId,
        displayName: group.displayName,
        description: group.description ?? "",
      };
    });
  const mappedGroupByDisplayName = toRecordByProperty(
    mappedGroups,
    "displayName",
  );
  const mappedGroupMemberships: StateFile["identityCenter"]["groupMemberships"] =
    [];
  for (const group of props.config.groups) {
    assertUniqueNames({
      values: group.members,
      entityName: `group member for "${group.displayName}"`,
    });
    const groupId =
      mappedGroupByDisplayName[group.displayName]?.groupId ?? pendingCreationId;
    for (const userName of group.members) {
      const currentMembership =
        groupMembershipByNameKey[
          createGroupMembershipNameKey({
            groupDisplayName: group.displayName,
            userName,
          })
        ];
      mappedGroupMemberships.push({
        membershipId: currentMembership?.membershipId ?? pendingCreationId,
        groupId,
        userId: mappedUserByUserName[userName]?.userId ?? pendingCreationId,
      });
    }
  }

  const mappedPermissionSets: StateFile["identityCenter"]["permissionSets"] =
    props.config.permissionSets.map((permissionSet) => {
      const matchedPermissionSet = permissionSetByName[permissionSet.name];
      return {
        permissionSetArn:
          matchedPermissionSet?.permissionSetArn ?? pendingCreationId,
        name: permissionSet.name,
        description: permissionSet.description,
        inlinePolicy: stableStringifyInlinePolicy(permissionSet.inlinePolicy),
        awsManagedPolicies: [...permissionSet.awsManagedPolicies],
        customerManagedPolicies: permissionSet.customerManagedPolicies.map(
          (customerManagedPolicy) => ({
            name: customerManagedPolicy.name,
            path: customerManagedPolicy.path,
          }),
        ),
      };
    });
  const mappedPermissionSetByName = toRecordByProperty(
    mappedPermissionSets,
    "name",
  );

  const mappedAccountAssignments: StateFile["identityCenter"]["accountAssignments"] =
    [];
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
              mappedGroupByDisplayName[assignment.group ?? ""]?.groupId ??
              pendingCreationId,
            principalType: "GROUP" as const,
          }
        : {
            principalId:
              mappedUserByUserName[assignment.user ?? ""]?.userId ??
              pendingCreationId,
            principalType: "USER" as const,
          };
    const permissionSetArn =
      mappedPermissionSetByName[assignment.permissionSet]?.permissionSetArn ??
      pendingCreationId;
    for (const accountName of assignment.accounts) {
      mappedAccountAssignments.push({
        accountId: mappedAccountIdByName.get(accountName) ?? pendingCreationId,
        permissionSetArn,
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
      groupMemberships: mappedGroupMemberships,
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
    values: props.config.organizationalUnits.map(
      (organizationalUnit) => organizationalUnit.name,
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
    values: props.config.permissionSets.map(
      (permissionSet) => permissionSet.name,
    ),
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
    groups: [...props.config.groups]
      .map((group) => ({
        ...group,
        members: [...group.members].sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    permissionSets: [...props.config.permissionSets]
      .map((permissionSet) => ({
        ...permissionSet,
        inlinePolicy:
          permissionSet.inlinePolicy == null
            ? undefined
            : sortJsonRecord(permissionSet.inlinePolicy),
        awsManagedPolicies: [...permissionSet.awsManagedPolicies].sort(
          (left, right) => left.localeCompare(right),
        ),
        customerManagedPolicies: [...permissionSet.customerManagedPolicies].sort(
          (left, right) =>
            compareStringKeys(left.path, right.path, left.name, right.name),
        ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
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
  const serializedConfig = renderTsValue(props.config, {
    indentLevel: 0,
    withinInlinePolicy: false,
  });
  return `import * as v from "valibot";
import { awsConfigSchema, iam, type AwsConfig } from "./aws.config.types.js";

/**
 * Human-editable AWS config.
 * Generated by "init"; refresh picklists after edits with "regenerate".
 * Use helpers like iam.s3("GetObject") for IAM action autocomplete in inline policies.
 * Generated inline policies use those helpers automatically when the action is
 * present in the installed @beesolve/iam-policy-ts catalog.
 * The synthetic { name: "root", parentName: null } entry represents organization root.
 * "Graveyard" is bootstrap-managed and used internally as the account-removal sink;
 * it is intentionally omitted from generated organizationalUnits in this file.
 */
const awsConfig: AwsConfig = v.parse(awsConfigSchema, ${serializedConfig} satisfies AwsConfig);

export default awsConfig;
`;
}

function renderTsValue(
  value: unknown,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new Error("Undefined values must be handled before TypeScript rendering.");
  }
  if (typeof value === "string") {
    return renderTsStringValue(value, props);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return renderTsArray(value, props);
  }
  if (isJsonRecord(value)) {
    return renderTsObject(value, props);
  }
  throw new Error(`Unsupported config value type: ${typeof value}.`);
}

function renderTsStringValue(
  value: string,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (
    props.withinInlinePolicy &&
    (props.parentPropertyName === "Action" ||
      props.parentPropertyName === "NotAction")
  ) {
    return renderPolicyActionString(value);
  }
  return JSON.stringify(value);
}

function renderTsArray(
  value: unknown[],
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (value.length === 0) {
    return "[]";
  }

  const indent = "  ".repeat(props.indentLevel);
  const childIndent = "  ".repeat(props.indentLevel + 1);
  const renderedItems = value.map((item) =>
    item === undefined
      ? "null"
      : renderTsValue(item, {
          indentLevel: props.indentLevel + 1,
          withinInlinePolicy: props.withinInlinePolicy,
          parentPropertyName: props.parentPropertyName,
        }),
  );

  return `[\n${renderedItems.map((item) => `${childIndent}${item}`).join(",\n")}\n${indent}]`;
}

function renderTsObject(
  value: Record<string, unknown>,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) {
    return "{}";
  }

  const indent = "  ".repeat(props.indentLevel);
  const childIndent = "  ".repeat(props.indentLevel + 1);
  const renderedEntries = entries.map(([key, entryValue]) => {
    const nextWithinInlinePolicy =
      props.withinInlinePolicy || key === "inlinePolicy";
    const renderedValue = renderTsValue(entryValue, {
      indentLevel: props.indentLevel + 1,
      withinInlinePolicy: nextWithinInlinePolicy,
      parentPropertyName: key,
    });
    return `${childIndent}${renderTsObjectKey(key)}: ${renderedValue}`;
  });

  return `{\n${renderedEntries.join(",\n")}\n${indent}}`;
}

function renderPolicyActionString(value: string): string {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return JSON.stringify(value);
  }

  const servicePrefix = value.slice(0, separatorIndex);
  const actionName = value.slice(separatorIndex + 1);
  const knownActions = iamActionCatalog[
    servicePrefix as keyof typeof iamActionCatalog
  ] as readonly string[] | undefined;
  if (knownActions == null || knownActions.includes(actionName) === false) {
    return JSON.stringify(value);
  }

  if (isIdentifierSafeServicePrefix(servicePrefix)) {
    return `iam.${servicePrefix}(${JSON.stringify(actionName)})`;
  }
  return `iam[${JSON.stringify(servicePrefix)}](${JSON.stringify(actionName)})`;
}

function isIdentifierSafeServicePrefix(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function renderTsObjectKey(value: string): string {
  return isIdentifierSafeServicePrefix(value) ? value : JSON.stringify(value);
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
import { iamPolicyDocumentSchema } from "@beesolve/iam-policy-ts";
export {
  iam,
  iamAction,
  iamActionCatalog,
  iamActionCatalogActionCount,
  iamActionCatalogSourceSha256,
  iamActionCatalogSourceUrl,
  iamPolicyDocumentSchema,
  iamPolicyStatementSchema,
  iamPolicyDocumentStrictSchema,
  iamPolicyStatementStrictSchema,
  isIamPolicyDocument,
  isIamPolicyStatement,
  isIamPolicyDocumentStrict,
  assertIamPolicyDocument,
  assertIamPolicyDocumentStrict,
} from "@beesolve/iam-policy-ts";
export type {
  IamActionCatalog,
  IamPolicyServicePrefix,
  IamPolicyActionNameByService,
  IamPolicyActionForService,
  IamPolicyVersion,
  IamPolicyScalar,
  IamPolicyScalarList,
  IamPolicyStringList,
  IamPolicyPrincipalMap,
  IamPolicyPrincipal,
  IamPolicyConditionBlock,
  IamPolicyStatement,
  IamPolicyDocument,
  IamPolicyStatementStrict,
  IamPolicyDocumentStrict,
} from "@beesolve/iam-policy-ts";

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
          tags: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      email: v.string(),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
      description: v.optional(v.string()),
      members: v.array(userNameSchema),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
      inlinePolicy: v.optional(iamPolicyDocumentSchema),
      awsManagedPolicies: v.array(v.string()),
      customerManagedPolicies: v.array(
        v.strictObject({
          name: v.string(),
          path: v.string(),
        }),
      ),
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
  groupById: Record<string, StateFile["identityCenter"]["groups"][number]>;
  userById: Record<string, StateFile["identityCenter"]["users"][number]>;
}): MapAssignmentPrincipalResult {
  const principalType = props.assignment.principalType;
  if (principalType === "GROUP") {
    const groupDisplayName =
      props.groupById[props.assignment.principalId]?.displayName;
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
  if (principalType === "USER") {
    const userName = props.userById[props.assignment.principalId]?.userName;
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
  assertUnreachable(
    principalType,
    `Unsupported principal type "${principalType}" in account assignment.`,
  );
}

function createGroupMembershipNameKey(props: {
  groupDisplayName: string;
  userName: string;
}): string {
  return [props.groupDisplayName, props.userName].join("|");
}

function parseInlinePolicyForConfig(props: {
  permissionSetName: string;
  inlinePolicy: string;
}): IamPolicyDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(props.inlinePolicy) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not parse inline policy for permission set "${props.permissionSetName}": ${message}`,
    );
  }
  if (isJsonRecord(parsed) === false) {
    throw new Error(
      `Inline policy for permission set "${props.permissionSetName}" must be a JSON object.`,
    );
  }
  return sortJsonRecord(assertIamPolicyDocument(parsed));
}

function stableStringifyInlinePolicy(
  inlinePolicy: IamPolicyDocument | undefined,
): string | null {
  if (inlinePolicy == null) {
    return null;
  }
  return JSON.stringify(sortJsonRecord(assertIamPolicyDocument(inlinePolicy)));
}

function sortJsonRecord<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, sortJsonValue(value)]),
  ) as T;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (isJsonRecord(value)) {
    return sortJsonRecord(value);
  }
  return value;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && Array.isArray(value) === false;
}

function compareStringKeys(...values: string[]): number {
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

function resolveOrganizationalUnitId(props: {
  organizationalUnitName: string;
  matchedOrganizationalUnit?: StateFile["organization"]["organizationalUnits"][number];
  context: AwsContextFile;
}): string {
  if (props.organizationalUnitName === "root") {
    return props.context.organization.rootId;
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
  const literals = [...props.values]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => JSON.stringify(value))
    .join(", ");
  return `v.picklist([${literals}])`;
}

async function readAwsContextFile(path: string): Promise<AwsContextFile> {
  const rawContent = await readFile(path, "utf8");
  const parsed = JSON.parse(rawContent) as unknown;
  return v.parse(awsContextSchema, parsed);
}

export async function loadAwsConfigModelFromTsFile(props: {
  configPath: string;
  typesPath: string;
}): Promise<AwsConfigModel> {
  const typesModule = await loadAwsConfigTypesModule({
    typesPath: props.typesPath,
  });
  return await loadAwsConfigFromTsFile({
    configPath: props.configPath,
    schema: typesModule.awsConfigSchema,
  });
}

export async function readAwsContextFromFile(
  path: string,
): Promise<AwsContextFile> {
  return await readAwsContextFile(path);
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
  let loadedModule: unknown;
  try {
    loadedModule = await loadTsModule({
      modulePath: props.configPath,
    });
  } catch (error) {
    if (isValiErrorLike(error)) {
      throw new Error(
        `aws.config.ts validation failed: ${error instanceof Error ? error.message : String(error)}. If you recently edited names/references, re-run regenerate after fixing the config.`,
      );
    }
    throw error;
  }
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
    if (isValiErrorLike(error)) {
      throw new Error(
        `aws.config.ts validation failed: ${error instanceof Error ? error.message : String(error)}. If you recently edited names/references, re-run regenerate after fixing the config.`,
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

function isValiErrorLike(error: unknown): error is Error {
  return (
    error instanceof v.ValiError ||
    (error instanceof Error && error.name === "ValiError")
  );
}
