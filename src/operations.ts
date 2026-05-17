import * as v from "valibot";

const moveAccountOperationSchema = v.strictObject({
  kind: v.literal("moveAccount"),
  accountId: v.string(),
  accountName: v.string(),
  fromOuId: v.string(),
  fromOuName: v.string(),
  toOuId: v.string(),
  toOuName: v.string(),
});

const createOuOperationSchema = v.strictObject({
  kind: v.literal("createOu"),
  ouName: v.string(),
  parentOuId: v.string(),
  parentOuName: v.string(),
});

const renameOuOperationSchema = v.strictObject({
  kind: v.literal("renameOu"),
  ouId: v.string(),
  fromOuName: v.string(),
  toOuName: v.string(),
  parentOuId: v.string(),
  parentOuName: v.string(),
});

const deleteOuOperationSchema = v.strictObject({
  kind: v.literal("deleteOu"),
  ouId: v.string(),
  ouName: v.string(),
  parentOuId: v.string(),
  parentOuName: v.string(),
});

const createAccountOperationSchema = v.strictObject({
  kind: v.literal("createAccount"),
  accountName: v.string(),
  accountEmail: v.string(),
  targetOuId: v.string(),
  targetOuName: v.string(),
});

const updateAccountTagsOperationSchema = v.strictObject({
  kind: v.literal("updateAccountTags"),
  accountId: v.string(),
  accountName: v.string(),
  tags: v.record(v.string(), v.string()),
});

const updateAccountNameOperationSchema = v.strictObject({
  kind: v.literal("updateAccountName"),
  accountId: v.string(),
  fromAccountName: v.string(),
  toAccountName: v.string(),
});

const removeAccountOperationSchema = v.strictObject({
  kind: v.literal("removeAccount"),
  accountId: v.string(),
  accountName: v.string(),
  fromOuId: v.string(),
  fromOuName: v.string(),
  toOuId: v.string(),
  toOuName: v.string(),
});

const createIdcUserOperationSchema = v.strictObject({
  kind: v.literal("createIdcUser"),
  userName: v.string(),
  displayName: v.string(),
  email: v.string(),
});

const updateIdcUserOperationSchema = v.strictObject({
  kind: v.literal("updateIdcUser"),
  userName: v.string(),
  displayName: v.string(),
  email: v.string(),
});

const deleteIdcUserOperationSchema = v.strictObject({
  kind: v.literal("deleteIdcUser"),
  userName: v.string(),
});

const createIdcGroupOperationSchema = v.strictObject({
  kind: v.literal("createIdcGroup"),
  groupDisplayName: v.string(),
  description: v.string(),
});

const updateIdcGroupDescriptionOperationSchema = v.strictObject({
  kind: v.literal("updateIdcGroupDescription"),
  groupDisplayName: v.string(),
  description: v.string(),
});

const deleteIdcGroupOperationSchema = v.strictObject({
  kind: v.literal("deleteIdcGroup"),
  groupDisplayName: v.string(),
});

const addIdcGroupMembershipOperationSchema = v.strictObject({
  kind: v.literal("addIdcGroupMembership"),
  groupDisplayName: v.string(),
  userName: v.string(),
});

const removeIdcGroupMembershipOperationSchema = v.strictObject({
  kind: v.literal("removeIdcGroupMembership"),
  groupDisplayName: v.string(),
  userName: v.string(),
});

const createIdcPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("createIdcPermissionSet"),
  permissionSetName: v.string(),
  description: v.string(),
  sessionDuration: v.nullable(v.string()),
});

const updateIdcPermissionSetDescriptionOperationSchema = v.strictObject({
  kind: v.literal("updateIdcPermissionSetDescription"),
  permissionSetName: v.string(),
  description: v.string(),
});

const updateIdcPermissionSetSessionDurationOperationSchema = v.strictObject({
  kind: v.literal("updateIdcPermissionSetSessionDuration"),
  permissionSetName: v.string(),
  sessionDuration: v.nullable(v.string()),
});

const deleteIdcPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("deleteIdcPermissionSet"),
  permissionSetName: v.string(),
});

