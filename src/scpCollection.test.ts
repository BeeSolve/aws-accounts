import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toScpCollection } from "./scpCollection.js";

// SCP collection based on Towards the Cloud examples:
// https://towardsthecloud.com/blog/aws-scp-examples

const collection = toScpCollection<string, string>();

function getStatements(result: { content: Record<string, unknown> }) {
  return (result.content as { Statement: Array<Record<string, unknown>> }).Statement;
}

describe("foundation.denyRootUser", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.denyRootUser();
    assert.equal(result.name, "DenyRootUser");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies all actions on all resources for root principal", () => {
    const result = collection.foundation.denyRootUser();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "*");
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.StringLike["aws:PrincipalArn"], "arn:aws:iam::*:root");
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.denyRootUser({
      name: "CustomDenyRoot",
      targets: ["security", "production"],
    });
    assert.equal(result.name, "CustomDenyRoot");
    assert.deepEqual(result.targets, ["security", "production"]);
  });
});

describe("foundation.denyUnsupportedRegions", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1"],
    });
    assert.equal(result.name, "DenyUnsupportedRegions");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("uses NotAction with global services", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1", "eu-west-1"],
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.ok(Array.isArray(stmt.NotAction));
    const notAction = stmt.NotAction as Array<string>;
    assert.ok(notAction.includes("iam:*"));
    assert.ok(notAction.includes("sts:*"));
    assert.ok(notAction.includes("cloudfront:*"));
    assert.ok(notAction.includes("route53:*"));
    assert.ok(notAction.includes("organizations:*"));
    assert.ok(notAction.includes("support:*"));
    assert.ok(notAction.includes("budgets:*"));
    assert.ok(notAction.includes("ce:*"));
    assert.ok(notAction.includes("waf:*"));
    assert.ok(notAction.includes("wafv2:*"));
    assert.ok(notAction.includes("shield:*"));
    assert.ok(notAction.includes("health:*"));
    assert.ok(notAction.includes("globalaccelerator:*"));
  });

  it("includes allowed regions in StringNotEquals condition", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1", "eu-west-1"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotEquals["aws:RequestedRegion"], ["us-east-1", "eu-west-1"]);
  });

  it("includes exempt roles when provided", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1"],
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], ["arn:aws:iam::*:role/Admin"]);
  });

  it("omits StringNotLike when exemptRoles is empty", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1"],
      exemptRoles: [],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.equal(condition.StringNotLike, undefined);
  });

  it("throws on empty allowedRegions", () => {
    assert.throws(
      () => collection.foundation.denyUnsupportedRegions({ allowedRegions: [] }),
      /allowedRegions must contain at least one region/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.denyUnsupportedRegions({
      allowedRegions: ["us-east-1"],
      name: "RegionLock",
      targets: ["dev"],
    });
    assert.equal(result.name, "RegionLock");
    assert.deepEqual(result.targets, ["dev"]);
  });
});

describe("foundation.enforceS3BucketOwnerEnforced", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.enforceS3BucketOwnerEnforced();
    assert.equal(result.name, "EnforceS3BucketOwnerEnforced");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies s3:CreateBucket without BucketOwnerEnforced", () => {
    const result = collection.foundation.enforceS3BucketOwnerEnforced();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "s3:CreateBucket");
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.StringNotEquals["s3:x-amz-object-ownership"], "BucketOwnerEnforced");
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.enforceS3BucketOwnerEnforced({
      name: "S3Ownership",
      targets: ["prod"],
    });
    assert.equal(result.name, "S3Ownership");
    assert.deepEqual(result.targets, ["prod"]);
  });
});

describe("foundation.preventLeavingOrganization", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.preventLeavingOrganization();
    assert.equal(result.name, "PreventLeavingOrganization");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies organizations:LeaveOrganization with no condition", () => {
    const result = collection.foundation.preventLeavingOrganization();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "organizations:LeaveOrganization");
    assert.equal(stmt.Resource, "*");
    assert.equal(stmt.Condition, undefined);
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.preventLeavingOrganization({
      name: "NoLeave",
      targets: ["all-ous"],
    });
    assert.equal(result.name, "NoLeave");
    assert.deepEqual(result.targets, ["all-ous"]);
  });
});

