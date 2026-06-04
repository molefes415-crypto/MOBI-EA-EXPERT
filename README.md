# Mobi EA — Render deployment

Standalone Node/Express build of the Mobi EA app. Serves the full UI plus the
license validator and AI chart scanner endpoints.

## Deploy on Render

1. Create a new repo and upload the contents of this zip (or push to GitHub).
2. On Render → **New → Web Service** → connect the repo (or pick "Deploy from
   ZIP" / Blueprint via `render.yaml`).
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
4. Add the environment variables (copy from `.env.example`):
   - `LOVABLE_API_KEY` — required for the AI chart scanner
   - `SUPABASE_URL` — optional, enables license caching + device binding
   - `SUPABASE_SERVICE_ROLE_KEY` — optional, same as above
5. Deploy. The app is served at `/`.

## Endpoints

- `POST /api/public/validate-license` `{ key, deviceId }`
- `POST /api/public/analyze-chart`    `{ imageBase64, symbol }`

## Local run

```bash
npm install
cp .env.example .env   # fill in keys
npm start
# open http://localhost:10000
```
