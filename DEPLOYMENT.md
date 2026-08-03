# Deployment — PM Synapse

## Docker (recommended)

### 1. Environment

```bash
cp .env.docker.example .env.docker
# Edit JWT_SECRET, DB_PASSWORD, SSO_CLIENT_SECRET, PM_BASE_URL, NEXT_PUBLIC_*
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

On **Project Management**, allow the Synapse SSO callback, e.g.:

```env
ALLOWED_SSO_REDIRECTS=http://localhost:3010/api/auth/sso/callback
SSO_CLIENT_ID=pm-synapse
SSO_CLIENT_SECRET=<same as Synapse SSO_CLIENT_SECRET>
```

### 2. Build & push image

From this folder (`pm-synapse/`):

```bash
# Linux if docker group is not active in this shell:
sg docker -c "./docker-build.sh"

# Or with an explicit version tag:
sg docker -c "./docker-build.sh 0.1.0"
```

Set `DOCKER_USERNAME` or the script will prompt. Image: `$DOCKER_USERNAME/pm-synapse`.

### 3. Run with Compose

```bash
export DOCKER_USERNAME=youruser   # must match the image you pushed
docker compose up -d
```

Services:

| Service | Port (host) | Notes |
|---------|-------------|--------|
| `app` | `3010` | Synapse (Next + Express) |
| `mysql` | `3307` → 3306 | Synapse DB (avoids clash with PM on 3306) |

```bash
curl -s http://localhost:3010/health
docker compose logs -f app
docker compose down
```

Uploads persist in the `synapse-uploads` volume; MySQL in `synapse-mysql-data`.

### 4. Run without Compose MySQL

Point `.env.docker` at an existing MySQL (e.g. host / PM stack):

```env
DB_HOST=host.docker.internal   # or the PM mysql container network name
DB_PORT=3306
```

Then start only the app (and remove/adjust `depends_on` as needed), or:

```bash
docker run -d --name pm-synapse \
  -p 3010:3010 \
  --env-file .env.docker \
  -v synapse-uploads:/app/data/uploads \
  youruser/pm-synapse:latest
```

### 5. Local image only (no push)

```bash
docker build -t pm-synapse:local .
docker run -d -p 3010:3010 --env-file .env.docker pm-synapse:local
```

## Production Node (without Docker)

```bash
pnpm install --frozen-lockfile
pnpm run build
NODE_ENV=production node dist/server/index.js
```

For Word export of Mermaid diagrams, install **librsvg** so `rsvg-convert` is on `PATH`
(e.g. Arch/`pacman -S librsvg`, Debian/`apt install librsvg2-bin`). The Docker image already
includes it.

Schema tables are created/updated on startup via `ensureSchema()`.

## Checklist

- [ ] `JWT_SECRET` set (64+ chars)
- [ ] `SSO_CLIENT_SECRET` matches PM
- [ ] `PM_BASE_URL` reachable from the Synapse container
- [ ] `NEXT_PUBLIC_APP_URL` is the browser URL for Synapse
- [ ] PM `ALLOWED_SSO_REDIRECTS` includes `{NEXT_PUBLIC_APP_URL}/api/auth/sso/callback`
- [ ] `/health` returns `healthy`