describe("foundation.denyIamUserCreation", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.denyIamUserCreation();
    assert.equal(result.name, "DenyIamUserCreation");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies iam:CreateUser and iam:CreateAccessKey", () => {
    const result = collection.foundation.denyIamUserCreation();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, ["iam:CreateUser", "iam:CreateAccessKey"]);
    assert.equal(stmt.Resource, "*");
  });

  it("includes exempt roles condition when provided", () => {
    const result = collection.foundation.denyIamUserCreation({
      exemptRoles: ["arn:aws:iam::*:role/BreakGlass"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], [
      "arn:aws:iam::*:role/BreakGlass",
    ]);
  });

  it("omits condition when exemptRoles is empty", () => {
    const result = collection.foundation.denyIamUserCreation({ exemptRoles: [] });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Condition, undefined);
  });

  it("omits condition when no options provided", () => {
    const result = collection.foundation.denyIamUserCreation();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Condition, undefined);
  });
});

describe("foundation.preventDisablingEbsEncryption", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.preventDisablingEbsEncryption();
    assert.equal(result.name, "PreventDisablingEbsEncryption");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies ec2:DisableEbsEncryptionByDefault", () => {
    const result = collection.foundation.preventDisablingEbsEncryption();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "ec2:DisableEbsEncryptionByDefault");
    assert.equal(stmt.Resource, "*");
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.preventDisablingEbsEncryption({
      name: "NoDisableEbs",
      targets: ["workloads"],
    });
    assert.equal(result.name, "NoDisableEbs");
    assert.deepEqual(result.targets, ["workloads"]);
  });
});

describe("foundation.protectPasswordPolicy", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.protectPasswordPolicy({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
    });
    assert.equal(result.name, "ProtectPasswordPolicy");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies password policy modification actions with exempt roles", () => {
    const result = collection.foundation.protectPasswordPolicy({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "iam:DeleteAccountPasswordPolicy",
      "iam:UpdateAccountPasswordPolicy",
    ]);
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], ["arn:aws:iam::*:role/Admin"]);
  });

  it("throws on empty exemptRoles", () => {
    assert.throws(
      () => collection.foundation.protectPasswordPolicy({ exemptRoles: [] }),
      /exemptRoles must contain at least one IAM role ARN pattern/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.protectPasswordPolicy({
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
      name: "PwdPolicy",
      targets: ["security"],
    });
    assert.equal(result.name, "PwdPolicy");
    assert.deepEqual(result.targets, ["security"]);
  });
});

