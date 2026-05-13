import * as v from "valibot";
import type { StateFile } from "./state.js";
import {
  planSchema,
  type Operation,
  type Plan,
  type UnsupportedDiff,
} from "./operations.js";

const pendingCreationId = "__pending_creation__" as const;
const operationExecutionPriority: Record<Operation["kind"], number> = {
  createOu: 1,
  renameOu: 2,
  createAccount: 3,
  moveAccount: 4,
  createIdcUser: 5,
  updateIdcUser: 6,
  createIdcGroup: 7,
  updateIdcGroupDescription: 8,
  addIdcGroupMembership: 9,
  createIdcPermissionSet: 10,
  updateIdcPermissionSetDescription: 11,
  putIdcPermissionSetInlinePolicy: 12,
  deleteIdcPermissionSetInlinePolicy: 13,
  attachIdcManagedPolicyToPermissionSet: 14,
  detachIdcManagedPolicyFromPermissionSet: 15,
  attachIdcCustomerManagedPolicyReferenceToPermissionSet: 16,
  detachIdcCustomerManagedPolicyReferenceFromPermissionSet: 17,
  provisionIdcPermissionSet: 18,
  grantIdcAccountAssignment: 19,
  removeIdcGroupMembership: 20,
  revokeIdcAccountAssignment: 21,
  deleteIdcUser: 22,
  deleteIdcGroup: 23,
  deleteIdcPermissionSet: 24,
  deleteOu: 25,
};

type DiffStatesProps = {
  current: StateFile;
  next: StateFile;
};

type GroupOrganizationalUnitsByParentIdProps = {
  organizationalUnits: StateFile["organization"]["organizationalUnits"];
};

type NormalizedOrganizationView = {
  rootId: string;
  organizationalUnits: StateFile["organization"]["organizationalUnits"];
  accounts: StateFile["organization"]["accounts"];
  organizationalUnitByName: Map<
    string,
    StateFile["organization"]["organizationalUnits"][number]
  >;
  accountByName: Map<string, StateFile["organization"]["accounts"][number]>;
  organizationalUnitNameById: Map<string, string>;
  organizationalUnitsByParentId: Map<
    string,
    StateFile["organization"]["organizationalUnits"]
  >;
  accountsByParentId: Map<string, number>;
  organizationalUnitDepthById: Map<string, number>;
};

type NormalizedIdcAssignment = {
  accountName: string;
  permissionSetName: string;
  principalType: StateFile["identityCenter"]["accountAssignments"][number]["principalType"];
  principalName: string;
};

type NormalizedIdcMembership = {
  groupDisplayName: string;
  userName: string;
};

type NormalizedIdcView = {
  usersByUserName: Map<string, StateFile["identityCenter"]["users"][number]>;
  groupsByDisplayName: Map<
    string,
    StateFile["identityCenter"]["groups"][number]
  >;
  membershipsByKey: Map<string, NormalizedIdcMembership>;
  permissionSetsByName: Map<
    string,
    StateFile["identityCenter"]["permissionSets"][number]
  >;
  assignmentsByKey: Map<string, NormalizedIdcAssignment>;
};

