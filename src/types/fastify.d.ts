import 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: any;
  }

  interface FastifyRequest {
    session?: {
      discordId: string;
      hwid: string;
    };
  }
}