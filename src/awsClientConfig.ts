import { fromIni } from "@aws-sdk/credential-providers";

export type AwsClientConfig = {
  region?: string;
  credentials?: ReturnType<typeof fromIni>;
};

export type AwsClientConfigInput = {
  profile?: string;
  region?: string;
};

export function resolveAwsProfile(profileArg?: string): string | undefined {
  const profile = profileArg ?? process.env.AWS_PROFILE;
  if (profile !== undefined && profile.trim() === "") {
    throw new Error("Invalid profile: value cannot be empty.");
  }
  return profile;
}

export function resolveAwsRegion(regionArg?: string): string | undefined {
  const region = regionArg ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region !== undefined && region.trim() === "") {
    throw new Error("Invalid region: value cannot be empty.");
  }
  return region;
}

export function buildAwsClientConfig(input: AwsClientConfigInput): AwsClientConfig {
  const profile = resolveAwsProfile(input.profile);
  const region = resolveAwsRegion(input.region);
  return {
    region,
    credentials: profile ? fromIni({ profile }) : undefined
  };
}
