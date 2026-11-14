# Elysiam server source import

Imported on 14 November 2026 from `103.129.209.29`. The active Nginx routes and
running Docker containers identify these as the sites using **elysiam with an a**:

| Live domain | Local code | Running release | Server source |
| --- | --- | --- | --- |
| `elysiam.bd` | [`storefront/`](storefront/) | `7ede228a682a` | `/srv/elysium-web/releases/7ede228a682a` |
| `erp.elysiam.bd` | Repository root | `2c17afcb983d` | `/home/enfinito/erp-brands/src/2c17afcb983d` |

The existing code, package names, documentation, and server paths retain their
original `elysium` spelling. The domain routing determines which deployment was
imported. The older `/home/enfinito/elysiam-erp` checkout was not used: the running
ERP container points to the newer release listed above.

The ERP stays at the repository root to preserve its workspace, CI, migration,
and deployment scripts. The storefront is a separate npm project. Both source
trees are unchanged from their deployed release directories.

## Included files

- 3,028 ERP files: applications, shared packages, database schema and migrations,
  tests, assets, documentation, and deployment scripts.
- 168 storefront files, including the Next.js application, packing scanner
  source and distributed APK, assets, tests, and deployment scripts.
- The two active Nginx configurations in [`deployment/nginx/`](deployment/nginx/).
- Safe environment templates supplied with the source.

Production environment files, credentials, databases, backups, uploaded customer
data, caches, installed dependencies, and older releases were not imported.
The server's running services and deployments were not changed.

## Run locally

Use Node 24 (see [`.nvmrc`](.nvmrc)) and pnpm 12.5.1 for the ERP. Its complete
setup instructions remain in [`README.md`](README.md):

```sh
pnpm install --frozen-lockfile
pnpm setup:env
docker compose -f infra/docker-compose.dev.yml up -d --wait
pnpm db:bootstrap
pnpm db:migrate
pnpm db:seed
pnpm dev
```

For the storefront, follow [`storefront/README.md`](storefront/README.md):

```sh
cd storefront
npm ci
cp .env.example .env.local
# Configure a local ERP URL and a website key issued by that ERP.
npm run dev -- -p 3100
```

The ERP API normally occupies port 3000. Use port 3100 for the storefront when
running both. Production keys and database contents are not required to develop
against a local ERP with seed data.

## Import verification

All **3,198 imported files** were checked against SHA-256 hashes calculated on
the server. [`deployment/server-import.json`](deployment/server-import.json)
records the source paths, release identifiers, counts, and manifest digest.

To check the imported snapshot again from the repository root:

```sh
shasum -a 256 -c deployment/source-checksums.sha256
```

The manifest covers original imported files, including the Nginx snapshots. It
excludes this import note and the import metadata. Later intentional source
edits will naturally differ from the server snapshot.

Local checks completed after import:

- Storefront unit tests: **37 passed**.
- Storefront lint: passed with no warnings or errors.
- Storefront `check:no-database`: passed.
- ERP brand-console and mother-console translation checks: passed.
- Every imported source file is visible to Git; dependencies remain ignored.

The full ERP build and integration suite were not run. Its white-label check
requires generated frontend builds and could not complete against the source
snapshot alone. Production services were not used for testing.
