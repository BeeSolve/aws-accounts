# 0. Architecture

- nodejs `cli` installed through `npm i @beesolve/aws-accounts` (for testing purposes we will build the project and link it through filesystem eg. add dependency as `file:../...`)
- simple nodejs24 `lambda` (created by cli - eg. bootstrap command) built with esbuild (esm modules) - this lambda uses AWS SDKs V3 to access aws resources - describe Organization OUs, IAM identity center users/groups/roles, access state persisted in S3 bucket
- S3 bucket (created by CLI tool - eg. bootstrap command) - will contain state.json - `state.json` is derived from `aws.config.ts`
- `aws.config.ts` - config which describes the state of OUs in organization, accounts (with their OUs), IAM identity center users/groups/permissions/roles - through this config the user will be able to model his organization - who has access where, which accounts shoudl be in which OU etc; once user changes this config file the cli should be able to generate `state.json` based on this, it should be able to compare changes to remote state.json (persisted on S3 - source of truth - this is the current state of the system) and by diffing it it should be able to plan the operations which are then persisted to S3 under key with UUID - after that the cli should invoke `lambda` with UUID as parameter, the lambda should pick up the changes which needs to be done and perform them - this should be synchronous eg. the lambda should respond once everything is done

# 1. Bootstrap management account

The package `@beesolve/aws-account` should come with prebuilt lambda.zip file. When user calls `npx aws-accounts bootstrap` it should deploy Lambda and S3 bucket in the management account - it should also persist s3 bucket name and aws lambda arn in aws.context.json file. The aws.config.ts should be also generated. The profile and region should be provided by arguments or env variables. Also create `Pending` OU and `Graveyard` OU. Note their "ids" in `aws.context.json` as well.

# 2. Scan for existing resources

After running `npx aws-accounts scan` the Lambda function should be invoked with instruction to do the investigation - through AWS SDKs it should read OU structure, accounts, and users/groups/permissions/roles from IAM Identity Center. Then it should persist current state in S3 bucket and also return signed link for this state. `cli` then should download the state.json and update `aws.config.ts` based on it.

# 3. Create new account

After running `npx aws-accounts create-account` user should be able to provide email address, and account name. The `lambda` should be invoked with an instruction to create acccount. The lambda should synchronously create account in Pending OU - the ID should be passed as argument to lambda. Lambda should also wait for the account to became active (poll for the status) - once it is active it should return it's ID. Then the `cli` should add this account into `aws.config.ts`.

# 4. Add/modify existing resources

There should be 2 phases to this - first is `plan` which essentially creates a diff between current `aws.config.ts` and remote `state.json` which effectivelly creates the instructions for `lambda` which are uploaded to s3 (or lambda is called with this instructions and the lambda is going to persist that on S3 so its cleaner). Then `apply` calls `lambda` with UUID of the changes which should be performed. These changes are performed via AWS SDK v3 calls inside lambda on behalf of the user.

We want to show user feedback on what is going to be changed and what has changed.


# 5. function specification

- use typescript 6+
- for testing use node test runner
- for validations use valibot
- do not use cloudformation
- use esbuild for building the code
- do not use barrel files
- group similar code in single file eg. functions/types in single file
- all code related to AWS Lambda handler should be in single file
- the code should be simple and boring and explicit
- name everything in camelCase
- make sure the names are clear and descriptive
- no delete/destructive actions should be implemented!
