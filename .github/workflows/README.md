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
