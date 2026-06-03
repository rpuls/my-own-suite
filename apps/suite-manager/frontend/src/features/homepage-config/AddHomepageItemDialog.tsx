import { Box, Globe2, Home, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Dialog, Notice, SelectField, TextAreaField, TextField } from '../../components/ui';
import { withSetupPath } from '../../lib/base-path';
import type {
  HomepageExternalServicesResponse,
  HomepageExternalServicesSaveResponse,
} from './types';

type AddChoice = 'catalog' | 'link' | 'network';

type FormState = {
  description: string;
  group: string;
  icon: string;
  publicUrl: string;
  subdomain: string;
  title: string;
  upstream: string;
};

type AddHomepageItemDialogProps = {
  onClose: () => void;
  onSaved: (message: string | null) => void;
};

type ChoiceOption = {
  description: string;
  disabled?: boolean;
  icon: typeof Box;
  id: AddChoice;
  title: string;
};

const EMPTY_FORM: FormState = {
  description: '',
  group: 'My External Services',
  icon: '',
  publicUrl: '',
  subdomain: '',
  title: '',
  upstream: '',
};

const HOMEPAGE_ICON_DOCS_URL = 'https://gethomepage.dev/configs/services/#icons';

const CHOICES: ChoiceOption[] = [
  {
    description: 'Install and manage a curated app from My Own Suite. This flow is not available yet.',
    disabled: true,
    icon: Box,
    id: 'catalog',
    title: 'App from MOS catalog',
  },
  {
    description: 'Add something already running on your home network, like Home Assistant.',
    icon: Home,
    id: 'network',
    title: 'Self-hosted LAN app',
  },
  {
    description: 'Add a normal website, bookmark, or shortcut tile.',
    icon: Globe2,
    id: 'link',
    title: 'Generic link / shortcut tile',
  },
];

async function readJson<T extends object>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({ error: fallback }))) as T | { error?: string };
  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : fallback);
  }
  return body as T;
}

async function loadExternalServicesMeta(): Promise<HomepageExternalServicesResponse> {
  const response = await fetch(withSetupPath('/api/homepage-config/external-services'));
  return readJson<HomepageExternalServicesResponse>(response, 'Unable to load Homepage sections.');
}

function normalizeSubdomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function buildStackUrl(urlScheme: string, subdomain: string, domain: string): string {
  const normalizedSubdomain = normalizeSubdomain(subdomain);
  if (!normalizedSubdomain || !domain.trim()) {
    return '';
  }

  return `${urlScheme || 'http'}://${normalizedSubdomain}.${domain.trim()}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validateForm(choice: AddChoice, form: FormState, defaultDomain: string, defaultUrlScheme: string): string | null {
  if (!form.title.trim()) {
    return 'Title is required.';
  }

  if (choice === 'link' && !isHttpUrl(form.publicUrl)) {
    return 'URL must be a full http or https address.';
  }

  if (choice === 'network') {
    const generatedUrl = buildStackUrl(defaultUrlScheme, form.subdomain, defaultDomain);
    if (!generatedUrl || !isHttpUrl(generatedUrl)) {
      return `Subdomain must create a valid URL under ${defaultDomain}.`;
    }

    if (!isHttpUrl(form.upstream)) {
      return 'Address on your network must be a full http or https address.';
    }
  }

  return null;
}

async function saveItem(
  choice: AddChoice,
  form: FormState,
  defaultDomain: string,
  defaultUrlScheme: string,
): Promise<HomepageExternalServicesSaveResponse> {
  const href = choice === 'network' ? buildStackUrl(defaultUrlScheme, form.subdomain, defaultDomain) : form.publicUrl;
  const response = await fetch(withSetupPath('/api/homepage-config/external-services'), {
    body: JSON.stringify({
      description: form.description,
      group: form.group,
      href,
      icon: form.icon,
      proxyEnabled: choice === 'network',
      title: form.title,
      upstream: form.upstream,
      upstreamTlsInsecureSkipVerify: false,
    }),
    headers: {
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  return readJson<HomepageExternalServicesSaveResponse>(response, 'Unable to add item.');
}

function resultMessage(result: HomepageExternalServicesSaveResponse): string | null {
  const messages = [];
  if (result.homepageRestarted) {
    messages.push('Homepage is refreshing.');
  }
  if (result.externalLinksUpdated) {
    messages.push('Links were updated.');
  }
  if (result.warning) {
    messages.push(result.warning);
  }

  return messages.length > 0 ? messages.join(' ') : 'Added to Homepage config.';
}

function exampleDefaults(choice: AddChoice | null): Partial<FormState> {
  if (choice === 'network') {
    return {
      description: '',
      icon: 'home-assistant',
      subdomain: 'homeassistant',
      title: '',
      upstream: '',
    };
  }

  if (choice === 'link') {
    return {
      description: '',
      icon: 'firefox',
      publicUrl: '',
      title: '',
    };
  }

  return {};
}

export default function AddHomepageItemDialog({ onClose, onSaved }: AddHomepageItemDialogProps) {
  const [choice, setChoice] = useState<AddChoice | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [groups, setGroups] = useState<string[]>(['My External Services']);
  const [defaultDomain, setDefaultDomain] = useState('mos.home');
  const [defaultUrlScheme, setDefaultUrlScheme] = useState('http');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const placementGroups = useMemo(
    () => Array.from(new Set(groups.length > 0 ? groups : ['My External Services'])).filter(Boolean),
    [groups],
  );
  const generatedLanUrl = buildStackUrl(defaultUrlScheme, form.subdomain, defaultDomain);
  const canSave = choice === 'link' || choice === 'network';

  function choose(nextChoice: AddChoice): void {
    const option = CHOICES.find((candidate) => candidate.id === nextChoice);
    if (option?.disabled) {
      setChoice(nextChoice);
      return;
    }

    setChoice(nextChoice);
    setErrorMessage(null);
    setForm((current) => ({
      ...current,
      ...exampleDefaults(nextChoice),
    }));
  }

  async function save(): Promise<void> {
    if (!choice || choice === 'catalog') {
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      const validationMessage = validateForm(choice, form, defaultDomain, defaultUrlScheme);
      if (validationMessage) {
        setErrorMessage(validationMessage);
        return;
      }

      const result = await saveItem(choice, form, defaultDomain, defaultUrlScheme);
      onSaved(resultMessage(result));
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to add item.');
    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    void loadExternalServicesMeta()
      .then((result) => {
        setGroups(result.groups);
        setDefaultDomain(result.defaultDomain || 'mos.home');
        setDefaultUrlScheme(result.defaultUrlScheme || 'http');
        if (result.groups.length > 0 && !result.groups.includes(EMPTY_FORM.group)) {
          setForm((current) => ({ ...current, group: result.groups[0] || EMPTY_FORM.group }));
        }
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load Homepage sections.');
      });
  }, []);

  return (
    <Dialog
      description="Start with what you want to add. The next fields change based on that choice."
      footer={
        <>
          <button className="suite-copy-button" disabled={isSaving} onClick={onClose} type="button">
            <X aria-hidden="true" className="suite-inline-icon" />
            Cancel
          </button>
          {canSave ? (
            <button className="suite-copy-button" disabled={isSaving} onClick={() => void save()} type="button">
              <Save aria-hidden="true" className="suite-inline-icon" />
              {isSaving ? 'Adding...' : 'Add'}
            </button>
          ) : null}
        </>
      }
      onClose={onClose}
      title="Add to Homepage"
    >
      <section className="suite-decision-step" aria-labelledby="add-homepage-question">
        <h3 id="add-homepage-question">What do you want to add?</h3>
        <div className="suite-choice-grid" role="group" aria-label="Item type">
          {CHOICES.map((option) => {
            const Icon = option.icon;
            return (
              <button
                aria-pressed={choice === option.id}
                disabled={option.disabled}
                className={`suite-choice-card ${choice === option.id ? 'is-selected' : ''}`}
                key={option.id}
                onClick={() => choose(option.id)}
                type="button"
              >
                <Icon aria-hidden="true" className="suite-choice-icon" />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {errorMessage ? (
        <Notice title="Could not add this" variant="error">
          <p>{errorMessage}</p>
        </Notice>
      ) : null}

      {choice === 'catalog' ? (
        <Notice title="Coming soon" variant="info">
          <p>The catalog flow will install and manage MOS apps later. For now, add a LAN app or a generic link.</p>
        </Notice>
      ) : null}

      {choice === 'link' ? (
        <>
          <div className="suite-form-grid">
            <TextField
              autoFocus
              label="Title"
              onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
              placeholder="Firefox"
              type="text"
              value={form.title}
            />
            <TextField
              label="URL"
              onChange={(event) => setForm({ ...form, publicUrl: event.currentTarget.value })}
              placeholder="https://www.mozilla.org/firefox/"
              type="url"
              value={form.publicUrl}
            />
            <SelectField
              label="Placement"
              onChange={(event) => setForm({ ...form, group: event.currentTarget.value })}
              value={form.group}
            >
              {placementGroups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </SelectField>
            <TextField
              helperText={
                <a className="suite-helper-link" href={HOMEPAGE_ICON_DOCS_URL} rel="noreferrer" target="_blank">
                  How Homepage icons work
                </a>
              }
              label="Icon"
              onChange={(event) => setForm({ ...form, icon: event.currentTarget.value })}
              placeholder="firefox"
              type="text"
              value={form.icon}
            />
            <TextAreaField
              helperText="Shown under the title on Homepage, so use a short reminder of why this shortcut is useful."
              label="Description"
              onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
              placeholder="Fast access to the Firefox browser download and project site."
              rows={3}
              value={form.description}
            />
          </div>
        </>
      ) : null}

      {choice === 'network' ? (
        <>
          <div className="suite-form-grid">
            <TextField
              autoFocus
              label="Title"
              onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
              placeholder="Home Assistant"
              type="text"
              value={form.title}
            />
            <TextField
              helperText={generatedLanUrl ? `Homepage URL: ${generatedLanUrl}` : `Will use ${defaultDomain}.`}
              label="Subdomain"
              onChange={(event) => setForm({ ...form, subdomain: normalizeSubdomain(event.currentTarget.value) })}
              placeholder="homeassistant"
              type="text"
              value={form.subdomain}
            />
            <TextField
              helperText="Where the app is reachable inside your LAN."
              label="Address on your network"
              onChange={(event) => setForm({ ...form, upstream: event.currentTarget.value })}
              placeholder="http://192.168.1.20:8123"
              type="url"
              value={form.upstream}
            />
            <SelectField
              label="Placement"
              onChange={(event) => setForm({ ...form, group: event.currentTarget.value })}
              value={form.group}
            >
              {placementGroups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </SelectField>
            <TextField
              helperText={
                <a className="suite-helper-link" href={HOMEPAGE_ICON_DOCS_URL} rel="noreferrer" target="_blank">
                  How Homepage icons work
                </a>
              }
              label="Icon"
              onChange={(event) => setForm({ ...form, icon: event.currentTarget.value })}
              placeholder="home-assistant"
              type="text"
              value={form.icon}
            />
            <TextAreaField
              helperText="Shown under the title on Homepage, so keep it short and recognizable."
              label="Description"
              onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
              placeholder="Control lights, automations, and smart-home devices from your own server."
              rows={3}
              value={form.description}
            />
          </div>
        </>
      ) : null}

      {choice === 'link' || choice === 'network' ? (
        <p className="suite-dialog-note">New items are added to the end of the selected section. Use the YAML editor if you want exact order.</p>
      ) : null}
    </Dialog>
  );
}