export function diffStates(props: DiffStatesProps): Plan {
  const operations: Operation[] = [];
  const unsupported: UnsupportedDiff[] = [];

  const currentOrganization = normalizeOrganizationState({
    state: props.current,
    includeDepthById: true,
  });
  const nextOrganization = normalizeOrganizationState({
    state: props.next,
  });

  for (const nextAccount of nextOrganization.accounts) {
    const currentAccount = currentOrganization.accountByName.get(nextAccount.name);
    if (currentAccount == null) {
      if (nextAccount.id === pendingCreationId) {
        const targetOuName = resolveOrganizationalUnitName({
          organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
          rootId: nextOrganization.rootId,
          organizationalUnitId: nextAccount.parentId,
        });
        if (
          isResolvableOrganizationalUnitId({
            rootId: nextOrganization.rootId,
            organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
            organizationalUnitId: nextAccount.parentId,
          }) === false
        ) {
          unsupported.push({
            kind: "newAccountWithUnknownOu",
            category: "unsupportedMutation",
            description: `new account "${nextAccount.name}" has unresolved target OU "${targetOuName}" (${nextAccount.parentId})`,
          });
          continue;
        }
        operations.push({
          kind: "createAccount",
          accountName: nextAccount.name,
          accountEmail: nextAccount.email,
          targetOuId: nextAccount.parentId,
          targetOuName,
        });
      }
      continue;
    }
    if (nextAccount.parentId === currentAccount.parentId) {
      continue;
    }
    if (
      currentAccount.id === pendingCreationId ||
      nextAccount.id === pendingCreationId ||
      currentAccount.parentId === pendingCreationId ||
      nextAccount.parentId === pendingCreationId
    ) {
      continue;
    }
    const fromOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: currentOrganization.organizationalUnitNameById,
      rootId: currentOrganization.rootId,
      organizationalUnitId: currentAccount.parentId,
    });
    const toOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
      rootId: nextOrganization.rootId,
      organizationalUnitId: nextAccount.parentId,
    });
    operations.push({
      kind: "moveAccount",
      accountId: nextAccount.id,
      accountName: nextAccount.name,
      fromOuId: currentAccount.parentId,
      fromOuName,
      toOuId: nextAccount.parentId,
      toOuName,
    });
  }

  for (const currentAccount of currentOrganization.accounts) {
    if (nextOrganization.accountByName.has(currentAccount.name)) {
      continue;
    }
    unsupported.push({
      kind: "removedAccount",
      category: "destructive",
      description: `removed account "${currentAccount.name}"`,
    });
  }

  for (const nextOrganizationalUnit of nextOrganization.organizationalUnits) {
    const currentOrganizationalUnit = currentOrganization.organizationalUnitByName.get(
      nextOrganizationalUnit.name,
    );
    if (currentOrganizationalUnit == null) {
      continue;
    }
    if (
      currentOrganizationalUnit.parentId === nextOrganizationalUnit.parentId
    ) {
      continue;
    }
    const fromParentOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: currentOrganization.organizationalUnitNameById,
      rootId: currentOrganization.rootId,
      organizationalUnitId: currentOrganizationalUnit.parentId,
    });
    const toParentOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
      rootId: nextOrganization.rootId,
      organizationalUnitId: nextOrganizationalUnit.parentId,
    });
    unsupported.push({
      kind: "reparentedOu",
      category: "unsupportedMutation",
      description: `OU "${nextOrganizationalUnit.name}" changed parent from "${fromParentOuName}" to "${toParentOuName}"`,
    });
  }

  const addedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] =
    [];
  const removedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] =
    [];
  for (const nextOrganizationalUnit of nextOrganization.organizationalUnits) {
    if (
      currentOrganization.organizationalUnitByName.has(nextOrganizationalUnit.name)
    ) {
      continue;
    }
    addedOrganizationalUnits.push(nextOrganizationalUnit);
  }
  for (const currentOrganizationalUnit of currentOrganization.organizationalUnits) {
    if (
      nextOrganization.organizationalUnitByName.has(currentOrganizationalUnit.name)
    ) {
      continue;
    }
    removedOrganizationalUnits.push(currentOrganizationalUnit);
  }

  const addedByParentId = groupOrganizationalUnitsByParentId({
    organizationalUnits: addedOrganizationalUnits,
  });
  const removedByParentId = groupOrganizationalUnitsByParentId({
    organizationalUnits: removedOrganizationalUnits,
  });
  const plannedMoveAccountDeparturesByOuId = countMoveAccountDeparturesByOuId({
    operations,
  });
  const consumedAddedOrganizationalUnitNames = new Set<string>();
  const consumedRemovedOrganizationalUnitNames = new Set<string>();

  const parentIds = new Set<string>([
    ...addedByParentId.keys(),
    ...removedByParentId.keys(),
  ]);
  for (const parentId of parentIds) {
    const parentAdded = (addedByParentId.get(parentId) ?? []).filter(
      (organizationalUnit) =>
        consumedAddedOrganizationalUnitNames.has(organizationalUnit.name) ===
        false,
    );
    const parentRemoved = (removedByParentId.get(parentId) ?? []).filter(
      (organizationalUnit) =>
        consumedRemovedOrganizationalUnitNames.has(organizationalUnit.name) ===
        false,
    );

    if (parentAdded.length === 1 && parentRemoved.length === 1) {
      const added = parentAdded[0];
      const removed = parentRemoved[0];
      consumedAddedOrganizationalUnitNames.add(added.name);
      consumedRemovedOrganizationalUnitNames.add(removed.name);
      const parentOuName = resolveOrganizationalUnitName({
        organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
        rootId: nextOrganization.rootId,
        organizationalUnitId: parentId,
      });
      operations.push({
        kind: "renameOu",
        ouId: removed.id,
        fromOuName: removed.name,
        toOuName: added.name,
        parentOuId: parentId,
        parentOuName,
      });
      continue;
    }

    if (parentAdded.length > 0 && parentRemoved.length > 0) {
      const parentOuName = resolveOrganizationalUnitName({
        organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
        rootId: nextOrganization.rootId,
        organizationalUnitId: parentId,
      });
      unsupported.push({
        kind: "ambiguousOuRename",
        category: "unsupportedMutation",
        description: `ambiguous OU rename under "${parentOuName}" (added: ${parentAdded
          .map((organizationalUnit) => organizationalUnit.name)
          .sort((left, right) => left.localeCompare(right))
          .join(", ")}; removed: ${parentRemoved
          .map((organizationalUnit) => organizationalUnit.name)
          .sort((left, right) => left.localeCompare(right))
          .join(", ")})`,
      });
      for (const organizationalUnit of parentAdded) {
        consumedAddedOrganizationalUnitNames.add(organizationalUnit.name);
      }
      for (const organizationalUnit of parentRemoved) {
        consumedRemovedOrganizationalUnitNames.add(organizationalUnit.name);
      }
      continue;
    }
  }

  for (const addedOrganizationalUnit of addedOrganizationalUnits) {
    if (
      consumedAddedOrganizationalUnitNames.has(addedOrganizationalUnit.name)
    ) {
      continue;
    }
    const parentOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
      rootId: nextOrganization.rootId,
      organizationalUnitId: addedOrganizationalUnit.parentId,
    });
    if (
      isResolvableOrganizationalUnitId({
        rootId: nextOrganization.rootId,
        organizationalUnitNameById: nextOrganization.organizationalUnitNameById,
        organizationalUnitId: addedOrganizationalUnit.parentId,
      }) === false
    ) {
      unsupported.push({
        kind: "newOuWithUnknownParent",
        category: "unsupportedMutation",
        description: `new OU "${addedOrganizationalUnit.name}" has unresolved parent "${parentOuName}" (${addedOrganizationalUnit.parentId})`,
      });
      continue;
    }
    operations.push({
      kind: "createOu",
      ouName: addedOrganizationalUnit.name,
      parentOuId: addedOrganizationalUnit.parentId,
      parentOuName,
    });
  }
  const pendingRemovedOrganizationalUnits = removedOrganizationalUnits.filter(
    (organizationalUnit) =>
      consumedRemovedOrganizationalUnitNames.has(organizationalUnit.name) ===
      false,
  );
  const pendingRemovedOrganizationalUnitIds = new Set(
    pendingRemovedOrganizationalUnits.map(
      (organizationalUnit) => organizationalUnit.id,
    ),
  );
  const deleteEligibilityByOuId = createDeleteEligibilityByOuId({
    removedOrganizationalUnits: pendingRemovedOrganizationalUnits,
    removedOrganizationalUnitIds: pendingRemovedOrganizationalUnitIds,
    currentOrganizationalUnitsByParentId:
      currentOrganization.organizationalUnitsByParentId,
    currentAccountsByParentId: currentOrganization.accountsByParentId,
    plannedMoveAccountDeparturesByOuId,
  });
  for (const removedOrganizationalUnit of pendingRemovedOrganizationalUnits) {
    if (deleteEligibilityByOuId.get(removedOrganizationalUnit.id) === true) {
      const parentOuName = resolveOrganizationalUnitName({
        organizationalUnitNameById: currentOrganization.organizationalUnitNameById,
        rootId: currentOrganization.rootId,
        organizationalUnitId: removedOrganizationalUnit.parentId,
      });
      operations.push({
        kind: "deleteOu",
        ouId: removedOrganizationalUnit.id,
        ouName: removedOrganizationalUnit.name,
        parentOuId: removedOrganizationalUnit.parentId,
        parentOuName,
      });
      continue;
    }
    unsupported.push({
      kind: "removedOu",
      category: "destructive",
      description: `removed OU "${removedOrganizationalUnit.name}"`,
    });
  }

  const currentIdcView = normalizeIdentityCenterState({
    state: props.current,
  });
  const nextIdcView = normalizeIdentityCenterState({
    state: props.next,
  });

  for (const nextUser of props.next.identityCenter.users) {
    if (currentIdcView.usersByUserName.has(nextUser.userName)) {
      continue;
    }
    operations.push({
      kind: "createIdcUser",
      userName: nextUser.userName,
      displayName: nextUser.displayName,
      email: nextUser.email,
    });
  }

  for (const nextUser of props.next.identityCenter.users) {
    const currentUser = currentIdcView.usersByUserName.get(nextUser.userName);
    if (currentUser == null) {
      continue;
    }
    const emailWouldChange =
      currentUser.email !== nextUser.email && nextUser.email.length > 0;
    if (currentUser.displayName === nextUser.displayName && emailWouldChange === false) {
      continue;
    }
    operations.push({
      kind: "updateIdcUser",
      userName: nextUser.userName,
      displayName: nextUser.displayName,
      email: nextUser.email,
    });
  }

  for (const nextGroup of props.next.identityCenter.groups) {
    if (currentIdcView.groupsByDisplayName.has(nextGroup.displayName)) {
      continue;
    }
    operations.push({
      kind: "createIdcGroup",
      groupDisplayName: nextGroup.displayName,
      description: nextGroup.description ?? "",
    });
  }

  for (const nextGroup of props.next.identityCenter.groups) {
    const currentGroup = currentIdcView.groupsByDisplayName.get(
      nextGroup.displayName,
    );
    if (currentGroup == null) {
      continue;
    }
    if ((currentGroup.description ?? "") === (nextGroup.description ?? "")) {
      continue;
    }
    operations.push({
      kind: "updateIdcGroupDescription",
      groupDisplayName: nextGroup.displayName,
      description: nextGroup.description ?? "",
    });
  }

  const removedUserNames = new Set(
    props.current.identityCenter.users
      .filter(
        (user) => nextIdcView.usersByUserName.has(user.userName) === false,
      )
      .map((user) => user.userName),
  );
  const removedGroupDisplayNames = new Set(
    props.current.identityCenter.groups
      .filter(
        (group) =>
          nextIdcView.groupsByDisplayName.has(group.displayName) === false,
      )
      .map((group) => group.displayName),
  );
  const removedPermissionSetNames = new Set(
    props.current.identityCenter.permissionSets
      .filter(
        (permissionSet) =>
          nextIdcView.permissionSetsByName.has(permissionSet.name) === false,
      )
      .map((permissionSet) => permissionSet.name),
  );
  const permissionSetNamesWithDesiredAssignments = new Set(
    [...nextIdcView.assignmentsByKey.values()].map(
      (assignment) => assignment.permissionSetName,
    ),
  );

  for (const nextMembership of nextIdcView.membershipsByKey.values()) {
    const membershipKey = createNormalizedIdcMembershipKey({
      membership: nextMembership,
    });
    if (currentIdcView.membershipsByKey.has(membershipKey)) {
      continue;
    }
    operations.push({
      kind: "addIdcGroupMembership",
      groupDisplayName: nextMembership.groupDisplayName,
      userName: nextMembership.userName,
    });
  }
  for (const currentMembership of currentIdcView.membershipsByKey.values()) {
    const membershipKey = createNormalizedIdcMembershipKey({
      membership: currentMembership,
    });
    if (
      nextIdcView.membershipsByKey.has(membershipKey) &&
      removedUserNames.has(currentMembership.userName) === false &&
      removedGroupDisplayNames.has(currentMembership.groupDisplayName) === false
    ) {
      continue;
    }
    operations.push({
      kind: "removeIdcGroupMembership",
      groupDisplayName: currentMembership.groupDisplayName,
      userName: currentMembership.userName,
    });
  }

  for (const nextPermissionSet of props.next.identityCenter.permissionSets) {
    const currentPermissionSet =
      currentIdcView.permissionSetsByName.get(nextPermissionSet.name);
    if (currentPermissionSet == null) {
      operations.push({
        kind: "createIdcPermissionSet",
        permissionSetName: nextPermissionSet.name,
        description: nextPermissionSet.description,
      });
    }

    const permissionSetMutationStartIndex = operations.length;
    if (currentPermissionSet != null) {
      if (currentPermissionSet.description !== nextPermissionSet.description) {
        operations.push({
          kind: "updateIdcPermissionSetDescription",
          permissionSetName: nextPermissionSet.name,
          description: nextPermissionSet.description,
        });
      }
    }

    const currentInlinePolicy = normalizeInlinePolicyString(
      currentPermissionSet?.inlinePolicy ?? null,
    );
    const nextInlinePolicy = normalizeInlinePolicyString(
      nextPermissionSet.inlinePolicy,
    );
    if (nextInlinePolicy != null && nextInlinePolicy !== currentInlinePolicy) {
      operations.push({
        kind: "putIdcPermissionSetInlinePolicy",
        permissionSetName: nextPermissionSet.name,
        inlinePolicy: nextInlinePolicy,
      });
    }
    if (nextInlinePolicy == null && currentInlinePolicy != null) {
      operations.push({
        kind: "deleteIdcPermissionSetInlinePolicy",
        permissionSetName: nextPermissionSet.name,
      });
    }

    const currentAwsManagedPolicies = new Set(
      currentPermissionSet?.awsManagedPolicies ?? [],
    );
    const nextAwsManagedPolicies = new Set(nextPermissionSet.awsManagedPolicies);
    for (const managedPolicyArn of nextAwsManagedPolicies) {
      if (currentAwsManagedPolicies.has(managedPolicyArn)) {
        continue;
      }
      operations.push({
        kind: "attachIdcManagedPolicyToPermissionSet",
        permissionSetName: nextPermissionSet.name,
        managedPolicyArn,
      });
    }
    for (const managedPolicyArn of currentAwsManagedPolicies) {
      if (nextAwsManagedPolicies.has(managedPolicyArn)) {
        continue;
      }
      operations.push({
        kind: "detachIdcManagedPolicyFromPermissionSet",
        permissionSetName: nextPermissionSet.name,
        managedPolicyArn,
      });
    }

    const currentCustomerManagedPolicies = new Map(
      (currentPermissionSet?.customerManagedPolicies ?? []).map((policy) => [
        createCustomerManagedPolicyReferenceKey(policy),
        policy,
      ]),
    );
    const nextCustomerManagedPolicies = new Map(
      nextPermissionSet.customerManagedPolicies.map((policy) => [
        createCustomerManagedPolicyReferenceKey(policy),
        policy,
      ]),
    );
    for (const [policyKey, customerManagedPolicy] of nextCustomerManagedPolicies) {
      if (currentCustomerManagedPolicies.has(policyKey)) {
        continue;
      }
      operations.push({
        kind: "attachIdcCustomerManagedPolicyReferenceToPermissionSet",
        permissionSetName: nextPermissionSet.name,
        customerManagedPolicyName: customerManagedPolicy.name,
        customerManagedPolicyPath: customerManagedPolicy.path,
      });
    }
    for (const [policyKey, customerManagedPolicy] of currentCustomerManagedPolicies) {
      if (nextCustomerManagedPolicies.has(policyKey)) {
        continue;
      }
      operations.push({
        kind: "detachIdcCustomerManagedPolicyReferenceFromPermissionSet",
        permissionSetName: nextPermissionSet.name,
        customerManagedPolicyName: customerManagedPolicy.name,
        customerManagedPolicyPath: customerManagedPolicy.path,
      });
    }

    if (
      currentPermissionSet != null &&
      operations.length > permissionSetMutationStartIndex &&
      permissionSetNamesWithDesiredAssignments.has(nextPermissionSet.name)
    ) {
      operations.push({
        kind: "provisionIdcPermissionSet",
        permissionSetName: nextPermissionSet.name,
        targetScope: "ALL_PROVISIONED_ACCOUNTS",
      });
    }
  }

  for (const nextAssignment of nextIdcView.assignmentsByKey.values()) {
    const assignmentKey = createNormalizedIdcAssignmentKey({
      assignment: nextAssignment,
    });
    if (currentIdcView.assignmentsByKey.has(assignmentKey)) {
      continue;
    }
    operations.push({
      kind: "grantIdcAccountAssignment",
      accountName: nextAssignment.accountName,
      permissionSetName: nextAssignment.permissionSetName,
      principalType: nextAssignment.principalType,
      principalName: nextAssignment.principalName,
    });
  }
  for (const currentAssignment of currentIdcView.assignmentsByKey.values()) {
    const assignmentKey = createNormalizedIdcAssignmentKey({
      assignment: currentAssignment,
    });
    if (
      nextIdcView.assignmentsByKey.has(assignmentKey) &&
      removedPermissionSetNames.has(currentAssignment.permissionSetName) ===
        false &&
      (currentAssignment.principalType === "USER"
        ? removedUserNames.has(currentAssignment.principalName) === false
        : removedGroupDisplayNames.has(currentAssignment.principalName) ===
          false)
    ) {
      continue;
    }
    operations.push({
      kind: "revokeIdcAccountAssignment",
      accountName: currentAssignment.accountName,
      permissionSetName: currentAssignment.permissionSetName,
      principalType: currentAssignment.principalType,
      principalName: currentAssignment.principalName,
    });
  }
  for (const removedUserName of removedUserNames) {
    operations.push({
      kind: "deleteIdcUser",
      userName: removedUserName,
    });
  }
  for (const removedGroupDisplayName of removedGroupDisplayNames) {
    operations.push({
      kind: "deleteIdcGroup",
      groupDisplayName: removedGroupDisplayName,
    });
  }
  for (const removedPermissionSetName of removedPermissionSetNames) {
    operations.push({
      kind: "deleteIdcPermissionSet",
      permissionSetName: removedPermissionSetName,
    });
  }

  operations.sort((left, right) => {
    const priorityComparison =
      getOperationExecutionPriority(left) -
      getOperationExecutionPriority(right);
    if (priorityComparison !== 0) {
      return priorityComparison;
    }
    if (left.kind === "deleteOu" && right.kind === "deleteOu") {
      const depthComparison =
        (currentOrganization.organizationalUnitDepthById.get(right.ouId) ?? 0) -
        (currentOrganization.organizationalUnitDepthById.get(left.ouId) ?? 0);
      if (depthComparison !== 0) {
        return depthComparison;
      }
    }
    return getOperationSortKey(left).localeCompare(getOperationSortKey(right));
  });
  unsupported.sort((left, right) => {
    const kindComparison = left.kind.localeCompare(right.kind);
    if (kindComparison !== 0) {
      return kindComparison;
    }
    return left.description.localeCompare(right.description);
  });

  return v.parse(planSchema, {
    operations,
    unsupported,
  });
}

