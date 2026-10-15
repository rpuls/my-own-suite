import { useState } from 'react';

import { Icon, Notice, Panel, PanelBody, PanelHead } from '../../components/ui';

// Deliberately not behind Technical controls, and the one place in Suite Manager
// where that is the whole point. This exists for an owner who cannot describe
// what is wrong, which is exactly the owner who will never have found a
// technical toggle — gating it would hide the feature from its only user.
// Nothing here is technical to look at: one sentence, one button, one file.
//
// The copy names all three readers on purpose. An owner who can debug their own
// server is as likely to press this as one who cannot, and wording that assumed
// somebody was being asked for help read as strange to everyone else.
export function DiagnosticsPanel() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState('');

  async function create() {
    setCreating(true);
    setError('');
    setCreated('');
    try {
      const response = await fetch('/suite-manager/api/support/bundle');
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'The diagnostics file could not be created.');
      }
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] || 'mos-diagnostics.txt';
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = filename;
      link.href = href;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setCreated(filename);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The diagnostics file could not be created.');
    } finally {
      setCreating(false);
    }
  }

  return <Panel>
    <PanelHead actions={<button className="mos-btn mos-btn-primary" disabled={creating} onClick={() => void create()} type="button"><Icon name="download" />{creating ? 'Collecting...' : 'Create file'}</button>} heading="h3" title="Diagnostics file">
      <p>One file with what is running, what failed recently, and why. Read it yourself, send it to someone helping you, or give it to an AI assistant. Passwords and app secrets are removed before the file is written.</p>
    </PanelHead>
    {error || created ? <PanelBody>
      {error ? <Notice title="The file could not be created" variant="error"><p>{error}</p></Notice> : null}
      {created ? <Notice title="Saved to your downloads" variant="success"><p><strong>{created}</strong> is plain text, so you can open and read it yourself, pass it on, or paste it somewhere that can help.</p></Notice> : null}
    </PanelBody> : null}
  </Panel>;
}
