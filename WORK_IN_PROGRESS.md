# Video app improvement progress

## Completed

- Step 1, startup configuration: SSM reads now use batches of at most 10; Memcached reads its endpoint when connecting. Both focused startup tests pass.
- Step 2, backend security: Cognito login responses are no longer logged, and unexpected login and MFA responses no longer include raw Cognito data. The focused auth test passes.

## Next step

- Step 3, backend jobs: fix failure and retry state transitions. No Step 3 code changes have started.

## Verification remaining

- A full startup against the configured AWS account has not been run here.
- The auth change has been tested with mocked Cognito responses, not a live Cognito user pool.
