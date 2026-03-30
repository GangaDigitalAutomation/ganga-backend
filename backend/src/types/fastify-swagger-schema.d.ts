import "fastify";

declare module "fastify" {
  interface FastifySchema {
    description?: string;
    summary?: string;
    tags?: string[];
  }
}
