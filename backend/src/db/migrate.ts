import { createCoreApp } from "../core/createApp.js";
import { ensureSchema } from "./bootstrap.js";

async function main() {
  const app = await createCoreApp();
  await ensureSchema(app);
  app.logger.info("Schema bootstrap complete");
  await app.fastify.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
