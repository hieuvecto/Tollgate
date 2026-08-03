# AGENTS.md

## Ground rules

- One milestone per implementation checkpoint. Do not begin the next until its tests pass.
- Read `docs/money-path.md` and the invariants before changing metering, limits,
  idempotency, or migrations.
- Money-path code is test-first.
- Do not widen scope. Record unresolved scope in `docs/open-questions.md`.

## Hard prohibitions

- No floating-point arithmetic on money. Use bigint micros.
- Never update or delete usage events or ledger entries.
- Never expose plaintext secrets in storage, logs, metrics, errors, or fixtures.
- Tests require no provider key or network egress.
- Do not silently change documented behavior to make a test pass.

## TypeScript style

- Follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html);
  ESLint and Prettier are authoritative.
- Do not suppress style or type errors without a documented external-contract reason.
- Preserve required database, wire, environment, and tool-defined names and exports.

## Definition of done

1. Typecheck, lint, and tests pass.
2. Relevant invariants have asserting tests.
3. Documentation records behavioral decisions and trade-offs.
4. Each milestone is a conventional commit.
