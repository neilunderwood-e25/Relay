import { useState } from 'react';
import {
  Add01Icon,
  Alert02Icon,
  Delete02Icon,
  Edit02Icon,
  Layers01Icon,
  Task01Icon
} from '@hugeicons/core-free-icons';
import type {
  AgentProfile,
  AgentProfileSaveRequest,
  OrchestrationStrategy,
  OrchestrationTemplate,
  OrchestrationTemplateSaveRequest,
  ProviderCapability,
  ProviderId
} from '../../../shared/contracts';
import { AgentAvatar } from './AgentAvatar';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Alert, AlertDescription } from './ui/alert';
import { Icon } from './ui/Icon';
import { Input } from './ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Tabs, TabsList, TabsTrigger } from './ui/Tabs';
import { Textarea } from './ui/textarea';
import { Tooltip } from './ui/app-tooltip';
import {
  providerIcon,
  providerLabel,
  providerModelLabel,
  providerModelOptions,
  providerReady,
  providerStatusLabel
} from '../providerUi';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';

const DEFAULT_MODEL_VALUE = '__cli_default__';

type DeleteTarget = { type: 'profile' | 'template'; id: string; name: string };

export function LibraryWorkspace({ profiles, templates, providers, onChange }: {
  profiles: AgentProfile[];
  templates: OrchestrationTemplate[];
  providers: ProviderCapability[];
  onChange: (profiles: AgentProfile[], templates: OrchestrationTemplate[]) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<'profiles' | 'templates'>('profiles');
  const [profileDraft, setProfileDraft] = useState<AgentProfileSaveRequest | null>(null);
  const [templateDraft, setTemplateDraft] = useState<OrchestrationTemplateSaveRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveProfile = async (): Promise<void> => {
    if (!profileDraft?.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await window.relay.saveAgentProfile(profileDraft);
      onChange(upsert(profiles, profile), templates);
      setProfileDraft(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async (): Promise<void> => {
    if (!templateDraft?.name.trim() || !templateDraft.objective.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const template = await window.relay.saveOrchestrationTemplate(templateDraft);
      onChange(profiles, upsert(templates, template));
      setTemplateDraft(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleProfile = async (profile: AgentProfile): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.relay.saveAgentProfile({ ...profile, enabled: !profile.enabled });
      onChange(upsert(profiles, updated), templates);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      const result = deleteTarget.type === 'profile'
        ? await window.relay.deleteAgentProfile({ id: deleteTarget.id })
        : await window.relay.deleteOrchestrationTemplate({ id: deleteTarget.id });
      if (!result.ok) throw new Error(result.error ?? 'Delete failed.');
      if (deleteTarget.type === 'profile') {
        onChange(
          profiles.filter(({ id }) => id !== deleteTarget.id),
          templates.map((template) => ({ ...template, profileIds: template.profileIds.filter((id) => id !== deleteTarget.id) }))
        );
      } else {
        onChange(profiles, templates.filter(({ id }) => id !== deleteTarget.id));
      }
      setDeleteTarget(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="operations-workspace library-workspace">
      <header className="dashboard-header operations-header">
        <div className="dashboard-title">
          <h1>Library</h1>
          <Badge variant="secondary">{tab === 'profiles' ? profiles.length : templates.length}</Badge>
        </div>
        <div className="library-header-actions">
          <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
            <TabsList aria-label="Library view">
              <TabsTrigger value="profiles">Agents</TabsTrigger>
              <TabsTrigger value="templates">Templates</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tooltip content={tab === 'profiles' ? 'New agent' : 'New template'}>
            <Button size="sm" onClick={() => tab === 'profiles'
              ? setProfileDraft(newProfile(providers))
              : setTemplateDraft(newTemplate())}
            >
              <Icon icon={Add01Icon} size={14} /> New
            </Button>
          </Tooltip>
        </div>
      </header>

      {error && <Alert variant="destructive"><Icon icon={Alert02Icon} size={15} /><AlertDescription>{error}</AlertDescription></Alert>}

      {tab === 'profiles' ? (
        <div className="library-grid">
          {profiles.map((profile) => (
            <Card key={profile.id} className={`library-card ${profile.enabled ? '' : 'disabled'}`}>
              <CardHeader className="library-card-header">
                <AgentAvatar seed={profile.avatarSeed} name={profile.name} className="library-avatar" />
                <div><strong>{profile.name}</strong><small>{profile.model ?? 'CLI default'}</small></div>
                <Badge variant={profile.enabled ? 'default' : 'secondary'}>{profile.enabled ? 'Ready' : 'Off'}</Badge>
              </CardHeader>
              <CardContent className="library-card-content">
                <span className={`library-provider ${profile.provider}`}>
                  <Icon icon={providerIcon(profile.provider)} size={14} />
                  {providerLabel(profile.provider)}
                </span>
                <p>{profile.instructions || 'General coding agent'}</p>
                <div className="library-card-actions">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleProfile(profile)}>{profile.enabled ? 'Disable' : 'Enable'}</Button>
                  <Tooltip content="Edit agent"><Button variant="ghost" size="icon" aria-label="Edit agent" onClick={() => setProfileDraft(profile)}><Icon icon={Edit02Icon} size={14} /></Button></Tooltip>
                  <Tooltip content="Delete agent"><Button variant="ghost" size="icon" className="danger-icon-button" aria-label="Delete agent" onClick={() => setDeleteTarget({ type: 'profile', id: profile.id, name: profile.name })}><Icon icon={Delete02Icon} size={14} /></Button></Tooltip>
                </div>
              </CardContent>
            </Card>
          ))}
          {profiles.length === 0 && <LibraryEmpty icon={Layers01Icon} label="No agents" onClick={() => setProfileDraft(newProfile(providers))} />}
        </div>
      ) : (
        <div className="library-grid">
          {templates.map((template) => (
            <Card key={template.id} className="library-card template-card">
              <CardHeader className="library-card-header">
                <span className="template-mark"><Icon icon={Task01Icon} size={16} /></span>
                <div><strong>{template.name}</strong><small>{strategyLabel(template.strategy)} · {template.concurrency} agents</small></div>
                <Badge variant="secondary">{template.profileIds.length}</Badge>
              </CardHeader>
              <CardContent className="library-card-content">
                <p>{template.objective}</p>
                <div className="template-agent-stack">
                  {template.profileIds.map((id) => {
                    const profile = profiles.find((candidate) => candidate.id === id);
                    return profile ? <AgentAvatar key={id} seed={profile.avatarSeed} name={profile.name} /> : null;
                  })}
                </div>
                <div className="library-card-actions">
                  <Tooltip content="Edit template"><Button variant="ghost" size="icon" aria-label="Edit template" onClick={() => setTemplateDraft(template)}><Icon icon={Edit02Icon} size={14} /></Button></Tooltip>
                  <Tooltip content="Delete template"><Button variant="ghost" size="icon" className="danger-icon-button" aria-label="Delete template" onClick={() => setDeleteTarget({ type: 'template', id: template.id, name: template.name })}><Icon icon={Delete02Icon} size={14} /></Button></Tooltip>
                </div>
              </CardContent>
            </Card>
          ))}
          {templates.length === 0 && <LibraryEmpty icon={Task01Icon} label="No templates" onClick={() => setTemplateDraft(newTemplate())} />}
        </div>
      )}

      <ProfileDialog draft={profileDraft} profiles={profiles} providers={providers} busy={busy} onChange={setProfileDraft} onSave={saveProfile} />
      <TemplateDialog draft={templateDraft} profiles={profiles} busy={busy} onChange={setTemplateDraft} onSave={saveTemplate} />
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
        <DialogContent className="confirm-dialog">
          <DialogHeader><DialogTitle>Delete {deleteTarget?.name}?</DialogTitle><DialogDescription>This removes the saved {deleteTarget?.type}.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Delete</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProfileDialog({ draft, profiles, providers, busy, onChange, onSave }: {
  draft: AgentProfileSaveRequest | null;
  profiles: AgentProfile[];
  providers: ProviderCapability[];
  busy: boolean;
  onChange: (draft: AgentProfileSaveRequest | null) => void;
  onSave: () => Promise<void>;
}): React.JSX.Element {
  if (!draft) return <></>;
  const seed = draft.avatarSeed || draft.id || `profile-preview-${profiles.length}`;
  const provider = draft.provider;
  const selectedCapability = providers.find(({ id }) => id === provider);
  const modelOptions = providerModelOptions(provider, selectedCapability);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onChange(null); }}>
      <DialogContent className="extension-dialog">
        <DialogHeader><DialogTitle>{draft.id ? 'Edit agent' : 'New agent'}</DialogTitle><DialogDescription>Reusable CLI profile</DialogDescription></DialogHeader>
        <div className="extension-form">
          <div className="profile-name-row"><AgentAvatar seed={seed} name={draft.name || 'Agent'} className="profile-dialog-avatar" /><Input aria-label="Agent name" placeholder="Agent name" value={draft.name} maxLength={32} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></div>
          <div className="extension-field-grid">
            <label><span>Engine</span><Select value={provider} onValueChange={(value) => onChange({ ...draft, provider: value as ProviderId, model: null })}><SelectTrigger aria-label="Agent engine"><SelectValue>{providerLabel(provider)}</SelectValue></SelectTrigger><SelectContent>{providers.map((candidate) => <SelectItem key={candidate.id} value={candidate.id} disabled={!providerReady(candidate)}><span className="provider-option"><span className={`provider-option-icon ${candidate.id}`}><Icon icon={providerIcon(candidate.id)} size={14} /></span><span>{providerLabel(candidate.id)}</span>{!providerReady(candidate) && <small>{providerStatusLabel(candidate)}</small>}</span></SelectItem>)}</SelectContent></Select></label>
            <label><span>Model</span><Select value={draft.model ?? DEFAULT_MODEL_VALUE} onValueChange={(value) => onChange({ ...draft, model: value === DEFAULT_MODEL_VALUE ? null : value })}><SelectTrigger aria-label="Agent model"><SelectValue>{providerModelLabel(provider, draft.model)}</SelectValue></SelectTrigger><SelectContent>{modelOptions.map((option) => <SelectItem key={option.id ?? DEFAULT_MODEL_VALUE} value={option.id ?? DEFAULT_MODEL_VALUE}>{option.label}</SelectItem>)}</SelectContent></Select></label>
          </div>
          <label className="extension-text-field"><span>Instructions</span><Textarea aria-label="Agent instructions" placeholder="Frontend specialist, test engineer…" value={draft.instructions ?? ''} maxLength={2_000} onChange={(event) => onChange({ ...draft, instructions: event.target.value })} /></label>
        </div>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => onChange(null)}>Cancel</Button><Button disabled={busy || !draft.name.trim()} onClick={() => void onSave()}>{busy ? 'Saving' : 'Save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateDialog({ draft, profiles, busy, onChange, onSave }: {
  draft: OrchestrationTemplateSaveRequest | null;
  profiles: AgentProfile[];
  busy: boolean;
  onChange: (draft: OrchestrationTemplateSaveRequest | null) => void;
  onSave: () => Promise<void>;
}): React.JSX.Element {
  if (!draft) return <></>;
  const selected = draft.profileIds ?? [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onChange(null); }}>
      <DialogContent className="extension-dialog template-dialog">
        <DialogHeader><DialogTitle>{draft.id ? 'Edit template' : 'New template'}</DialogTitle><DialogDescription>Reusable objective and team</DialogDescription></DialogHeader>
        <div className="extension-form">
          <Input aria-label="Template name" placeholder="Template name" value={draft.name} maxLength={32} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
          <label className="extension-text-field"><span>Objective</span><Textarea aria-label="Template objective" placeholder="What should the team deliver?" value={draft.objective} maxLength={2_000} onChange={(event) => onChange({ ...draft, objective: event.target.value })} /></label>
          <div className="extension-field-grid">
            <label><span>Mode</span><Select value={draft.strategy} onValueChange={(value) => onChange({ ...draft, strategy: value as OrchestrationStrategy })}><SelectTrigger aria-label="Template mode"><SelectValue>{strategyLabel(draft.strategy)}</SelectValue></SelectTrigger><SelectContent><SelectItem value="balanced">Build</SelectItem><SelectItem value="parallel">Split</SelectItem><SelectItem value="audit">Audit</SelectItem></SelectContent></Select></label>
            <label><span>Agents</span><Select value={String(draft.concurrency ?? 2)} onValueChange={(value) => onChange({ ...draft, concurrency: Number(value) })}><SelectTrigger aria-label="Template concurrency"><SelectValue>{draft.concurrency ?? 2}</SelectValue></SelectTrigger><SelectContent>{[1, 2, 3, 4].map((count) => <SelectItem key={count} value={String(count)}>{count}</SelectItem>)}</SelectContent></Select></label>
          </div>
          <div className="template-profile-picker" aria-label="Template agents">
            {profiles.filter(({ enabled }) => enabled).map((profile) => {
              const active = selected.includes(profile.id);
              return <button key={profile.id} className={active ? 'selected' : ''} onClick={() => onChange({ ...draft, profileIds: active ? selected.filter((id) => id !== profile.id) : [...selected, profile.id].slice(0, 4) })}><AgentAvatar seed={profile.avatarSeed} name={profile.name} /><span>{profile.name}</span></button>;
            })}
            {profiles.length === 0 && <small>Create an agent profile first.</small>}
          </div>
        </div>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => onChange(null)}>Cancel</Button><Button disabled={busy || !draft.name.trim() || !draft.objective.trim()} onClick={() => void onSave()}>{busy ? 'Saving' : 'Save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LibraryEmpty({ icon, label, onClick }: { icon: typeof Layers01Icon; label: string; onClick: () => void }): React.JSX.Element {
  return <Card className="library-empty"><Icon icon={icon} size={20} /><span>{label}</span><Button size="sm" variant="secondary" onClick={onClick}>Create</Button></Card>;
}

function newProfile(providers: ProviderCapability[]): AgentProfileSaveRequest {
  return { name: '', provider: providers.find(providerReady)?.id ?? 'claude', model: null, instructions: '', enabled: true };
}

function newTemplate(): OrchestrationTemplateSaveRequest {
  return { name: '', objective: '', strategy: 'balanced', profileIds: [], concurrency: 2 };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some(({ id }) => id === item.id) ? items.map((candidate) => candidate.id === item.id ? item : candidate) : [...items, item];
}

function strategyLabel(strategy: OrchestrationStrategy): string {
  return strategy === 'parallel' ? 'Split' : strategy === 'audit' ? 'Audit' : 'Build';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
