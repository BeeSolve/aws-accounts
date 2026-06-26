import { fromIni } from "@aws-sdk/credential-providers";

export type AwsClientConfig = {
  region?: string;
  credentials?: ReturnType<typeof fromIni>;
};

export type AwsClientConfigInput = {
  profile?: string;
  region?: string;
};

export function resolveAwsProfile(props: { profileArg?: string }): string | undefined {
  const profile = props.profileArg ?? process.env.AWS_PROFILE;
  if (profile !== undefined && profile.trim() === "") {
    throw new Error("Invalid profile: value cannot be empty.");
  }
  return profile;
}

export function resolveAwsRegion(props: { regionArg?: string }): string | undefined {
  const region = props.regionArg ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region !== undefined && region.trim() === "") {
    throw new Error("Invalid region: value cannot be empty.");
  }
  return region;
}

export function buildAwsClientConfig(props: AwsClientConfigInput): AwsClientConfig {
  return {
    region: props.region,
    credentials: props.profile ? fromIni({ profile: props.profile }) : undefined,
  };
}
