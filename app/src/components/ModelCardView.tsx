import { useEffect, useId, useState } from 'react';
import type { Generated } from '../lib/generate';
import { modeState } from '../lib/modes';
import type { FormState, ModelCard } from '../lib/model';
import { useApp } from '../lib/store';
import { ExecSettings, fieldId } from './ExecSettings';
import { FilePicker } from './FilePicker';
import { Button, Label, RadioGroup, TextInput } from './ui';

export function ModelCardView({ card, index, form, gen, errors, patch, patchSettings, onDuplicate, onRemove, canRemove }: {
  card: ModelCard; index: number; form: FormState; gen: Generated; errors: Record<string, string>;
  patch(p: Partial<ModelCard>): void; patchSettings(p: Partial<ModelCard['settings']>): void; onDuplicate(): void; onRemove(): void; canRemove: boolean;
}) {
  const app = useApp();
  const m = modeState(form);
  const listId = useId();
  const wsListId = useId();
  const at = (k: string) => `models.${card.id}.${k}`;
  const [otherModels, setOtherModels] = useState<string[]>([]);
  const sameModels = app.discovery?.models.map((x) => x.displayName) ?? [];

  // Semantic models of the other workspace, for the suggestions of the dataset field
  useEffect(() => {
    if (card.workspaceMode !== 'other') return;
    const w = app.workspaces.find((x) => x.displayName === card.workspace.trim());
    if (!w) { setOtherModels([]); return; }
    let alive = true;
    app.backend.items(w.id, 'SemanticModel').then((i) => { if (alive) setOtherModels(i.map((x) => x.displayName)); }).catch(() => { if (alive) setOtherModels([]); });
    return () => { alive = false; };
  }, [app.backend, app.workspaces, card.workspaceMode, card.workspace]);

  const datasets = card.workspaceMode === 'other' ? otherModels : sameModels;
  const effective = gen.effective.find((e) => e.cardId === card.id);
  const line = gen.cardLines[card.id];
  const settingsShown = m.cardExecOff ? form.global : card.settings;
  const scopeKey = m.cardExecOff ? `global` : `models.${card.id}.settings`;
  const sharedQuery = form.navMode === 'same';

  return (
    <article className="card" aria-labelledby={`${card.id}-title`}>
      <header className="card-head">
        <div>
          <h3 id={`${card.id}-title`}>{card.model_key || `Model ${index + 1}`}{card.dataset ? <span className="muted"> · {card.dataset}</span> : null}</h3>
          <p className="muted small" aria-label="What this model will do">{effective ? line : ''}</p>
        </div>
        <div className="card-actions">
          <Button small onClick={onDuplicate} title="Same dataset and workspace, new model_key, no users">Duplicate</Button>
          <Button small kind="danger" disabled={!canRemove} reason="At least one model is needed" onClick={onRemove}>Remove</Button>
        </div>
      </header>

      <div className="grid2">
        <div className="field">
          <Label htmlFor={fieldId(at('model_key'))}>model_key</Label>
          <TextInput id={fieldId(at('model_key'))} value={card.model_key} onChange={(v) => patch({ model_key: v })} error={errors[at('model_key')]} mono placeholder="SalesA" />
          <p className="muted small">Part of the run folder name; not the model name.</p>
        </div>
        <div className="field">
          <Label htmlFor={fieldId(at('dataset'))}>dataset (exact semantic model name)</Label>
          <input id={fieldId(at('dataset'))} className={`input${errors[at('dataset')] ? ' bad' : ''}`} list={listId} value={card.dataset} spellCheck={false}
            aria-invalid={errors[at('dataset')] ? true : undefined} onChange={(e) => patch({ dataset: e.target.value })} placeholder="Choose or type the exact name" />
          <datalist id={listId}>{datasets.map((d) => <option key={d} value={d} />)}</datalist>
          {errors[at('dataset')] && <p className="err-text" role="alert">{errors[at('dataset')]}</p>}
        </div>
      </div>

      <div className="field">
        <RadioGroup label="Workspace of the semantic model (workspace)" value={card.workspaceMode} onChange={(v) => patch({ workspaceMode: v })}
          options={[{ value: 'same', label: 'Same workspace where the test runs' }, { value: 'other', label: 'Another workspace' }]} />
        {card.workspaceMode === 'other' && (
          <>
            <input id={fieldId(at('workspace'))} className={`input${errors[at('workspace')] ? ' bad' : ''}`} list={wsListId} value={card.workspace} spellCheck={false}
              aria-label="Display name of the workspace" aria-invalid={errors[at('workspace')] ? true : undefined} placeholder="Display name of the workspace (never its GUID)"
              onChange={(e) => patch({ workspace: e.target.value })} />
            <datalist id={wsListId}>{app.workspaces.map((w) => <option key={w.id} value={w.displayName} />)}</datalist>
            {errors[at('workspace')] && <p className="err-text" role="alert">{errors[at('workspace')]}</p>}
          </>
        )}
      </div>

      <div className="field">
        <Label htmlFor={fieldId(at('queryfile'))}>Navigation JSON (queryfile)</Label>
        <FilePicker kind="queries" id={fieldId(at('queryfile'))} label={`Navigation file of ${card.model_key || 'the model'}`} value={sharedQuery ? form.globalQueryfile : card.queryfile}
          onChange={(p) => patch({ queryfile: p })} off={m.cardNavOff}
          why={`Disabled: "Same file for all models" is selected. Inherited path: ${form.globalQueryfile || '(none yet)'}`} error={sharedQuery ? undefined : errors[at('queryfile')]} />
      </div>

      <fieldset className="subsection">
        <legend>RLS users of this model</legend>
        <div className="field">
          <Label htmlFor={fieldId(at('users'))}>users (UPNs)</Label>
          <TextInput id={fieldId(at('users'))} textarea rows={3} mono value={card.users} onChange={(v) => patch({ users: v })} off={m.cardUsersOff} why={m.cardUsersWhy} error={errors[at('users')]} placeholder="one per line, or separated by commas" />
        </div>
        <div className="field">
          <Label htmlFor={fieldId(at('users_file'))}>users_file</Label>
          <FilePicker kind="users" id={fieldId(at('users_file'))} label={`Users file of ${card.model_key || 'the model'}`} value={card.users_file} onChange={(p) => patch({ users_file: p })}
            off={m.cardFileOff} why={m.cardFileWhy} error={errors[at('users_file')]} />
        </div>
      </fieldset>

      <fieldset className="subsection">
        <legend>Run settings of this model</legend>
        <ExecSettings value={m.cardExecOff ? settingsShown : card.settings} onChange={patchSettings} scope={scopeKey === 'global' ? `card-${card.id}-global` : scopeKey}
          off={m.cardExecOff} why={m.cardExecWhy} errors={errors} />
      </fieldset>
    </article>
  );
}
