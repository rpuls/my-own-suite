const HOMEPAGE_IMAGE = 'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a';
const HOMEPAGE_PORT = 3200;

function renderCaddyfile() {
  return `http://$MOS_HOME_HOST {
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

function renderPublicCloudCaddyfile() {
  return `http://$MOS_HOME_HOST {
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
}

https://$MOS_HOME_HOST {
  reverse_proxy 127.0.0.1:$MOS_SUITE_MANAGER_PORT
}

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

function renderHttpsCaddyfile({ acmeEmail, baseDomain, bootstrapHost, suiteManagerPort = '$MOS_SUITE_MANAGER_PORT' }) {
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

import /etc/caddy/mos-homepage-routes.caddy
import /etc/caddy/mos-app-routes.caddy
`;
}

function renderHomepageSystemdUnit({
  homeHost = '$MOS_HOME_HOST',
  homepagePort = HOMEPAGE_PORT,
  stateRoot = '$MOS_STATE_ROOT',
} = {}) {
  return `[Unit]
Description=MOS Homepage dashboard
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=3
ExecStartPre=-/usr/bin/docker rm -f mos-homepage
ExecStart=/usr/bin/docker run --rm --name mos-homepage --publish 127.0.0.1:${homepagePort}:3000 --env HOMEPAGE_ALLOWED_HOSTS=${homeHost} --volume ${stateRoot}/homepage/config:/app/config --volume ${stateRoot}/homepage/config/images:/app/public/images ${HOMEPAGE_IMAGE}
ExecStop=/usr/bin/docker stop -t 10 mos-homepage

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
  renderPublicCloudCaddyfile,
};
