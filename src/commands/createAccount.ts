import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  MoveAccountCommand,
  type Account,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  loadAwsConfigModelFromTsFile,
  readAwsContextFromFile,
  regenerateAwsConfigTypes,
  writeAwsConfigModelToFile,
} from "../awsConfig.js";
import type { Logger } from "../logger.js";
import { readStateFile, writeStateFile } from "../state.js";

type CreateAccountCommandInput = {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  configPath: string;
  typesPath: string;
  statePath: string;
  contextPath: string;
  accountName: string;
  accountEmail: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
};

type CreateAccountCommandResult = {
  status: "created" | "alreadyExists";
  accountId?: string;
  stateUpdated: boolean;
  configUpdated: boolean;
  typesUpdated: boolean;
};

export async function runCreateAccountCommand(
  props: CreateAccountCommandInput,
): Promise<CreateAccountCommandResult> {
  if (props.timeoutInMs <= 0) {
    throw new Error("create-account requires timeoutInMs > 0.");
  }
  if (props.pollIntervalInMs <= 0) {
    throw new Error("create-account requires pollIntervalInMs > 0.");
  }
  const accountName = props.accountName.trim();
  const accountEmail = props.accountEmail.trim();
  if (accountName.length === 0) {
    throw new Error("create-account requires a non-empty accountName.");
  }
  if (accountEmail.length === 0) {
    throw new Error("create-account requires a non-empty accountEmail.");
  }

  const [context, config] = await Promise.all([
    readAwsContextFromFile(props.contextPath),
    loadAwsConfigModelFromTsFile({
      configPath: props.configPath,
      typesPath: props.typesPath,
    }),
  ]);
  const pendingOu = config.organizationalUnits.find((ou) => ou.name === "Pending");
  if (pendingOu == null) {
    throw new Error('Could not find "Pending" OU in aws.config.ts.');
  }
  if (context.organization.pendingOuId.trim().length === 0) {
    throw new Error(
      'Could not resolve Pending OU id from aws.context.json. Re-run bootstrap.',
    );
  }

  props.logger.log(
    `Checking if account already exists: "${accountName}" (${accountEmail})`,
  );
  const existingAccount = await findExistingAccountByNameOrEmail({
    organizationsClient: props.organizationsClient,
    accountName,
    accountEmail,
  });
  if (existingAccount != null) {
    const localMatch = config.organizationalUnits
      .flatMap((ou) => ou.accounts)
      .find(
        (account) => account.name === accountName || account.email === accountEmail,
      );
    props.logger.log(
      `Account already exists in AWS: "${existingAccount.name}" (${existingAccount.id})`,
    );
    if (localMatch == null) {
      props.logger.warn("Local config was not changed.");
      props.logger.warn(
        "Run `npm run cli -- scan` (or `npm run cli -- init`) to refresh local config.",
      );
    }
    return {
      status: "alreadyExists",
      accountId: existingAccount.id,
      stateUpdated: false,
      configUpdated: false,
      typesUpdated: false,
    };
  }

  props.logger.log(`Creating account "${accountName}" (${accountEmail})...`);
  const createResponse = await props.organizationsClient.send(
    new CreateAccountCommand({
      AccountName: accountName,
      Email: accountEmail,
    }),
  );
  const createRequestId = createResponse.CreateAccountStatus?.Id;
  if (createRequestId == null) {
    throw new Error("CreateAccount did not return a request id.");
  }

  const accountId = await pollCreateAccountStatusUntilTerminal({
    organizationsClient: props.organizationsClient,
    logger: props.logger,
    createRequestId,
    timeoutInMs: props.timeoutInMs,
    pollIntervalInMs: props.pollIntervalInMs,
  });
  props.logger.log(
    `Moving account "${accountName}" (${accountId}) to Pending OU (${context.organization.pendingOuId})...`,
  );
  await props.organizationsClient.send(
    new MoveAccountCommand({
      AccountId: accountId,
      SourceParentId: context.organization.rootId,
      DestinationParentId: context.organization.pendingOuId,
    }),
  );
  const stateWriteResult = await upsertCreatedAccountInState({
    organizationsClient: props.organizationsClient,
    statePath: props.statePath,
    accountId,
    pendingOuId: context.organization.pendingOuId,
  });
  pendingOu.accounts.push({
    name: accountName,
    email: accountEmail,
  });
  const configWriteResult = await writeAwsConfigModelToFile({
    config,
    configPath: props.configPath,
  });
  const typesWriteResult = await regenerateAwsConfigTypes({
    configPath: props.configPath,
    typesPath: props.typesPath,
    logger: props.logger,
    overwriteConfirmation: async () => true,
  });
  return {
    status: "created",
    accountId,
    stateUpdated: stateWriteResult.changed,
    configUpdated: configWriteResult.changed,
    typesUpdated: typesWriteResult.changed,
  };
}

