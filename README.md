# Booking API

A REST API for booking time slots on things like salon chairs, meeting rooms, staff members or
tennis courts. Businesses plug it into their website or app to take bookings without ever
double-booking a slot.

Built with **Node.js, TypeScript, Fastify, MongoDB and Zod**.

**Live API docs:** https://YOUR-APP.onrender.com/docs <!-- replace after deploying -->

**See it in use:** [Hourstay](https://github.com/el-compte/booking-web), an Airbnb-style
storefront built on this API.

![CI](https://github.com/el-compte/booking-api/actions/workflows/ci.yml/badge.svg)

## Features

- **No double bookings, even under load.** Overlaps are blocked by a unique database index, not
  by a "check then insert" that two requests can race through. A test fires 8 identical requests
  at once and expects exactly one to succeed.
- **API keys and user logins.** Businesses sign up with email and password, then create API keys
  for their servers. Keys are stored as SHA-256 hashes and shown only once. API keys can't create
  more API keys.
- **Opening hours and time zones.** Each resource has weekly opening hours in its own time zone,
  including split shifts and daylight-saving days.
- **Free-slot lookup** for a calendar day, ready to show in a booking widget.
- **Custom metadata** on resources (photos, prices, addresses), so a storefront can be built on
  the API alone.
- **Safe retries.** Send an `Idempotency-Key` header and a retried request returns the original
  booking instead of creating a second one.
- **Rate limiting** per account, with `x-ratelimit-*` and `retry-after` headers.
- **Consistent errors.** Every error has the same shape, a machine-readable `code` and a
  `requestId` you can find in the logs.
- **Versioned routes** (`/v1`) and **OpenAPI 3.1 docs** generated from the same Zod schemas that
  validate requests, so the docs can't drift from the code.
- **Cursor pagination** on list endpoints.
- **53 automated tests** against a real (in-memory) MongoDB, run by GitHub Actions on every push.

## Quick start

You need Node.js 22+ and MongoDB (local, Docker, or a free
[MongoDB Atlas](https://www.mongodb.com/atlas) cluster).

```bash
npm install
cp .env.example .env   # then set JWT_SECRET and MONGODB_URI
npm run dev
```

Open http://localhost:3000/docs to explore and call the API from your browser.

## Try it with curl

```bash
API=http://localhost:3000/v1

# 1. Create an account (returns an access token)
TOKEN=$(curl -s -X POST $API/auth/signup -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"a-long-password","name":"My Salon"}' | jq -r .accessToken)

# 2. Create an API key for your website's server (shown once)
KEY=$(curl -s -X POST $API/api-keys -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Website"}' | jq -r .key)

# 3. Add something bookable. Default hours: Monday to Friday, 9:00 to 17:00
RESOURCE=$(curl -s -X POST $API/resources -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Chair 1","timezone":"Europe/Paris","slotMinutes":30}' | jq -r .id)

# 4. See the free slots on a day
curl -s "$API/resources/$RESOURCE/availability?date=2026-11-02" -H "x-api-key: $KEY"

# 5. Book one
curl -s -X POST $API/bookings -H "x-api-key: $KEY" -H 'idempotency-key: order-1001' \
  -H 'content-type: application/json' \
  -d "{\"resourceId\":\"$RESOURCE\",\"start\":\"2026-11-02T10:00:00+01:00\",\"end\":\"2026-11-02T11:00:00+01:00\",\"customer\":{\"name\":\"Alex Martin\"}}"
```

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/v1/auth/signup` | Create an account |
| `POST` | `/v1/auth/login` | Get an access token |
| `GET` | `/v1/me` | Current account |
| `POST` `GET` | `/v1/api-keys` | Create or list API keys (login token only) |
| `DELETE` | `/v1/api-keys/{id}` | Revoke an API key |
| `POST` `GET` | `/v1/resources` | Create or list resources |
| `GET` `PATCH` `DELETE` | `/v1/resources/{id}` | Get, update or archive a resource |
| `GET` | `/v1/resources/{id}/availability?date=` | Free slots on a day |
| `POST` `GET` | `/v1/bookings` | Book, or list bookings (filter by resource, status, time) |
| `GET` | `/v1/bookings/{id}` | Get a booking |
| `POST` | `/v1/bookings/{id}/cancel` | Cancel and free the slots |

Errors look like this:

```json
{
  "error": {
    "code": "slot_unavailable",
    "message": "This time overlaps an existing booking",
    "requestId": "32abc993-08cd-46d7-8f36-edcc61d54e93"
  }
}
```

## How double booking is prevented

Each booking stores the 15-minute units it covers. A 10:00–11:00 booking stores 10:00, 10:15,
10:30 and 10:45. All slot lengths are multiples of 15 minutes, so two bookings overlap exactly
when they share a unit.

MongoDB then enforces a unique index on `(resourceId, units)` for confirmed bookings. If two
requests try to take the same unit, the database accepts one and rejects the other, which the API
turns into `409 slot_unavailable`. Cancelled bookings are left out of the index, so cancelling
frees the slot straight away.

## Tests

```bash
npm test          # 53 tests: unit tests plus HTTP tests against an in-memory MongoDB
npm run lint      # Biome
npm run typecheck
```

The tests cover login and API keys, validation messages, overlapping and simultaneous
bookings, idempotent retries, opening hours, daylight-saving days, pagination, rate limits and the
generated docs.

## Deploy for free

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/atlas) and copy its
   connection string.
2. On [Render](https://render.com), choose **New → Blueprint** and pick this repository.
   `render.yaml` sets everything up and generates `JWT_SECRET`.
3. Set `MONGODB_URI` to your Atlas connection string and `PUBLIC_URL` to your Render URL.

A `Dockerfile` is also included for other hosts, such as Azure App Service, Fly.io or Railway.

## Project structure

```
src/
  app.ts            Fastify setup: docs, rate limits, error handling, /v1 routes
  server.ts         Starts the server
  config.ts         Environment variables, validated at startup
  db.ts             Document types, collections and indexes
  errors.ts         Error format
  plugins/auth.ts   API key and access-token checks
  lib/schedule.ts   Opening hours, slot and overlap logic
  modules/          auth, api-keys, resources, bookings routes
test/               Vitest tests
```

## Ideas for next steps

- MCP server so AI assistants can check availability and book
- Webhooks when a booking is created or cancelled
- Rescheduling a booking in one call
- Redis store for rate limits when running several instances

## License

MIT
