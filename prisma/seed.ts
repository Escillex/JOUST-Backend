import { PrismaClient, TournamentSystem, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import 'dotenv/config';
import { generateUniqueUserSlug } from '../src/user/user-slug.util';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const BUILTIN_FORMATS: {
  name: string;
  description: string;
  system: TournamentSystem;
  config: object;
}[] = [
  {
    name: 'Single Elimination',
    description: 'One loss and you are out. Classic bracket play.',
    system: TournamentSystem.SINGLE_ELIMINATION,
    config: {
      bestOf: 1,
      allowDraw: false,
      seedingMode: 'RANDOM',
      sessionsCount: 1,
    },
  },
  {
    name: 'Double Elimination',
    description: 'Two losses before elimination. Winners and losers bracket.',
    system: TournamentSystem.DOUBLE_ELIMINATION,
    config: {
      bestOf: 1,
      allowDraw: false,
      seedingMode: 'RANDOM',
    },
  },
  {
    name: 'Swiss',
    description: 'Players face opponents with similar records across rounds.',
    system: TournamentSystem.SWISS,
    config: {
      swissRounds: null,        // auto-calculated from player count
      swissPointsForWin: 3,
      swissPointsForDraw: 1,
      swissPointsForLoss: 0,
      bestOf: 1,
      allowDraw: false,
      seedingMode: 'RANDOM',
    },
  },
  {
    name: 'Round Robin',
    description: 'Everyone plays everyone. Best record wins.',
    system: TournamentSystem.ROUND_ROBIN,
    config: {
      bestOf: 1,
      allowDraw: false,
      seedingMode: 'RANDOM',
      sessionsCount: 1,
    },
  },
  {
    name: 'Swiss → Top Cut',
    description:
      'Swiss rounds to determine standings, followed by a single-elimination top cut.',
    system: TournamentSystem.HYBRID,
    config: {
      // seedingMode sits at the root, not inside a phase: how the field is
      // drawn belongs to the event, not to the Swiss phase.
      seedingMode: 'RANDOM',
      phase1: {
        engine: 'SWISS',
        swissRounds: 4,
        swissPointsForWin: 3,
        swissPointsForDraw: 1,
        swissPointsForLoss: 0,
        bestOf: 1,
        allowDraw: false,
      },
      phase2: {
        engine: 'SINGLE_ELIMINATION',
        topCutSize: 8,
        bestOf: 2,
      },
    },
  },
];

async function main() {
  console.log('🌱 Starting seed...');

  // ── 1. Preserve or create admin user ─────────────────────────────
  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminEmail = process.env.ADMIN_EMAIL ?? `${adminUsername}@joust.local`;
  // No default password. This file is committed, so any fallback here would be a
  // published credential for the first admin of every fresh database.
  const adminPassword = process.env.ADMIN_PASSWORD;

  let admin = await prisma.user.findFirst({
    where: { roles: { has: Role.ADMIN } },
  });

  if (!admin) {
    // Checked here rather than at the top of main(): a database that already has
    // an admin does not need the variable at all, and the rest of the seed
    // (built-in formats) should still run without it.
    if (!adminPassword) {
      throw new Error(
        'ADMIN_PASSWORD is not set, and this database has no admin account. ' +
          'Set ADMIN_PASSWORD before seeding — the seed will not fall back to a ' +
          'default password.',
      );
    }
    console.log('  Creating admin user...');
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    const adminSlug = await generateUniqueUserSlug(prisma, adminUsername);
    admin = await prisma.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        slug: adminSlug,
        hashedPassword,
        roles: [Role.ADMIN, Role.ORGANIZER, Role.PLAYER],
        isGuest: false,
      },
    });
    console.log(`  ✅ Admin created: ${admin.username}`);
  } else {
    console.log(`  ✅ Admin preserved: ${admin.username}`);
  }

  // ── 2. Seed the built-in "General" game ──────────────────────────
  // Every tournament has a game; "General" is the required floor an organizer
  // falls back to when no specific game is chosen (todo.md §5). It is builtin and
  // must never be deletable.
  const general = await prisma.game.upsert({
    where: { name: 'General' },
    update: { isBuiltin: true },
    create: {
      name: 'General',
      slug: 'general',
      description:
        'Uncategorised play. The default game every tournament falls back to when no specific game is set.',
      isBuiltin: true,
      createdById: admin.id,
    },
  });
  console.log(`  ✅ Game: ${general.name}`);

  // ── 3. Seed built-in Tournament Formats ──────────────────────────
  console.log('  Seeding built-in formats...');
  for (const fmt of BUILTIN_FORMATS) {
    await prisma.tournamentFormat.upsert({
      where: { name: fmt.name },
      update: { description: fmt.description, config: fmt.config, isBuiltin: true },
      create: {
        name: fmt.name,
        description: fmt.description,
        system: fmt.system,
        config: fmt.config,
        isBuiltin: true,
        createdById: admin.id,
      },
    });
    console.log(`  ✅ Format: ${fmt.name}`);
  }

  console.log('🌱 Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
