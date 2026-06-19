(() => {
  const toolbar = document.createElement('nav');
  toolbar.className = 'mos-dashboard-toolbar';
  toolbar.setAttribute('aria-label', 'MOS account controls');

  const suiteManagerUrl = new URL(window.location.href);
  suiteManagerUrl.hostname = suiteManagerUrl.hostname.replace(/^home\./, 'suite-manager.');
  suiteManagerUrl.pathname = '/';
  suiteManagerUrl.search = '';
  suiteManagerUrl.hash = '';

  const manageLink = document.createElement('a');
  manageLink.href = suiteManagerUrl.toString();
  manageLink.textContent = 'Suite Manager';

  const logoutButton = document.createElement('button');
  logoutButton.type = 'button';
  logoutButton.textContent = 'Sign out';
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/setup/');
    }
  });

  toolbar.append(manageLink, logoutButton);
  document.body.append(toolbar);
})();
