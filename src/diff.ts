import * as v from "valibot";
import type { StateFile } from "./state.js";
import {
  planSchema,
  type Operation,
  type Plan,
  type UnsupportedDiff,
} from "./operations.js";

const pendingCreationId = "__pending_creation__" as const;

type DiffStatesProps = {
  current: StateFile;
  next: StateFile;
};

export function diffStates(props: DiffStatesProps): Plan {
  const operations: Operation[] = [];
  const unsupported: UnsupportedDiff[] = [];

  const currentOrganizationalUnitByName = new Map(
    props.current.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.name,
      organizationalUnit,
    ]),
  );
  const nextOrganizationalUnitByName = new Map(
    props.next.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.name,
      organizationalUnit,
    ]),
  );
  const currentAccountByName = new Map(
    props.current.organization.accounts.map((account) => [account.name, account]),
  );
  const nextAccountByName = new Map(
    props.next.organization.accounts.map((account) => [account.name, account]),
  );
  const currentOrganizationalUnitNameById = new Map(
    props.current.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.id,
      organizationalUnit.name,
    ]),
  );
  const nextOrganizationalUnitNameById = new Map(
    props.next.organization.organizationalUnits.map((organizationalUnit) => [
      organizationalUnit.id,
      organizationalUnit.name,
    ]),
  );

  for (const nextAccount of props.next.organization.accounts) {
    const currentAccount = currentAccountByName.get(nextAccount.name);
    if (currentAccount == null) {
      if (nextAccount.id === pendingCreationId) {
        const targetOuName = resolveOrganizationalUnitName({
          organizationalUnitNameById: nextOrganizationalUnitNameById,
          rootId: props.next.organization.rootId,
          organizationalUnitId: nextAccount.parentId,
        });
        if (
          isResolvableOrganizationalUnitId({
            rootId: props.next.organization.rootId,
            organizationalUnitNameById: nextOrganizationalUnitNameById,
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
          targetOuName: targetOuName,
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
      organizationalUnitNameById: currentOrganizationalUnitNameById,
      rootId: props.current.organization.rootId,
      organizationalUnitId: currentAccount.parentId,
    });
    const toOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: nextOrganizationalUnitNameById,
      rootId: props.next.organization.rootId,
      organizationalUnitId: nextAccount.parentId,
    });
    operations.push({
      kind: "moveAccount",
      accountId: nextAccount.id,
      accountName: nextAccount.name,
      fromOuId: currentAccount.parentId,
      fromOuName: fromOuName,
      toOuId: nextAccount.parentId,
      toOuName: toOuName,
    });
  }

  for (const currentAccount of props.current.organization.accounts) {
    if (nextAccountByName.has(currentAccount.name)) {
      continue;
    }
    unsupported.push({
      kind: "removedAccount",
      category: "destructive",
      description: `removed account "${currentAccount.name}"`,
    });
  }

  const addedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] = [];
  const removedOrganizationalUnits: StateFile["organization"]["organizationalUnits"] = [];
  for (const nextOrganizationalUnit of props.next.organization.organizationalUnits) {
    if (currentOrganizationalUnitByName.has(nextOrganizationalUnit.name)) {
      continue;
    }
    addedOrganizationalUnits.push(nextOrganizationalUnit);
  }
  for (const currentOrganizationalUnit of props.current.organization.organizationalUnits) {
    if (nextOrganizationalUnitByName.has(currentOrganizationalUnit.name)) {
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
  const consumedAddedOrganizationalUnitNames = new Set<string>();
  const consumedRemovedOrganizationalUnitNames = new Set<string>();

  const parentIds = new Set<string>([
    ...addedByParentId.keys(),
    ...removedByParentId.keys(),
  ]);
  for (const parentId of parentIds) {
    const parentAdded = (addedByParentId.get(parentId) ?? []).filter(
      (organizationalUnit) =>
        consumedAddedOrganizationalUnitNames.has(organizationalUnit.name) === false,
    );
    const parentRemoved = (removedByParentId.get(parentId) ?? []).filter(
      (organizationalUnit) =>
        consumedRemovedOrganizationalUnitNames.has(organizationalUnit.name) === false,
    );

    if (parentAdded.length === 1 && parentRemoved.length === 1) {
      const added = parentAdded[0];
      const removed = parentRemoved[0];
      consumedAddedOrganizationalUnitNames.add(added.name);
      consumedRemovedOrganizationalUnitNames.add(removed.name);
      const parentOuName = resolveOrganizationalUnitName({
        organizationalUnitNameById: nextOrganizationalUnitNameById,
        rootId: props.next.organization.rootId,
        organizationalUnitId: parentId,
      });
      operations.push({
        kind: "renameOu",
        ouId: removed.id,
        fromOuName: removed.name,
        toOuName: added.name,
        parentOuId: parentId,
        parentOuName: parentOuName,
      });
      continue;
    }

    if (parentAdded.length > 0 && parentRemoved.length > 0) {
      const parentOuName = resolveOrganizationalUnitName({
        organizationalUnitNameById: nextOrganizationalUnitNameById,
        rootId: props.next.organization.rootId,
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
    if (consumedAddedOrganizationalUnitNames.has(addedOrganizationalUnit.name)) {
      continue;
    }
    const parentOuName = resolveOrganizationalUnitName({
      organizationalUnitNameById: nextOrganizationalUnitNameById,
      rootId: props.next.organization.rootId,
      organizationalUnitId: addedOrganizationalUnit.parentId,
    });
    if (
      isResolvableOrganizationalUnitId({
        rootId: props.next.organization.rootId,
        organizationalUnitNameById: nextOrganizationalUnitNameById,
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
      parentOuName: parentOuName,
    });
  }
  for (const removedOrganizationalUnit of removedOrganizationalUnits) {
    if (consumedRemovedOrganizationalUnitNames.has(removedOrganizationalUnit.name)) {
      continue;
    }
    unsupported.push({
      kind: "removedOu",
      category: "destructive",
      description: `removed OU "${removedOrganizationalUnit.name}"`,
    });
  }

  const currentUserNameSet = new Set(
    props.current.identityCenter.users.map((user) => user.userName),
  );
  for (const nextUser of props.next.identityCenter.users) {
    if (currentUserNameSet.has(nextUser.userName)) {
      continue;
    }
    unsupported.push({
      kind: "idcUserAdded",
      category: "unsupportedMutation",
      description: `new IdC user "${nextUser.userName}"`,
    });
  }

  const currentGroupNameSet = new Set(
    props.current.identityCenter.groups.map((group) => group.displayName),
  );
  for (const nextGroup of props.next.identityCenter.groups) {
    if (currentGroupNameSet.has(nextGroup.displayName)) {
      continue;
    }
    unsupported.push({
      kind: "idcGroupAdded",
      category: "unsupportedMutation",
      description: `new IdC group "${nextGroup.displayName}"`,
    });
  }

  const currentPermissionSetNameSet = new Set(
    props.current.identityCenter.permissionSets.map(
      (permissionSet) => permissionSet.name,
    ),
  );
  for (const nextPermissionSet of props.next.identityCenter.permissionSets) {
    if (currentPermissionSetNameSet.has(nextPermissionSet.name)) {
      continue;
    }
    unsupported.push({
      kind: "idcPermissionSetAdded",
      category: "unsupportedMutation",
      description: `new IdC permission set "${nextPermissionSet.name}"`,
    });
  }

  if (
    areIdentityCenterAssignmentsEquivalent({
      current: props.current.identityCenter.accountAssignments,
      next: props.next.identityCenter.accountAssignments,
    }) === false
  ) {
    unsupported.push({
      kind: "idcAssignmentChanged",
      category: "unsupportedMutation",
      description: "IdC account assignments changed",
    });
  }

  operations.sort((left, right) =>
    getOperationSortKey(left).localeCompare(getOperationSortKey(right)),
  );
  unsupported.sort((left, right) => {
    const kindComparison = left.kind.localeCompare(right.kind);
    if (kindComparison !== 0) {
      return kindComparison;
    }
    return left.description.localeCompare(right.description);
  });

  return v.parse(planSchema, {
    operations: operations,
    unsupported: unsupported,
  });
}

type GroupOrganizationalUnitsByParentIdProps = {
  organizationalUnits: StateFile["organization"]["organizationalUnits"];
};

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
  return "zzzz";
}

function areIdentityCenterAssignmentsEquivalent(props: {
  current: StateFile["identityCenter"]["accountAssignments"];
  next: StateFile["identityCenter"]["accountAssignments"];
}): boolean {
  if (props.current.length !== props.next.length) {
    return false;
  }
  const currentKeys = props.current
    .map((assignment) =>
      [
        assignment.accountId,
        assignment.permissionSetArn,
        assignment.principalId,
        assignment.principalType,
      ].join("|"),
    )
    .sort((left, right) => left.localeCompare(right));
  const nextKeys = props.next
    .map((assignment) =>
      [
        assignment.accountId,
        assignment.permissionSetArn,
        assignment.principalId,
        assignment.principalType,
      ].join("|"),
    )
    .sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < currentKeys.length; index += 1) {
    if (currentKeys[index] !== nextKeys[index]) {
      return false;
    }
  }
  return true;
}

function resolveOrganizationalUnitName(props: {
  organizationalUnitNameById: Map<string, string>;
  rootId: string;
  organizationalUnitId: string;
}): string {
  if (props.organizationalUnitId === props.rootId) {
    return "root";
  }
  return props.organizationalUnitNameById.get(props.organizationalUnitId) ?? "unknown";
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
