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

const createIdcUserOperationSchema = v.strictObject({
  kind: v.literal("createIdcUser"),
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

export const operationSchema = v.variant("kind", [
  moveAccountOperationSchema,
  createOuOperationSchema,
  renameOuOperationSchema,
  deleteOuOperationSchema,
  createAccountOperationSchema,
  createIdcUserOperationSchema,
  deleteIdcUserOperationSchema,
  createIdcGroupOperationSchema,
  deleteIdcGroupOperationSchema,
  addIdcGroupMembershipOperationSchema,
  removeIdcGroupMembershipOperationSchema,
  createIdcPermissionSetOperationSchema,
  deleteIdcPermissionSetOperationSchema,
  putIdcPermissionSetInlinePolicyOperationSchema,
  deleteIdcPermissionSetInlinePolicyOperationSchema,
  attachIdcManagedPolicyToPermissionSetOperationSchema,
  detachIdcManagedPolicyFromPermissionSetOperationSchema,
  attachIdcCustomerManagedPolicyReferenceToPermissionSetOperationSchema,
  detachIdcCustomerManagedPolicyReferenceFromPermissionSetOperationSchema,
  provisionIdcPermissionSetOperationSchema,
  grantIdcAccountAssignmentOperationSchema,
  revokeIdcAccountAssignmentOperationSchema,
]);

const unsupportedDiffKindSchema = v.picklist([
  "ambiguousOuRename",
  "reparentedOu",
  "newOuWithUnknownParent",
  "newAccountWithUnknownOu",
  "removedOu",
  "removedAccount",
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

export type MoveAccountOperation = v.InferOutput<
  typeof moveAccountOperationSchema
>;
export type CreateOuOperation = v.InferOutput<typeof createOuOperationSchema>;
export type RenameOuOperation = v.InferOutput<typeof renameOuOperationSchema>;
export type DeleteOuOperation = v.InferOutput<typeof deleteOuOperationSchema>;
export type CreateAccountOperation = v.InferOutput<
  typeof createAccountOperationSchema
>;
export type CreateIdcUserOperation = v.InferOutput<
  typeof createIdcUserOperationSchema
>;
export type DeleteIdcUserOperation = v.InferOutput<
  typeof deleteIdcUserOperationSchema
>;
export type CreateIdcGroupOperation = v.InferOutput<
  typeof createIdcGroupOperationSchema
>;
export type DeleteIdcGroupOperation = v.InferOutput<
  typeof deleteIdcGroupOperationSchema
>;
export type AddIdcGroupMembershipOperation = v.InferOutput<
  typeof addIdcGroupMembershipOperationSchema
>;
export type RemoveIdcGroupMembershipOperation = v.InferOutput<
  typeof removeIdcGroupMembershipOperationSchema
>;
export type CreateIdcPermissionSetOperation = v.InferOutput<
  typeof createIdcPermissionSetOperationSchema
>;
export type DeleteIdcPermissionSetOperation = v.InferOutput<
  typeof deleteIdcPermissionSetOperationSchema
>;
export type PutIdcPermissionSetInlinePolicyOperation = v.InferOutput<
  typeof putIdcPermissionSetInlinePolicyOperationSchema
>;
export type DeleteIdcPermissionSetInlinePolicyOperation = v.InferOutput<
  typeof deleteIdcPermissionSetInlinePolicyOperationSchema
>;
export type AttachIdcManagedPolicyToPermissionSetOperation = v.InferOutput<
  typeof attachIdcManagedPolicyToPermissionSetOperationSchema
>;
export type DetachIdcManagedPolicyFromPermissionSetOperation = v.InferOutput<
  typeof detachIdcManagedPolicyFromPermissionSetOperationSchema
>;
export type AttachIdcCustomerManagedPolicyReferenceToPermissionSetOperation =
  v.InferOutput<
    typeof attachIdcCustomerManagedPolicyReferenceToPermissionSetOperationSchema
  >;
export type DetachIdcCustomerManagedPolicyReferenceFromPermissionSetOperation =
  v.InferOutput<
    typeof detachIdcCustomerManagedPolicyReferenceFromPermissionSetOperationSchema
  >;
export type ProvisionIdcPermissionSetOperation = v.InferOutput<
  typeof provisionIdcPermissionSetOperationSchema
>;
export type GrantIdcAccountAssignmentOperation = v.InferOutput<
  typeof grantIdcAccountAssignmentOperationSchema
>;
export type RevokeIdcAccountAssignmentOperation = v.InferOutput<
  typeof revokeIdcAccountAssignmentOperationSchema
>;
export type Operation = v.InferOutput<typeof operationSchema>;
export type UnsupportedDiffKind = v.InferOutput<
  typeof unsupportedDiffKindSchema
>;
export type UnsupportedDiff = v.InferOutput<typeof unsupportedDiffSchema>;
export type Plan = v.InferOutput<typeof planSchema>;
