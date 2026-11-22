import type { Request, Response } from 'express';

type ExpressHandler = (req: Request, res: Response) => unknown;

let cachedApp: ExpressHandler | null = null;

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    if (!cachedApp) {
      const { createApp } = await import('../server/app.ts');
      cachedApp = createApp();
    }

    const app = cachedApp;
    await new Promise<void>((resolve) => {
      if (res.writableEnded) {
        resolve();
        return;
      }
      const done = () => {
        res.off('finish', done);
        res.off('close', done);
        resolve();
      };
      res.on('finish', done);
      res.on('close', done);
      app(req, res);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server initialization failed.';
    console.error('[Buddy Elder AI Vercel Handler Error]', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        code: 'SERVER_INIT_ERROR',
        error: {
          code: 'SERVER_INIT_ERROR',
          message:
            process.env.NODE_ENV === 'production'
              ? 'Backend server initialization failed. Check server runtime and environment variables.'
              : message,
        },
      });
    }
  }
}
