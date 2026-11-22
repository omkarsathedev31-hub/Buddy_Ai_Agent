# Buddy Elder AI - Run It in 4 Steps

1. **Install Node.js** (LTS version) from https://nodejs.org (one time only).
2. **Add your Gemini key.** Open the file named `.env` in this folder with Notepad or VS Code.
   Replace `your-gemini-api-key` with your real key (keep the quotes, one line). Save.
   Free key: https://aistudio.google.com/apikey
3. **Start the app.**
   - Windows: double-click `start-windows.bat`
   - Mac/Linux: run `./start-mac-linux.sh`
   - VS Code: open a NEW terminal, run `npm install` then `npm run dev`
4. Open **http://localhost:3000**, create an account, and open **AI Buddy**.

## If the AI does not answer
Run `npm run diagnose:gemini`. It shows PASS/FAIL for each step and the exact cause
(invalid key, restricted key, model, quota, network). It never prints your key.

Common fix: an OLD key left in your Windows/Mac environment. Close all terminals and open a new one.
The app already prefers the key saved in `.env` and prints a notice if it replaced an old one.

## Useful commands
- `npm run dev`             start the website (development)
- `npm run build`           create the production build
- `npm start`               run in production mode
- `npm run lint`            TypeScript check
- `npm run diagnose:gemini` test the Gemini connection

## Your data
Accounts, sessions and conversations are stored in `./data/buddy-elder.db` on your computer
(created automatically). Back up that file to keep your data.

## Deploying to Vercel
Add `GEMINI_API_KEY` in Project Settings -> Environment Variables (Production), then redeploy.
Vercel uses temporary storage, so logins and chats are not permanent there until a hosted
database is added. For full persistence, run it locally or on a host with a disk.
