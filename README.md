# Τα Ψώνια μας

Mobile-first κοινή λίστα αγορών με Node.js backend, PostgreSQL και realtime συγχρονισμό.

## Architecture

- Frontend: vanilla HTML/CSS/JavaScript PWA
- Backend: Node.js HTTP API
- Database: PostgreSQL
- Realtime: Server-Sent Events
- Hosting: Render Web Service
- Source of truth: GitHub branch `astra-shopping-app-rebuild`

## Τρέχουσες λειτουργίες

- signup / login
- δημιουργία household
- συμμετοχή με invite code
- κοινά shopping items
- add / edit / purchased / restore / soft delete
- quantity / unit / category / store / note / priority
- activity history
- realtime refresh μεταξύ sessions
- search
- light / dark / system mode
- PWA shell / install support

## Environment variables

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — ισχυρό production secret
- `APP_ORIGIN` — επιτρεπόμενο frontend origin
- `NODE_ENV=production`

Μην κάνεις commit πραγματικά secrets.

## Render

Προτεινόμενη τρέχουσα διάταξη:

- Render Web Service: `tapsoniamas-api`
- Build command: `npm install`
- Start command: `npm start`
- Branch: `astra-shopping-app-rebuild`

Το ίδιο Web Service μπορεί να σερβίρει frontend και API.

## Health

`GET /api/health`

## Γνωστό τρέχον blocker

Χωρίς `DATABASE_URL`, το API ξεκινά αλλά δεν μπορεί να εκτελέσει signup/login ή να αποθηκεύσει δεδομένα.

## Επόμενο pass

Μετά το πρώτο end-to-end functional test θα γίνει security hardening: secure sessions, rate limiting, migrations, offline mutation queue, concurrency/versioning, CI/tests και πλήρες PWA/security audit.
