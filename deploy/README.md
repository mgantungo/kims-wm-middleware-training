# Deploying on Debian 12 behind Apache

Two independent deployments of the same codebase run side by side on one
host: **training** (`kims-wm.training.klanlogistics.com:6443`) and
**production** (`kims-wm.prod.klanlogistics.com:7443`). Each is its own
Node process, its own `.env`, its own port, and its own Apache vhost —
nothing is shared between them except the code.

```
Internet ──HTTPS:6443──▶ Apache (mod_ssl, training vhost) ──HTTP:3001──▶ Node (KIMS_ENV=training)
Internet ──HTTPS:7443──▶ Apache (mod_ssl, production vhost) ──HTTP:3002──▶ Node (KIMS_ENV=production)
```

Apache terminates TLS and reverse-proxies to Node listening on
`127.0.0.1` only (see `server.js` — it never binds `0.0.0.0`), so Node is
never directly reachable from outside the host.

## 1. Install Node and Apache modules

```bash
# Node 18+ (adjust to your preferred install method — nodesource, nvm, etc.)
sudo apt update
sudo apt install -y nodejs npm apache2

sudo a2enmod ssl proxy proxy_http headers rewrite
sudo systemctl restart apache2
```

## 2. Deploy the code (twice — once per environment)

```bash
sudo mkdir -p /opt/kims-wm-middleware-training /opt/kims-wm-middleware-prod

# Copy/clone the repo into both, then in each:
cd /opt/kims-wm-middleware-training
npm ci --omit=dev
cp .env.example .env
# edit .env: KIMS_ENV=training, PORT=3001, DATA_SOURCE=demo, JWT_SECRET=<unique random value>
npm run seed:users

cd /opt/kims-wm-middleware-prod
npm ci --omit=dev
cp .env.example .env
# edit .env: KIMS_ENV=production, PORT=3002, DATA_SOURCE=demo, JWT_SECRET=<different unique random value>
npm run seed:users
```

Generate each `JWT_SECRET` with `openssl rand -base64 48` — use a
**different** secret per environment so a training token can never be
replayed against production.

## 3. systemd services

`/etc/systemd/system/kims-wm-training.service`:
```ini
[Unit]
Description=KIMS-WM Middleware (training)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/kims-wm-middleware-training
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/kims-wm-middleware-training/.env

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/kims-wm-prod.service` — identical, pointed at
`/opt/kims-wm-middleware-prod`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kims-wm-training kims-wm-prod
sudo systemctl status kims-wm-training kims-wm-prod
```

## 4. Apache vhosts

`/etc/apache2/sites-available/kims-wm-training.conf`:
```apache
<VirtualHost *:6443>
    ServerName kims-wm.training.klanlogistics.com

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/kims-wm.training.klanlogistics.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/kims-wm.training.klanlogistics.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    RequestHeader set X-Forwarded-Proto "https"

    ErrorLog  ${APACHE_LOG_DIR}/kims-wm-training-error.log
    CustomLog ${APACHE_LOG_DIR}/kims-wm-training-access.log combined
</VirtualHost>
```

`/etc/apache2/sites-available/kims-wm-prod.conf` — same shape, on `*:7443`,
`ServerName kims-wm.prod.klanlogistics.com`, proxying to `127.0.0.1:3002`,
with its own certificate paths.

Apache needs to actually listen on 6443 and 7443 — add to
`/etc/apache2/ports.conf`:
```apache
Listen 6443
Listen 7443
```

Then enable both sites:
```bash
sudo a2ensite kims-wm-training kims-wm-prod
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## 5. TLS certificates

If using Let's Encrypt via certbot, the Apache plugin handles this
automatically once the vhost above exists on port 443 or via DNS-01
challenge for non-standard ports like 6443/7443 (HTTP-01 challenge needs
port 80/443, so for non-standard ports use `certbot certonly --dns-<provider>`
or issue via your existing internal CA if Klan Logistics has one).

## 6. Point the Flutter app at these URLs

This middleware's routes are unprefixed (`/auth/login`, `/put-away/documents`,
etc.), matching `ApiEndpoints` in the Flutter app exactly. Build with the
base URL pointing straight at the host — no `/api/v1` suffix, since nothing
here is mounted under that prefix:

```bash
flutter build apk \
  --dart-define=API_BASE_URL_LIVE=https://kims-wm.prod.klanlogistics.com:7443 \
  --dart-define=API_BASE_URL_TRAINING=https://kims-wm.training.klanlogistics.com:6443
```

If you'd rather version the API explicitly, mount the whole router tree in
`app.js` under `/api/v1` and add that suffix to both dart-define values —
either approach works, just keep the two sides in sync.

## 7. Smoke test

```bash
curl -k https://kims-wm.training.klanlogistics.com:6443/health
curl -k -X POST https://kims-wm.training.klanlogistics.com:6443/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"wh-jdoe","password":"changeme123"}'
```

The login response's `token` can then be used as a Bearer token against
any other endpoint to confirm the full path works before pointing the app
at it.
