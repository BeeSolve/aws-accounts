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

const createAccountOperationSchema = v.strictObject({
  kind: v.literal("createAccount"),
  accountName: v.string(),
  accountEmail: v.string(),
  targetOuId: v.string(),
  targetOuName: v.string(),
});

export const operationSchema = v.variant("kind", [
  moveAccountOperationSchema,
  createOuOperationSchema,
  renameOuOperationSchema,
  createAccountOperationSchema,
]);

const unsupportedDiffKindSchema = v.picklist([
  "ambiguousOuRename",
  "newOuWithUnknownParent",
  "newAccountWithUnknownOu",
  "removedOu",
  "idcUserAdded",
  "idcGroupAdded",
  "idcPermissionSetAdded",
  "idcAssignmentChanged",
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
export type CreateAccountOperation = v.InferOutput<
  typeof createAccountOperationSchema
>;
export type Operation = v.InferOutput<typeof operationSchema>;
export type UnsupportedDiffKind = v.InferOutput<typeof unsupportedDiffKindSchema>;
export type UnsupportedDiff = v.InferOutput<typeof unsupportedDiffSchema>;
export type Plan = v.InferOutput<typeof planSchema>;