const putIdcPermissionSetInlinePolicyOperationSchema = v.strictObject({
  kind: v.literal("putIdcPermissionSetInlinePolicy"),
  permissionSetName: v.string(),
  inlinePolicy: v.string(),
});

const deleteIdcPermissionSetInlinePolicyOperationSchema = v.strictObject({
  kind: v.literal("deleteIdcPermissionSetInlinePolicy"),
  permissionSetName: v.string(),
});

const attachIdcManagedPolicyToPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("attachIdcManagedPolicyToPermissionSet"),
  permissionSetName: v.string(),
  managedPolicyArn: v.string(),
});

const detachIdcManagedPolicyFromPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("detachIdcManagedPolicyFromPermissionSet"),
  permissionSetName: v.string(),
  managedPolicyArn: v.string(),
});

const attachIdcCustomerManagedPolicyReferenceToPermissionSetOperationSchema =
  v.strictObject({
    kind: v.literal("attachIdcCustomerManagedPolicyReferenceToPermissionSet"),
    permissionSetName: v.string(),
    customerManagedPolicyName: v.string(),
    customerManagedPolicyPath: v.string(),
  });

const detachIdcCustomerManagedPolicyReferenceFromPermissionSetOperationSchema =
  v.strictObject({
    kind: v.literal("detachIdcCustomerManagedPolicyReferenceFromPermissionSet"),
    permissionSetName: v.string(),
    customerManagedPolicyName: v.string(),
    customerManagedPolicyPath: v.string(),
  });

const provisionIdcPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("provisionIdcPermissionSet"),
  permissionSetName: v.string(),
  targetScope: v.literal("ALL_PROVISIONED_ACCOUNTS"),
});

const permissionsBoundaryOperationValueSchema = v.union([
  v.strictObject({ managedPolicyArn: v.string() }),
  v.strictObject({
    customerManagedPolicyName: v.string(),
    customerManagedPolicyPath: v.string(),
  }),
]);

const putIdcPermissionSetPermissionsBoundaryOperationSchema = v.strictObject({
  kind: v.literal("putIdcPermissionSetPermissionsBoundary"),
  permissionSetName: v.string(),
  permissionsBoundary: permissionsBoundaryOperationValueSchema,
});

const deleteIdcPermissionSetPermissionsBoundaryOperationSchema = v.strictObject({
  kind: v.literal("deleteIdcPermissionSetPermissionsBoundary"),
  permissionSetName: v.string(),
});

const grantIdcAccountAssignmentOperationSchema = v.strictObject({
  kind: v.literal("grantIdcAccountAssignment"),
  accountName: v.string(),
  permissionSetName: v.string(),
  principalType: v.picklist(["GROUP", "USER"]),
  principalName: v.string(),
});

const revokeIdcAccountAssignmentOperationSchema = v.strictObject({
  kind: v.literal("revokeIdcAccountAssignment"),
  accountName: v.string(),
  permissionSetName: v.string(),
  principalType: v.picklist(["GROUP", "USER"]),
  principalName: v.string(),
});

const setIdcAccessControlAttributesOperationSchema = v.strictObject({
  kind: v.literal("setIdcAccessControlAttributes"),
  attributes: v.array(
    v.strictObject({
      key: v.string(),
      source: v.array(v.string()),
    }),
  ),
});

const alternateContactTypeSchema = v.picklist([
  "BILLING",
  "OPERATIONS",
  "SECURITY",
]);

const putAlternateContactOperationSchema = v.strictObject({
  kind: v.literal("putAlternateContact"),
  accountId: v.string(),
  accountName: v.string(),
  contactType: alternateContactTypeSchema,
  name: v.string(),
  email: v.string(),
  phone: v.string(),
  title: v.optional(v.string()),
});

const deleteAlternateContactOperationSchema = v.strictObject({
  kind: v.literal("deleteAlternateContact"),
  accountId: v.string(),
  accountName: v.string(),
  contactType: alternateContactTypeSchema,
});

const createOrgPolicyOperationSchema = v.strictObject({
  kind: v.literal("createOrgPolicy"),
  policyName: v.string(),
  policyType: v.picklist([
    "SERVICE_CONTROL_POLICY",
    "RESOURCE_CONTROL_POLICY",
    "TAG_POLICY",
    "AISERVICES_OPT_OUT_POLICY",
  ]),
  description: v.string(),
  content: v.string(),
});

