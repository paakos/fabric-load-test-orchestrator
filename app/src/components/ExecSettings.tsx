import { useId } from 'react';
import type { ExecForm } from '../lib/model';
import { MAX_LEVEL, RAMP_PRESETS, THINK_SCALE_PRESETS } from '../lib/parameters';
import { parseLevels, parseNumberText, levelsText } from '../lib/generate';
import { Label, RadioGroup, TextInput } from './ui';

export const fieldId = (field: string) => `f-${field.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

/** The ten execution settings: the same controls for the global values and for every model card. */
export function ExecSettings({ value, onChange, scope, off, why, errors }: {
  value: ExecForm; onChange(patch: Partial<ExecForm>): void; scope: string; off: boolean; why: string; errors: Record<string, string>;
}) {
  const uid = useId();
  const f = (k: string) => fieldId(`${scope}.${k}`);
  const err = (k: string) => errors[`${scope}.${k}`];
  const levels = parseLevels(value.ramp_levels);
  const presetId = RAMP_PRESETS.find((p) => !levels.error && p.levels.join(',') === levels.levels.join(','))?.id ?? 'custom';
  const scaleN = parseNumberText(value.think_time_scale);
  const scalePreset = THINK_SCALE_PRESETS.find((s) => s === scaleN);
  const thinkOff = !off && !value.enable_think_times;
  const whyId = `${uid}-why`;
  const thinkWhyId = `${uid}-think-why`;
  const dep = off || thinkOff;
  const rampUp = parseNumberText(value.ramp_up_sec) ?? 0;
  const firstLevel = !levels.error ? Math.min(6, levels.levels[0]) : 6;

  return (
    <div className="exec">
      {off && <p className="why wide-why" id={whyId}>{why}</p>}
      <div className="field wide">
        <Label htmlFor={f('ramp_levels')} param="ramp_levels">Ramp levels (concurrent users)</Label>
        <RadioGroup label="Ramp preset" value={presetId} disabled={off} describedBy={off ? whyId : undefined}
          options={[...RAMP_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom' }]}
          onChange={(v) => { const p = RAMP_PRESETS.find((x) => x.id === v); if (p) onChange({ ramp_levels: p.levels.join(', ') }); else document.getElementById(f('ramp_levels'))?.focus(); }} />
        <TextInput id={f('ramp_levels')} value={value.ramp_levels} onChange={(v) => onChange({ ramp_levels: v })} off={off} describedBy={whyId} error={err('ramp_levels')} inputMode="text" mono placeholder="for example 6, 20, 60" />
        {!off && !levels.error && (
          <p className="muted small">{levels.levels.length === 1 ? `Fixed number of users: ${levels.levels[0]}.` : `Levels run one after another: ${levelsText(levels.levels)}.`} Each value is 1–{MAX_LEVEL}.</p>
        )}
      </div>

      <div className="field">
        <Label htmlFor={f('iterations')} param="iterations">Iterations</Label>
        <TextInput id={f('iterations')} value={value.iterations} onChange={(v) => onChange({ iterations: v })} off={off} describedBy={whyId} error={err('iterations')} inputMode="numeric" />
      </div>
      <div className="field">
        <Label htmlFor={f('delay_sec')} param="delay_sec">Delay between iterations (s)</Label>
        <TextInput id={f('delay_sec')} value={value.delay_sec} onChange={(v) => onChange({ delay_sec: v })} off={off} describedBy={whyId} error={err('delay_sec')} inputMode="numeric" />
      </div>
      <div className="field">
        <Label htmlFor={f('ramp_up_sec')} param="ramp_up_sec">Start window (s)</Label>
        <TextInput id={f('ramp_up_sec')} value={value.ramp_up_sec} onChange={(v) => onChange({ ramp_up_sec: v })} off={off} describedBy={whyId} error={err('ramp_up_sec')} inputMode="decimal" />
        {!off && rampUp > 0 && (
          <p className="muted small">Users of a level start at {Array.from({ length: Math.min(firstLevel, 6) }, (_, i) => Math.round((rampUp * i) / firstLevel * 10) / 10).join(', ')} s (ramp_up_sec × i / N). Not the ramp of levels.</p>
        )}
      </div>
      <div className="field">
        <Label htmlFor={f('initial_user_jitter_sec')} param="initial_user_jitter_sec">Initial jitter (s)</Label>
        <TextInput id={f('initial_user_jitter_sec')} value={value.initial_user_jitter_sec} onChange={(v) => onChange({ initial_user_jitter_sec: v })} off={off} describedBy={whyId} error={err('initial_user_jitter_sec')} inputMode="decimal" />
      </div>

      <div className="field wide think">
        <Label param="enable_think_times">Think times</Label>
        <RadioGroup label="Replay the recorded pauses" value={value.enable_think_times} disabled={off} describedBy={off ? whyId : undefined}
          options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} onChange={(v) => onChange({ enable_think_times: v })} />
        <p className="formula" id={`${uid}-formula`}>applied pause = min(recorded pause × think_time_scale, max_think_time_sec) × random(1 − jitter, 1 + jitter)</p>
      </div>
      {thinkOff && <p className="why wide-why" id={thinkWhyId}>Disabled: think times are off. These fields keep their values but are not used.</p>}
      <div className="field wide">
        <Label htmlFor={f('think_time_scale')} param="think_time_scale">Think time scale</Label>
        <RadioGroup label="Scale preset" value={scalePreset === undefined ? 'other' : String(scalePreset)} disabled={dep} describedBy={dep ? (off ? whyId : thinkWhyId) : undefined}
          options={[...THINK_SCALE_PRESETS.map((s) => ({ value: String(s), label: `×${s}` })), { value: 'other', label: 'Other value' }]}
          onChange={(v) => { if (v === 'other') document.getElementById(f('think_time_scale'))?.focus(); else onChange({ think_time_scale: v }); }} />
        <TextInput id={f('think_time_scale')} value={value.think_time_scale} onChange={(v) => onChange({ think_time_scale: v })} off={dep} describedBy={dep ? (off ? whyId : thinkWhyId) : undefined} error={err('think_time_scale')} inputMode="decimal" />
      </div>
      <div className="field">
        <Label htmlFor={f('max_think_time_sec')} param="max_think_time_sec">Max think time (s)</Label>
        <TextInput id={f('max_think_time_sec')} value={value.max_think_time_sec} onChange={(v) => onChange({ max_think_time_sec: v })} off={dep} describedBy={dep ? (off ? whyId : thinkWhyId) : undefined} error={err('max_think_time_sec')} inputMode="decimal" />
      </div>
      <div className="field">
        <Label htmlFor={f('think_time_jitter_pct')} param="think_time_jitter_pct">Jitter (0–1)</Label>
        <TextInput id={f('think_time_jitter_pct')} value={value.think_time_jitter_pct} onChange={(v) => onChange({ think_time_jitter_pct: v })} off={dep} describedBy={dep ? (off ? whyId : thinkWhyId) : undefined} error={err('think_time_jitter_pct')} inputMode="decimal" />
      </div>
      <div className="field">
        <Label htmlFor={f('fallback_think_time_sec')} param="fallback_think_time_sec">Fallback think time (s)</Label>
        <TextInput id={f('fallback_think_time_sec')} value={value.fallback_think_time_sec} onChange={(v) => onChange({ fallback_think_time_sec: v })} off={dep} describedBy={dep ? (off ? whyId : thinkWhyId) : undefined} error={err('fallback_think_time_sec')} inputMode="decimal" />
      </div>
    </div>
  );
}
