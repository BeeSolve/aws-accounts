import { readAwsContextFromFile } from "../awsConfig.js";
import type { Logger } from "../logger.js";
import { readStateFile } from "../state.js";

type GraveyardCommandInput = {
  logger: Logger;
  statePath: string;
  contextPath: string;
};

type GraveyardCommandResult = {
  graveyardOuId: string;
  accounts: Array<{
    id: string;
    name: string;
    email: string;
    status: string;
  }>;
};

export async function runGraveyardCommand(
  props: GraveyardCommandInput,
): Promise<GraveyardCommandResult> {
  const [state, context] = await Promise.all([
    readStateFile(props.statePath),
    readAwsContextFromFile(props.contextPath),
  ]);
  const graveyardOuId = context.organization.graveyardOuId;
  const graveyardAccounts = state.organization.accounts
    .filter((account) => account.parentId === graveyardOuId)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      status: account.status,
    }));

  props.logger.log(`Graveyard OU: ${graveyardOuId}`);
  props.logger.log(`Accounts in Graveyard: ${graveyardAccounts.length}`);
  if (graveyardAccounts.length === 0) {
    props.logger.log("No accounts currently parked in Graveyard.");
    return {
      graveyardOuId,
      accounts: graveyardAccounts,
    };
  }

  props.logger.log("");
  for (const account of graveyardAccounts) {
    props.logger.log(
      `- ${account.name} (${account.id}) [${account.status}] <${account.email}>`,
    );
    props.logger.log(
      `  aws organizations close-account --account-id ${account.id}`,
    );
  }

  return {
    graveyardOuId,
    accounts: graveyardAccounts,
  };
}
