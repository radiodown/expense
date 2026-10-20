import { createApp } from './app.js';
const { app, db } = createApp();
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '127.0.0.1', () => console.log(`모아 가계부: http://127.0.0.1:${port}`));
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
