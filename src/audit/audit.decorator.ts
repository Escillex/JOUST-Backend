import { SetMetadata } from '@nestjs/common';
import { AuditCategory } from '@prisma/client';

export const AUDIT_KEY = 'audit:spec';

/** What a route's summary line can draw on. Names are resolved BEFORE the
 *  action runs, so a deletion can still say what it deleted. */
export interface AuditContext {
  /** Tournament name, or a neutral fallback when there is none. */
  t: string;
  /** The user the action was done to, when there is one. */
  target: string;
  /** ONLY the whitelisted body fields (see `pick`). */
  body: Record<string, unknown>;
  params: Record<string, string>;
  /** NAMES of the fields sent — never their values. For "updated X, Y". */
  fields: string[];
  /** What the route returned — e.g. the id of something just created. */
  result: unknown;
  /** Round and players, when the route acts on a match. */
  match?: { round: number; p1: string; p2: string };
  /** Name of the catalog item acted on (game, award, format, product) —
   *  resolved before the handler, so it survives a delete. */
  subject: string;
  /** The actor acted on themselves (joined, left) rather than on someone. */
  self: boolean;
}

/** How an organizer would say a round number aloud. Double elimination packs
 *  three brackets into one integer: 101+ losers, 200 final, 201 reset. */
export function roundText(n: number): string {
  if (n === 201) return 'grand final reset';
  if (n >= 200) return 'grand final';
  if (n > 100) return `losers round ${n - 100}`;
  return `round ${n}`;
}

/** "Mira Calder vs Yuki Harada (losers round 2)". */
export function matchText(c: AuditContext): string {
  return `${c.match?.p1 ?? 'TBD'} vs ${c.match?.p2 ?? 'TBD'} (${roundText(c.match?.round ?? 0)})`;
}

export type SubjectModel = 'game' | 'award' | 'tournamentFormat' | 'storeProduct' | 'userAward';

export interface AuditSpec {
  /** Stable machine name, e.g. `tournament.start`. */
  action: string;
  category: AuditCategory;
  /** Where the tournament comes from. */
  tournament?:
    | { param: string }
    | { matchParam: string }
    | { invitationParam: string }
    | { result: string }
    | { body: string };
  /** Where the affected user comes from. */
  targetUser?: { param: string } | { body: string };
  /** A catalog item whose name to snapshot before the handler runs. */
  subject?: { model: SubjectModel } & ({ param: string } | { body: string });
  /**
   * Body fields that may be STORED. Everything else is discarded before the
   * entry is written — a request body wholesale would put passwords and the
   * SMTP key into the log.
   */
  pick?: string[];
  /** A whitelist that depends on the request itself — e.g. a setting's value
   *  is kept unless that setting is a secret. Takes precedence over `pick`. */
  pickFn?: (body: Record<string, unknown>) => Record<string, unknown>;
  describe: (c: AuditContext) => string;
}

/**
 * Record this route in the audit log once it has succeeded (todo.md obj. 3.1).
 * A failed or refused request records nothing: the log is of what happened,
 * not of what was attempted.
 */
export const Audit = (spec: AuditSpec) => SetMetadata(AUDIT_KEY, spec);
