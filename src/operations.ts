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

const createIdcGroupOperationSchema = v.strictObject({
  kind: v.literal("createIdcGroup"),
  groupDisplayName: v.string(),
});

const createIdcPermissionSetOperationSchema = v.strictObject({
  kind: v.literal("createIdcPermissionSet"),
  permissionSetName: v.string(),
  description: v.string(),
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
  createIdcGroupOperationSchema,
  createIdcPermissionSetOperationSchema,
  grantIdcAccountAssignmentOperationSchema,
  revokeIdcAccountAssignmentOperationSchema,
]);

const unsupportedDiffKindSchema = v.picklist([
  "ambiguousOuRename",
  "reparentedOu",
  "newOuWithUnknownParent",
  "newAccountWithUnknownOu",
  "removedOu",
  "idcUserRemoved",
  "idcGroupRemoved",
  "idcPermissionSetRemoved",
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

export type MoveAccountOperation = v.InferOutput<typeof moveAccountOperationSchema>;
export type CreateOuOperation = v.InferOutput<typeof createOuOperationSchema>;
export type RenameOuOperation = v.InferOutput<typeof renameOuOperationSchema>;
export type DeleteOuOperation = v.InferOutput<typeof deleteOuOperationSchema>;
export type CreateAccountOperation = v.InferOutput<
  typeof createAccountOperationSchema
>;
export type CreateIdcUserOperation = v.InferOutput<
  typeof createIdcUserOperationSchema
>;
export type CreateIdcGroupOperation = v.InferOutput<
  typeof createIdcGroupOperationSchema
>;
export type CreateIdcPermissionSetOperation = v.InferOutput<
  typeof createIdcPermissionSetOperationSchema
>;
export type GrantIdcAccountAssignmentOperation = v.InferOutput<
  typeof grantIdcAccountAssignmentOperationSchema
>;
export type RevokeIdcAccountAssignmentOperation = v.InferOutput<
  typeof revokeIdcAccountAssignmentOperationSchema
>;
export type Operation = v.InferOutput<typeof operationSchema>;
export type UnsupportedDiffKind = v.InferOutput<typeof unsupportedDiffKindSchema>;
export type UnsupportedDiff = v.InferOutput<typeof unsupportedDiffSchema>;
export type Plan = v.InferOutput<typeof planSchema>;
