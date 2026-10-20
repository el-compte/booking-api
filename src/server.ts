import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb, ensureIndexes, getCollections } from './db.js';

const config = loadConfig();
const { client, db } = await connectDb(config.MONGODB_URI);
await ensureIndexes(getCollections(db));

const app = await buildApp({ config, db });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await client.close();
    process.exit(0);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`API docs at ${config.PUBLIC_URL ?? `http://localhost:${config.PORT}`}/docs`);