async function findExistingAccountByNameOrEmail(props: {
  organizationsClient: OrganizationsClient;
  accountName: string;
  accountEmail: string;
}): Promise<{ id: string; name: string; email: string } | undefined> {
  const targetEmail = props.accountEmail.toLowerCase();
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListAccountsCommand({ NextToken: nextToken }),
    );
    const matchedAccount = (response.Accounts ?? []).find((account) => {
      if (account.Id == null || account.Name == null || account.Email == null) {
        return false;
      }
      const matchesName = account.Name === props.accountName;
      const matchesEmail = account.Email.toLowerCase() === targetEmail;
      return matchesName || matchesEmail;
    });
    if (
      matchedAccount?.Id != null &&
      matchedAccount.Name != null &&
      matchedAccount.Email != null
    ) {
      return {
        id: matchedAccount.Id,
        name: matchedAccount.Name,
        email: matchedAccount.Email,
      };
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return undefined;
}

async function pollCreateAccountStatusUntilTerminal(props: {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  createRequestId: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
}): Promise<string> {
  const startedAt = Date.now();
  let lastStatus: string | undefined;
  while (Date.now() - startedAt < props.timeoutInMs) {
    const response = await props.organizationsClient.send(
      new DescribeCreateAccountStatusCommand({
        CreateAccountRequestId: props.createRequestId,
      }),
    );
    const status = response.CreateAccountStatus;
    const state = status?.State ?? "UNKNOWN";
    if (state !== lastStatus) {
      props.logger.log(`CreateAccount status: ${state}`);
      lastStatus = state;
    }
    if (state === "SUCCEEDED") {
      if (status?.AccountId == null) {
        throw new Error(
          "CreateAccount succeeded but response did not include AccountId.",
        );
      }
      return status.AccountId;
    }
    if (state === "FAILED") {
      throw new Error(
        `CreateAccount failed: ${status?.FailureReason ?? "unknown reason"}.`,
      );
    }
    await delay(props.pollIntervalInMs);
  }
  throw new Error(
    `CreateAccount timed out after ${props.timeoutInMs}ms. Check AWS Organizations and retry.`,
  );
}

async function upsertCreatedAccountInState(props: {
  organizationsClient: OrganizationsClient;
  statePath: string;
  accountId: string;
  pendingOuId: string;
}): Promise<{ changed: boolean }> {
  const account = await findAccountById({
    organizationsClient: props.organizationsClient,
    accountId: props.accountId,
  });
  if (account == null) {
    throw new Error(
      `Created account "${props.accountId}" could not be resolved from AWS Organizations list.`,
    );
  }
  const currentState = await readStateFile(props.statePath);
  const existingIndex = currentState.organization.accounts.findIndex(
    (item) => item.id === props.accountId,
  );
  const nextAccount = {
    id: account.id,
    arn: account.arn,
    name: account.name,
    email: account.email,
    status: account.status,
    parentId: props.pendingOuId,
  };
  if (existingIndex >= 0) {
    const existing = currentState.organization.accounts[existingIndex];
    if (
      existing.id === nextAccount.id &&
      existing.arn === nextAccount.arn &&
      existing.name === nextAccount.name &&
      existing.email === nextAccount.email &&
      existing.status === nextAccount.status &&
      existing.parentId === nextAccount.parentId
    ) {
      return { changed: false };
    }
    currentState.organization.accounts[existingIndex] = nextAccount;
  } else {
    currentState.organization.accounts.push(nextAccount);
  }
  await writeStateFile(props.statePath, currentState);
  return { changed: true };
}

async function findAccountById(props: {
  organizationsClient: OrganizationsClient;
  accountId: string;
}): Promise<
  | {
      id: string;
      arn: string;
      name: string;
      email: string;
      status: NonNullable<Account["Status"]>;
    }
  | undefined
> {
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListAccountsCommand({ NextToken: nextToken }),
    );
    const matched = (response.Accounts ?? []).find((account) =>
      isCompleteAccountWithStatus(account, props.accountId),
    );
    if (
      matched?.Id != null &&
      matched.Arn != null &&
      matched.Name != null &&
      matched.Email != null &&
      matched.Status != null
    ) {
      return {
        id: matched.Id,
        arn: matched.Arn,
        name: matched.Name,
        email: matched.Email,
        status: matched.Status,
      };
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return undefined;
}

function isCompleteAccountWithStatus(
  account: Account,
  expectedAccountId?: string,
): boolean {
  if (
    account.Id == null ||
    account.Arn == null ||
    account.Name == null ||
    account.Email == null ||
    account.Status == null
  ) {
    return false;
  }
  if (expectedAccountId == null) {
    return true;
  }
  return account.Id === expectedAccountId;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
