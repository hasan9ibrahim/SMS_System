import { buildServer } from "./server.js";
import { startBestBuyRefresh } from "./api/bestbuy.js";

const host = process.env.MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.MOCK_PORT ?? 4010);

const app = await buildServer({ logger: true });
await app.listen({ host, port });
startBestBuyRefresh();
