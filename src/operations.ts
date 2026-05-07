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

export const operationSchema = v.variant("kind", [moveAccountOperationSchema]);

const unsupportedDiffKindSchema = v.picklist([
  "newOu",
  "renamedOu",
  "removedOu",
  "idcUserAdded",
  "idcGroupAdded",
  "idcPermissionSetAdded",
  "idcAssignmentChanged",
  "newAccount",
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
export type Operation = v.InferOutput<typeof operationSchema>;
export type UnsupportedDiffKind = v.InferOutput<typeof unsupportedDiffKindSchema>;
export type UnsupportedDiff = v.InferOutput<typeof unsupportedDiffSchema>;
export type Plan = v.InferOutput<typeof planSchema>;
