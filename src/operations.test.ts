import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";
import { operationSchema, unsupportedDiffSchema } from "./operations.js";

test("operationSchema accepts supported organization and IdC operations", () => {
  const operations = [
    {
      kind: "deleteOu",
      ouId: "ou-empty",
      ouName: "Empty",
      parentOuId: "r-root",
      parentOuName: "root",
    },
    {
      kind: "createIdcUser",
      userName: "alice",
      displayName: "Alice",
      email: "alice@example.com",
    },
    {
      kind: "updateIdcUser",
      userName: "alice",
      displayName: "Alice A",
      email: "alice@example.com",
    },
    {
      kind: "deleteIdcUser",
      userName: "alice",
    },
    {
      kind: "createIdcGroup",
      groupDisplayName: "Admins",
      description: "",
    },
    {
      kind: "updateIdcGroupDescription",
      groupDisplayName: "Admins",
      description: "Administration",
    },
    {
      kind: "deleteIdcGroup",
      groupDisplayName: "Admins",
    },
    {
      kind: "addIdcGroupMembership",
      groupDisplayName: "Admins",
      userName: "alice",
    },
    {
      kind: "removeIdcGroupMembership",
      groupDisplayName: "Admins",
      userName: "alice",
    },
    {
      kind: "createIdcPermissionSet",
      permissionSetName: "AdminAccess",
      description: "Admin",
    },
    {
      kind: "updateIdcPermissionSetDescription",
      permissionSetName: "AdminAccess",
      description: "Administrator",
    },
    {
      kind: "deleteIdcPermissionSet",
      permissionSetName: "AdminAccess",
    },
    {
      kind: "putIdcPermissionSetInlinePolicy",
      permissionSetName: "AdminAccess",
      inlinePolicy: '{"Version":"2012-10-17"}',
    },
    {
      kind: "deleteIdcPermissionSetInlinePolicy",
      permissionSetName: "AdminAccess",
    },
    {
      kind: "attachIdcManagedPolicyToPermissionSet",
      permissionSetName: "AdminAccess",
      managedPolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    },
    {
      kind: "detachIdcManagedPolicyFromPermissionSet",
      permissionSetName: "AdminAccess",
      managedPolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
    },
    {
      kind: "attachIdcCustomerManagedPolicyReferenceToPermissionSet",
      permissionSetName: "AdminAccess",
      customerManagedPolicyName: "SupportReadOnly",
      customerManagedPolicyPath: "/beesolve/",
    },
    {
      kind: "detachIdcCustomerManagedPolicyReferenceFromPermissionSet",
      permissionSetName: "AdminAccess",
      customerManagedPolicyName: "SupportReadOnly",
      customerManagedPolicyPath: "/beesolve/",
    },
    {
      kind: "provisionIdcPermissionSet",
      permissionSetName: "AdminAccess",
      targetScope: "ALL_PROVISIONED_ACCOUNTS",
    },
    {
      kind: "grantIdcAccountAssignment",
      accountName: "AppAccount",
      permissionSetName: "AdminAccess",
      principalType: "GROUP",
      principalName: "Admins",
    },
    {
      kind: "revokeIdcAccountAssignment",
      accountName: "AppAccount",
      permissionSetName: "AdminAccess",
      principalType: "USER",
      principalName: "alice",
    },
  ];

  for (const operation of operations) {
    assert.deepEqual(v.parse(operationSchema, operation), operation);
  }
});

test("unsupportedDiffSchema accepts remaining unsupported diff kinds", () => {
  const unsupportedDiffs = [
    {
      kind: "ambiguousOuRename",
      category: "unsupportedMutation",
      description: 'ambiguous OU rename under "root" (added: Platform; removed: Engineering)',
    },
    {
      kind: "newOuWithUnknownParent",
      category: "unsupportedMutation",
      description: 'new OU "Platform" has unresolved parent "unknown" (__pending_creation__)',
    },
    {
      kind: "removedAccount",
      category: "destructive",
      description: 'removed account "AppAccount"',
    },
  ];

  for (const unsupportedDiff of unsupportedDiffs) {
    assert.deepEqual(
      v.parse(unsupportedDiffSchema, unsupportedDiff),
      unsupportedDiff,
    );
  }
});
