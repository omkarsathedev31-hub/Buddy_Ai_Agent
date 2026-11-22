import './server/env.ts';
import { getEnvLoadReport, getGeminiKeyInfo } from './server/env.ts';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server/app.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApp();
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          error: 'API endpoint not found.',
        });
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    const dbStatus = app.locals.buddyMeta as
      | { dbMode?: string; aiConfigured?: boolean; messagingConfigured?: boolean }
      | undefined;
    console.log(
      `Buddy Elder AI server running on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`,
      { ...(dbStatus ?? {}), aiKeySource: getGeminiKeyInfo().source }
    );
    const keyInfo = getGeminiKeyInfo();
    const envReport = getEnvLoadReport();
    console.log('AI Provider: Gemini');
    console.log(`AI Configuration: ${keyInfo.configured ? 'Configured' : 'NOT CONFIGURED'}`);
    if (!keyInfo.configured) {
      console.warn(
        `[Buddy AI] GEMINI_API_KEY was not found (or is still a placeholder). Looked for .env / .env.local in: ${envReport.directory || process.cwd()} ` +
          `(files found: ${envReport.filesRead.join(', ') || 'none'}). Add a line GEMINI_API_KEY="your-key" to .env and restart.`
      );
    } else if (keyInfo.formatIssue) {
      console.warn(`[Buddy AI] ${keyInfo.formatIssue}`);
    }
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the conflicting process or set PORT to another free port.`);
    } else if (err.code === 'EACCES') {
      console.error(`Permission denied binding to port ${PORT}. Try PORT=3000 or check OS firewall permissions.`);
    } else {
      console.error('Buddy Elder AI server error:', err.message);
    }
    process.exit(1);
  });
}

export { createApp };

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || Boolean(process.env.VERCEL_ENV);

if (!isVercel) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
