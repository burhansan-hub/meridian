# Fork notes

This is a fork of [rynfar/meridian](https://github.com/rynfar/meridian), branched
from `meridian-v1.88.0`, so Meridian can run as an independently deployed,
multi-account container behind an API key. It follows the same pattern as the
`openai-api-server-via-codex` fork: an operator UI behind the key, an account
pool, and a pull-and-run compose file.

What the fork adds on top of upstream:

| Change | Where | Docs |
|---|---|---|
| Web UI sign-in: the API key is exchanged for an HttpOnly session cookie, so a keyed instance's UI is usable from a browser | `src/proxy/auth.ts`, `src/telemetry/uiLoginPage.ts` | [configuration](docs/configuration.md#web-ui-sign-in) |
| `balanced` routing: new conversations go to the account with the fewest requests in flight, then the lowest usage, then the one idle longest; affinity, cooldowns and failover come from upstream's priority pool | `src/proxy/routing.ts`, `src/proxy/server.ts` | [profiles](docs/profiles.md#balanced-routing) |
| Disable / enable / remove Claude profiles from the profiles page, the CLI and HTTP | `src/proxy/profileState.ts`, `src/telemetry/profilePage.ts` | [profiles](docs/profiles.md#disabling-a-profile) |
| `MERIDIAN_REQUIRE_PROFILE=1`: never substitute another account for a missing, unknown or disabled `x-meridian-profile` (replaces SocialAgent's `meridian-strict-profiles.patch`) | `src/proxy/profiles.ts` | [profiles](docs/profiles.md#requiring-an-explicit-profile) |
| `docker-compose.deploy.yml` and volume paths pre-created in the image | `docker-compose.deploy.yml`, `Dockerfile` | [deployment](docs/deployment.md#deploying-a-published-image) |

Upstream already had, and the fork relies on: browser and pasted-code Claude
sign-in from `/profiles`, the priority failover pool with per-account cooldowns,
the weekly reserve, duplicate-account detection, `MERIDIAN_API_KEY`, and the
Dockerfile.

## Remotes

```bash
git remote -v      # upstream = github.com/rynfar/meridian
git fetch upstream --tags
git merge meridian-v<next>    # resolve, then run the tests below
```

## Tests

The suite runs under Bun. Without Bun installed:

```bash
docker run --rm -v "$PWD":/app -v meridian-dev-nm:/app/node_modules \
  -v /path/to/machine-id:/etc/machine-id:ro -w /app oven/bun:1.3.11 \
  sh -c 'bun install --frozen-lockfile --ignore-scripts && bun run test'
```

`/etc/machine-id` must exist (`openssl rand -hex 16 > machine-id`): session
ownership refuses to start without one, as the Dockerfile notes.
