import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const nonEmptyStringListSchema = v.union([
  nonEmptyString,
  v.pipe(v.array(nonEmptyString), v.minLength(1)),
]);
const policyScalarSchema = v.union([v.string(), v.number(), v.boolean()]);
const policyScalarListSchema = v.union([
  policyScalarSchema,
  v.pipe(v.array(policyScalarSchema), v.minLength(1)),
]);
const policyPrincipalMapSchema = v.record(
  nonEmptyString,
  nonEmptyStringListSchema,
);
const policyPrincipalSchema = v.union([
  v.literal("*"),
  policyPrincipalMapSchema,
]);
const policyConditionBlockSchema = v.record(
  nonEmptyString,
  v.record(nonEmptyString, policyScalarListSchema),
);

export const iamPolicyStatementSchema = v.strictObject({
  Sid: v.optional(nonEmptyString),
  Effect: v.picklist(["Allow", "Deny"]),
  Action: v.optional(nonEmptyStringListSchema),
  NotAction: v.optional(nonEmptyStringListSchema),
  Resource: v.optional(nonEmptyStringListSchema),
  NotResource: v.optional(nonEmptyStringListSchema),
  Principal: v.optional(policyPrincipalSchema),
  NotPrincipal: v.optional(policyPrincipalSchema),
  Condition: v.optional(policyConditionBlockSchema),
});

export const iamPolicyDocumentSchema = v.strictObject({
  Version: v.optional(v.picklist(["2008-10-17", "2012-10-17"])),
  Id: v.optional(nonEmptyString),
  Statement: v.union([
    iamPolicyStatementSchema,
    v.pipe(v.array(iamPolicyStatementSchema), v.minLength(1)),
  ]),
});

export type IamPolicyVersion = v.InferOutput<
  typeof iamPolicyDocumentSchema
>["Version"];
export type IamPolicyScalar = v.InferOutput<typeof policyScalarSchema>;
export type IamPolicyScalarList = v.InferOutput<typeof policyScalarListSchema>;
export type IamPolicyStringList = v.InferOutput<typeof nonEmptyStringListSchema>;
export type IamPolicyPrincipalMap = v.InferOutput<
  typeof policyPrincipalMapSchema
>;
export type IamPolicyPrincipal = v.InferOutput<typeof policyPrincipalSchema>;
export type IamPolicyConditionBlock = v.InferOutput<
  typeof policyConditionBlockSchema
>;
export type IamPolicyStatement = v.InferOutput<typeof iamPolicyStatementSchema>;
export type IamPolicyDocument = v.InferOutput<typeof iamPolicyDocumentSchema>;

/**
 * AWS inline policy documents follow the IAM JSON policy grammar:
 * Version/Statement at the top level, required Effect per statement, and
 * documented pairs like Action/NotAction and Resource/NotResource.
 */
export function isIamPolicyDocument(value: unknown): value is IamPolicyDocument {
  return v.safeParse(iamPolicyDocumentSchema, value).success;
}

export function isIamPolicyStatement(
  value: unknown,
): value is IamPolicyStatement {
  return v.safeParse(iamPolicyStatementSchema, value).success;
}

export function assertIamPolicyDocument(value: unknown): IamPolicyDocument {
  return v.parse(iamPolicyDocumentSchema, value);
}
