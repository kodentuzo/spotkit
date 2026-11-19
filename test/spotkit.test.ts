import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { clientAddress, health, SpotkitError, spotkit } from '../src/index.ts'

const ISSUER = 'https://dash.example.test/pools/main'
const AUTH_URL = 'https://lifts.example.test/_spotcraft/auth'
const USER = '8a22a41f-636c-4249-99b7-95aafff1346e'

const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA' }],
})
const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' })

/** A token as the pool signs one. */
function token(
  claims: Record<string, unknown> = {},
  { key = privateKey, issuer = ISSUER, ttl = '15m' } = {},
) {
  return new SignJWT({ is_anonymous: true, ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject(USER)
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key)
}

/** The pool's `/token`: a JWT for a known session, 401 otherwise; counts its calls. */
function fakePool(sessions: Record<string, string>) {
  const calls: Headers[] = []
  const pool: typeof fetch = async (input, init) => {
    assert.equal(String(input), `${AUTH_URL}/token`)
    const headers = new Headers(init?.headers)
    calls.push(headers)
    const session = headers.get('cookie') ?? headers.get('authorization') ?? ''
    const jwt = sessions[session]
    return jwt
      ? Response.json({ token: jwt })
      : Response.json({ message: 'Unauthorized' }, { status: 401 })
  }
  return { pool, calls }
}

const request = (headers: Record<string, string>) =>
  new Request('https://lifts.example.test/', { headers })

describe('the user', () => {
  it('comes from a JWT sent as a bearer token, checked as it is', async () => {
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: fakePool({}).pool })
    const jwt = await token()
    assert.deepEqual(await kit.user(request({ authorization: `Bearer ${jwt}` })), {
      id: USER,
      isAnonymous: true,
    })
  })

  it('is null for a token signed by another key, from another issuer, or expired', async () => {
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: fakePool({}).pool })
    for (const jwt of [
      await token({}, { key: other.privateKey }),
      await token({}, { issuer: 'https://evil.example.test' }),
      await token({}, { ttl: '-1m' }),
    ]) {
      assert.equal(await kit.user(request({ authorization: `Bearer ${jwt}` })), null)
    }
  })

  it('comes from a session cookie through the pool, which is asked once per session', async () => {
    const cookie = 'better-auth.session_token=abc.def'
    const { pool, calls } = fakePool({ [cookie]: await token({ is_anonymous: false }) })
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: pool })
    const expected = { id: USER, isAnonymous: false }
    assert.deepEqual(await kit.user(request({ cookie })), expected)
    assert.deepEqual(await kit.user(request({ cookie })), expected)
    assert.equal(calls.length, 1, 'kept until the token expires')
    assert.equal(calls[0].get('cookie'), cookie, 'only the cookie is passed on')
  })

  it('comes from a session token sent as a bearer token (clients without cookies)', async () => {
    const { pool, calls } = fakePool({ 'Bearer session-token': await token() })
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: pool })
    assert.equal((await kit.user(request({ authorization: 'Bearer session-token' })))?.id, USER)
    assert.equal(calls[0].get('authorization'), 'Bearer session-token')
  })

  it('is null without a session, or with one the pool does not know', async () => {
    const { pool, calls } = fakePool({})
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: pool })
    assert.equal(await kit.user(request({})), null)
    assert.equal(calls.length, 0, 'the pool is not asked without a session')
    assert.equal(await kit.user(request({ cookie: 'better-auth.session_token=gone' })), null)
  })

  it('throws when the pool fails, rather than treating the visitor as signed out', async () => {
    const failing: typeof fetch = async () => new Response('down', { status: 502 })
    const kit = spotkit({ authUrl: AUTH_URL, issuer: ISSUER, keys, fetch: failing })
    await assert.rejects(kit.user(request({ cookie: 'x=y' })), /answered 502/)
  })

  it('reads its settings from the env Spotcraft sets, naming what is missing', () => {
    const env = {
      AUTH_URL,
      AUTH_ISSUER: ISSUER,
      AUTH_JWKS_URL: `${AUTH_URL}/jwks`,
    }
    assert.doesNotThrow(() => spotkit({}, env))
    assert.throws(() => spotkit({}, { ...env, AUTH_URL: '' }), SpotkitError)
    assert.throws(() => spotkit({}, { ...env, AUTH_ISSUER: undefined }), /AUTH_ISSUER is not set/)
    assert.throws(
      () => spotkit({}, { ...env, AUTH_JWKS_URL: 'nope' }),
      /AUTH_JWKS_URL must be a URL/,
    )
  })
})

describe('client address and health', () => {
  it('takes the last X-Forwarded-For entry', () => {
    assert.equal(
      clientAddress(new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })),
      '203.0.113.9',
    )
    assert.equal(clientAddress(new Headers()), 'unknown')
  })

  it('answers 200 when ready and 503 when not, never cached', async () => {
    assert.equal((await health()).status, 200)
    assert.equal((await health(async () => false)).status, 503)
    const failing = await health(async () => {
      throw new Error('db down')
    })
    assert.equal(failing.status, 503)
    assert.equal(failing.headers.get('cache-control'), 'no-store')
  })
})