describe("foundation.enforceDataPerimeter", () => {
  it("returns correct default name and targets", () => {
    const result = collection.foundation.enforceDataPerimeter({
      organizationId: "o-abc123def4",
    });
    assert.equal(result.name, "EnforceDataPerimeter");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("produces correct condition structure", () => {
    const result = collection.foundation.enforceDataPerimeter({
      organizationId: "o-abc123def4",
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "*");
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.equal(condition.StringNotEqualsIfExists["aws:PrincipalOrgID"], "o-abc123def4");
    assert.equal(condition.BoolIfExists["aws:PrincipalIsAWSService"], "false");
    const arnPatterns = condition.StringNotLike["aws:PrincipalARN"] as Array<string>;
    assert.ok(arnPatterns.includes("arn:aws:iam::*:role/aws-service-role/*"));
  });

  it("includes additional exempt roles when provided", () => {
    const result = collection.foundation.enforceDataPerimeter({
      organizationId: "o-abc123def4",
      exemptRoles: ["arn:aws:iam::*:role/CrossAccountRole"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    const arnPatterns = condition.StringNotLike["aws:PrincipalARN"] as Array<string>;
    assert.ok(arnPatterns.includes("arn:aws:iam::*:role/aws-service-role/*"));
    assert.ok(arnPatterns.includes("arn:aws:iam::*:role/CrossAccountRole"));
  });

  it("throws on empty organizationId", () => {
    assert.throws(
      () => collection.foundation.enforceDataPerimeter({ organizationId: "" }),
      /organizationId is required/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.foundation.enforceDataPerimeter({
      organizationId: "o-abc123def4",
      name: "OrgPerimeter",
      targets: ["all"],
    });
    assert.equal(result.name, "OrgPerimeter");
    assert.deepEqual(result.targets, ["all"]);
  });
});

describe("security.protectSecurityServicesComprehensive", () => {
  it("returns correct default name and targets", () => {
    const result = collection.security.protectSecurityServicesComprehensive({
      exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin"],
    });
    assert.equal(result.name, "ProtectSecurityServicesComprehensive");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies destructive actions for CloudTrail, Config, GuardDuty, Security Hub", () => {
    const result = collection.security.protectSecurityServicesComprehensive({
      exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin"],
    });
    const stmt = getStatements(result)[0];
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("cloudtrail:DeleteTrail"));
    assert.ok(actions.includes("cloudtrail:StopLogging"));
    assert.ok(actions.includes("config:DeleteConfigRule"));
    assert.ok(actions.includes("config:StopConfigurationRecorder"));
    assert.ok(actions.includes("guardduty:DeleteDetector"));
    assert.ok(actions.includes("guardduty:DeleteMembers"));
    assert.ok(actions.includes("securityhub:DisableSecurityHub"));
    assert.ok(actions.includes("securityhub:DeleteMembers"));
  });

  it("includes exempt roles condition", () => {
    const result = collection.security.protectSecurityServicesComprehensive({
      exemptRoles: ["arn:aws:iam::*:role/SecurityAdmin"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], [
      "arn:aws:iam::*:role/SecurityAdmin",
    ]);
  });

  it("throws on empty exemptRoles", () => {
    assert.throws(
      () => collection.security.protectSecurityServicesComprehensive({ exemptRoles: [] }),
      /exemptRoles must contain at least one IAM role ARN pattern/,
    );
  });
});

describe("security.restrictToSecurityOperations", () => {
  it("returns correct default name and targets", () => {
    const result = collection.security.restrictToSecurityOperations();
    assert.equal(result.name, "RestrictToSecurityOperations");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies workload deployment actions", () => {
    const result = collection.security.restrictToSecurityOperations();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "ec2:RunInstances",
      "rds:CreateDBInstance",
      "lambda:CreateFunction",
      "ecs:CreateCluster",
      "eks:CreateCluster",
    ]);
    assert.equal(stmt.Resource, "*");
  });

  it("passes custom name and targets", () => {
    const result = collection.security.restrictToSecurityOperations({
      name: "NoWorkloads",
      targets: ["security-ou"],
    });
    assert.equal(result.name, "NoWorkloads");
    assert.deepEqual(result.targets, ["security-ou"]);
  });
});

describe("security.enforceMfaForIam", () => {
  it("returns correct default name and targets", () => {
    const result = collection.security.enforceMfaForIam();
    assert.equal(result.name, "EnforceMfaForIam");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies sensitive IAM operations without MFA", () => {
    const result = collection.security.enforceMfaForIam();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "iam:CreateUser",
      "iam:DeleteUser",
      "iam:AttachUserPolicy",
      "iam:AttachRolePolicy",
      "iam:CreateAccessKey",
      "iam:CreatePolicyVersion",
    ]);
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.BoolIfExists["aws:MultiFactorAuthPresent"], "false");
  });

  it("includes exempt roles when provided", () => {
    const result = collection.security.enforceMfaForIam({
      exemptRoles: ["arn:aws:iam::*:role/PipelineRole"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], [
      "arn:aws:iam::*:role/PipelineRole",
    ]);
  });

  it("omits StringNotLike when exemptRoles is empty", () => {
    const result = collection.security.enforceMfaForIam({ exemptRoles: [] });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.equal(condition.StringNotLike, undefined);
  });
});

describe("production.enforceEncryption", () => {
  it("returns correct default name and targets", () => {
    const result = collection.production.enforceEncryption();
    assert.equal(result.name, "EnforceEncryption");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("has 3 statements for S3, EBS, and RDS", () => {
    const result = collection.production.enforceEncryption();
    const statements = getStatements(result);
    assert.equal(statements.length, 3);
  });

  it("denies unencrypted S3 uploads", () => {
    const result = collection.production.enforceEncryption();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Action, "s3:PutObject");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Null["s3:x-amz-server-side-encryption"], "true");
  });

  it("denies unencrypted EBS volumes", () => {
    const result = collection.production.enforceEncryption();
    const stmt = getStatements(result)[1];
    assert.equal(stmt.Action, "ec2:RunInstances");
    assert.equal(stmt.Resource, "arn:aws:ec2:*:*:volume/*");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Bool["ec2:Encrypted"], "false");
  });

  it("denies unencrypted RDS instances", () => {
    const result = collection.production.enforceEncryption();
    const stmt = getStatements(result)[2];
    assert.equal(stmt.Action, "rds:CreateDBInstance");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Bool["rds:StorageEncrypted"], "false");
  });

  it("passes custom name and targets", () => {
    const result = collection.production.enforceEncryption({
      name: "EncryptAll",
      targets: ["prod-ou"],
    });
    assert.equal(result.name, "EncryptAll");
    assert.deepEqual(result.targets, ["prod-ou"]);
  });
});

describe("production.preventUnauthorizedTermination", () => {
  it("returns correct default name and targets", () => {
    const result = collection.production.preventUnauthorizedTermination({
      approvedRoles: ["arn:aws:iam::*:role/DeployRole"],
    });
    assert.equal(result.name, "PreventUnauthorizedTermination");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies termination actions with approved roles exemption", () => {
    const result = collection.production.preventUnauthorizedTermination({
      approvedRoles: ["arn:aws:iam::*:role/DeployRole"],
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "ec2:TerminateInstances",
      "rds:DeleteDBInstance",
      "dynamodb:DeleteTable",
    ]);
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], [
      "arn:aws:iam::*:role/DeployRole",
    ]);
  });

  it("throws on empty approvedRoles", () => {
    assert.throws(
      () => collection.production.preventUnauthorizedTermination({ approvedRoles: [] }),
      /approvedRoles must contain at least one role ARN pattern/,
    );
  });
});

