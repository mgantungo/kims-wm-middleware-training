# KIMS-WM Middleware

Node.js/Express middleware between the KIMS-WM Flutter app and Business
Central. Matches the Flutter app's `ApiEndpoints` contract exactly, so
pointing the app's `--dart-define=API_BASE_URL_*` at a running instance of
this service is the only wiring needed.

## Architecture

```
src/
  server.js              Entrypoint. Binds 127.0.0.1 only — Apache
                          terminates TLS and reverse-proxies in front
                          (see deploy/README.md).
  app.js                 Express app assembly: security middleware,
                          route mounting, central error handler.

  config/env.js           Single place every env var is read from and
                          validated at boot.

  middleware/
    requireAuth.js         Verifies the JWT the app attaches as a Bearer
                          token; matches AuthException handling on the
                          Flutter side (401 -> "session expired").
    environmentGuard.js    Cross-checks the app's X-KIMS-Environment
                          header against this deployment's KIMS_ENV —
                          refuses the request on mismatch rather than
                          risk training data landing in production.
    errorHandler.js        The one place an error becomes an HTTP
                          response. Every unexpected exception is logged
                          in full and converted to a safe generic 500 —
                          nothing crashes the process, nothing leaks a
                          stack trace to the client.

  auth/                    Local JSON user store + JWT issuance. Kept
                          behind a small interface so swapping to
                          Business Central / Azure AD later only means a
                          new store implementation.

  data/
    adapters/
      dataSource.interface.js    Documents the contract every adapter
                                must implement.
      demoDataSource.js          In-memory data seeded 1:1 from the
                                approved HTML prototype. Active now.
      businessCentralDataSource.js  Phase 2 stub — same method surface,
                                throws "not implemented" until real BC
                                credentials are wired in.
    dataSourceFactory.js   The ONLY switch point: reads DATA_SOURCE from
                          .env and hands every module the right adapter.
                          No controller ever imports an adapter directly.

  modules/                 One folder per feature (putAway, pick,
                          verifyPack, ship, gatePass, inquiry), each with
                          a thin controller + router. All business logic
                          that might change between demo and Business
                          Central lives in the data source adapter, not
                          here — these stay adapter-agnostic.

  utils/
    apiError.js             The one error type route handlers throw.
                          Produces { error, code } bodies the Flutter
                          app's ApiClient already knows how to map to the
                          right AppException subtype.
    asyncHandler.js         Wraps every async route so a rejected
                          promise always reaches errorHandler.js instead
                          of hanging the request.
```

## Local development

```bash
npm install
cp .env.example .env          # set KIMS_ENV=training, DATA_SOURCE=demo
npm run seed:users            # creates data/users.json with wh-jdoe / changeme123
npm run dev                   # node --watch, restarts on file change
```

Health check: `curl http://localhost:3000/health`

Login:
```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"wh-jdoe","password":"changeme123"}'
```

Then use the returned `token` as `Authorization: Bearer <token>` against
any other route, e.g.:
```bash
curl http://localhost:3000/put-away/documents \
  -H 'Authorization: Bearer <token>' \
  -H 'X-KIMS-Environment: training'
```

## Deploying to Debian 12 + Apache (training :6443 / production :7443)

See `deploy/README.md` for the full walkthrough — two systemd-managed Node
processes, one per environment, each behind its own Apache vhost
terminating TLS.

## Swapping to real Business Central (Phase 2)

1. Implement each method in `src/data/adapters/businessCentralDataSource.js`
   against the real Business Central OData v4 / API v2.0 endpoints,
   returning the same JSON shape the demo adapter already returns (see
   `dataSource.interface.js` for the exact contract).
2. Set `DATA_SOURCE=businessCentral` and fill in the `BC_*` variables in
   `.env`.
3. Restart the service. No route, controller, or Flutter-side code changes.
