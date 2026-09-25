# AGENTS.md

Working notes for coding agents on the Onehop Payload Platform. The product
itself is documented in [README.md](README.md); this file covers the one thing
the repository cannot show you — how a change reaches production.

## How deployment works

- The `deploy` remote is the fork **SoftwareEnergiot/SW_OnehopData_Web**. Vercel
  builds every commit on its `main` and publishes it to production (project
  `sw-onehop-data-web`, <https://onehop-data.vercel.app>).
- **Deploying means merging a pull request into that `main`.** There is no
  separate step in Vercel, and nothing is ever pushed straight to `main`.
- The `origin` remote (Energiot/SW_OnehopData_Web) is not what Vercel builds.
- Devices POST their reports to `https://onehop-data.vercel.app/api/payloads`
  every 5 minutes and the firmware does not retry, so a broken deploy is lost
  data, not a retryable error.

## Database changes come first

- The SQL scripts are **not in this repository** — they live in Supabase and a
  person runs them. An agent never applies them.
- Whenever a change reads or writes a new column, the SQL is applied **before**
  the code is deployed. In the other order every insert is rejected and the
  reports are dropped, while the endpoint still answers `204`.
- Hand the SQL over as its own block, ready for the Supabase SQL editor, with
  nullable columns and no defaults, so it can be applied while the current
  production code is still running.
- Once you are told it has been applied, check it yourself before going on. The
  listing endpoints are public and read-only:

  ```
  GET https://onehop-data.vercel.app/api/payloads?environment=REE&limit=1
  ```

  The new columns must appear as keys of the returned row.

## Before opening a pull request

Branch off an up-to-date `main` (`git fetch deploy && git merge --ff-only
deploy/main`), naming the branch `feat/…`, `fix/…` or `docs/…`.

All four must pass locally:

```bash
npm test
npx tsc --noEmit
npx eslint lib components app
npx next build
```

Commit messages are in English: an imperative subject, then a body that says
what was wrong, why, and what was decided — the reasoning is the part that is
worth keeping.

## Pull request and merge

The pull request is opened on the fork, **SoftwareEnergiot/SW_OnehopData_Web**,
and only the `SoftwareEnergiot` GitHub account can open one there. `gh` has more
than one account logged in, so switch the active one to `SoftwareEnergiot` just
for the pull request, then switch back to whichever account was active before:

```bash
PREV=$(gh api user --jq .login)
gh auth switch --user SoftwareEnergiot
gh pr create --repo SoftwareEnergiot/SW_OnehopData_Web --base main --head <branch>
gh auth switch --user "$PREV"
```

Always switch back, even if `gh pr create` fails. Never read or print a token.

Wait for both checks — the second is the Vercel preview build. **A human merges
the pull request.** Ask for it and wait; never push to `main` and never look for
another route to merge.

## After merging

1. Wait for the production deployment to finish:

   ```bash
   gh api repos/SoftwareEnergiot/SW_OnehopData_Web/commits/<merge-sha>/status
   ```

2. Verify against the next real report, which arrives within 5 minutes:

   ```
   GET https://onehop-data.vercel.app/api/payloads?environment=REE&limit=1
   GET https://onehop-data.vercel.app/api/payloads?limit=1
   ```

   Check that `created_at` is later than the deployment and that the fields the
   change touched are populated.

3. Say plainly what the change does not cover: rows stored earlier that cannot
   be backfilled, reports lost while it was being rolled out, and anything left
   waiting on the firmware.

## Rules

- Never change the Vercel configuration or the production domain — the endpoint
  URL is compiled into the firmware of devices already in the field.
- Never deploy code that writes a column the database does not have yet.
- Which table a report lands in is decided by the device UID against the REE
  schema's `writeDeviceUids` (`lib/payload-schemas.ts`); everything else goes to
  `public.payloads`. Keep that list in step with the database restriction.
- If a step fails, stop and say so rather than working around it.
