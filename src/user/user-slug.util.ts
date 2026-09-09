// Username -> URL-friendly public handle for profile links.
//
// Mirrors the tournament slug approach (generateUniqueSlug in tournament.service):
// lowercase, collapse non-alphanumerics to '-', trim, cap length; if the handle is
// already taken, append '-2', '-3', ... so the unique constraint on User.slug
// always holds. Shared so the ~5 user-creation sites cannot each grow their own
// copy of the rule.

/** Profile-route segments a handle must never equal, or a real user would be
 *  shadowed by a static Next.js route. Only `/profile/edit` exists today; `me`
 *  is reserved defensively as a common convention. Kept deliberately minimal so
 *  ordinary names (including "admin") get their clean handle. */
const RESERVED = new Set(['edit', 'me']);

const MAX_LEN = 40;

/** The base slug for a username, before uniqueness is resolved. Never empty. */
export function slugifyUsername(username: string | null | undefined): string {
  const base = (username ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LEN);
  if (!base) return 'player';
  return RESERVED.has(base) ? `${base}-1` : base;
}

/** Minimal shape this helper needs — satisfied by PrismaService and by a
 *  transaction client, so it can run inside or outside a $transaction. */
interface SlugLookup {
  user: {
    findUnique(args: {
      where: { slug: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * A slug for `username` that no other user holds. `ignoreUserId` lets an update
 * keep its own current slug (so re-deriving a user's slug never collides with
 * itself). Suffixes stay within the column's length budget.
 */
export async function generateUniqueUserSlug(
  client: SlugLookup,
  username: string | null | undefined,
  ignoreUserId?: string,
): Promise<string> {
  const base = slugifyUsername(username);
  let candidate = base;
  for (let n = 2; ; n++) {
    const taken = await client.user.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken || (ignoreUserId && taken.id === ignoreUserId)) return candidate;
    const suffix = `-${n}`;
    candidate = base.slice(0, MAX_LEN - suffix.length) + suffix;
  }
}
