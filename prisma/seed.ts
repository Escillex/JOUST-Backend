import { PrismaClient, TournamentSystem, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import 'dotenv/config';

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
      winsToAdvance: 1,
      bestOf: 1,
      allowDraw: false,
      sessionsCount: 1,
    },
  },
  {
    name: 'Double Elimination',
    description: 'Two losses before elimination. Winners and losers bracket.',
    system: TournamentSystem.DOUBLE_ELIMINATION,
    config: {
      winsToAdvance: 1,
      bestOf: 1,
      allowDraw: false,
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
    },
  },
  {
    name: 'Round Robin',
    description: 'Everyone plays everyone. Best record wins.',
    system: TournamentSystem.ROUND_ROBIN,
    config: {
      bestOf: 1,
      allowDraw: false,
      sessionsCount: 1,
    },
  },
  {
    name: 'Swiss → Top Cut',
    description:
      'Swiss rounds to determine standings, followed by a single-elimination top cut.',
    system: TournamentSystem.HYBRID,
    config: {
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
        bestOf: 3,
      },
    },
  },
];

async function main() {
  console.log('🌱 Starting seed...');

  // ── 1. Preserve or create admin user ─────────────────────────────
  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminEmail = process.env.ADMIN_EMAIL ?? `${adminUsername}@joust.local`;
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin123';

  let admin = await prisma.user.findFirst({
    where: { roles: { has: Role.ADMIN } },
  });

  if (!admin) {
    console.log('  Creating admin user...');
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    admin = await prisma.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        hashedPassword,
        roles: [Role.ADMIN, Role.ORGANIZER, Role.PLAYER],
        isGuest: false,
      },
    });
    console.log(`  ✅ Admin created: ${admin.username}`);
  } else {
    console.log(`  ✅ Admin preserved: ${admin.username}`);
  }

  // ── 2. Seed built-in Tournament Formats ──────────────────────────
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
