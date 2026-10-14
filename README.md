# VENOMIX backend (Render free)

Flow: customer pays by UPI and places an order (status `processing`) -> admin clicks **Approve & send** -> backend sends it to CheapSMMMarket (`action=add`) -> status becomes `inprogress` -> backend syncs provider status -> `completed` / `cancelled`.

Services without a provider ID are "manual": Approve marks them completed straight away, like before.

## 1. Deploy on Render
1. Put the `backend/` folder in a GitHub repo (or the whole project; `render.yaml` uses `rootDir: backend`).
2. Render > New > Web Service > connect the repo. Runtime Node, Build `npm install`, Start `npm start`, plan Free.
3. Environment variables (see `.env.example`):
   - `PROVIDER_API_KEY` from your CheapSMMMarket account page
   - `ADMIN_EMAIL` same as config.js
   - `ALLOWED_ORIGINS` your site URL, e.g. `https://your-domain.com`
   - `FIREBASE_SERVICE_ACCOUNT` Firebase Console > Project settings > Service accounts > Generate new private key, paste the JSON on one line
   - `CRON_SECRET` any long random string
   - optional `PROVIDER_CURRENCY_TO_INR` (e.g. 90 if provider prices are USD) and `DEFAULT_MARKUP_PERCENT`
4. Copy the service URL into `API_URL` in `config.js`, upload the frontend.

## 2. Firestore rules
Paste `firestore.rules` into Firebase Console > Firestore > Rules. This stops customers from editing their own order status and keeps provider IDs/cost private (`serviceMap` is backend-only).

## 3. Keep it awake and synced (free)
Render free sleeps after 15 min idle (first request then takes ~30-60 s). Create a free monitor on cron-job.org or UptimeRobot hitting every 10 min:
`https://YOUR-SERVICE.onrender.com/api/cron/sync?token=CRON_SECRET`
This keeps the service awake and syncs order statuses, so customers see "Completed" without you opening the admin panel.

## 4. Adding services
Admin > Services > Provider services: search, tap **Use**, set your own name and price, **Add service**. Min/max are clamped to the provider limits.

## Notes
- Check the UPI payment before approving: approving sends the order and spends your provider balance.
- If an order shows `sending` for long, the server was interrupted mid-request. Check the provider panel before retrying to avoid a double order.
- Customer emails on provider completion are not sent automatically (EmailJS runs in the browser); the approve email is still sent from the admin panel.
