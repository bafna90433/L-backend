# MongoDB to PostgreSQL migration

This backend supports a staged, non-destructive cutover. MongoDB remains the active database until PostgreSQL has been populated and verified.

## Safety rules

- Keep `DATABASE_PROVIDER=mongodb` during schema creation, import and verification.
- Keep `MONGO_URI` configured. The migration scripts only read from MongoDB.
- The import uses `createMany(..., skipDuplicates: true)` inside one PostgreSQL transaction. It does not update or delete source or target rows.
- Reference, required-field and unique-field validation runs before PostgreSQL writes.
- Verification compares every ID and every field value. Any missing, extra or changed row blocks cutover.
- Do not remove MongoDB until PostgreSQL has been used successfully in production and a separate backup/rollback decision has been approved.

## Railway variables

Configure these on the `L-backend` service:

```text
DATABASE_PROVIDER=mongodb
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Keep the existing `MONGO_URI` unchanged.

## Safe run order

```bash
npm test
npm run db:audit:mongo
npm run db:migrate:safe
```

`db:migrate:safe` creates the PostgreSQL schema, performs the insert-only import, and then runs exact content verification. It exits with an error before cutover if anything does not match.

After verification succeeds, set:

```text
DATABASE_PROVIDER=postgresql
```

Redeploy and verify authentication, employees, cash transactions, reminders, tasks, departments and kiosk APIs. Rollback is only a variable change back to `DATABASE_PROVIDER=mongodb`; MongoDB is retained unchanged.
