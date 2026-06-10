- [ ] lambda function memory and timeout should be configurable through generated aws.context.json - the default values should be 1025MiB and 5m and they should be written to the config as well
- [ ] add functionality like "disable root accounts", force MFA, force password policy etc
- [ ] support settings for creating IAM Identity Center?
- [ ] replace such and similar tests with simple inline valibot schema checking:
      ```ts
      const assumeResult = await stsClient.send(
        new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${props.targetAccountId}:role/OrganizationAccountAccessRole`,
          RoleSessionName: "beesolve-aws-accounts-config-bucket",
        }),
      );
      const credentials = assumeResult.Credentials;
      if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
        throw new Error(`Failed to assume role in account ${props.targetAccountId}`);
      }
      ```
- [ ]
