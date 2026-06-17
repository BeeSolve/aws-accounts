import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPolicies, toSecurityBaseline } from "./security.js";

const { scp, backupPolicy, permissionSet } = toPolicies<string, string>();

describe("scp.blockExpensiveResources", () => {
  const opts = { allowedEc2InstanceTypes: ["t3.micro", "t3.small", "m8g.medium"] };

  it("returns correct shape with defaults", () => {
    const result = scp.blockExpensiveResources(opts);
    assert.equal(result.name, "BlockExpensiveResources");
    assert.deepEqual(result.targets, ["root"]);
    assert.equal((result.content as any).Version, "2012-10-17");
    assert.equal((result.content as any).Statement.length, 4);
  });

  it("omits Condition when exemptAccounts is empty", () => {
    const result = scp.blockExpensiveResources(opts);
    const stmt = (result.content as any).Statement[0];
    assert.equal(stmt.Condition, undefined);
  });

  it("includes aws:PrincipalAccount condition when exemptAccounts provided", () => {
    const result = scp.blockExpensiveResources({ ...opts, exemptAccounts: ["111", "222"] });
    const stmt = (result.content as any).Statement[0];
    assert.deepEqual(stmt.Condition, {
      StringNotEquals: { "aws:PrincipalAccount": ["111", "222"] },
    });
  });

  it("EC2 statement has ForAnyValue:StringNotLike with allowed types", () => {
    const result = scp.blockExpensiveResources(opts);
    const stmt = (result.content as any).Statement[1];
    assert.deepEqual(stmt.Condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], [
      "t3.micro",
      "t3.small",
      "m8g.medium",
    ]);
  });

  it("respects custom name and targets", () => {
    const result = scp.blockExpensiveResources({ ...opts, name: "Custom", targets: ["projects"] });
    assert.equal(result.name, "Custom");
    assert.deepEqual(result.targets, ["projects"]);
  });

  it("fits within 10240 character SCP limit", () => {
    const result = scp.blockExpensiveResources({ ...opts, exemptAccounts: ["111", "222", "333"] });
    assert.ok(JSON.stringify(result.content).length < 10240);
  });
});

describe("scp.protectSecurityServices", () => {
  it("returns correct shape with defaults", () => {
    const result = scp.protectSecurityServices();
    assert.equal(result.name, "ProtectSecurityServices");
    assert.deepEqual(result.targets, ["root"]);
    assert.equal((result.content as any).Statement.length, 3);
  });

  it("includes exemptAccounts condition", () => {
    const result = scp.protectSecurityServices({ exemptAccounts: ["123"] });
    const stmt = (result.content as any).Statement[0];
    assert.deepEqual(stmt.Condition, { StringNotEquals: { "aws:PrincipalAccount": ["123"] } });
  });

  it("protect excludes guardduty when guardDuty is false", () => {
    const result = scp.protectSecurityServices({
      protect: { cloudTrail: true, config: true, guardDuty: false },
    });
    const stmts = (result.content as any).Statement;
    assert.equal(stmts.length, 2);
    assert.equal(stmts[0].Sid, "ProtectCloudTrail");
    assert.equal(stmts[1].Sid, "ProtectConfig");
  });

  it("protect includes only guardduty when others are false", () => {
    const result = scp.protectSecurityServices({
      protect: { guardDuty: true, cloudTrail: false, config: false },
    });
    const stmts = (result.content as any).Statement;
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].Sid, "ProtectGuardDuty");
  });
});

describe("backupPolicy.dailyWithRetention", () => {
  it("returns correct shape with defaults", () => {
    const result = backupPolicy.dailyWithRetention({ regions: ["eu-central-1"] });
    assert.equal(result.name, "DailyBackupPolicy");
    assert.deepEqual(result.targets, ["root"]);
    const plan = (result.content as any).plans.DailyBackup;
    assert.deepEqual(plan.regions, { "@@assign": ["eu-central-1"] });
    assert.equal(plan.rules.Daily.lifecycle.delete_after_days["@@assign"], "35");
  });

  it("respects custom retention and vault", () => {
    const result = backupPolicy.dailyWithRetention({
      regions: ["us-east-1"],
      retentionDays: 90,
      backupVaultName: "Fort",
    });
    const plan = (result.content as any).plans.DailyBackup;
    assert.equal(plan.rules.Daily.lifecycle.delete_after_days["@@assign"], "90");
    assert.equal(plan.rules.Daily.target_backup_vault_name["@@assign"], "Fort");
  });
});

