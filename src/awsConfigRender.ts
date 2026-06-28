import { iamActionCatalog } from "@beesolve/iam-policy-ts";

import type { AwsConfigModel } from "./awsConfig.js";
import { sortJsonValue } from "./helpers.js";

export function sortConfigPolicies(
  policies: AwsConfigModel["policies"]["serviceControlPolicies"],
): AwsConfigModel["policies"]["serviceControlPolicies"] {
  return [...policies]
    .map((p) => ({
      ...p,
      content: sortJsonRecord(p.content),
      targets: [...p.targets].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function sortAwsConfigModel(props: { config: AwsConfigModel }): AwsConfigModel {
  const childrenByParentName = new Map<string | null, AwsConfigModel["organizationalUnits"]>();
  for (const organizationalUnit of props.config.organizationalUnits) {
    const existingChildren = childrenByParentName.get(organizationalUnit.parentName) ?? [];
    existingChildren.push(organizationalUnit);
    childrenByParentName.set(organizationalUnit.parentName, existingChildren);
  }

  const orderedOrganizationalUnits: AwsConfigModel["organizationalUnits"] = [];
  const root = props.config.organizationalUnits.find((ou) => ou.name === "root");
  if (root == null || root.parentName !== null) {
    throw new Error(
      "Config model must include a synthetic root organizational unit with parentName set to null.",
    );
  }
  orderedOrganizationalUnits.push({
    ...root,
    accounts: [...root.accounts].sort((left, right) => left.name.localeCompare(right.name)),
  });

  const queue: Array<string> = [root.name];
  while (queue.length > 0) {
    const currentParentName = queue.shift();
    if (currentParentName == null) {
      continue;
    }
    const children = (childrenByParentName.get(currentParentName) ?? [])
      .filter((ou) => ou.name !== "root")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      orderedOrganizationalUnits.push({
        ...child,
        accounts: [...child.accounts]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((account) => ({
            ...account,
            alternateContacts:
              account.alternateContacts == null
                ? undefined
                : [...account.alternateContacts].sort((a, b) =>
                    a.contactType.localeCompare(b.contactType),
                  ),
          })),
      });
      queue.push(child.name);
    }
  }

  return {
    organizationalUnits: orderedOrganizationalUnits,
    users: [...props.config.users].sort((left, right) =>
      left.userName.localeCompare(right.userName),
    ),
    groups: [...props.config.groups]
      .map((group) => ({
        ...group,
        members: [...group.members].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    permissionSets: [...props.config.permissionSets]
      .map((permissionSet) => ({
        ...permissionSet,
        inlinePolicy:
          permissionSet.inlinePolicy == null
            ? undefined
            : sortJsonRecord(permissionSet.inlinePolicy),
        awsManagedPolicies: [...permissionSet.awsManagedPolicies].sort((left, right) =>
          left.localeCompare(right),
        ),
        customerManagedPolicies: [...permissionSet.customerManagedPolicies].sort((left, right) =>
          compareStringKeys(left.path, right.path, left.name, right.name),
        ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    assignments: [...props.config.assignments]
      .map((assignment) => ({
        ...assignment,
        accounts: [...assignment.accounts].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => {
        const leftPrincipal = left.group ?? left.user ?? "";
        const rightPrincipal = right.group ?? right.user ?? "";
        const principalComparison = leftPrincipal.localeCompare(rightPrincipal);
        if (principalComparison !== 0) {
          return principalComparison;
        }
        return left.permissionSet.localeCompare(right.permissionSet);
      }),
    accessControlAttributes: [...props.config.accessControlAttributes]
      .map((attr) => ({
        ...attr,
        source: [...attr.source].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    delegatedAdministrators: [...props.config.delegatedAdministrators].sort((left, right) => {
      const accountComparison = left.account.localeCompare(right.account);
      if (accountComparison !== 0) {
        return accountComparison;
      }
      return left.servicePrincipal.localeCompare(right.servicePrincipal);
    }),
    policies: {
      serviceControlPolicies: sortConfigPolicies(props.config.policies.serviceControlPolicies),
      resourceControlPolicies: sortConfigPolicies(props.config.policies.resourceControlPolicies),
      tagPolicies: sortConfigPolicies(props.config.policies.tagPolicies),
      aiServicesOptOutPolicies: sortConfigPolicies(props.config.policies.aiServicesOptOutPolicies),
      backupPolicies: sortConfigPolicies(props.config.policies.backupPolicies),
    },
  };
}

export function renderAwsConfigTs(props: { config: AwsConfigModel }): string {
  const serializedConfig = renderTsValue(props.config, {
    indentLevel: 0,
    withinInlinePolicy: false,
  });
  return `import { iam, type AwsConfig } from "./aws.config.types.js";

/**
 * Human-editable AWS config.
 * Generated by "init"; refresh picklists after edits with "regenerate".
 * Use helpers like iam.s3("GetObject") for IAM action autocomplete in inline policies.
 * Generated inline policies use those helpers automatically when the action is
 * present in the installed @beesolve/iam-policy-ts catalog.
 * The synthetic { name: "root", parentName: null } entry represents organization root.
 * "Graveyard" is bootstrap-managed and used internally as the account-removal sink;
 * it is intentionally omitted from generated organizationalUnits in this file.
 */
const awsConfig = ${serializedConfig} satisfies AwsConfig;

export default awsConfig;
`;
}

export function renderTsValue(
  value: unknown,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new Error("Undefined values must be handled before TypeScript rendering.");
  }
  if (typeof value === "string") {
    return renderTsStringValue(value, props);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return renderTsArray(value, props);
  }
  if (isJsonRecord(value)) {
    return renderTsObject(value, props);
  }
  throw new Error(`Unsupported config value type: ${typeof value}.`);
}

function renderTsStringValue(
  value: string,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (
    props.withinInlinePolicy &&
    (props.parentPropertyName === "Action" || props.parentPropertyName === "NotAction")
  ) {
    return renderPolicyActionString(value);
  }
  return JSON.stringify(value);
}

function renderTsArray(
  value: Array<unknown>,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  if (value.length === 0) {
    return "[]";
  }

  const indent = "  ".repeat(props.indentLevel);
  const childIndent = "  ".repeat(props.indentLevel + 1);
  const renderedItems = value.map((item) =>
    item === undefined
      ? "null"
      : renderTsValue(item, {
          indentLevel: props.indentLevel + 1,
          withinInlinePolicy: props.withinInlinePolicy,
          parentPropertyName: props.parentPropertyName,
        }),
  );

  return `[\n${renderedItems.map((item) => `${childIndent}${item}`).join(",\n")}\n${indent}]`;
}

function renderTsObject(
  value: Record<string, unknown>,
  props: {
    indentLevel: number;
    withinInlinePolicy: boolean;
    parentPropertyName?: string;
  },
): string {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) {
    return "{}";
  }

  const indent = "  ".repeat(props.indentLevel);
  const childIndent = "  ".repeat(props.indentLevel + 1);
  const renderedEntries = entries.map(([key, entryValue]) => {
    const nextWithinInlinePolicy =
      props.withinInlinePolicy || key === "inlinePolicy" || key === "content";
    const renderedValue = renderTsValue(entryValue, {
      indentLevel: props.indentLevel + 1,
      withinInlinePolicy: nextWithinInlinePolicy,
      parentPropertyName: key,
    });
    return `${childIndent}${renderTsObjectKey(key)}: ${renderedValue}`;
  });

  return `{\n${renderedEntries.join(",\n")}\n${indent}}`;
}

function renderPolicyActionString(value: string): string {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return JSON.stringify(value);
  }

  const servicePrefix = value.slice(0, separatorIndex);
  const actionName = value.slice(separatorIndex + 1);
  const knownActions = iamActionCatalog[servicePrefix as keyof typeof iamActionCatalog] as
    | ReadonlyArray<string>
    | undefined;
  if (knownActions == null || knownActions.includes(actionName) === false) {
    return JSON.stringify(value);
  }

  const fnName = servicePrefixToCamelCase(servicePrefix);
  if (isIdentifierSafeServicePrefix(fnName)) {
    return `iam.${fnName}(${JSON.stringify(actionName)})`;
  }
  return `iam[${JSON.stringify(fnName)}](${JSON.stringify(actionName)})`;
}

function servicePrefixToCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function isIdentifierSafeServicePrefix(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function renderTsObjectKey(value: string): string {
  return isIdentifierSafeServicePrefix(value) ? value : JSON.stringify(value);
}

export function renderAwsConfigTypesTs(props: { config: AwsConfigModel }): string {
  const organizationalUnitNames = props.config.organizationalUnits.map((ou) => ou.name);
  const accountNames = props.config.organizationalUnits.flatMap((ou) =>
    ou.accounts.map((account) => account.name),
  );
  const permissionSetNames = props.config.permissionSets.map((permissionSet) => permissionSet.name);
  const groupNames = props.config.groups.map((group) => group.displayName);
  const userNames = props.config.users.map((user) => user.userName);

  const organizationalUnitNameSchema = renderPicklistSchema({
    values: organizationalUnitNames,
  });
  const accountNameSchema = renderPicklistSchema({
    values: accountNames,
  });
  const permissionSetNameSchema = renderPicklistSchema({
    values: permissionSetNames,
  });
  const groupNameSchema = renderPicklistSchema({
    values: groupNames,
  });
  const userNameSchema = renderPicklistSchema({
    values: userNames,
  });

  return `import * as v from "valibot";
import { iamPolicyDocumentSchema } from "@beesolve/iam-policy-ts";
import { toPolicies, toSecurityBaseline, type SecurityBaselineOptions } from "@beesolve/aws-accounts/security";
export * as iam from "@beesolve/iam-policy-ts";
export {
  iamActionCatalog,
  iamActionCatalogActionCount,
  iamActionCatalogSourceSha256,
  iamActionCatalogSourceUrl,
  iamPolicyDocumentSchema,
  iamPolicyStatementSchema,
  iamPolicyDocumentStrictSchema,
  iamPolicyStatementStrictSchema,
  isIamPolicyDocument,
  isIamPolicyStatement,
  isIamPolicyDocumentStrict,
  assertIamPolicyDocument,
  assertIamPolicyDocumentStrict,
} from "@beesolve/iam-policy-ts";
export type {
  IamPolicyVersion,
  IamPolicyScalar,
  IamPolicyScalarList,
  IamPolicyStringList,
  IamPolicyPrincipalMap,
  IamPolicyPrincipal,
  IamPolicyConditionBlock,
  IamPolicyStatement,
  IamPolicyDocument,
  IamPolicyStatementStrict,
  IamPolicyDocumentStrict,
} from "@beesolve/iam-policy-ts";

/**
 * Generated file. Do not edit by hand.
 */
const organizationalUnitNameSchema = ${organizationalUnitNameSchema};
const accountNameSchema = ${accountNameSchema};
const permissionSetNameSchema = ${permissionSetNameSchema};
const groupNameSchema = ${groupNameSchema};
const userNameSchema = ${userNameSchema};

export const awsConfigSchema = v.strictObject({
  organizationalUnits: v.array(
    v.strictObject({
      name: v.string(),
      parentName: v.union([organizationalUnitNameSchema, v.null_()]),
      accounts: v.array(
        v.strictObject({
          name: v.string(),
          email: v.string(),
          tags: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
          alternateContacts: v.optional(
            v.array(
              v.strictObject({
                contactType: v.picklist(["BILLING", "OPERATIONS", "SECURITY"]),
                name: v.string(),
                email: v.string(),
                phone: v.string(),
                title: v.optional(v.string()),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
  users: v.array(
    v.strictObject({
      userName: v.string(),
      displayName: v.string(),
      email: v.string(),
    }),
  ),
  groups: v.array(
    v.strictObject({
      displayName: v.string(),
      description: v.optional(v.string()),
      members: v.array(userNameSchema),
    }),
  ),
  permissionSets: v.array(
    v.strictObject({
      name: v.string(),
      description: v.string(),
      sessionDuration: v.optional(v.string()),
      inlinePolicy: v.optional(iamPolicyDocumentSchema),
      awsManagedPolicies: v.array(v.string()),
      customerManagedPolicies: v.array(
        v.strictObject({
          name: v.string(),
          path: v.string(),
        }),
      ),
      permissionsBoundary: v.optional(
        v.union([
          v.strictObject({ managedPolicyArn: v.string() }),
          v.strictObject({
            customerManagedPolicyName: v.string(),
            customerManagedPolicyPath: v.string(),
          }),
        ]),
      ),
    }),
  ),
  assignments: v.array(
    v.strictObject({
      permissionSet: permissionSetNameSchema,
      group: v.optional(groupNameSchema),
      user: v.optional(userNameSchema),
      accounts: v.array(accountNameSchema),
    }),
  ),
  accessControlAttributes: v.array(
    v.strictObject({
      key: v.string(),
      source: v.array(v.string()),
    }),
  ),
  delegatedAdministrators: v.array(
    v.strictObject({
      account: accountNameSchema,
      servicePrincipal: v.string(),
    }),
  ),
  policies: v.strictObject({
    serviceControlPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
      }),
    ),
    resourceControlPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
      }),
    ),
    tagPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
      }),
    ),
    aiServicesOptOutPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
      }),
    ),
    backupPolicies: v.array(
      v.strictObject({
        name: v.string(),
        description: v.optional(v.string()),
        content: v.record(v.string(), v.unknown()),
        targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
      }),
    ),
  }),
  securityBaseline: v.optional(
    v.strictObject({
      stackSets: v.array(
        v.strictObject({
          name: v.string(),
          templateKey: v.string(),
          targets: v.array(v.union([organizationalUnitNameSchema, accountNameSchema])),
          parameters: v.array(
            v.strictObject({
              key: v.string(),
              value: v.string(),
            }),
          ),
        }),
      ),
      configDeliveryBucket: v.optional(
        v.strictObject({
          accountName: accountNameSchema,
        }),
      ),
      cloudTrailBucket: v.optional(
        v.strictObject({
          accountName: accountNameSchema,
        }),
      ),
    }),
  ),
});

export type AwsConfig = v.InferOutput<typeof awsConfigSchema>;

type PolicyTarget = v.InferOutput<typeof organizationalUnitNameSchema> | v.InferOutput<typeof accountNameSchema>;
type AccountName = v.InferOutput<typeof accountNameSchema>;
export const policies = toPolicies<PolicyTarget, AccountName>();
export function withSecurityBaseline(config: AwsConfig, options: SecurityBaselineOptions<PolicyTarget, AccountName>) { return toSecurityBaseline(config, options); }
`;
}

export function renderPicklistSchema(props: { values: Array<string> }): string {
  if (props.values.length === 0) {
    return 'v.picklist(["__EMPTY_PICKLIST__"])';
  }
  const literals = [...props.values]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => JSON.stringify(value))
    .join(", ");
  return `v.picklist([${literals}])`;
}

export function sortJsonRecord<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, sortJsonValue(value)]),
  ) as T;
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && Array.isArray(value) === false;
}

function compareStringKeys(...values: Array<string>): number {
  for (let index = 0; index < values.length; index += 2) {
    const left = values[index] ?? "";
    const right = values[index + 1] ?? "";
    const compared = left.localeCompare(right);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}
