import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app, startScheduler } = await createApp(cfg);
startScheduler();
app.listen(cfg.port, () => console.log(`IPO running on http://localhost:${cfg.port}`));