describe("production.protectTaggedStacks", () => {
  it("returns correct default name and targets", () => {
    const result = collection.production.protectTaggedStacks({
      organizationTagValue: "beesolve",
      exemptRoles: ["arn:aws:iam::*:role/CDKRole"],
    });
    assert.equal(result.name, "ProtectTaggedStacks");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies CloudFormation delete actions with tag and role conditions", () => {
    const result = collection.production.protectTaggedStacks({
      organizationTagValue: "beesolve",
      exemptRoles: ["arn:aws:iam::*:role/CDKRole"],
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "cloudformation:DeleteStack",
      "cloudformation:DeleteStackInstances",
      "cloudformation:DeleteStackSet",
    ]);
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.equal(condition.StringEquals["aws:ResourceTag/organization"], "beesolve");
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], ["arn:aws:iam::*:role/CDKRole"]);
  });

  it("uses custom tagKey", () => {
    const result = collection.production.protectTaggedStacks({
      organizationTagValue: "myorg",
      exemptRoles: ["arn:aws:iam::*:role/Admin"],
      tagKey: "managed-by",
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.equal(condition.StringEquals["aws:ResourceTag/managed-by"], "myorg");
  });

  it("throws on empty exemptRoles or empty organizationTagValue", () => {
    assert.throws(
      () =>
        collection.production.protectTaggedStacks({
          organizationTagValue: "beesolve",
          exemptRoles: [],
        }),
      /organizationTagValue and exemptRoles are both required/,
    );
    assert.throws(
      () =>
        collection.production.protectTaggedStacks({
          organizationTagValue: "",
          exemptRoles: ["arn:aws:iam::*:role/Admin"],
        }),
      /organizationTagValue and exemptRoles are both required/,
    );
  });
});

describe("production.enforceImdsV2", () => {
  it("returns correct default name and targets", () => {
    const result = collection.production.enforceImdsV2();
    assert.equal(result.name, "EnforceIMDSv2");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies ec2:RunInstances without IMDSv2", () => {
    const result = collection.production.enforceImdsV2();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "ec2:RunInstances");
    assert.equal(stmt.Resource, "arn:aws:ec2:*:*:instance/*");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.StringNotEquals["ec2:MetadataHttpTokens"], "required");
  });

  it("passes custom name and targets", () => {
    const result = collection.production.enforceImdsV2({
      name: "IMDSv2Only",
      targets: ["prod"],
    });
    assert.equal(result.name, "IMDSv2Only");
    assert.deepEqual(result.targets, ["prod"]);
  });
});

