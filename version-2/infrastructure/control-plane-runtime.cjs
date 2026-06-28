const HOMEPAGE_IMAGE = 'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a';
const HOMEPAGE_PORT = 3200;

function renderCaddyfile() {
  return `http://$MOS_V2_HOME_HOST {
  reverse_proxy 127.0.0.1:$MOS_V2_SUITE_MANAGER_PORT
}

import /etc/caddy/mos-v2-homepage-routes.caddy
import /etc/caddy/mos-v2-app-routes.caddy
`;
}

function renderHttpsCaddyfile({ acmeEmail, baseDomain, bootstrapHost, suiteManagerPort = '$MOS_V2_SUITE_MANAGER_PORT' }) {
  const homeHost = `home.${baseDomain}`;
  return `{
  email ${acmeEmail}
  acme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}

http://${bootstrapHost} {
  reverse_proxy 127.0.0.1:${suiteManagerPort}
}

http://${homeHost} {
  redir https://${homeHost}{uri} permanent
}

https://${homeHost} {
  reverse_proxy 127.0.0.1:${suiteManagerPort}
}

import /etc/caddy/mos-v2-homepage-routes.caddy
import /etc/caddy/mos-v2-app-routes.caddy
`;
}

function renderHomepageSystemdUnit() {
  return `[Unit]
Description=MOS V2 Homepage dashboard
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f mos-v2-homepage
ExecStart=/usr/bin/docker run --rm --name mos-v2-homepage --publish 127.0.0.1:${HOMEPAGE_PORT}:3000 --env HOMEPAGE_ALLOWED_HOSTS=$MOS_V2_HOME_HOST --volume $MOS_V2_STATE_ROOT/homepage/config:/app/config --volume $MOS_V2_STATE_ROOT/homepage/config/images:/app/public/images ${HOMEPAGE_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 mos-v2-homepage

[Install]
WantedBy=multi-user.target
`;
}

module.exports = {
  HOMEPAGE_IMAGE,
  HOMEPAGE_PORT,
  renderCaddyfile,
  renderHttpsCaddyfile,
  renderHomepageSystemdUnit,
};
