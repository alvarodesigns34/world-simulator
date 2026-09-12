/**
 * Command log (T-0023, DEC-022). The UI never writes simulation state; it
 * issues one of these. `timeScale` changes ARE commands (DEC-030).
 */

export type Command =
  | { readonly kind: 'setTimeScale'; readonly scale: number }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'setRegime'; readonly regime: 'explicit' | 'synoptic' | 'climatology' | 'paleo' }
  | { readonly kind: 'setVisualField'; readonly field: string }
  | { readonly kind: 'stepOnce' };

export interface CommandLog {
  readonly entries: readonly { readonly seq: number; readonly cmd: Command }[];
  push(cmd: Command): void;
}

export function createCommandLog(): CommandLog {
  const entries: { seq: number; cmd: Command }[] = [];
  return {
    get entries() {
      return entries;
    },
    push(cmd: Command): void {
      entries.push({ seq: entries.length, cmd });
    },
  };
}