function groupOrganizationalUnitsByParentId(
  props: GroupOrganizationalUnitsByParentIdProps,
): Map<string, StateFile["organization"]["organizationalUnits"]> {
  const grouped = new Map<
    string,
    StateFile["organization"]["organizationalUnits"]
  >();
  for (const organizationalUnit of props.organizationalUnits) {
    const existing = grouped.get(organizationalUnit.parentId) ?? [];
    existing.push(organizationalUnit);
    grouped.set(organizationalUnit.parentId, existing);
  }
  return grouped;
}

function countChildrenByParentId(props: {
  values: Array<{ parentId: string }>;
}): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of props.values) {
    counts.set(value.parentId, (counts.get(value.parentId) ?? 0) + 1);
  }
  return counts;
}

function countMoveAccountDeparturesByOuId(props: {
  operations: Operation[];
}): Map<string, number> {
  const counts = new Map<string, number>();
  for (const operation of props.operations) {
    if (operation.kind !== "moveAccount") {
      continue;
    }
    counts.set(operation.fromOuId, (counts.get(operation.fromOuId) ?? 0) + 1);
  }
  return counts;
}

function normalizeOrganizationState(props: {
  state: StateFile;
  includeDepthById?: boolean;
}): NormalizedOrganizationView {
  const organizationalUnitByName = new Map(
    props.state.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.name,
      organizationalUnit,
    ]),
  );
  const organizationalUnitById = new Map(
    props.state.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.id,
      organizationalUnit,
    ]),
  );
  const accountByName = new Map(
    props.state.organization.accounts.map((account) => [account.name, account]),
  );
  const organizationalUnitNameById = new Map(
    props.state.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.id,
      organizationalUnit.name,
    ]),
  );
  const organizationalUnitsByParentId = groupOrganizationalUnitsByParentId({
    organizationalUnits: props.state.organization.organizationalUnits,
  });
  const accountsByParentId = countChildrenByParentId({
    values: props.state.organization.accounts,
  });

  return {
    rootId: props.state.organization.rootId,
    organizationalUnits: props.state.organization.organizationalUnits,
    accounts: props.state.organization.accounts,
    organizationalUnitByName,
    accountByName,
    organizationalUnitNameById,
    organizationalUnitsByParentId,
    accountsByParentId,
    organizationalUnitDepthById: props.includeDepthById
      ? createOrganizationalUnitDepthById({
          rootId: props.state.organization.rootId,
          organizationalUnitById,
        })
      : new Map(),
  };
}

