import { assertIamPolicyDocument, type IamPolicyDocument } from "@beesolve/iam-policy-ts";
import * as v from "valibot";

import { awsConfigModelSchema, type AwsConfigModel, type AwsContextFile } from "./awsConfig.js";
import { sortJsonRecord, isJsonRecord } from "./awsConfigRender.js";
import { assertUnreachable, sortJsonValue, toRecordByProperty } from "./helpers.js";
import {
  createAccessRoleName,
  type OrgPolicyState,
  type StateFile,
  validateState,
} from "./state.js";

const pendingCreationId = "__pending_creation__" as const;

type MapAssignmentPrincipalResult =
  | { kind: "group"; value: string }
  | { kind: "user"; value: string };

type MapAwsConfigToStateProps = {
  config: AwsConfigModel;
  currentState: StateFile;
  context: AwsContextFile;
};

type ConfigPolicyEntry = {
  name: string;
  description?: string;
  content: Record<string, unknown>;
  targets: Array<string>;
};

function resolveAccountStateMatchForConfigEntry(props: {
  account: { name: string; email: string };
  accountByName: Record<string, StateFile["organization"]["accounts"][number]>;
  accounts: StateFile["organization"]["accounts"];
}): StateFile["organization"]["accounts"][number] | undefined {
  const matchedByName = props.accountByName[props.account.name];
  if (matchedByName != null) {
    return matchedByName;
  }
  const emailMatches = props.accounts.filter(
    (candidate) => candidate.email === props.account.email,
  );
  if (emailMatches.length > 1) {
    throw new Error(
      `Cannot map config account "${props.account.name}": multiple member accounts use email "${props.account.email}".`,
    );
  }
  return emailMatches[0];
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

function assertUniqueNames(props: { values: Array<string>; entityName: string }): void {
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
    const groupDisplayName = props.groupById[props.assignment.principalId]?.displayName;
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

function stableStringifyInlinePolicy(inlinePolicy: IamPolicyDocument | undefined): string | null {
  if (inlinePolicy == null) {
    return null;
  }
  return JSON.stringify(sortJsonRecord(assertIamPolicyDocument(inlinePolicy)));
}

export function assertStateMatchesContext(props: {
  state: StateFile;
  context: AwsContextFile;
}): void {
  if (props.state.organization.rootId !== props.context.organization.rootId) {
    throw new Error(
      `state/context mismatch for organization.rootId: state has "${props.state.organization.rootId}" but context has "${props.context.organization.rootId}".`,
    );
  }

  const graveyardOrganizationalUnit = props.state.organization.organizationalUnits.find(
    (ou) => ou.name === "Graveyard",
  );
  if (
    graveyardOrganizationalUnit?.id !== props.context.organization.graveyardOuId &&
    !(graveyardOrganizationalUnit == null && props.context.organization.graveyardOuId === "pending")
  ) {
    throw new Error(
      `state/context mismatch for Graveyard OU id: state has "${graveyardOrganizationalUnit?.id ?? "<missing>"}" but context has "${props.context.organization.graveyardOuId}".`,
    );
  }

  if (
    props.state.identityCenter.instanceArn !== props.context.identityCenter.instanceArn ||
    props.state.identityCenter.identityStoreId !== props.context.identityCenter.identityStoreId
  ) {
    throw new Error(
      "state/context mismatch for identityCenter.instanceArn or identityCenter.identityStoreId.",
    );
  }
}

function resolveAccountNamesInPolicyContent(
  content: Record<string, unknown>,
  accountByName: Record<string, { id: string }>,
): Record<string, unknown> {
  const statements = (content as { Statement?: Array<unknown> }).Statement;
  if (!Array.isArray(statements)) return content;
  return {
    ...content,
    Statement: statements.map((stmt) => {
      if (stmt == null || typeof stmt !== "object") return stmt;
      const s = stmt as Record<string, unknown>;
      const condition = s.Condition as Record<string, unknown> | undefined;
      if (condition == null) return stmt;
      const sne = condition.StringNotEquals as Record<string, unknown> | undefined;
      if (sne == null) return stmt;
      const accounts = sne["aws:PrincipalAccount"];
      if (!Array.isArray(accounts)) return stmt;
      return {
        ...s,
        Condition: {
          ...condition,
          StringNotEquals: {
            ...sne,
            "aws:PrincipalAccount": accounts.map((name: string) => accountByName[name]?.id ?? name),
          },
        },
      };
    }),
  };
}

function resolveAccountIdsInPolicyContent(
  content: Record<string, unknown>,
  accountById: Record<string, { name: string }>,
): Record<string, unknown> {
  const statements = (content as { Statement?: Array<unknown> }).Statement;
  if (!Array.isArray(statements)) return content;
  return {
    ...content,
    Statement: statements.map((stmt) => {
      if (stmt == null || typeof stmt !== "object") return stmt;
      const s = stmt as Record<string, unknown>;
      const condition = s.Condition as Record<string, unknown> | undefined;
      if (condition == null) return stmt;
      const sne = condition.StringNotEquals as Record<string, unknown> | undefined;
      if (sne == null) return stmt;
      const accounts = sne["aws:PrincipalAccount"];
      if (!Array.isArray(accounts)) return stmt;
      return {
        ...s,
        Condition: {
          ...condition,
          StringNotEquals: {
            ...sne,
            "aws:PrincipalAccount": accounts.map((id: string) => accountById[id]?.name ?? id),
          },
        },
      };
    }),
  };
}

export function mapStateToAwsConfig(props: { state: StateFile }): AwsConfigModel {
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
  for (const organizationalUnit of props.state.organization.organizationalUnits) {
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

  const organizationalUnitByName = toRecordByProperty(organizationalUnits, "name");
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
      throw new Error(`Account "${account.name}" has unknown parentId "${account.parentId}".`);
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
    const contacts = account.alternateContacts;
    ownerOu.accounts.push({
      name: account.name,
      email: account.email,
      tags: account.tags ?? [],
      alternateContacts: contacts != null && contacts.length > 0 ? contacts : undefined,
    });
  }

  const permissionSetByArn = toRecordByProperty(
    props.state.identityCenter.permissionSets,
    "permissionSetArn",
  );
  const groupById = toRecordByProperty(props.state.identityCenter.groups, "groupId");
  const userById = toRecordByProperty(props.state.identityCenter.users, "userId");
  const accountById = toRecordByProperty(props.state.organization.accounts, "id");
  const membersByGroupDisplayName = new Map(
    props.state.identityCenter.groups.map((group) => [group.displayName, [] as Array<string>]),
  );

  const assignmentsByKey = new Map<string, AwsConfigModel["assignments"][number]>();
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
      throw new Error(`Could not map membership for group "${groupDisplayName}".`);
    }
    if (members.includes(userName) === false) {
      members.push(userName);
    }
  }

  const orgPolicies = props.state.organization.policies ?? [];
  const orgPolicyAttachments = props.state.organization.policyAttachments ?? [];
  const ouById = toRecordByProperty(props.state.organization.organizationalUnits, "id");
  const orgAccountById = toRecordByProperty(props.state.organization.accounts, "id");

  function resolveTargetName(targetId: string, targetType: string): string | null {
    if (targetType === "ROOT") {
      return "root";
    }
    if (targetType === "ORGANIZATIONAL_UNIT") {
      return ouById[targetId]?.name ?? null;
    }
    if (targetType === "ACCOUNT") {
      return orgAccountById[targetId]?.name ?? null;
    }
    return null;
  }

  const attachmentsByPolicyId = new Map<string, Array<string>>();
  for (const attachment of orgPolicyAttachments) {
    const targetName = resolveTargetName(attachment.targetId, attachment.targetType);
    if (targetName == null) {
      continue;
    }
    const targets = attachmentsByPolicyId.get(attachment.policyId) ?? [];
    targets.push(targetName);
    attachmentsByPolicyId.set(attachment.policyId, targets);
  }

  const mappedOrgPolicies = orgPolicies.map((p) => ({
    type: p.type,
    name: p.name,
    description: p.description.length > 0 ? p.description : undefined,
    content:
      p.type === "SERVICE_CONTROL_POLICY"
        ? resolveAccountIdsInPolicyContent(
            JSON.parse(p.content) as Record<string, unknown>,
            orgAccountById,
          )
        : (JSON.parse(p.content) as Record<string, unknown>),
    targets: [...(attachmentsByPolicyId.get(p.id) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
  }));

  const policiesByType = new Map<OrgPolicyState["type"], Array<ConfigPolicyEntry>>();
  for (const policy of mappedOrgPolicies) {
    const bucket = policiesByType.get(policy.type) ?? new Array<ConfigPolicyEntry>();
    bucket.push({
      name: policy.name,
      description: policy.description,
      content: policy.content,
      targets: policy.targets,
    });
    policiesByType.set(policy.type, bucket);
  }

  const scps = policiesByType.get("SERVICE_CONTROL_POLICY") ?? [];
  const rcps = policiesByType.get("RESOURCE_CONTROL_POLICY") ?? [];
  const tagPolicies = policiesByType.get("TAG_POLICY") ?? [];
  const aiServicesOptOutPolicies = policiesByType.get("AISERVICES_OPT_OUT_POLICY") ?? [];
  const backupPolicies = policiesByType.get("BACKUP_POLICY") ?? [];

  const stateDelegatedAdmins = props.state.organization.delegatedAdministrators ?? [];
  const mappedDelegatedAdministrators = stateDelegatedAdmins.map((da) => ({
    account: accountById[da.accountId]?.name ?? da.accountId,
    servicePrincipal: da.servicePrincipal,
  }));

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
    permissionSets: props.state.identityCenter.permissionSets.map((permissionSet) => ({
      name: permissionSet.name,
      description: permissionSet.description,
      sessionDuration: permissionSet.sessionDuration ?? undefined,
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
      permissionsBoundary: permissionSet.permissionsBoundary ?? undefined,
    })),
    assignments: [...assignmentsByKey.values()],
    accessControlAttributes: props.state.identityCenter.accessControlAttributes.map((attr) => ({
      key: attr.key,
      source: [...attr.source],
    })),
    delegatedAdministrators: mappedDelegatedAdministrators,
    policies: {
      serviceControlPolicies: scps,
      resourceControlPolicies: rcps,
      tagPolicies,
      aiServicesOptOutPolicies,
      backupPolicies,
    },
  };

  assertUniqueNames({
    values: mapped.organizationalUnits.map((ou) => ou.name),
    entityName: "organizational unit",
  });
  assertUniqueNames({
    values: mapped.organizationalUnits.flatMap((ou) => ou.accounts.map((account) => account.name)),
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

export function mapAwsConfigToState(props: MapAwsConfigToStateProps): StateFile {
  const organizationalUnitByName = toRecordByProperty(
    props.currentState.organization.organizationalUnits,
    "name",
  );
  const accountByName = toRecordByProperty(props.currentState.organization.accounts, "name");
  const userByUserName = toRecordByProperty(props.currentState.identityCenter.users, "userName");
  const userById = toRecordByProperty(props.currentState.identityCenter.users, "userId");
  const groupByDisplayName = toRecordByProperty(
    props.currentState.identityCenter.groups,
    "displayName",
  );
  const groupById = toRecordByProperty(props.currentState.identityCenter.groups, "groupId");
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
      matchedOrganizationalUnit: organizationalUnitByName[organizationalUnit.name],
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
    const matchedOrganizationalUnit = organizationalUnitByName[organizationalUnit.name];
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
    mappedOrganizationalUnitIdByName.set(managedOrganizationalUnitName, managedOuId);
    if (
      mappedOrganizationalUnits.some((organizationalUnit) => organizationalUnit.id === managedOuId)
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
    const ownerParentId = mappedOrganizationalUnitIdByName.get(organizationalUnit.name);
    if (ownerParentId == null) {
      throw new Error(
        `Could not resolve mapped parent id for organizational unit "${organizationalUnit.name}".`,
      );
    }
    for (const account of organizationalUnit.accounts) {
      const matchedAccount = resolveAccountStateMatchForConfigEntry({
        account,
        accountByName,
        accounts: props.currentState.organization.accounts,
      });
      const mappedId = matchedAccount?.id ?? pendingCreationId;
      mappedAccounts.push({
        id: mappedId,
        arn: matchedAccount?.arn ?? pendingCreationId,
        name: account.name,
        email: account.email,
        state: matchedAccount?.state ?? "ACTIVE",
        parentId: ownerParentId,
        tags: account.tags,
        alternateContacts:
          account.alternateContacts != null && account.alternateContacts.length > 0
            ? account.alternateContacts
            : undefined,
      });
      mappedAccountIdByName.set(account.name, mappedId);
    }
  }

  const mappedUsers: StateFile["identityCenter"]["users"] = props.config.users.map((user) => {
    const matchedUser = userByUserName[user.userName];
    return {
      userId: matchedUser?.userId ?? pendingCreationId,
      userName: user.userName,
      displayName: user.displayName,
      email: user.email,
    };
  });
  const mappedUserByUserName = toRecordByProperty(mappedUsers, "userName");

  const mappedGroups: StateFile["identityCenter"]["groups"] = props.config.groups.map((group) => {
    const matchedGroup = groupByDisplayName[group.displayName];
    return {
      groupId: matchedGroup?.groupId ?? pendingCreationId,
      displayName: group.displayName,
      description: group.description ?? "",
    };
  });
  const mappedGroupByDisplayName = toRecordByProperty(mappedGroups, "displayName");
  const mappedGroupMemberships: StateFile["identityCenter"]["groupMemberships"] = [];
  for (const group of props.config.groups) {
    assertUniqueNames({
      values: group.members,
      entityName: `group member for "${group.displayName}"`,
    });
    const groupId = mappedGroupByDisplayName[group.displayName]?.groupId ?? pendingCreationId;
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
        permissionSetArn: matchedPermissionSet?.permissionSetArn ?? pendingCreationId,
        name: permissionSet.name,
        description: permissionSet.description,
        sessionDuration: permissionSet.sessionDuration ?? null,
        inlinePolicy: stableStringifyInlinePolicy(permissionSet.inlinePolicy),
        awsManagedPolicies: [...permissionSet.awsManagedPolicies],
        customerManagedPolicies: permissionSet.customerManagedPolicies.map(
          (customerManagedPolicy) => ({
            name: customerManagedPolicy.name,
            path: customerManagedPolicy.path,
          }),
        ),
        permissionsBoundary: permissionSet.permissionsBoundary ?? null,
      };
    });
  const mappedPermissionSetByName = toRecordByProperty(mappedPermissionSets, "name");

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
              mappedGroupByDisplayName[assignment.group ?? ""]?.groupId ?? pendingCreationId,
            principalType: "GROUP" as const,
          }
        : {
            principalId: mappedUserByUserName[assignment.user ?? ""]?.userId ?? pendingCreationId,
            principalType: "USER" as const,
          };
    const permissionSetArn =
      mappedPermissionSetByName[assignment.permissionSet]?.permissionSetArn ?? pendingCreationId;
    for (const accountName of assignment.accounts) {
      mappedAccountAssignments.push({
        accountId: mappedAccountIdByName.get(accountName) ?? pendingCreationId,
        permissionSetArn,
        principalId: mappedPrincipal.principalId,
        principalType: mappedPrincipal.principalType,
      });
    }
  }

  const configPolicies = props.config.policies;
  const allConfigPolicies: Array<{
    name: string;
    description: string;
    type: OrgPolicyState["type"];
    content: string;
    targets: Array<{
      targetId: string;
      targetType: "ROOT" | "ORGANIZATIONAL_UNIT" | "ACCOUNT";
    }>;
  }> = [];

  const ouByName = toRecordByProperty(props.currentState.organization.organizationalUnits, "name");
  const stateAccountByName = toRecordByProperty(props.currentState.organization.accounts, "name");

  function resolveTargetId(targetName: string): {
    targetId: string;
    targetType: "ROOT" | "ORGANIZATIONAL_UNIT" | "ACCOUNT";
  } {
    if (targetName === "root") {
      return {
        targetId: props.context.organization.rootId,
        targetType: "ROOT",
      };
    }
    const ou = ouByName[targetName];
    if (ou != null) {
      return { targetId: ou.id, targetType: "ORGANIZATIONAL_UNIT" };
    }
    const acct = stateAccountByName[targetName];
    if (acct != null) {
      return { targetId: acct.id, targetType: "ACCOUNT" };
    }
    return { targetId: pendingCreationId, targetType: "ACCOUNT" };
  }

  for (const policy of configPolicies.serviceControlPolicies) {
    allConfigPolicies.push({
      name: policy.name,
      description: policy.description ?? "",
      type: "SERVICE_CONTROL_POLICY",
      content: JSON.stringify(
        resolveAccountNamesInPolicyContent(policy.content, stateAccountByName),
      ),
      targets: policy.targets.map((t) => resolveTargetId(t)),
    });
  }

  for (const policy of configPolicies.resourceControlPolicies) {
    allConfigPolicies.push({
      name: policy.name,
      description: policy.description ?? "",
      type: "RESOURCE_CONTROL_POLICY",
      content: JSON.stringify(policy.content),
      targets: policy.targets.map((t) => resolveTargetId(t)),
    });
  }

  for (const policy of configPolicies.tagPolicies) {
    allConfigPolicies.push({
      name: policy.name,
      description: policy.description ?? "",
      type: "TAG_POLICY",
      content: JSON.stringify(policy.content),
      targets: policy.targets.map((t) => resolveTargetId(t)),
    });
  }

  for (const policy of configPolicies.aiServicesOptOutPolicies) {
    allConfigPolicies.push({
      name: policy.name,
      description: policy.description ?? "",
      type: "AISERVICES_OPT_OUT_POLICY",
      content: JSON.stringify(policy.content),
      targets: policy.targets.map((t) => resolveTargetId(t)),
    });
  }

  for (const policy of configPolicies.backupPolicies) {
    allConfigPolicies.push({
      name: policy.name,
      description: policy.description ?? "",
      type: "BACKUP_POLICY",
      content: JSON.stringify(policy.content),
      targets: policy.targets.map((t) => resolveTargetId(t)),
    });
  }

  const currentPoliciesByNameAndType = new Map(
    (props.currentState.organization.policies ?? []).map((p) => [`${p.type}|${p.name}`, p]),
  );

  const mappedPolicies: NonNullable<StateFile["organization"]["policies"]> = allConfigPolicies.map(
    (p) => {
      const current = currentPoliciesByNameAndType.get(`${p.type}|${p.name}`);
      return {
        id: current?.id ?? pendingCreationId,
        arn: current?.arn ?? pendingCreationId,
        name: p.name,
        description: p.description,
        type: p.type,
        content: p.content,
      };
    },
  );

  const mappedPolicyAttachments: NonNullable<StateFile["organization"]["policyAttachments"]> = [];
  for (let i = 0; i < allConfigPolicies.length; i++) {
    const configPolicy = allConfigPolicies[i];
    const mappedPolicy = mappedPolicies[i];
    if (configPolicy == null || mappedPolicy == null) {
      continue;
    }
    for (const target of configPolicy.targets) {
      mappedPolicyAttachments.push({
        policyId: mappedPolicy.id,
        targetId: target.targetId,
        targetType: target.targetType,
      });
    }
  }

  const configDelegatedAdmins = props.config.delegatedAdministrators;
  const mappedDelegatedAdministrators =
    configDelegatedAdmins.length > 0
      ? configDelegatedAdmins.map(({ account, servicePrincipal }) => ({
          accountId: stateAccountByName[account]?.id ?? pendingCreationId,
          servicePrincipal,
        }))
      : undefined;

  const mapped: StateFile = {
    version: props.currentState.version,
    generatedAt: props.currentState.generatedAt,
    organization: {
      organizationId: props.currentState.organization.organizationId,
      rootId: props.context.organization.rootId,
      organizationalUnits: mappedOrganizationalUnits,
      accounts: mappedAccounts,
      policies: mappedPolicies,
      policyAttachments: mappedPolicyAttachments,
      delegatedAdministrators: mappedDelegatedAdministrators,
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
      accessControlAttributes: (props.config.accessControlAttributes ?? []).map((attr) => ({
        key: attr.key,
        source: [...attr.source],
      })),
    },
  };

  assertUniqueNames({
    values: props.config.organizationalUnits.map((organizationalUnit) => organizationalUnit.name),
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
  assertUniqueNames({
    values: props.config.policies.serviceControlPolicies.map((p) => p.name),
    entityName: "SCP",
  });
  assertUniqueNames({
    values: props.config.policies.resourceControlPolicies.map((p) => p.name),
    entityName: "RCP",
  });
  assertUniqueNames({
    values: props.config.policies.tagPolicies.map((p) => p.name),
    entityName: "tag policy",
  });
  assertUniqueNames({
    values: props.config.policies.aiServicesOptOutPolicies.map((p) => p.name),
    entityName: "AI services opt-out policy",
  });
  assertUniqueNames({
    values: props.config.policies.backupPolicies.map((p) => p.name),
    entityName: "backup policy",
  });

  return validateState(mapped);
}
