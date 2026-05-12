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
      kind: "createIdcGroup",
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

test("unsupportedDiffSchema accepts Wave 2 IdC removal kinds", () => {
  const unsupportedDiffs = [
    {
      kind: "idcUserRemoved",
      category: "destructive",
      description: 'removed IdC user "alice"',
    },
    {
      kind: "idcGroupRemoved",
      category: "destructive",
      description: 'removed IdC group "Admins"',
    },
    {
      kind: "idcPermissionSetRemoved",
      category: "destructive",
      description: 'removed IdC permission set "AdminAccess"',
    },
  ];

  for (const unsupportedDiff of unsupportedDiffs) {
    assert.deepEqual(
      v.parse(unsupportedDiffSchema, unsupportedDiff),
      unsupportedDiff,
    );
  }
});