function createDeleteEligibilityByOuId(props: {
  removedOrganizationalUnits: StateFile["organization"]["organizationalUnits"];
  removedOrganizationalUnitIds: Set<string>;
  currentOrganizationalUnitsByParentId: Map<
    string,
    StateFile["organization"]["organizationalUnits"]
  >;
  currentAccountsByParentId: Map<string, number>;
  plannedMoveAccountDeparturesByOuId: Map<string, number>;
}): Map<string, boolean> {
  const eligibilityByOuId = new Map<string, boolean>();

  function canDeleteOrganizationalUnit(organizationalUnitId: string): boolean {
    const cachedEligibility = eligibilityByOuId.get(organizationalUnitId);
    if (cachedEligibility != null) {
      return cachedEligibility;
    }

    const currentChildren =
      props.currentOrganizationalUnitsByParentId.get(organizationalUnitId) ??
      [];
    for (const childOrganizationalUnit of currentChildren) {
      if (
        props.removedOrganizationalUnitIds.has(childOrganizationalUnit.id) ===
        false
      ) {
        eligibilityByOuId.set(organizationalUnitId, false);
        return false;
      }
      if (canDeleteOrganizationalUnit(childOrganizationalUnit.id) === false) {
        eligibilityByOuId.set(organizationalUnitId, false);
        return false;
      }
    }

    const projectedRemainingAccounts =
      (props.currentAccountsByParentId.get(organizationalUnitId) ?? 0) -
      (props.plannedMoveAccountDeparturesByOuId.get(organizationalUnitId) ?? 0);
    const canDelete = projectedRemainingAccounts === 0;
    eligibilityByOuId.set(organizationalUnitId, canDelete);
    return canDelete;
  }

  for (const removedOrganizationalUnit of props.removedOrganizationalUnits) {
    canDeleteOrganizationalUnit(removedOrganizationalUnit.id);
  }

  return eligibilityByOuId;
}

