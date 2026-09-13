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
  | { readonly kind: 'stepOnce' }
  | { readonly kind: 'advance'; readonly seconds: number }
  | { readonly kind: 'advanceDeepTime'; readonly years: number }
  | { readonly kind: 'bookmark'; readonly label: string };

export interface LoggedCommand {
  readonly seq: number;
  readonly time: { readonly year: number; readonly seconds: number };
  readonly cmd: Command;
}

export interface CommandLog {
  readonly entries: readonly LoggedCommand[];
  push(cmd: Command): void;
  restore(entries: readonly LoggedCommand[]): void;
}

export function createCommandLog(now: () => { readonly year: number; readonly seconds: number }): CommandLog {
  const entries: LoggedCommand[] = [];
  return {
    get entries() {
      return entries;
    },
    push(cmd: Command): void {
      if (cmd.kind === 'advance') {
        const last = entries[entries.length - 1];
        if (last?.cmd.kind === 'advance') {
          entries[entries.length - 1] = {
            ...last,
            cmd: { kind: 'advance', seconds: last.cmd.seconds + cmd.seconds },
          };
          return;
        }
      }
      entries.push({ seq: entries.length, time: { ...now() }, cmd });
    },
    restore(saved: readonly LoggedCommand[]): void {
      entries.splice(0, entries.length, ...saved.map((entry, seq) => ({
        seq,
        time: { ...entry.time },
        cmd: { ...entry.cmd },
      })));
    },
  };
}
