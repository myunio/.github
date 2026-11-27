# Shared workflows

The release flow every Unio website repo uses: websitestrategy, ultraoffice, unio-software and
unioapp-com.

- A pull request runs one check, `ci / check`, which main requires.
- A merge to main deploys staging.
- Production deploys only when someone runs "Release to production" from main (Actions > Release to
  production > Run workflow).

Each repo keeps three short files that call the two workflows here at `@main`, so a change here
reaches all four at their next run.

| Repo file | Calls | Runs on |
| --- | --- | --- |
| `.github/workflows/ci.yml` (job `ci`) | `website-ci.yml` | every pull request |
| `.github/workflows/deploy-staging.yml` | `website-deploy.yml` with `environment: staging` | push to main, or by hand |
| `.github/workflows/release.yml` | `website-deploy.yml` with `environment: production` | by hand, from main only |

The inputs at the top of each workflow cover the differences between repos: npm or no Node
dependencies, a Ruby build, the build and check commands, and the Worker and account each deploy
must reach.

## What each repo needs

- GitHub environments `staging` and `production`, each limited to the `main` branch, each holding
  `CLOUDFLARE_API_TOKEN` (Workers deploy rights on that account) and `CLOUDFLARE_ACCOUNT_ID`. The
  deploy job names the environment itself, so GitHub reads these environment secrets before any
  repository secret of the same name.
- The repository variable `STAGING_ENABLED` set to `true` once the staging address is ready (behind
  Cloudflare Access where the site is not public). Until then a merge deploys nothing.
- `wrangler.jsonc` with the production Worker at its top level and staging under `env.staging`.

## Safety built in

- **Check deploy target**: before any deploy, the run works out the Worker name and account id
  wrangler will use (from a build plugin's `.wrangler/deploy/config.json`, else `wrangler.jsonc`
  and its env) and stops unless both match the caller's `worker-name` and `account-id`.
- **Main only**: the deploy job runs only on `refs/heads/main`, and each environment's branch rule
  says the same.
- **No overlap**: one deploy at a time per environment in each repo; a running deploy is never
  cancelled.
- Actions are pinned to commit SHAs.

## Scoped Unio releases

UltraOffice and Unio Software opt into the scoped path. Their protected
GitHub environments supply the per-Worker deploy token. The shared job
reads the public account, Worker and KV IDs from reviewed config. It
checks the Worker identity and public URL settings, uploads a version,
checks its KV binding and activates that exact version. The Google
Cloud Storage lock serializes the release with OpenTofu binding writes.

A staging release starts on a push to main. The bootstrap release may
run before the hostname is attached. After attachment, the reviewed
site config enables the hostname checks. They verify the Unio Access
challenge on the homepage, stylesheet and form endpoint. UltraOffice
also checks the inbound service token using the two pinned Secret
Manager versions. Production requires Steve to dispatch the current main
commit on the first attempt, a green staging run of that commit and
enabled hostname checks.