function createOrganizationalUnitDepthById(props: {
  rootId: string;
  organizationalUnitById: Map<
    string,
    StateFile["organization"]["organizationalUnits"][number]
  >;
}): Map<string, number> {
  const depthById = new Map<string, number>();

  function getDepth(organizationalUnitId: string): number {
    const cachedDepth = depthById.get(organizationalUnitId);
    if (cachedDepth != null) {
      return cachedDepth;
    }

    const organizationalUnit =
      props.organizationalUnitById.get(organizationalUnitId);
    if (organizationalUnit == null) {
      return 0;
    }
    if (organizationalUnit.parentId === props.rootId) {
      depthById.set(organizationalUnitId, 1);
      return 1;
    }

    const depth = getDepth(organizationalUnit.parentId) + 1;
    depthById.set(organizationalUnitId, depth);
    return depth;
  }

  for (const organizationalUnitId of props.organizationalUnitById.keys()) {
    getDepth(organizationalUnitId);
  }

  return depthById;
}

function getOperationExecutionPriority(operation: Operation): number {
  return operationExecutionPriority[operation.kind];
}

function getOperationSortKey(operation: Operation): string {
  if (operation.kind === "moveAccount") {
    return `${operation.kind}|${operation.accountName}|${operation.accountId}`;
  }
  if (operation.kind === "createOu") {
    return `${operation.kind}|${operation.ouName}|${operation.parentOuName}`;
  }
  if (operation.kind === "renameOu") {
    return `${operation.kind}|${operation.fromOuName}|${operation.toOuName}`;
  }
  if (operation.kind === "createAccount") {
    return `${operation.kind}|${operation.accountName}|${operation.targetOuName}`;
  }
  if (operation.kind === "deleteOu") {
    return `${operation.kind}|${operation.ouName}|${operation.parentOuName}`;
  }
  if (operation.kind === "createIdcUser") {
    return `${operation.kind}|${operation.userName}`;
  }
  if (operation.kind === "updateIdcUser") {
    return `${operation.kind}|${operation.userName}`;
  }
  if (operation.kind === "deleteIdcUser") {
    return `${operation.kind}|${operation.userName}`;
  }
  if (operation.kind === "createIdcGroup") {
    return `${operation.kind}|${operation.groupDisplayName}`;
  }
  if (operation.kind === "updateIdcGroupDescription") {
    return `${operation.kind}|${operation.groupDisplayName}`;
  }
  if (operation.kind === "deleteIdcGroup") {
    return `${operation.kind}|${operation.groupDisplayName}`;
  }
  if (
    operation.kind === "addIdcGroupMembership" ||
    operation.kind === "removeIdcGroupMembership"
  ) {
    return `${operation.kind}|${operation.groupDisplayName}|${operation.userName}`;
  }
  if (operation.kind === "createIdcPermissionSet") {
    return `${operation.kind}|${operation.permissionSetName}`;
  }
  if (operation.kind === "deleteIdcPermissionSet") {
    return `${operation.kind}|${operation.permissionSetName}`;
  }
  if (
    operation.kind === "putIdcPermissionSetInlinePolicy" ||
    operation.kind === "deleteIdcPermissionSetInlinePolicy" ||
    operation.kind === "updateIdcPermissionSetDescription" ||
    operation.kind === "provisionIdcPermissionSet"
  ) {
    return `${operation.kind}|${operation.permissionSetName}`;
  }
  if (
    operation.kind === "attachIdcManagedPolicyToPermissionSet" ||
    operation.kind === "detachIdcManagedPolicyFromPermissionSet"
  ) {
    return [
      operation.kind,
      operation.permissionSetName,
      operation.managedPolicyArn,
    ].join("|");
  }
  if (
    operation.kind === "attachIdcCustomerManagedPolicyReferenceToPermissionSet" ||
    operation.kind === "detachIdcCustomerManagedPolicyReferenceFromPermissionSet"
  ) {
    return [
      operation.kind,
      operation.permissionSetName,
      operation.customerManagedPolicyPath,
      operation.customerManagedPolicyName,
    ].join("|");
  }
  if (
    operation.kind === "grantIdcAccountAssignment" ||
    operation.kind === "revokeIdcAccountAssignment"
  ) {
    return [
      operation.kind,
      operation.accountName,
      operation.permissionSetName,
      operation.principalType,
      operation.principalName,
    ].join("|");
  }
  return "zzzz";
}