describe("development.preventExpensiveInstances", () => {
  it("returns correct default name and targets", () => {
    const result = collection.development.preventExpensiveInstances();
    assert.equal(result.name, "PreventExpensiveInstances");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("has 4 statements by default (EC2, RDS, io2, NAT)", () => {
    const result = collection.development.preventExpensiveInstances();
    const statements = getStatements(result);
    assert.equal(statements.length, 4);
  });

  it("omits io2 statement when denyIo2Volumes is false", () => {
    const result = collection.development.preventExpensiveInstances({
      denyIo2Volumes: false,
    });
    const statements = getStatements(result);
    assert.equal(statements.length, 3);
    const sids = statements.map((statement) => statement.Sid);
    assert.ok(!sids.includes("DenyIo2Volumes"));
  });

  it("omits NAT statement when denyNatGateway is false", () => {
    const result = collection.development.preventExpensiveInstances({
      denyNatGateway: false,
    });
    const statements = getStatements(result);
    assert.equal(statements.length, 3);
    const sids = statements.map((statement) => statement.Sid);
    assert.ok(!sids.includes("DenyNatGateway"));
  });

  it("has 2 statements when both toggles are false", () => {
    const result = collection.development.preventExpensiveInstances({
      denyNatGateway: false,
      denyIo2Volumes: false,
    });
    const statements = getStatements(result);
    assert.equal(statements.length, 2);
  });

  it("uses provided allowedEc2InstanceTypes in condition", () => {
    const result = collection.development.preventExpensiveInstances({
      allowedEc2InstanceTypes: ["t3.micro", "t3.small"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], [
      "t3.micro",
      "t3.small",
    ]);
  });

  it("uses provided allowedRdsInstanceClasses in condition", () => {
    const result = collection.development.preventExpensiveInstances({
      allowedRdsInstanceClasses: ["db.t3.micro"],
    });
    const stmt = getStatements(result)[1];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition["ForAnyValue:StringNotLike"]["rds:DatabaseClass"], ["db.t3.micro"]);
  });

  it("passes custom name and targets", () => {
    const result = collection.development.preventExpensiveInstances({
      name: "CostControl",
      targets: ["dev-ou"],
    });
    assert.equal(result.name, "CostControl");
    assert.deepEqual(result.targets, ["dev-ou"]);
  });
});

describe("development.blockReservedPurchases", () => {
  it("returns correct default name and targets", () => {
    const result = collection.development.blockReservedPurchases();
    assert.equal(result.name, "BlockReservedPurchases");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies all reserved instance and savings plan purchase actions", () => {
    const result = collection.development.blockReservedPurchases();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("ec2:PurchaseReservedInstancesOffering"));
    assert.ok(actions.includes("ec2:PurchaseHostReservation"));
    assert.ok(actions.includes("ec2:PurchaseScheduledInstances"));
    assert.ok(actions.includes("rds:PurchaseReservedDBInstancesOffering"));
    assert.ok(actions.includes("elasticache:PurchaseReservedCacheNodesOffering"));
    assert.ok(actions.includes("redshift:PurchaseReservedNodeOffering"));
    assert.ok(actions.includes("dynamodb:PurchaseReservedCapacityOfferings"));
    assert.ok(actions.includes("savingsplans:CreateSavingsPlan"));
    assert.equal(stmt.Resource, "*");
  });

  it("passes custom name and targets", () => {
    const result = collection.development.blockReservedPurchases({
      name: "NoReserved",
      targets: ["dev"],
    });
    assert.equal(result.name, "NoReserved");
    assert.deepEqual(result.targets, ["dev"]);
  });
});

describe("development.preventExpensiveAiMl", () => {
  it("returns correct default name and targets", () => {
    const result = collection.development.preventExpensiveAiMl();
    assert.equal(result.name, "PreventExpensiveAiMl");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies expensive AI/ML service actions", () => {
    const result = collection.development.preventExpensiveAiMl();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("sagemaker:CreateTrainingJob"));
    assert.ok(actions.includes("sagemaker:CreateHyperParameterTuningJob"));
    assert.ok(actions.includes("sagemaker:CreateNotebookInstance"));
    assert.ok(actions.includes("sagemaker:CreateEndpoint"));
    assert.ok(actions.includes("elasticmapreduce:RunJobFlow"));
    assert.ok(actions.includes("redshift:CreateCluster"));
    assert.ok(actions.includes("redshift-serverless:CreateWorkgroup"));
    assert.equal(stmt.Resource, "*");
  });

  it("passes custom name and targets", () => {
    const result = collection.development.preventExpensiveAiMl({
      name: "NoAiMl",
      targets: ["sandbox"],
    });
    assert.equal(result.name, "NoAiMl");
    assert.deepEqual(result.targets, ["sandbox"]);
  });
});

