<!--
  PR title must follow the convention: [Tag] Short description

  Valid tags:
    [Added]    — New feature or functionality
    [Fixed]    — Bug fix
    [Changed]  — Modification to existing behavior
    [Removed]  — Removed feature or code
    [Updated]  — Dependency, config, or documentation update
    [Refactor] — Code restructuring without behavior change

  Examples:
    [Added] Plugin hot-reload support
    [Fixed] Model autocomplete not refreshing after provider setup
    [Changed] Gateway to support multi-provider routing
    [Removed] Legacy configuration loader
    [Updated] Go dependencies to latest patch versions
    [Refactor] Extract provider router from gateway server
-->

## What

<!-- What does this PR do? Keep it to 1-2 sentences. -->

## Why

<!-- Why is this change needed? Link to an issue if applicable. -->

Closes #

## How

<!-- Brief explanation of the approach. Skip if obvious from the diff. -->

## Checklist

- [ ] PR title follows `[Tag] Description` convention
- [ ] Code formatted (`bun run format`)
- [ ] Linter passes (`bun run lint`)
- [ ] Types check (`bun run typecheck`)
- [ ] Tests pass (if applicable)
- [ ] Protobuf regenerated (if `.proto` files changed)
- [ ] No secrets or credentials committed
