import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  MoveAccountCommand,
  type Account,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";
import type { Logger } from "./logger.js";
import { readStateFile, writeStateFile } from "./state.js";

type CreateAccountAndMoveToOuProps = {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  statePath: string;
  accountName: string;
  accountEmail: string;
  sourceParentId: string;
  destinationParentId: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
};

type CreateAccountAndMoveToOuResult = {
  accountId: string;
  stateUpdated: boolean;
};

export async function createAccountAndMoveToOu(
  props: CreateAccountAndMoveToOuProps,
): Promise<CreateAccountAndMoveToOuResult> {
  props.logger.log(
    `Creating account "${props.accountName}" (${props.accountEmail})...`,
  );
  const createResponse = await props.organizationsClient.send(
    new CreateAccountCommand({
      AccountName: props.accountName,
      Email: props.accountEmail,
    }),
  );
  const createRequestId = createResponse.CreateAccountStatus?.Id;
  if (createRequestId == null) {
    throw new Error("CreateAccount did not return a request id.");
  }

  const accountId = await pollCreateAccountStatusUntilTerminal({
    organizationsClient: props.organizationsClient,
    logger: props.logger,
    createRequestId: createRequestId,
    timeoutInMs: props.timeoutInMs,
    pollIntervalInMs: props.pollIntervalInMs,
  });
  props.logger.log(
    `Moving account "${props.accountName}" (${accountId}) to destination OU (${props.destinationParentId})...`,
  );
  await props.organizationsClient.send(
    new MoveAccountCommand({
      AccountId: accountId,
      SourceParentId: props.sourceParentId,
      DestinationParentId: props.destinationParentId,
    }),
  );
  const stateWriteResult = await upsertCreatedAccountInState({
    organizationsClient: props.organizationsClient,
    statePath: props.statePath,
    accountId: accountId,
    destinationParentId: props.destinationParentId,
  });
  return {
    accountId: accountId,
    stateUpdated: stateWriteResult.changed,
  };
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
  destinationParentId: string;
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
    parentId: props.destinationParentId,
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