describe("development.enforceResourceTagging", () => {
  it("returns correct default name and targets", () => {
    const result = collection.development.enforceResourceTagging();
    assert.equal(result.name, "EnforceResourceTagging");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("uses default requiredTags of Environment and Owner", () => {
    const result = collection.development.enforceResourceTagging();
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Null["aws:RequestTag/Environment"], "true");
    assert.equal(condition.Null["aws:RequestTag/Owner"], "true");
  });

  it("has 2 statements (EC2 and RDS)", () => {
    const result = collection.development.enforceResourceTagging();
    const statements = getStatements(result);
    assert.equal(statements.length, 2);
  });

  it("uses custom requiredTags", () => {
    const result = collection.development.enforceResourceTagging({
      requiredTags: ["CostCenter", "Team"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Null["aws:RequestTag/CostCenter"], "true");
    assert.equal(condition.Null["aws:RequestTag/Team"], "true");
    assert.equal(condition.Null["aws:RequestTag/Environment"], undefined);
  });

  it("throws on empty requiredTags", () => {
    assert.throws(
      () => collection.development.enforceResourceTagging({ requiredTags: [] }),
      /requiredTags must contain at least one tag key/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.development.enforceResourceTagging({
      name: "TagRequired",
      targets: ["dev-ou"],
    });
    assert.equal(result.name, "TagRequired");
    assert.deepEqual(result.targets, ["dev-ou"]);
  });
});

describe("sandbox.restrictToBasicServices", () => {
  it("returns correct default name and targets", () => {
    const result = collection.sandbox.restrictToBasicServices();
    assert.equal(result.name, "RestrictToBasicServices");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("has 3 statements (NotAction, instance types, network connectivity)", () => {
    const result = collection.sandbox.restrictToBasicServices();
    const statements = getStatements(result);
    assert.equal(statements.length, 3);
  });

  it("uses NotAction for allowed services", () => {
    const result = collection.sandbox.restrictToBasicServices();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.ok(Array.isArray(stmt.NotAction));
    const notAction = stmt.NotAction as Array<string>;
    assert.ok(notAction.includes("ec2:*"));
    assert.ok(notAction.includes("s3:*"));
    assert.ok(notAction.includes("lambda:*"));
    assert.ok(notAction.includes("dynamodb:*"));
    assert.ok(notAction.includes("iam:*"));
    assert.ok(notAction.includes("sts:*"));
  });

  it("restricts instance types", () => {
    const result = collection.sandbox.restrictToBasicServices();
    const stmt = getStatements(result)[1];
    assert.equal(stmt.Action, "ec2:RunInstances");
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], [
      "t2.micro",
      "t2.small",
      "t3.micro",
      "t3.small",
    ]);
  });

  it("denies network connectivity actions", () => {
    const result = collection.sandbox.restrictToBasicServices();
    const stmt = getStatements(result)[2];
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("ec2:CreateVpcPeeringConnection"));
    assert.ok(actions.includes("ec2:AcceptVpcPeeringConnection"));
    assert.ok(actions.includes("ec2:CreateTransitGatewayVpcAttachment"));
    assert.ok(actions.includes("directconnect:*"));
    assert.ok(actions.includes("globalaccelerator:*"));
  });

  it("accepts custom allowedServices", () => {
    const result = collection.sandbox.restrictToBasicServices({
      allowedServices: ["s3:*", "lambda:*"],
    });
    const stmt = getStatements(result)[0];
    assert.deepEqual(stmt.NotAction, ["s3:*", "lambda:*"]);
  });

  it("accepts custom allowedInstanceTypes", () => {
    const result = collection.sandbox.restrictToBasicServices({
      allowedInstanceTypes: ["t3.nano"],
    });
    const stmt = getStatements(result)[1];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], ["t3.nano"]);
  });

  it("passes custom name and targets", () => {
    const result = collection.sandbox.restrictToBasicServices({
      name: "SandboxRestrict",
      targets: ["sandbox-ou"],
    });
    assert.equal(result.name, "SandboxRestrict");
    assert.deepEqual(result.targets, ["sandbox-ou"]);
  });
});

describe("sandbox.preventExternalSharing", () => {
  it("returns correct default name and targets", () => {
    const result = collection.sandbox.preventExternalSharing();
    assert.equal(result.name, "PreventExternalSharing");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies RAM sharing actions", () => {
    const result = collection.sandbox.preventExternalSharing();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "ram:CreateResourceShare",
      "ram:UpdateResourceShare",
      "ram:AssociateResourceShare",
      "ram:AcceptResourceShareInvitation",
    ]);
    assert.equal(stmt.Resource, "*");
  });

  it("passes custom name and targets", () => {
    const result = collection.sandbox.preventExternalSharing({
      name: "NoSharing",
      targets: ["sandbox"],
    });
    assert.equal(result.name, "NoSharing");
    assert.deepEqual(result.targets, ["sandbox"]);
  });
});

describe("suspended.completeLockdown", () => {
  it("returns correct default name and targets", () => {
    const result = collection.suspended.completeLockdown({
      exemptRoles: ["arn:aws:iam::*:role/OrgAdmin"],
    });
    assert.equal(result.name, "SuspendedAccountLockdown");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies all actions with exempt roles condition", () => {
    const result = collection.suspended.completeLockdown({
      exemptRoles: ["arn:aws:iam::*:role/OrgAdmin"],
    });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "*");
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], ["arn:aws:iam::*:role/OrgAdmin"]);
  });

  it("throws on empty exemptRoles", () => {
    assert.throws(
      () => collection.suspended.completeLockdown({ exemptRoles: [] }),
      /exemptRoles must contain at least one IAM role ARN pattern/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.suspended.completeLockdown({
      exemptRoles: ["arn:aws:iam::*:role/OrgAdmin"],
      name: "Lockdown",
      targets: ["suspended-ou"],
    });
    assert.equal(result.name, "Lockdown");
    assert.deepEqual(result.targets, ["suspended-ou"]);
  });
});

