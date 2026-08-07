# Working in this repo

Deployment notes that are not discoverable from the code. Each one below has already
caused a failure that looked like success — a green build, a passing healthcheck, or a
200 response — while the system was actually broken.

## Railway

**Redeploy after changing variables.** Setting a variable does not restart the service,
and `--skip-deploys` guarantees it will not. Running containers keep the environment they
started with. Rotating a credential without redeploying leaves the old value live until
the next deploy, so the service keeps authenticating with a secret that no longer works.

**`DATABASE_URL` must be the `ratchet_app` role, never `postgres`.** Row-level security is
enforced against `ratchet_app`; a superuser bypasses RLS entirely. If this is switched to
the superuser, cross-tenant isolation silently stops applying, and nothing surfaces it —
`/health` passes, `/db-check` passes, queries return rows. `ADMIN_DATABASE_URL` is the
superuser and is used only for migrations, which create roles and set `FORCE` RLS.

**`preDeployCommand` only takes effect from `railway.json`.** When a config file is set on
the service, that file's `deploy` section is the authoritative manifest and any
service-level setting is ignored — silently, without warning. A service-level
`preDeployCommand` of a nonexistent binary still deploys successfully, which means you
cannot trust a passing deploy as evidence the command ran.

**Keep services in one region.** The API, workers, and Postgres talk over private
networking. A service moved to another region reaches its database across the Atlantic, or
not at all.

## Vercel

**`VITE_API_URL` is baked in at build time.** It is read by `packages/web/src/main.tsx`
during the Vite build, not at runtime. Changing it in project settings does nothing to the
deployed bundle until a redeploy.

**Renaming a project does not move the site.** Aliases only regenerate on the next
production deploy, so the old URL keeps serving and the new one 404s. When the canonical
URL does change, it must be added to `CORS_ORIGINS` on the API or every console request
fails. Team-scoped aliases (`<project>-<team>.vercel.app`) sit behind Vercel SSO and are
not publicly reachable; the public URL is the short `<project>.vercel.app`.

## Both platforms

**`@workspace/sdk` must be built before `@workspace/api` or `@workspace/web`.** Both
resolve it through `dist/`, so a build command that targets only the leaf package fails
with `TS2307: Cannot find module '@workspace/sdk'` plus a cascade of `unknown` and
implicit-`any` errors downstream. Those downstream errors are symptoms — fix the build
order, not the types.

**`packages/api` is ESM.** Relative imports need explicit `.js` extensions; `tsc` is set to
`NodeNext` so it rejects bare specifiers at compile time rather than emitting output that
builds cleanly and cannot start.
