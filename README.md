# Τα Ψώνια μας

Mobile-first εφαρμογή προσωπικών και κοινών λιστών αγορών.

## Τρέχουσα αρχιτεκτονική

- Frontend: vanilla HTML/CSS/JavaScript PWA
- Backend: Node.js
- Database: PostgreSQL
- Hosting: Render Web Service
- Realtime: Server-Sent Events
- Offline cache/queue: IndexedDB
- Source of truth: GitHub branch `astra-shopping-app-rebuild`

## Χρήστες και λίστες

- signup με όνομα, email και κωδικό
- νέοι users μπαίνουν σε κατάσταση pending
- ο admin εγκρίνει / αναστέλλει users
- κάθε user έχει προσωπική λίστα
- υπάρχουν πολλαπλές κοινές λίστες
- ο admin προσθέτει/αφαιρεί users από κοινές λίστες
- οι users δεν βλέπουν την προσωπική λίστα του admin
- ο admin μπορεί να δει προσωπικές λίστες άλλων users μόνο ως προβολή και αυτό δηλώνεται καθαρά στο UI

## Authentication / security

- HttpOnly + Secure + SameSite=Lax session cookie
- server-side session table
- logout
- logout από όλες τις συσκευές
- password change με invalidation όλων των sessions
- login/signup/join/password rate limiting
- origin checks για state-changing requests
- CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- server-side list/household authorization
- soft delete / restore
- optimistic concurrency με item version
- ελληνικά user-facing errors
- npm audit μέσω CI

## Offline / PWA

- τελευταία λίστα αποθηκεύεται σε IndexedDB
- offline add/edit μπαίνουν σε local mutation queue
- replay όταν επανέλθει Internet
- states Online / Offline / Συγχρονισμός / Αποτυχία sync
- service worker με versioned cache
- cleanup παλιών caches
- API requests δεν cache-άρονται από service worker

## CI

GitHub Actions τρέχει σε κάθε push στο development branch:

- `npm install`
- `npm run check`
- `npm test`
- `npm audit --audit-level=high`

## Environment variables

- `DATABASE_URL`
- `APP_ORIGIN=https://tapsoniamas-api.onrender.com`
- `NODE_ENV=production`

Πραγματικά secrets δεν πρέπει να γίνονται commit.

## Render

Web Service: `tapsoniamas-api`

- build: `npm install`
- start: `npm start`
- branch: `astra-shopping-app-rebuild`

Το Web Service σερβίρει frontend και API από το ίδιο origin.

## Health

`GET /api/health`

## Γνωστοί περιορισμοί πριν το τελικό production pass

- το GitHub CI εκτελεί πραγματικό end-to-end API test με δύο sessions και PostgreSQL· τελικό οπτικό/mobile acceptance γίνεται στην πραγματική συσκευή
- πριν merge στο `main` θα γίνει τελικός permission/realtime/mobile έλεγχος