describe("infrastructure.restrictToNetworking", () => {
  it("returns correct default name and targets", () => {
    const result = collection.infrastructure.restrictToNetworking();
    assert.equal(result.name, "RestrictToNetworkingOnly");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("has 2 statements (NotAction for networking, explicit Deny for compute)", () => {
    const result = collection.infrastructure.restrictToNetworking();
    const statements = getStatements(result);
    assert.equal(statements.length, 2);
  });

  it("allows only networking operations via NotAction", () => {
    const result = collection.infrastructure.restrictToNetworking();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.ok(Array.isArray(stmt.NotAction));
    const notAction = stmt.NotAction as Array<string>;
    assert.ok(notAction.includes("directconnect:*"));
    assert.ok(notAction.includes("route53:*"));
    assert.ok(notAction.includes("route53resolver:*"));
    assert.ok(notAction.includes("networkfirewall:*"));
    assert.ok(notAction.includes("vpc-lattice:*"));
    assert.ok(notAction.includes("iam:*"));
    assert.ok(notAction.includes("sts:*"));
  });

  it("explicitly denies compute and storage services", () => {
    const result = collection.infrastructure.restrictToNetworking();
    const stmt = getStatements(result)[1];
    assert.equal(stmt.Effect, "Deny");
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("ec2:RunInstances"));
    assert.ok(actions.includes("rds:*"));
    assert.ok(actions.includes("s3:CreateBucket"));
    assert.ok(actions.includes("lambda:*"));
    assert.ok(actions.includes("ecs:*"));
    assert.ok(actions.includes("eks:*"));
  });

  it("passes custom name and targets", () => {
    const result = collection.infrastructure.restrictToNetworking({
      name: "NetOnly",
      targets: ["network-ou"],
    });
    assert.equal(result.name, "NetOnly");
    assert.deepEqual(result.targets, ["network-ou"]);
  });
});

describe("infrastructure.protectVpcFlowLogs", () => {
  it("returns correct default name and targets", () => {
    const result = collection.infrastructure.protectVpcFlowLogs();
    assert.equal(result.name, "ProtectVpcFlowLogs");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies deleting flow logs and log groups", () => {
    const result = collection.infrastructure.protectVpcFlowLogs();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, ["ec2:DeleteFlowLogs", "logs:DeleteLogGroup"]);
    assert.equal(stmt.Resource, "*");
  });

  it("includes exempt roles when provided", () => {
    const result = collection.infrastructure.protectVpcFlowLogs({
      exemptRoles: ["arn:aws:iam::*:role/NetworkAdmin"],
    });
    const stmt = getStatements(result)[0];
    const condition = stmt.Condition as Record<string, Record<string, unknown>>;
    assert.deepEqual(condition.StringNotLike["aws:PrincipalARN"], [
      "arn:aws:iam::*:role/NetworkAdmin",
    ]);
  });

  it("omits condition when exemptRoles is empty", () => {
    const result = collection.infrastructure.protectVpcFlowLogs({ exemptRoles: [] });
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Condition, undefined);
  });

  it("passes custom name and targets", () => {
    const result = collection.infrastructure.protectVpcFlowLogs({
      name: "FlowLogProtect",
      targets: ["infra"],
    });
    assert.equal(result.name, "FlowLogProtect");
    assert.deepEqual(result.targets, ["infra"]);
  });
});

describe("modern.controlBedrockModels", () => {
  it("returns correct default name and targets", () => {
    const result = collection.modern.controlBedrockModels();
    assert.equal(result.name, "ControlBedrockModels");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies bedrock model invocation on denied patterns", () => {
    const result = collection.modern.controlBedrockModels();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    const resource = stmt.Resource as Array<string>;
    assert.ok(resource.some((pattern) => pattern.includes("anthropic.claude-3-opus")));
    assert.ok(resource.some((pattern) => pattern.includes("meta.llama3-1-405b")));
  });

  it("uses custom deniedModelPatterns", () => {
    const result = collection.modern.controlBedrockModels({
      deniedModelPatterns: ["arn:aws:bedrock:*::foundation-model/custom-model-*"],
    });
    const stmt = getStatements(result)[0];
    assert.deepEqual(stmt.Resource, ["arn:aws:bedrock:*::foundation-model/custom-model-*"]);
  });

  it("throws on empty deniedModelPatterns", () => {
    assert.throws(
      () => collection.modern.controlBedrockModels({ deniedModelPatterns: [] }),
      /deniedModelPatterns must contain at least one model ARN pattern/,
    );
  });

  it("passes custom name and targets", () => {
    const result = collection.modern.controlBedrockModels({
      name: "ModelControl",
      targets: ["ai-ou"],
    });
    assert.equal(result.name, "ModelControl");
    assert.deepEqual(result.targets, ["ai-ou"]);
  });
});

