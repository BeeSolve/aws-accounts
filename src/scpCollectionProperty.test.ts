import assert from "node:assert/strict";
import { describe, it } from "node:test";

import fc from "fast-check";

import { toScpCollection } from "./scpCollection.js";

// SCP collection based on Towards the Cloud examples:
// https://towardsthecloud.com/blog/aws-scp-examples

const collection = toScpCollection<string, string>();

const arbTargets = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 5,
});
const arbName = fc.string({ minLength: 1, maxLength: 50 });
const arbRoles = fc.array(
  fc.constantFrom(
    "arn:aws:iam::*:role/Admin",
    "arn:aws:iam::*:role/Deploy",
    "arn:aws:iam::*:role/SecurityAdmin",
  ),
  { minLength: 1, maxLength: 5 },
);
const arbRegions = fc.array(
  fc.constantFrom("us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1"),
  { minLength: 1, maxLength: 5 },
);
const arbTags = fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
  minLength: 1,
  maxLength: 5,
});
const arbInstanceTypes = fc.array(
  fc.constantFrom("t3.micro", "t3.small", "t3.medium", "m5.large"),
  { minLength: 1, maxLength: 5 },
);

type PolicyContent = {
  Version: string;
  Statement: Array<Record<string, unknown>>;
};

// eslint-disable-next-line typescript/no-unsafe-type-assertion
function getContent(result: { content: Record<string, unknown> }): PolicyContent {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return result.content as PolicyContent;
}

function getCondition(stmt: Record<string, unknown>): Record<string, Record<string, unknown>> {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return (stmt.Condition ?? {}) as Record<string, Record<string, unknown>>;
}

function allScpFunctionsWithDefaults(): Array<{
  content: Record<string, unknown>;
  name: string;
  description: string;
  targets: Array<string>;
}> {
  return [
    collection.foundation.denyRootUser(),
    collection.foundation.denyUnsupportedRegions({ allowedRegions: ["us-east-1"] }),
    collection.foundation.enforceS3BucketOwnerEnforced(),
    collection.foundation.preventLeavingOrganization(),
    collection.foundation.denyIamUserCreation(),
    collection.foundation.preventDisablingEbsEncryption(),
    collection.foundation.protectPasswordPolicy({ exemptRoles: ["arn:aws:iam::*:role/Admin"] }),
    collection.foundation.enforceDataPerimeter({ organizationId: "o-abc123def4" }),
    collection.security.protectSecurityServicesComprehensive({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
    }),
    collection.security.protectSecurityHubConfig({ exemptRoles: ["arn:aws:iam::*:role/Admin"] }),
    collection.security.restrictToSecurityOperations(),
    collection.security.enforceMfaForIam(),
    collection.production.enforceEncryption(),
    collection.production.preventUnauthorizedTermination({
      approvedRoles: ["arn:aws:iam::*:role/Admin"],
    }),
    collection.production.protectTaggedStacks({
      organizationTagValue: "beesolve",
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
    }),
    collection.production.enforceImdsV2(),
    collection.development.preventExpensiveInstances(),
    collection.development.blockReservedPurchases(),
    collection.development.preventExpensiveAiMl(),
    collection.development.enforceResourceTagging(),
    collection.sandbox.restrictToBasicServices(),
    collection.sandbox.preventExternalSharing(),
    collection.suspended.completeLockdown({ exemptRoles: ["arn:aws:iam::*:role/Admin"] }),
    collection.infrastructure.restrictToNetworking(),
    collection.infrastructure.protectVpcFlowLogs(),
    collection.modern.controlBedrockModels(),
    collection.modern.restrictQDeveloperIam(),
    collection.modern.requireVpcForSageMaker(),
  ];
}

