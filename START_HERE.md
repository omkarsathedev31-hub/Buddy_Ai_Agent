# Buddy Elder AI – Quick Start (Windows / Mac / Linux)

1. Install Node.js 20+ from https://nodejs.org
2. Open this folder in VS Code, then open a NEW terminal (Terminal > New Terminal).
3. Run: `npm install`
4. Copy `.env.example` to a new file named `.env` and set ONE line:
   `GEMINI_API_KEY="your-real-key-from-Google-AI-Studio"`
   (Also set ADMIN_PASSCODE if you want the admin console.)
5. Check your setup (never prints the key): `npm run diagnose:gemini`
6. Start the website: `npm run dev`  -> open http://localhost:3000

Production-style run: `npm run build` then `npm start`.
Tests: `npx tsx --test tests/api.test.ts tests/gemini.test.ts`

Notes
- After editing `.env`, stop the server (Ctrl+C) and start it again.
- If a key still seems ignored, close all terminals and open a new one (old terminals keep old variables).
- Never commit `.env` or share your key. If a key leaks, create a new one in Google AI Studio.
- Vercel: add GEMINI_API_KEY in Project Settings > Environment Variables, then redeploy.
  SQLite on Vercel is temporary storage, so logins/chats will not persist there; use a hosted database for that.
