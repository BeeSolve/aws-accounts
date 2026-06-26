import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  MoveAccountCommand,
  type Account,
  type OrganizationsClient,
} from "@aws-sdk/client-organizations";

import { delay } from "./helpers.js";
import type { Logger } from "./logger.js";

type CreateAccountAndMoveToOuProps = {
  organizationsClient: OrganizationsClient;
  logger: Logger;
  accountName: string;
  accountEmail: string;
  sourceParentId: string;
  destinationParentId: string;
  timeoutInMs: number;
  pollIntervalInMs: number;
};

export type CreatedAccountRecord = {
  id: string;
  arn: string;
  name: string;
  email: string;
  state: NonNullable<Account["State"]>;
  parentId: string;
};

type CreateAccountAndMoveToOuResult = {
  accountId: string;
  account: CreatedAccountRecord;
};

export async function createAccountAndMoveToOu(
  props: CreateAccountAndMoveToOuProps,
): Promise<CreateAccountAndMoveToOuResult> {
  props.logger.log(`Creating account "${props.accountName}" (${props.accountEmail})...`);
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
    createRequestId,
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
  const account = await resolveCreatedAccountRecord({
    organizationsClient: props.organizationsClient,
    accountId,
    destinationParentId: props.destinationParentId,
  });
  return {
    accountId,
    account,
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
        throw new Error("CreateAccount succeeded but response did not include AccountId.");
      }
      return status.AccountId;
    }
    if (state === "FAILED") {
      throw new Error(`CreateAccount failed: ${status?.FailureReason ?? "unknown reason"}.`);
    }
    await delay(props.pollIntervalInMs);
  }
  throw new Error(
    `CreateAccount timed out after ${props.timeoutInMs}ms. Check AWS Organizations and retry.`,
  );
}

async function resolveCreatedAccountRecord(props: {
  organizationsClient: OrganizationsClient;
  accountId: string;
  destinationParentId: string;
}): Promise<CreatedAccountRecord> {
  const account = await findAccountById({
    organizationsClient: props.organizationsClient,
    accountId: props.accountId,
  });
  if (account == null) {
    throw new Error(
      `Created account "${props.accountId}" could not be resolved from AWS Organizations list.`,
    );
  }
  return {
    id: account.id,
    arn: account.arn,
    name: account.name,
    email: account.email,
    state: account.state,
    parentId: props.destinationParentId,
  };
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
      state: NonNullable<Account["State"]>;
    }
  | undefined
> {
  let nextToken: string | undefined;
  do {
    const response = await props.organizationsClient.send(
      new ListAccountsCommand({ NextToken: nextToken }),
    );
    const matched = (response.Accounts ?? []).find((account) =>
      isCompleteAccount(account, props.accountId),
    );
    if (
      matched?.Id != null &&
      matched.Arn != null &&
      matched.Name != null &&
      matched.Email != null &&
      matched.State != null
    ) {
      return {
        id: matched.Id,
        arn: matched.Arn,
        name: matched.Name,
        email: matched.Email,
        state: matched.State,
      };
    }
    nextToken = response.NextToken;
  } while (nextToken != null);
  return undefined;
}

function isCompleteAccount(account: Account, expectedAccountId?: string): boolean {
  if (
    account.Id == null ||
    account.Arn == null ||
    account.Name == null ||
    account.Email == null ||
    account.State == null
  ) {
    return false;
  }
  if (expectedAccountId == null) {
    return true;
  }
  return account.Id === expectedAccountId;
}