describe("Property 1: Valid IAM policy document structure", () => {
  /**
   * **Validates: Requirements 30.3**
   */
  it("every SCP function returns content with Version 2012-10-17 and valid Statement array", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const results = allScpFunctionsWithDefaults();
        for (const result of results) {
          const content = getContent(result);
          assert.equal(content.Version, "2012-10-17");
          assert.ok(Array.isArray(content.Statement));
          assert.ok(content.Statement.length > 0);
          for (const statement of content.Statement) {
            assert.ok(typeof statement.Sid === "string" && statement.Sid.length > 0);
            assert.equal(statement.Effect, "Deny");
            assert.ok(statement.Resource != null);
            assert.ok(statement.Action != null || statement.NotAction != null);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 2: PolicyEntry shape consistency", () => {
  /**
   * **Validates: Requirements 1.2, 1.5**
   */
  it("every SCP function returns name, description, content, targets with correct types", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const results = allScpFunctionsWithDefaults();
        for (const result of results) {
          assert.ok(typeof result.name === "string" && result.name.length > 0);
          assert.ok(typeof result.description === "string" && result.description.length > 0);
          assert.ok(typeof result.content === "object" && result.content != null);
          assert.ok(Array.isArray(result.targets) && result.targets.length > 0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 3: Default targets fallback", () => {
  /**
   * **Validates: Requirements 30.1**
   */
  it("functions invoked without targets return ['root']", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const results = [
          collection.foundation.denyRootUser(),
          collection.foundation.denyUnsupportedRegions({ allowedRegions: ["us-east-1"] }),
          collection.foundation.enforceS3BucketOwnerEnforced(),
          collection.foundation.preventLeavingOrganization(),
          collection.foundation.denyIamUserCreation(),
          collection.foundation.preventDisablingEbsEncryption(),
          collection.foundation.protectPasswordPolicy({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
          }),
          collection.foundation.enforceDataPerimeter({ organizationId: "o-abc123def4" }),
          collection.security.protectSecurityServicesComprehensive({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
          }),
          collection.security.protectSecurityHubConfig({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
          }),
          collection.security.restrictToSecurityOperations(),
          collection.security.enforceMfaForIam(),
          collection.production.enforceEncryption(),
          collection.production.preventUnauthorizedTermination({
            approvedRoles: ["arn:aws:iam::*:role/Admin"],
          }),
          collection.production.protectTaggedStacks({
            organizationTagValue: "beesolve",
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
          }),
          collection.production.enforceImdsV2(),
          collection.development.preventExpensiveInstances(),
          collection.development.blockReservedPurchases(),
          collection.development.preventExpensiveAiMl(),
          collection.development.enforceResourceTagging(),
          collection.sandbox.restrictToBasicServices(),
          collection.sandbox.preventExternalSharing(),
          collection.suspended.completeLockdown({ exemptRoles: ["arn:aws:iam::*:role/Admin"] }),
          collection.infrastructure.restrictToNetworking(),
          collection.infrastructure.protectVpcFlowLogs(),
          collection.modern.controlBedrockModels(),
          collection.modern.restrictQDeveloperIam(),
          collection.modern.requireVpcForSageMaker(),
        ];
        for (const result of results) {
          assert.deepEqual(result.targets, ["root"]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 4: Custom name and targets passthrough", () => {
  /**
   * **Validates: Requirements 2.3, 30.1**
   */
  it("custom name and targets are returned exactly as provided", () => {
    fc.assert(
      fc.property(arbName, arbTargets, (name, targets) => {
        const results = [
          collection.foundation.denyRootUser({ name, targets }),
          collection.foundation.denyUnsupportedRegions({
            allowedRegions: ["us-east-1"],
            name,
            targets,
          }),
          collection.foundation.enforceS3BucketOwnerEnforced({ name, targets }),
          collection.foundation.preventLeavingOrganization({ name, targets }),
          collection.foundation.denyIamUserCreation({ name, targets }),
          collection.foundation.preventDisablingEbsEncryption({ name, targets }),
          collection.foundation.protectPasswordPolicy({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.foundation.enforceDataPerimeter({
            organizationId: "o-abc123def4",
            name,
            targets,
          }),
          collection.security.protectSecurityServicesComprehensive({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.security.protectSecurityHubConfig({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.security.restrictToSecurityOperations({ name, targets }),
          collection.security.enforceMfaForIam({ name, targets }),
          collection.production.enforceEncryption({ name, targets }),
          collection.production.preventUnauthorizedTermination({
            approvedRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.production.protectTaggedStacks({
            organizationTagValue: "beesolve",
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.production.enforceImdsV2({ name, targets }),
          collection.development.preventExpensiveInstances({ name, targets }),
          collection.development.blockReservedPurchases({ name, targets }),
          collection.development.preventExpensiveAiMl({ name, targets }),
          collection.development.enforceResourceTagging({ name, targets }),
          collection.sandbox.restrictToBasicServices({ name, targets }),
          collection.sandbox.preventExternalSharing({ name, targets }),
          collection.suspended.completeLockdown({
            exemptRoles: ["arn:aws:iam::*:role/Admin"],
            name,
            targets,
          }),
          collection.infrastructure.restrictToNetworking({ name, targets }),
          collection.infrastructure.protectVpcFlowLogs({ name, targets }),
          collection.modern.controlBedrockModels({ name, targets }),
          collection.modern.restrictQDeveloperIam({ name, targets }),
          collection.modern.requireVpcForSageMaker({ name, targets }),
        ];
        for (const result of results) {
          assert.equal(result.name, name);
          assert.deepEqual(result.targets, targets);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 5: Exempt roles condition generation", () => {
  /**
   * **Validates: Requirements 30.2, 30.4, 30.5, 3.3, 3.5, 6.3, 6.4**
   */
  it("non-empty exemptRoles produces StringNotLike on aws:PrincipalARN", () => {
    fc.assert(
      fc.property(arbRoles, (roles) => {
        const results = [
          collection.foundation.denyUnsupportedRegions({
            allowedRegions: ["us-east-1"],
            exemptRoles: roles,
          }),
          collection.foundation.denyIamUserCreation({ exemptRoles: roles }),
          collection.security.enforceMfaForIam({ exemptRoles: roles }),
          collection.infrastructure.protectVpcFlowLogs({ exemptRoles: roles }),
        ];
        for (const result of results) {
          const content = getContent(result);
          for (const statement of content.Statement) {
            const condition = getCondition(statement);
            assert.ok(condition != null);
            assert.ok(condition.StringNotLike != null);
            assert.ok(condition.StringNotLike["aws:PrincipalARN"] != null);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("empty or omitted exemptRoles produces no StringNotLike condition", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const results = [
          collection.foundation.denyUnsupportedRegions({
            allowedRegions: ["us-east-1"],
            exemptRoles: [],
          }),
          collection.foundation.denyIamUserCreation({ exemptRoles: [] }),
          collection.security.enforceMfaForIam({ exemptRoles: [] }),
          collection.infrastructure.protectVpcFlowLogs({ exemptRoles: [] }),
        ];
        for (const result of results) {
          const content = getContent(result);
          for (const statement of content.Statement) {
            // eslint-disable-next-line typescript/no-unsafe-type-assertion
            const condition = statement.Condition as
              | Record<string, Record<string, unknown>>
              | undefined;
            if (condition != null) {
              assert.ok(
                condition.StringNotLike == null ||
                  condition.StringNotLike["aws:PrincipalARN"] == null,
              );
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 6: Region restriction round-trip", () => {
  /**
   * **Validates: Requirements 3.1, 3.4**
   */
  it("allowedRegions appear in StringNotEquals condition on aws:RequestedRegion", () => {
    fc.assert(
      fc.property(arbRegions, (regions) => {
        const result = collection.foundation.denyUnsupportedRegions({ allowedRegions: regions });
        const content = getContent(result);
        const statement = content.Statement[0];
        const condition = getCondition(statement);
        assert.ok(condition.StringNotEquals != null);
        const requestedRegion = condition.StringNotEquals["aws:RequestedRegion"];
        assert.deepEqual(requestedRegion, regions);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 7: Required parameter validation", () => {
  /**
   * **Validates: Requirements 8.3, 10.4, 15.3, 16.6, 24.2, 27.4**
   */
  it("functions with required non-empty arrays throw on empty", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        assert.throws(
          () => collection.foundation.protectPasswordPolicy({ exemptRoles: [] }),
          /exemptRoles/,
        );
        assert.throws(
          () => collection.security.protectSecurityServicesComprehensive({ exemptRoles: [] }),
          /exemptRoles/,
        );
        assert.throws(
          () => collection.security.protectSecurityHubConfig({ exemptRoles: [] }),
          /exemptRoles/,
        );
        assert.throws(
          () => collection.production.preventUnauthorizedTermination({ approvedRoles: [] }),
          /approvedRoles/,
        );
        assert.throws(
          () => collection.suspended.completeLockdown({ exemptRoles: [] }),
          /exemptRoles/,
        );
        assert.throws(
          () => collection.modern.controlBedrockModels({ deniedModelPatterns: [] }),
          /deniedModelPatterns/,
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 8: Organization ID validation", () => {
  /**
   * **Validates: Requirements 9.3**
   */
  it("enforceDataPerimeter throws on empty or null organizationId", () => {
    fc.assert(
      fc.property(
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        fc.constantFrom("", undefined as unknown as string, null as unknown as string),
        (orgId) => {
          assert.throws(
            () => collection.foundation.enforceDataPerimeter({ organizationId: orgId }),
            /organizationId/,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 9: Development instance type filtering", () => {
  /**
   * **Validates: Requirements 18.1, 18.2**
   */
  it("allowedEc2InstanceTypes appear in ForAnyValue:StringNotLike condition", () => {
    fc.assert(
      fc.property(arbInstanceTypes, (instanceTypes) => {
        const result = collection.development.preventExpensiveInstances({
          allowedEc2InstanceTypes: instanceTypes,
        });
        const content = getContent(result);
        const ec2Statement = content.Statement.find(
          (statement) => statement.Sid === "DenyExpensiveEc2Instances",
        );
        assert.ok(ec2Statement != null);
        const condition = getCondition(ec2Statement);
        assert.ok(condition["ForAnyValue:StringNotLike"] != null);
        assert.deepEqual(condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], instanceTypes);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 10: Tag enforcement null condition", () => {
  /**
   * **Validates: Requirements 21.1**
   */
  it("requiredTags produce Null condition with aws:RequestTag/<key> set to true", () => {
    fc.assert(
      fc.property(arbTags, (tags) => {
        const result = collection.development.enforceResourceTagging({ requiredTags: tags });
        const content = getContent(result);
        for (const statement of content.Statement) {
          const condition = getCondition(statement);
          assert.ok(condition.Null != null);
          for (const tagKey of tags) {
            assert.equal(condition.Null[`aws:RequestTag/${tagKey}`], "true");
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 11: SCP size constraint", () => {
  /**
   * **Validates: Requirements 30.3**
   */
  it("JSON of content is under 5120 chars for realistic options", () => {
    const arbRealisticRoles = fc.array(
      fc.constantFrom(
        "arn:aws:iam::*:role/Admin",
        "arn:aws:iam::*:role/Deploy",
        "arn:aws:iam::*:role/SecurityAdmin",
        "arn:aws:iam::*:role/OrganizationAdmin",
        "arn:aws:iam::*:role/ComplianceRole",
      ),
      { minLength: 1, maxLength: 10 },
    );
    const arbRealisticRegions = fc.array(
      fc.constantFrom("us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1"),
      { minLength: 1, maxLength: 5 },
    );

    fc.assert(
      fc.property(arbRealisticRoles, arbRealisticRegions, (roles, regions) => {
        const results = [
          collection.foundation.denyRootUser(),
          collection.foundation.denyUnsupportedRegions({
            allowedRegions: regions,
            exemptRoles: roles,
          }),
          collection.foundation.enforceS3BucketOwnerEnforced(),
          collection.foundation.preventLeavingOrganization(),
          collection.foundation.denyIamUserCreation({ exemptRoles: roles }),
          collection.foundation.preventDisablingEbsEncryption(),
          collection.foundation.protectPasswordPolicy({ exemptRoles: roles }),
          collection.foundation.enforceDataPerimeter({
            organizationId: "o-abc123def4",
            exemptRoles: roles,
          }),
          collection.security.protectSecurityServicesComprehensive({ exemptRoles: roles }),
          collection.security.protectSecurityHubConfig({ exemptRoles: roles }),
          collection.security.restrictToSecurityOperations(),
          collection.security.enforceMfaForIam({ exemptRoles: roles }),
          collection.production.enforceEncryption(),
          collection.production.preventUnauthorizedTermination({ approvedRoles: roles }),
          collection.production.protectTaggedStacks({
            organizationTagValue: "beesolve",
            exemptRoles: roles,
          }),
          collection.production.enforceImdsV2(),
          collection.development.preventExpensiveInstances(),
          collection.development.blockReservedPurchases(),
          collection.development.preventExpensiveAiMl(),
          collection.development.enforceResourceTagging(),
          collection.sandbox.restrictToBasicServices(),
          collection.sandbox.preventExternalSharing(),
          collection.suspended.completeLockdown({ exemptRoles: roles }),
          collection.infrastructure.restrictToNetworking(),
          collection.infrastructure.protectVpcFlowLogs({ exemptRoles: roles }),
          collection.modern.controlBedrockModels(),
          collection.modern.restrictQDeveloperIam(),
          collection.modern.requireVpcForSageMaker(),
        ];
        for (const result of results) {
          const jsonSize = JSON.stringify(result.content).length;
          assert.ok(jsonSize < 5120, `SCP content JSON is ${jsonSize} chars, exceeds 5120 limit`);
        }
      }),
      { numRuns: 100 },
    );
  });
});
