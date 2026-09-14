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
  /**
   * Close the current coalesce window (T-0133).
   *
   * Consecutive `advance`s merge into one entry so a 60 Hz loop does not write
   * a 60-line recipe per second. A checkpoint is a replay boundary: the next
   * advance must be a new entry, or `commandCount` cannot find it.
   */
  seal(): void;
}

export function createCommandLog(now: () => { readonly year: number; readonly seconds: number }): CommandLog {
  const entries: LoggedCommand[] = [];
  let coalesce = true;
  return {
    get entries() {
      return entries;
    },
    push(cmd: Command): void {
      if (cmd.kind === 'advance') {
        const last = entries[entries.length - 1];
        if (coalesce && last?.cmd.kind === 'advance') {
          entries[entries.length - 1] = {
            ...last,
            cmd: { kind: 'advance', seconds: last.cmd.seconds + cmd.seconds },
          };
          return;
        }
      }
      coalesce = true;
      entries.push({ seq: entries.length, time: { ...now() }, cmd });
    },
    restore(saved: readonly LoggedCommand[]): void {
      entries.splice(0, entries.length, ...saved.map((entry, seq) => ({
        seq,
        time: { ...entry.time },
        cmd: { ...entry.cmd },
      })));
      coalesce = true;
    },
    seal(): void {
      coalesce = false;
    },
  };
}
