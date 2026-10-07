# @beesolve/aws-accounts - Documentation

**Keywords:** aws organizations, identity center, scp, service control policy, permission set, toScpCollection, toSecurityBaseline, toPolicies, plan apply, aws-accounts cli

> This documentation is published inside the installed package and matches the installed version. Prefer it over prior knowledge or older examples found online.

> Full source and examples: https://github.com/BeeSolve/aws-accounts/tree/main

`@beesolve/aws-accounts` is both a CLI for managing AWS Organizations and IAM Identity Center from a typed config file, and a library of composable Service Control Policy and security-baseline builders. For CLI usage install it globally (`npm install -g @beesolve/aws-accounts`) or run it with `npx @beesolve/aws-accounts`; for library usage install it as a dependency (`npm install @beesolve/aws-accounts`).

## How-To Guides

| Guide                                               | Description                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| [Getting Started](./docs/how-to/getting-started.md) | Install the CLI, bootstrap, scan, edit `aws.config.ts`, plan and apply  |
| [SCP Collection](./docs/how-to/scp-collection.md)   | Compose Service Control Policies programmatically via `./scpCollection` |

## Working Examples

This package does not ship a standalone example project. See the How-To Guides above for runnable snippets, and the [README](./README.md) for the full CLI walkthrough.

## Further Reading

- [README](./README.md) - CLI commands, configuration, Plan/Apply safety, SCP patterns, and FAQ
- [CHANGELOG](./CHANGELOG.md) - Version history
- [Architecture Decision Records](https://github.com/BeeSolve/aws-accounts/tree/main/docs/adr) (GitHub only)
