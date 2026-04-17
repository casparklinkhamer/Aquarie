# Acquire Online

Volledig online multiplayer versie van het bordspel Acquire.

## Lokaal testen

```bash
npm install
npm start
# Open http://localhost:3000
```

## Gratis online zetten (Railway)

1. Maak een gratis account op https://railway.app
2. Klik "New Project" → "Deploy from GitHub repo"
3. Upload of push deze map naar GitHub
4. Railway detecteert automatisch Node.js en start de server
5. Klik op het gegenereerde domein (bijv. acquire-xxx.up.railway.app)
6. Deel die URL met vrienden — zij openen dezelfde link en voeren jouw spelcode in

## Gratis online zetten (Render)

1. Maak een gratis account op https://render.com
2. "New Web Service" → verbind je GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Kies "Free" plan → Deploy

## Spelen

1. Host opent de URL, voert naam in, klikt "Nieuw spel"
2. Deel de spelcode of kopieer de invite-link
3. Vrienden openen de link en voeren hun naam in
4. Host klikt "Spel starten" zodra iedereen er is

## Techniek

- Node.js + Express (server)
- Socket.io (real-time multiplayer)
- Vanilla HTML/CSS/JS (frontend, geen framework nodig)
