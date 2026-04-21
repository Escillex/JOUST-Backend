import { INestApplication, Injectable, OnModuleInit } from "@nestjs/common";    
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
    constructor() {
        super({
            adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
        });
    }

    async onModuleInit() {
        await this.$connect();
    }

    async enableShutdownHooks( app: INestApplication) {
        this.$on('beforeExit' as never, async () => {
            await app.close();
        });
    }
}