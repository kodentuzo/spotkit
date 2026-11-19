# spotkit

Small helpers for apps on [Spotcraft](https://spotcraft.dev), for any framework: who a request
comes from, the client's address, and a health answer. It uses only Web `Request`, `Response`
and `Headers`, and one dependency, [jose](https://github.com/panva/jose).

Everything here is in Spotcraft's
[app contract](https://github.com/kodentuzo/spotcraft/blob/main/docs/contracts.md), so an app
can also do it by hand, or run elsewhere with the same env.

```bash
npm install @kodentuzo/spotkit
```

## Who the user is

On Spotcraft, every app gets the instance's user pool at `AUTH_URL`
(`<PUBLIC_URL>/_spotcraft/auth`), with `AUTH_ISSUER` and `AUTH_JWKS_URL`. Locally,
`spotcraft dev` writes the same names to `.env`.

```ts
import { spotkit } from '@kodentuzo/spotkit'

const kit = spotkit() // reads AUTH_URL, AUTH_ISSUER and AUTH_JWKS_URL

export async function handle(request: Request) {
  const user = await kit.user(request) // { id, isAnonymous } or null
  if (!user) return new Response('Sign in first', { status: 401 })
  // user.id is auth.users.id: reference it from your tables with a foreign key.
}
```

`kit.user(request)` reads, in order:

1. **`Authorization: Bearer <JWT>`**: a token from the pool, checked as it is (signature against
   the JWKS, issuer, expiry).
2. **A session cookie**, or **`Authorization: Bearer <session token>`** from a client without
   cookies: the pool's `/token` turns it into a JWT, which is checked. The answer is kept until
   the token is about to expire (15 minutes), so the pool is asked once per session in that time.

It returns `null` when there's no session or the pool doesn't know it, and throws when the pool
fails, so a broken pool doesn't look like a signed-out visitor. `kit.verifyToken(jwt)` checks
one token on its own and returns `{ id, isAnonymous, expiresAt }`.

### Making guests

Guests are made in the browser, with Better Auth's client pointed at the pool, so the pool
limits new guests per visitor's address:

```ts
import { createAuthClient } from 'better-auth/client'
import { anonymousClient } from 'better-auth/client/plugins'

// On Spotcraft the pool is on the app's own domain; locally, use AUTH_URL from .env.
export const auth = createAuthClient({
  baseURL: new URL('/_spotcraft/auth', location.origin).href,
  plugins: [anonymousClient()],
})

await auth.signIn.anonymous()
```

The session cookie is first-party on the app's domain, so the next request to the app's server
carries it, and `kit.user(request)` finds the guest. Expo and other clients without the app's
domain use `https://auth.<apps domain>/main` with the bearer plugin; their origin must be in the
instance's `AUTH_TRUSTED_ORIGINS`.

### Your tables

```ts
import { pgSchema, pgTable, uuid } from 'drizzle-orm/pg-core'

export const users = pgSchema('auth').table('users', { id: uuid('id').primaryKey() })

export const workouts = pgTable('workouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
})
```

Deleting a user in the pool deletes their rows in every app. Spotcraft runs your migrations
from the image's `dev.spotcraft.migrate` label, so spotkit has no migration runner.

## Client address

```ts
import { clientAddress } from '@kodentuzo/spotkit'

clientAddress(request.headers) // the last X-Forwarded-For entry, or 'unknown'
```

Spotcraft's Caddy sets `X-Forwarded-For` to the address it resolved (the visitor's, from
Cloudflare behind a tunnel). Only trust it behind such a proxy.

## Health

```ts
import { health } from '@kodentuzo/spotkit'

// GET /health
return health(async () => (await db.query('select 1')).rowCount === 1)
```

200 when `ready` resolves true (or right away without it), 503 otherwise or if it throws, never
cached. Spotcraft waits for a 2xx from `/health` before moving traffic to a new version of an
image without a `HEALTHCHECK`.

## Developing

```bash
pnpm install
pnpm verify   # Biome, types, tests, build
```

Releases are `vX.Y.Z` tags on `main`; CI publishes to npm with provenance.

## License

[MIT](LICENSE)