function normalizeIdentityCenterState(props: {
  state: StateFile;
}): NormalizedIdcView {
  const usersByUserName = new Map(
    props.state.identityCenter.users.map((user) => [user.userName, user]),
  );
  const groupsByDisplayName = new Map(
    props.state.identityCenter.groups.map((group) => [
      group.displayName,
      group,
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
  const membershipsByKey = new Map<string, NormalizedIdcMembership>();
  for (const groupMembership of props.state.identityCenter.groupMemberships) {
    const groupDisplayName = groupDisplayNameById.get(groupMembership.groupId);
    if (groupDisplayName == null) {
      throw new Error(
        `Could not resolve group display name for IdC membership groupId "${groupMembership.groupId}".`,
      );
    }
    const userName = userNameById.get(groupMembership.userId);
    if (userName == null) {
      throw new Error(
        `Could not resolve user name for IdC membership userId "${groupMembership.userId}".`,
      );
    }
    const normalizedMembership = {
      groupDisplayName,
      userName,
    };
    membershipsByKey.set(
      createNormalizedIdcMembershipKey({
        membership: normalizedMembership,
      }),
      normalizedMembership,
    );
  }
  const permissionSetsByName = new Map(
    props.state.identityCenter.permissionSets.map((permissionSet) => [
      permissionSet.name,
      permissionSet,
    ]),
  );
  const accountNameById = new Map(
    props.state.organization.accounts.map((account) => [
      account.id,
      account.name,
    ]),
  );
  const permissionSetNameByArn = new Map(
    props.state.identityCenter.permissionSets.map((permissionSet) => [
      permissionSet.permissionSetArn,
      permissionSet.name,
    ]),
  );
  const assignmentsByKey = new Map<string, NormalizedIdcAssignment>();
  for (const accountAssignment of props.state.identityCenter
    .accountAssignments) {
    const accountName = accountNameById.get(accountAssignment.accountId);
    if (accountName == null) {
      throw new Error(
        `Could not resolve account name for IdC assignment accountId "${accountAssignment.accountId}".`,
      );
    }
    const permissionSetName = permissionSetNameByArn.get(
      accountAssignment.permissionSetArn,
    );
    if (permissionSetName == null) {
      throw new Error(
        `Could not resolve permission set name for IdC assignment permissionSetArn "${accountAssignment.permissionSetArn}".`,
      );
    }
    const principalName = resolveAssignmentPrincipalName({
      principalId: accountAssignment.principalId,
      principalType: accountAssignment.principalType,
      groupDisplayNameById,
      userNameById,
    });
    const normalizedAssignment = {
      accountName,
      permissionSetName,
      principalType: accountAssignment.principalType,
      principalName,
    };
    assignmentsByKey.set(
      createNormalizedIdcAssignmentKey({
        assignment: normalizedAssignment,
      }),
      normalizedAssignment,
    );
  }
  return {
    usersByUserName,
    groupsByDisplayName,
    membershipsByKey,
    permissionSetsByName,
    assignmentsByKey,
  };
}

function createNormalizedIdcMembershipKey(props: {
  membership: NormalizedIdcMembership;
}): string {
  return [props.membership.groupDisplayName, props.membership.userName].join("|");
}

function resolveAssignmentPrincipalName(props: {
  principalId: string;
  principalType: StateFile["identityCenter"]["accountAssignments"][number]["principalType"];
  groupDisplayNameById: Map<string, string>;
  userNameById: Map<string, string>;
}): string {
  if (props.principalType === "GROUP") {
    const groupDisplayName = props.groupDisplayNameById.get(props.principalId);
    if (groupDisplayName == null) {
      throw new Error(
        `Could not resolve group display name for IdC assignment principalId "${props.principalId}".`,
      );
    }
    return groupDisplayName;
  }
  const userName = props.userNameById.get(props.principalId);
  if (userName == null) {
    throw new Error(
      `Could not resolve user name for IdC assignment principalId "${props.principalId}".`,
    );
  }
  return userName;
}

function createNormalizedIdcAssignmentKey(props: {
  assignment: NormalizedIdcAssignment;
}): string {
  return [
    props.assignment.accountName,
    props.assignment.permissionSetName,
    props.assignment.principalType,
    props.assignment.principalName,
  ].join("|");
}

function createCustomerManagedPolicyReferenceKey(props: {
  name: string;
  path: string;
}): string {
  return [props.path, props.name].join("|");
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

function resolveOrganizationalUnitName(props: {
  organizationalUnitNameById: Map<string, string>;
  rootId: string;
  organizationalUnitId: string;
}): string {
  if (props.organizationalUnitId === props.rootId) {
    return "root";
  }
  return (
    props.organizationalUnitNameById.get(props.organizationalUnitId) ??
    "unknown"
  );
}

function isResolvableOrganizationalUnitId(props: {
  rootId: string;
  organizationalUnitNameById: Map<string, string>;
  organizationalUnitId: string;
}): boolean {
  if (props.organizationalUnitId === pendingCreationId) {
    return false;
  }
  if (props.organizationalUnitId === props.rootId) {
    return true;
  }
  return props.organizationalUnitNameById.has(props.organizationalUnitId);
}
