import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/**
 * spotkit: small helpers for apps on Spotcraft that work with any framework. Everything it does
 * is in Spotcraft's app contract (docs/contracts.md), so an app can also do it by hand.
 */

/** A user of the instance's pool, from a verified token. */
export interface User {
  /** The user's id: the token's `sub`, the same as `auth.users.id`. */
  id: string
  /** A guest: a visitor who hasn't signed up. */
  isAnonymous: boolean
}

export interface SpotkitOptions {
  /** The pool, `AUTH_URL`: on Spotcraft, `<PUBLIC_URL>/_spotcraft/auth`. */
  authUrl?: string
  /** Every token's `iss`, `AUTH_ISSUER`. */
  issuer?: string
  /** The pool's public keys, `AUTH_JWKS_URL`. */
  jwksUrl?: string
  /** Keys to verify with, instead of fetching `jwksUrl` (tests, a key you hold). */
  keys?: JWTVerifyGetKey
  /** For the call to the pool's `/token`; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** Settings that are missing or not what spotkit needs. */
export class SpotkitError extends Error {}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** Sessions' tokens, kept until they expire (15 minutes on Spotcraft) to spare the pool. */
const MAX_CACHED = 1000

function setting(value: string | undefined, name: string): string {
  if (!value) throw new SpotkitError(`${name} is not set`)
  if (!URL.canParse(value)) throw new SpotkitError(`${name} must be a URL`)
  return value
}

/**
 * The user pool, as seen from the app's server. Settings come from `options`, else from the env
 * Spotcraft sets (`AUTH_URL`, `AUTH_ISSUER`, `AUTH_JWKS_URL`).
 */
export function spotkit(options: SpotkitOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  const authUrl = setting(options.authUrl ?? env.AUTH_URL, 'AUTH_URL').replace(/\/$/, '')
  const issuer = setting(options.issuer ?? env.AUTH_ISSUER, 'AUTH_ISSUER')
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(setting(options.jwksUrl ?? env.AUTH_JWKS_URL, 'AUTH_JWKS_URL')))
  const call = options.fetch ?? fetch
  const cache = new Map<string, { user: User; until: number }>()

  /**
   * The user a JWT from the pool names. Throws if its signature, issuer or expiry is wrong, or
   * if it lacks the contract's claims.
   */
  async function verifyToken(token: string): Promise<User & { expiresAt: number }> {
    const { payload } = await jwtVerify(token, keys, { issuer })
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
      throw new SpotkitError('The token has no subject or expiry')
    }
    return {
      id: payload.sub,
      isAnonymous: payload.is_anonymous === true,
      expiresAt: payload.exp * 1000,
    }
  }

  /**
   * The user the request comes from, or null:
   * - `Authorization: Bearer <JWT>`: the token is checked as it is;
   * - a session cookie, or `Authorization: Bearer <session token>` (a client without cookies):
   *   the pool's `/token` turns it into a JWT, which is checked. Kept until it expires.
   */
  async function user(request: Request): Promise<User | null> {
    const authorization = request.headers.get('authorization') ?? ''
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1]
    if (bearer && JWT.test(bearer)) {
      try {
        const { id, isAnonymous } = await verifyToken(bearer)
        return { id, isAnonymous }
      } catch {
        return null
      }
    }
    const cookie = request.headers.get('cookie') ?? ''
    if (!bearer && !cookie) return null

    const key = bearer ? `bearer:${bearer}` : `cookie:${cookie}`
    const cached = cache.get(key)
    if (cached && cached.until > Date.now()) return cached.user

    const headers = new Headers(bearer ? { authorization } : { cookie })
    const response = await call(`${authUrl}/token`, { headers })
    if (response.status === 401) return null
    if (!response.ok) throw new SpotkitError(`The user pool answered ${response.status}`)
    const { token } = (await response.json()) as { token?: string }
    if (!token) return null
    let verified: User & { expiresAt: number }
    try {
      verified = await verifyToken(token)
    } catch {
      return null
    }
    const found = { id: verified.id, isAnonymous: verified.isAnonymous }
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
    // A little before the token's own expiry, so a cached user is never past it.
    cache.set(key, { user: found, until: verified.expiresAt - 30_000 })
    return found
  }

  return { user, verifyToken }
}

/**
 * The visitor's address: the last `X-Forwarded-For` entry, which Spotcraft's Caddy sets to the
 * address it resolved (Cloudflare's `CF-Connecting-IP` behind a tunnel). `unknown` without one.
 * Only trust it behind such a proxy.
 */
export function clientAddress(headers: Headers): string {
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.at(-1) ?? 'unknown'
}

/**
 * An answer for `GET /health`: 200 once `ready` resolves true (or right away without it), else
 * 503. Spotcraft waits for a 2xx before moving traffic to a new version.
 */
export async function health(ready?: () => Promise<boolean> | boolean): Promise<Response> {
  let ok = true
  try {
    ok = ready ? await ready() : true
  } catch {
    ok = false
  }
  return new Response(ok ? 'ok' : 'starting', {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  })
}