describe("modern.restrictQDeveloperIam", () => {
  it("returns correct default name and targets", () => {
    const result = collection.modern.restrictQDeveloperIam();
    assert.equal(result.name, "RestrictQDeveloperIam");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies IAM operations via chatbot", () => {
    const result = collection.modern.restrictQDeveloperIam();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    const actions = stmt.Action as Array<string>;
    assert.ok(actions.includes("iam:CreateUser"));
    assert.ok(actions.includes("iam:DeleteUser"));
    assert.ok(actions.includes("iam:CreateRole"));
    assert.ok(actions.includes("iam:DeleteRole"));
    assert.ok(actions.includes("iam:AttachUserPolicy"));
    assert.ok(actions.includes("iam:AttachRolePolicy"));
    assert.ok(actions.includes("iam:CreateAccessKey"));
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.StringEquals["aws:CalledViaFirst"], "chatbot.amazonaws.com");
  });

  it("passes custom name and targets", () => {
    const result = collection.modern.restrictQDeveloperIam({
      name: "NoChatIam",
      targets: ["all-ous"],
    });
    assert.equal(result.name, "NoChatIam");
    assert.deepEqual(result.targets, ["all-ous"]);
  });
});

describe("modern.requireVpcForSageMaker", () => {
  it("returns correct default name and targets", () => {
    const result = collection.modern.requireVpcForSageMaker();
    assert.equal(result.name, "RequireVpcForSageMaker");
    assert.deepEqual(result.targets, ["root"]);
  });

  it("denies SageMaker without VPC", () => {
    const result = collection.modern.requireVpcForSageMaker();
    const stmt = getStatements(result)[0];
    assert.equal(stmt.Effect, "Deny");
    assert.deepEqual(stmt.Action, [
      "sagemaker:CreateNotebookInstance",
      "sagemaker:CreateTrainingJob",
    ]);
    assert.equal(stmt.Resource, "*");
    const condition = stmt.Condition as Record<string, Record<string, string>>;
    assert.equal(condition.Null["sagemaker:VpcSubnets"], "true");
  });

  it("passes custom name and targets", () => {
    const result = collection.modern.requireVpcForSageMaker({
      name: "VpcSageMaker",
      targets: ["ml-ou"],
    });
    assert.equal(result.name, "VpcSageMaker");
    assert.deepEqual(result.targets, ["ml-ou"]);
  });
});

describe("all policies have valid document structure", () => {
  it("every policy has Version 2012-10-17 and non-empty Statement array", () => {
    const allPolicies = [
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
        approvedRoles: ["arn:aws:iam::*:role/Deploy"],
      }),
      collection.production.protectTaggedStacks({
        organizationTagValue: "org",
        exemptRoles: ["arn:aws:iam::*:role/CDK"],
      }),
      collection.production.enforceImdsV2(),
      collection.development.preventExpensiveInstances(),
      collection.development.blockReservedPurchases(),
      collection.development.preventExpensiveAiMl(),
      collection.development.enforceResourceTagging(),
      collection.sandbox.restrictToBasicServices(),
      collection.sandbox.preventExternalSharing(),
      collection.suspended.completeLockdown({
        exemptRoles: ["arn:aws:iam::*:role/Admin"],
      }),
      collection.infrastructure.restrictToNetworking(),
      collection.infrastructure.protectVpcFlowLogs(),
      collection.modern.controlBedrockModels(),
      collection.modern.restrictQDeveloperIam(),
      collection.modern.requireVpcForSageMaker(),
    ];

    for (const policy of allPolicies) {
      const content = policy.content as { Version: string; Statement: Array<unknown> };
      assert.equal(content.Version, "2012-10-17", `${policy.name} should have correct Version`);
      assert.ok(
        Array.isArray(content.Statement) && content.Statement.length > 0,
        `${policy.name} should have non-empty Statement array`,
      );
      assert.ok(policy.name.length > 0, `${policy.name} should have non-empty name`);
      assert.ok(policy.description.length > 0, `${policy.name} should have non-empty description`);
      assert.ok(policy.targets.length > 0, `${policy.name} should have non-empty targets`);
    }
  });
});