const updateOrgPolicyContentOperationSchema = v.strictObject({
  kind: v.literal("updateOrgPolicyContent"),
  policyId: v.string(),
  policyName: v.string(),
  content: v.string(),
});

const updateOrgPolicyDescriptionOperationSchema = v.strictObject({
  kind: v.literal("updateOrgPolicyDescription"),
  policyId: v.string(),
  policyName: v.string(),
  description: v.string(),
});

const attachOrgPolicyOperationSchema = v.strictObject({
  kind: v.literal("attachOrgPolicy"),
  policyId: v.string(),
  policyName: v.string(),
  targetId: v.string(),
  targetName: v.string(),
});

const detachOrgPolicyOperationSchema = v.strictObject({
  kind: v.literal("detachOrgPolicy"),
  policyId: v.string(),
  policyName: v.string(),
  targetId: v.string(),
  targetName: v.string(),
});

const deleteOrgPolicyOperationSchema = v.strictObject({
  kind: v.literal("deleteOrgPolicy"),
  policyId: v.string(),
  policyName: v.string(),
});

export const operationSchema = v.variant("kind", [
  moveAccountOperationSchema,
  createOuOperationSchema,
  renameOuOperationSchema,
  deleteOuOperationSchema,
  createAccountOperationSchema,
  updateAccountTagsOperationSchema,
  updateAccountNameOperationSchema,
  removeAccountOperationSchema,
  createIdcUserOperationSchema,
  updateIdcUserOperationSchema,
  deleteIdcUserOperationSchema,
  createIdcGroupOperationSchema,
  updateIdcGroupDescriptionOperationSchema,
  deleteIdcGroupOperationSchema,
  addIdcGroupMembershipOperationSchema,
  removeIdcGroupMembershipOperationSchema,
  createIdcPermissionSetOperationSchema,
  updateIdcPermissionSetDescriptionOperationSchema,
  updateIdcPermissionSetSessionDurationOperationSchema,
  deleteIdcPermissionSetOperationSchema,
  putIdcPermissionSetInlinePolicyOperationSchema,
  deleteIdcPermissionSetInlinePolicyOperationSchema,
  attachIdcManagedPolicyToPermissionSetOperationSchema,
  detachIdcManagedPolicyFromPermissionSetOperationSchema,
  attachIdcCustomerManagedPolicyReferenceToPermissionSetOperationSchema,
  detachIdcCustomerManagedPolicyReferenceFromPermissionSetOperationSchema,
  provisionIdcPermissionSetOperationSchema,
  putIdcPermissionSetPermissionsBoundaryOperationSchema,
  deleteIdcPermissionSetPermissionsBoundaryOperationSchema,
  grantIdcAccountAssignmentOperationSchema,
  revokeIdcAccountAssignmentOperationSchema,
  createOrgPolicyOperationSchema,
  updateOrgPolicyContentOperationSchema,
  updateOrgPolicyDescriptionOperationSchema,
  attachOrgPolicyOperationSchema,
  detachOrgPolicyOperationSchema,
  deleteOrgPolicyOperationSchema,
  putAlternateContactOperationSchema,
  deleteAlternateContactOperationSchema,
  setIdcAccessControlAttributesOperationSchema,
]);

const unsupportedDiffKindSchema = v.picklist([
  "ambiguousOuRename",
  "reparentedOu",
  "newOuWithUnknownParent",
  "newAccountWithUnknownOu",
  "removedOu",
]);

const unsupportedDiffCategorySchema = v.picklist([
  "destructive",
  "unsupportedMutation",
]);

export const unsupportedDiffSchema = v.strictObject({
  kind: unsupportedDiffKindSchema,
  category: unsupportedDiffCategorySchema,
  description: v.string(),
});

export const planSchema = v.strictObject({
  operations: v.array(operationSchema),
  unsupported: v.array(unsupportedDiffSchema),
});

export type Operation = v.InferOutput<typeof operationSchema>;
export type UnsupportedDiff = v.InferOutput<typeof unsupportedDiffSchema>;
export type Plan = v.InferOutput<typeof planSchema>;
