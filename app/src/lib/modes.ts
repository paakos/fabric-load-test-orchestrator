import type { FormState } from './model';

/** Which fields are active and which are greyed out, and why, for the three mode switches (A: settings, B: RLS, C: navigation). */
export interface ModeState {
  globalExecOff: boolean; globalExecWhy: string;
  cardExecOff: boolean; cardExecWhy: string;
  rlsScopeOff: boolean; rlsScopeWhy: string;
  globalUsersOff: boolean; globalUsersWhy: string;
  globalFileOff: boolean; globalFileWhy: string;
  cardUsersOff: boolean; cardUsersWhy: string;
  cardFileOff: boolean; cardFileWhy: string;
  globalNavOff: boolean; globalNavWhy: string;
  cardNavOff: boolean;
}

export function modeState(f: FormState): ModeState {
  const { rlsSource: src, rlsScope: scope } = f;
  const none = src === 'none';
  return {
    globalExecOff: f.settingsMode === 'per_model',
    globalExecWhy: 'Disabled: the run settings are per model. These are the pipeline defaults; they are not used in this mode.',
    cardExecOff: f.settingsMode === 'global',
    cardExecWhy: 'Disabled: the run settings are global. This model uses the global values shown here.',
    rlsScopeOff: none, rlsScopeWhy: 'Disabled: the RLS source is "none" (no impersonation).',
    globalUsersOff: !(src === 'list' && scope === 'global'),
    globalUsersWhy: none ? 'Disabled: the RLS source is "none".' : src === 'file' ? 'Disabled: the RLS source is "file".' : 'Disabled: the RLS scope is per model (each model has its own users).',
    globalFileOff: !(src === 'file' && scope === 'global'),
    globalFileWhy: none ? 'Disabled: the RLS source is "none".' : src === 'list' ? 'Disabled: the RLS source is "list".' : 'Disabled: the RLS scope is per model (each model has its own file).',
    cardUsersOff: !(src === 'list' && scope === 'per_model'),
    cardUsersWhy: none ? 'Disabled: the RLS source is "none".' : src === 'file' ? 'Disabled: the RLS source is "file".' : 'Disabled: the RLS scope is global (the global list is used).',
    cardFileOff: !(src === 'file' && scope === 'per_model'),
    cardFileWhy: none ? 'Disabled: the RLS source is "none".' : src === 'list' ? 'Disabled: the RLS source is "list".' : 'Disabled: the RLS scope is global (the global file is used).',
    globalNavOff: f.navMode === 'per_model',
    globalNavWhy: 'Disabled: each model has its own navigation file.',
    cardNavOff: f.navMode === 'same',
  };
}