describe("permissionSet patterns", () => {
  it("readOnlyAuditor returns ViewOnlyAccess managed policy", () => {
    const result = permissionSet.readOnlyAuditor();
    assert.equal(result.name, "ReadOnlyAuditor");
    assert.deepEqual(result.awsManagedPolicies, [
      "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess",
    ]);
  });

  it("cloudTrailAnalyst has inline policy with Athena", () => {
    const result = permissionSet.cloudTrailAnalyst();
    assert.equal(result.name, "CloudTrailAnalyst");
    assert.ok(result.inlinePolicy);
    const actions = (result.inlinePolicy as any).Statement.flatMap((s: any) => s.Action);
    assert.ok(actions.includes("athena:StartQueryExecution"));
  });

  it("configCompliance has Config read actions", () => {
    const result = permissionSet.configCompliance();
    assert.equal(result.name, "ConfigCompliance");
    const actions = (result.inlinePolicy as any).Statement[0].Action;
    assert.ok(actions.includes("config:Describe*"));
  });

  it("securityInvestigator combines multiple services", () => {
    const result = permissionSet.securityInvestigator();
    assert.equal(result.name, "SecurityInvestigator");
    assert.equal((result.inlinePolicy as any).Statement.length, 5);
  });

  it("respects custom name and sessionDuration", () => {
    const result = permissionSet.readOnlyAuditor({ name: "MyAuditor", sessionDuration: "PT12H" });
    assert.equal(result.name, "MyAuditor");
    assert.equal(result.sessionDuration, "PT12H");
  });
});

describe("toSecurityBaseline", () => {
  const baseConfig = {
    organizationalUnits: [
      { name: "root", parentName: null, accounts: [] },
      {
        name: "Security",
        parentName: "root",
        accounts: [
          { name: "SecurityAudit", email: "sec@test.com", tags: [] },
          { name: "LogArchive", email: "log@test.com", tags: [] },
        ],
      },
    ],
    delegatedAdministrators: [] as Array<{ account: string; servicePrincipal: string }>,
  };

  it("adds cloudtrail delegated admin", () => {
    const result = toSecurityBaseline(baseConfig, {
      cloudTrail: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        logArchiveAccount: "LogArchive",
      },
    });
    assert.ok(
      result.delegatedAdministrators.some((d) => d.servicePrincipal === "cloudtrail.amazonaws.com"),
    );
  });

  it("adds config recorder stackset", () => {
    const result = toSecurityBaseline(baseConfig, {
      configRecorder: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        deliveryBucketAccount: "LogArchive",
        targets: ["root"],
      },
    });
    assert.equal(result.securityBaseline?.stackSets.length, 2);
    assert.equal(result.securityBaseline?.stackSets[0].templateKey, "security-setup");
    assert.equal(result.securityBaseline?.stackSets[1].templateKey, "config-recorder");
  });

  it("adds guardduty stackset with defaults", () => {
    const result = toSecurityBaseline(baseConfig, {
      guardDuty: { enabled: true, delegatedAdminAccount: "SecurityAudit" },
    });
    assert.equal(result.securityBaseline?.stackSets[0].parameters[0].value, "FIFTEEN_MINUTES");
  });

  it("throws if referenced account does not exist", () => {
    assert.throws(
      () =>
        toSecurityBaseline(baseConfig, {
          cloudTrail: {
            enabled: true,
            delegatedAdminAccount: "NonExistent",
            logArchiveAccount: "LogArchive",
          },
        }),
      /account "NonExistent" not found/,
    );
  });

  it("does not duplicate existing delegated admins", () => {
    const configWithExisting = {
      ...baseConfig,
      delegatedAdministrators: [
        { account: "SecurityAudit", servicePrincipal: "cloudtrail.amazonaws.com" },
      ],
    };
    const result = toSecurityBaseline(configWithExisting, {
      cloudTrail: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        logArchiveAccount: "LogArchive",
      },
    });
    const ctAdmins = result.delegatedAdministrators.filter(
      (d) => d.servicePrincipal === "cloudtrail.amazonaws.com",
    );
    assert.equal(ctAdmins.length, 1);
  });

  it("returns config unchanged when no features enabled", () => {
    const result = toSecurityBaseline(baseConfig, {});
    assert.deepEqual(result.delegatedAdministrators, []);
    assert.equal(result.securityBaseline, undefined);
  });

  it("guardDuty enabled:false does not add delegated admin or stackSet", () => {
    const result = toSecurityBaseline(baseConfig, {
      guardDuty: { enabled: false },
    });
    assert.ok(
      !result.delegatedAdministrators.some((d) => d.servicePrincipal === "guardduty.amazonaws.com"),
    );
    assert.equal(result.securityBaseline, undefined);
  });
});

