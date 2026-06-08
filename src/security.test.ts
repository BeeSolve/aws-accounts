import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPolicies, withSecurityBaseline } from "./security.js";

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
    assert.deepEqual(stmt.Condition, { StringNotEquals: { "aws:PrincipalAccount": ["111", "222"] } });
  });

  it("EC2 statement has ForAnyValue:StringNotLike with allowed types", () => {
    const result = scp.blockExpensiveResources(opts);
    const stmt = (result.content as any).Statement[1];
    assert.deepEqual(stmt.Condition["ForAnyValue:StringNotLike"]["ec2:InstanceType"], ["t3.micro", "t3.small", "m8g.medium"]);
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
    const result = backupPolicy.dailyWithRetention({ regions: ["us-east-1"], retentionDays: 90, backupVaultName: "Fort" });
    const plan = (result.content as any).plans.DailyBackup;
    assert.equal(plan.rules.Daily.lifecycle.delete_after_days["@@assign"], "90");
    assert.equal(plan.rules.Daily.target_backup_vault_name["@@assign"], "Fort");
  });
});

describe("permissionSet patterns", () => {
  it("readOnlyAuditor returns ViewOnlyAccess managed policy", () => {
    const result = permissionSet.readOnlyAuditor();
    assert.equal(result.name, "ReadOnlyAuditor");
    assert.deepEqual(result.awsManagedPolicies, ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"]);
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

describe("withSecurityBaseline", () => {
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
    const result = withSecurityBaseline(baseConfig, {
      cloudTrail: { enabled: true, delegatedAdminAccount: "SecurityAudit", logArchiveAccount: "LogArchive" },
    });
    assert.ok(result.delegatedAdministrators.some((d) => d.servicePrincipal === "cloudtrail.amazonaws.com"));
  });

  it("adds config recorder stackset", () => {
    const result = withSecurityBaseline(baseConfig, {
      configRecorder: { enabled: true, delegatedAdminAccount: "SecurityAudit", deliveryBucketAccount: "LogArchive", targets: ["root"] },
    });
    assert.equal(result.securityBaseline?.stackSets.length, 1);
    assert.equal(result.securityBaseline?.stackSets[0].templateKey, "config-recorder");
  });

  it("adds guardduty stackset with defaults", () => {
    const result = withSecurityBaseline(baseConfig, {
      guardDuty: { enabled: true, delegatedAdminAccount: "SecurityAudit" },
    });
    assert.equal(result.securityBaseline?.stackSets[0].parameters[0].value, "FIFTEEN_MINUTES");
  });

  it("throws if referenced account does not exist", () => {
    assert.throws(
      () => withSecurityBaseline(baseConfig, {
        cloudTrail: { enabled: true, delegatedAdminAccount: "NonExistent", logArchiveAccount: "LogArchive" },
      }),
      /account "NonExistent" not found/,
    );
  });

  it("does not duplicate existing delegated admins", () => {
    const configWithExisting = {
      ...baseConfig,
      delegatedAdministrators: [{ account: "SecurityAudit", servicePrincipal: "cloudtrail.amazonaws.com" }],
    };
    const result = withSecurityBaseline(configWithExisting, {
      cloudTrail: { enabled: true, delegatedAdminAccount: "SecurityAudit", logArchiveAccount: "LogArchive" },
    });
    const ctAdmins = result.delegatedAdministrators.filter((d) => d.servicePrincipal === "cloudtrail.amazonaws.com");
    assert.equal(ctAdmins.length, 1);
  });

  it("returns config unchanged when no features enabled", () => {
    const result = withSecurityBaseline(baseConfig, {});
    assert.deepEqual(result.delegatedAdministrators, []);
    assert.equal(result.securityBaseline, undefined);
  });
});
