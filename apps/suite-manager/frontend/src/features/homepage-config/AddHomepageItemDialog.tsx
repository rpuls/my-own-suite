import { ArrowLeft, Box, Check, Globe2, Home, Pencil, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Dialog, Notice, SelectField, Stepper, TextAreaField, TextField } from '../../components/ui';
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
    description: 'Add Home Assistant, Pi-hole, or another app already running at home.',
    icon: Home,
    id: 'network',
    title: 'App on my home network',
  },
  {
    description: 'Add any website or shortcut that should show on Homepage.',
    icon: Globe2,
    id: 'link',
    title: 'Website or shortcut',
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

function subdomainFromTitle(title: string): string {
  return normalizeSubdomain(title);
}

function buildStackUrl(urlScheme: string, subdomain: string, domain: string): string {
  const normalizedSubdomain = normalizeSubdomain(subdomain);
  if (!normalizedSubdomain || !domain.trim()) {
    return '';
  }

  return `${urlScheme || 'http'}://${normalizedSubdomain}.${domain.trim()}`;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  return Boolean(parseHttpUrl(value));
}

function isOriginOnlyUrl(value: string): boolean {
  const parsed = parseHttpUrl(value);
  return Boolean(parsed && parsed.pathname === '/' && !parsed.search && !parsed.hash);
}

function validateForm(choice: AddChoice, form: FormState, defaultDomain: string, defaultUrlScheme: string): string | null {
  if (!form.title.trim()) {
    return 'Name is required.';
  }

  if (choice === 'link' && !isHttpUrl(form.publicUrl)) {
    return 'Enter the website address as a full link, like https://example.com.';
  }

  if (choice === 'network') {
    const generatedUrl = buildStackUrl(defaultUrlScheme, form.subdomain, defaultDomain);
    if (!generatedUrl || !isHttpUrl(generatedUrl)) {
      return `Choose a URL subdomain that works under ${defaultDomain}.`;
    }

    if (!isHttpUrl(form.upstream)) {
      return 'Enter the app address as a full link, like http://192.168.1.20:8123.';
    }

    if (!isOriginOnlyUrl(form.upstream)) {
      return 'Use the main app address only, without extra paths after it.';
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
      icon: '',
      subdomain: '',
      title: '',
      upstream: '',
    };
  }

  if (choice === 'link') {
    return {
      description: '',
      icon: '',
      publicUrl: '',
      title: '',
    };
  }

  return {};
}

export default function AddHomepageItemDialog({ onClose, onSaved }: AddHomepageItemDialogProps) {
  const [choice, setChoice] = useState<AddChoice | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [customSubdomain, setCustomSubdomain] = useState(false);
  const [editingSubdomain, setEditingSubdomain] = useState(false);
  const [groups, setGroups] = useState<string[]>(['My External Services']);
  const [defaultDomain, setDefaultDomain] = useState('mos.home');
  const [defaultUrlScheme, setDefaultUrlScheme] = useState('http');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const placementGroups = useMemo(
    () => Array.from(new Set(groups.length > 0 ? groups : ['My External Services'])).filter(Boolean),
    [groups],
  );
  const lanSubdomain = customSubdomain ? form.subdomain : subdomainFromTitle(form.title);
  const generatedLanUrl = buildStackUrl(defaultUrlScheme, lanSubdomain, defaultDomain);
  const canSave = choice === 'link' || choice === 'network';
  const selectedChoice = choice ? CHOICES.find((option) => option.id === choice) : null;
  const SelectedChoiceIcon = selectedChoice?.icon;
  const step = choice === 'link' || choice === 'network' ? 2 : 1;

  function choose(nextChoice: AddChoice): void {
    const option = CHOICES.find((candidate) => candidate.id === nextChoice);
    if (option?.disabled) {
      setChoice(nextChoice);
      return;
    }

    setChoice(nextChoice);
    setErrorMessage(null);
    setCustomSubdomain(false);
    setEditingSubdomain(false);
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
      const preparedForm = choice === 'network' ? { ...form, subdomain: lanSubdomain } : form;
      const validationMessage = validateForm(choice, preparedForm, defaultDomain, defaultUrlScheme);
      if (validationMessage) {
        setErrorMessage(validationMessage);
        return;
      }

      const result = await saveItem(choice, preparedForm, defaultDomain, defaultUrlScheme);
      onSaved(resultMessage(result));
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to add item.');
    } finally {
      setIsSaving(false);
    }
  }

  function goBack(): void {
    setChoice(null);
    setErrorMessage(null);
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
      footer={
        <>
          {step === 2 ? (
            <button className="suite-copy-button" disabled={isSaving} onClick={goBack} type="button">
              <ArrowLeft aria-hidden="true" className="suite-inline-icon" />
              Back
            </button>
          ) : null}
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
      <Stepper
        canNavigateToStep={(stepIndex) => stepIndex < step - 1}
        currentStepIndex={step - 1}
        onStepClick={(stepIndex) => {
          if (stepIndex === 0) {
            goBack();
          }
        }}
        steps={['Type', 'Details']}
      />

      {step === 1 ? (
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
      ) : null}

      {errorMessage ? (
        <Notice title="Could not add this" variant="error">
          <p>{errorMessage}</p>
        </Notice>
      ) : null}

      {choice === 'catalog' ? (
        <Notice title="Coming soon" variant="info">
          <p>The catalog flow will install and manage MOS apps later. For now, add a home network app or a website.</p>
        </Notice>
      ) : null}

      {selectedChoice && SelectedChoiceIcon && step === 2 ? (
        <div className="suite-selected-choice">
          <SelectedChoiceIcon aria-hidden="true" className="suite-inline-icon" />
          <span>{selectedChoice.title}</span>
        </div>
      ) : null}

      {choice === 'link' ? (
        <>
          <div className="suite-form-grid">
            <TextField
              autoFocus
              label="Name"
              onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
              placeholder="Firefox"
              type="text"
              value={form.title}
            />
            <TextField
              label="Website address"
              onChange={(event) => setForm({ ...form, publicUrl: event.currentTarget.value })}
              placeholder="https://www.mozilla.org/firefox/"
              type="url"
              value={form.publicUrl}
            />
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
              helperText="Optional. A short note shown under the name."
              label="Description"
              onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
              placeholder="Fast access to the Firefox browser download and project site."
              rows={3}
              value={form.description}
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
          </div>
        </>
      ) : null}

      {choice === 'network' ? (
        <>
          <div className="suite-form-grid">
            <TextField
              autoFocus
              helperText="Use the name you already use for this app."
              label="Name"
              onChange={(event) => {
                const nextTitle = event.currentTarget.value;
                setForm((current) => ({ ...current, title: nextTitle }));
              }}
              placeholder="Home Assistant"
              type="text"
              value={form.title}
            />
            <TextField
              helperText="The address you already use at home."
              label="App address"
              onChange={(event) => setForm({ ...form, upstream: event.currentTarget.value })}
              placeholder="http://192.168.1.20:8123"
              type="url"
              value={form.upstream}
            />
          </div>
          <div className={`suite-homepage-address-preview ${generatedLanUrl ? '' : 'is-empty'}`}>
            <span className="suite-field-label">App URL</span>
            {editingSubdomain ? (
              <span className="suite-inline-url-editor">
                <span>{defaultUrlScheme || 'http'}://</span>
                <input
                  aria-label="URL subdomain"
                  className="suite-inline-url-input"
                  onChange={(event) => setForm({ ...form, subdomain: normalizeSubdomain(event.currentTarget.value) })}
                  placeholder={subdomainFromTitle(form.title) || 'home-assistant'}
                  type="text"
                  value={form.subdomain}
                />
                <span>.{defaultDomain}</span>
              </span>
            ) : (
              <strong>{generatedLanUrl || 'Add a name to preview the URL'}</strong>
            )}
            {editingSubdomain ? (
              <>
                <button className="suite-subtle-button" onClick={() => setEditingSubdomain(false)} type="button">
                  <Check aria-hidden="true" className="suite-inline-icon" />
                  Done
                </button>
                <button
                  className="suite-subtle-button"
                  onClick={() => {
                    setCustomSubdomain(false);
                    setEditingSubdomain(false);
                    setForm({ ...form, subdomain: '' });
                  }}
                  type="button"
                >
                  <X aria-hidden="true" className="suite-inline-icon" />
                  Use name
                </button>
              </>
            ) : (
              <button
                className="suite-subtle-button"
                disabled={!generatedLanUrl}
                onClick={() => {
                  setForm({ ...form, subdomain: lanSubdomain });
                  setCustomSubdomain(true);
                  setEditingSubdomain(true);
                }}
                type="button"
              >
                <Pencil aria-hidden="true" className="suite-inline-icon" />
                Edit URL subdomain
              </button>
            )}
          </div>
          <div className="suite-form-grid">
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
              helperText="Optional. A short note shown under the name."
              label="Description"
              onChange={(event) => setForm({ ...form, description: event.currentTarget.value })}
              placeholder="Control lights, automations, and smart-home devices from your own server."
              rows={3}
              value={form.description}
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
          </div>
        </>
      ) : null}

      {choice === 'link' || choice === 'network' ? (
        <p className="suite-dialog-note">New items are added to the end of the selected section.</p>
      ) : null}
    </Dialog>
  );
}