describe("securityBaseline stackSet declarations", () => {
  const baseConfig = {
    organizationalUnits: [
      { name: "root", parentName: null, accounts: [] },
      {
        name: "Security",
        parentName: "root",
        accounts: [
          { name: "SecurityAudit", email: "sec@test.com", tags: [] },
          { name: "LogArchive", email: "log@test.com", tags: [] },
        ],
      },
    ],
    delegatedAdministrators: [],
  };

  it("configRecorder produces stackSet with correct templateKey and parameters", () => {
    const result = toSecurityBaseline(baseConfig, {
      configRecorder: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        deliveryBucketAccount: "LogArchive",
        targets: ["root"],
        deliveryFrequency: "Six_Hours",
        recordAllResourceTypes: false,
      },
    });
    const ss = result.securityBaseline!.stackSets[1];
    assert.equal(ss.templateKey, "config-recorder");
    assert.deepEqual(ss.targets, ["root"]);
    assert.ok(ss.parameters.some((p) => p.key === "DeliveryFrequency" && p.value === "Six_Hours"));
    assert.ok(ss.parameters.some((p) => p.key === "AllSupported" && p.value === "false"));
  });

  it("guardDuty produces stackSet with custom frequency", () => {
    const result = toSecurityBaseline(baseConfig, {
      guardDuty: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        findingPublishingFrequency: "ONE_HOUR",
        targets: ["Security"],
      },
    });
    const ss = result.securityBaseline!.stackSets[0];
    assert.equal(ss.templateKey, "guardduty-member");
    assert.deepEqual(ss.targets, ["Security"]);
    assert.ok(
      ss.parameters.some((p) => p.key === "FindingPublishingFrequency" && p.value === "ONE_HOUR"),
    );
  });

  it("multiple features produce multiple stackSets", () => {
    const result = toSecurityBaseline(baseConfig, {
      configRecorder: {
        enabled: true,
        delegatedAdminAccount: "SecurityAudit",
        deliveryBucketAccount: "LogArchive",
        targets: ["root"],
      },
      guardDuty: { enabled: true, delegatedAdminAccount: "SecurityAudit" },
    });
    assert.equal(result.securityBaseline!.stackSets.length, 3);
    assert.equal(result.securityBaseline!.stackSets[0].templateKey, "security-setup");
    assert.equal(result.securityBaseline!.stackSets[1].templateKey, "config-recorder");
    assert.equal(result.securityBaseline!.stackSets[2].templateKey, "guardduty-member");
  });

  it("disabled features produce no stackSets", () => {
    const result = toSecurityBaseline(baseConfig, {
      configRecorder: {
        enabled: false,
      },
    });
    assert.equal(result.securityBaseline, undefined);
  });
});

describe("template resolution", () => {
  it("default templates exist in package", async () => {
    const { readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const configRecorder = await readFile(
      join(packageDir, "templates", "config-recorder.yaml"),
      "utf8",
    );
    const guardduty = await readFile(
      join(packageDir, "templates", "guardduty-member.yaml"),
      "utf8",
    );
    assert.ok(configRecorder.includes("AWS::Config::ConfigurationRecorder"));
    assert.ok(guardduty.includes("AWS::GuardDuty::Detector"));
  });
});

describe("scp.denyRootWithoutMfa", () => {
  it("returns correct SCP with MFA condition", () => {
    const { scp } = toPolicies<string, string>();
    const result = scp.denyRootWithoutMfa();
    assert.equal(result.name, "DenyRootWithoutMFA");
    assert.deepEqual(result.targets, ["root"]);
    const stmt = (result.content as any).Statement[0];
    assert.equal(stmt.Effect, "Deny");
    assert.equal(stmt.Action, "*");
    assert.deepEqual(stmt.Condition.BoolIfExists, { "aws:MultiFactorAuthPresent": "false" });
    assert.deepEqual(stmt.Condition.StringLike, { "aws:PrincipalArn": "arn:aws:iam::*:root" });
  });

  it("respects custom targets", () => {
    const { scp } = toPolicies<string, string>();
    const result = scp.denyRootWithoutMfa({ targets: ["projects"] });
    assert.deepEqual(result.targets, ["projects"]);
  });
});

describe("toSecurityBaseline rootAccessManagement", () => {
  const baseConfig = {
    organizationalUnits: [
      {
        name: "root",
        parentName: null,
        accounts: [] as Array<{
          name: string;
          email: string;
          tags: Array<{ key: string; value: string }>;
        }>,
      },
      {
        name: "Security",
        parentName: "root",
        accounts: [
          { name: "SecurityAudit", email: "sec@test.com", tags: [] },
          { name: "LogArchive", email: "log@test.com", tags: [] },
        ],
      },
    ],
    delegatedAdministrators: [] as Array<{ account: string; servicePrincipal: string }>,
  };

  it("registers iam.amazonaws.com delegated admin", () => {
    const result = toSecurityBaseline(baseConfig, {
      rootAccessManagement: { enabled: true, delegatedAdminAccount: "SecurityAudit" },
    });
    assert.ok(
      result.delegatedAdministrators.some(
        (d) => d.servicePrincipal === "iam.amazonaws.com" && d.account === "SecurityAudit",
      ),
    );
  });

  it("works without delegatedAdminAccount", () => {
    const result = toSecurityBaseline(baseConfig, {
      rootAccessManagement: { enabled: true },
    });
    assert.ok(
      !result.delegatedAdministrators.some((d) => d.servicePrincipal === "iam.amazonaws.com"),
    );
  });

  it("does nothing when disabled", () => {
    const result = toSecurityBaseline(baseConfig, {
      rootAccessManagement: { enabled: false },
    });
    assert.deepEqual(result.delegatedAdministrators, []);
  });
});
