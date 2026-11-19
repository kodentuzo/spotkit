# Changelog

All notable changes to spotkit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is 0.y.z, a breaking change raises the minor version and is listed under **Changed**
or **Removed** with migration steps.

## [Unreleased]

## [0.1.0] - 2026-11-19

### Added

- `spotkit()` and its `user(request)`: who a request comes from, from a bearer JWT, a session
  cookie or a session bearer token, checked against the user pool's JWKS and issuer.
  `verifyToken(token)` for a JWT on its own.
- `clientAddress(headers)`: the last `X-Forwarded-For` entry, as Spotcraft's Caddy sets it.
- `health(ready)`: a `Response` for `GET /health`.
