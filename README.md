# linkedin-profile-api

One endpoint. POST a LinkedIn profile URL, get clean profile JSON back.

## API

```
Deployed URL :
POST http://localhost:3000/api/profile
Content-Type: application/json

Local Deployment :
POST http://localhost:3000/api/profile
Content-Type: application/json
```

**Request**

```json
{ "url": "https://www.linkedin.com/in/williamhgates/" }
```

**Response** `200`

```json
{
  "ok": true,
  "profile": {
    "profileId": "ACoAAA…",
    "memberId": "251749025",
    "publicId": "williamhgates",
    "profileUrl": "https://www.linkedin.com/in/williamhgates/",
    "firstName": "Bill",
    "lastName": "Gates",
    "fullName": "Bill Gates",
    "headline": "Chair, Gates Foundation and Founder, Breakthrough Energy",
    "summary": null,
    "pronoun": null,
    "location": "Seattle, Washington, United States",
    "countryCode": "US",
    "industry": "Philanthropy",
    "photoUrl": "https://media.licdn.com/…",
    "backgroundUrl": "https://media.licdn.com/…",
    "isPremium": false,
    "isInfluencer": true,
    "isCreator": false,

    "positions": [
      {
        "title": "Co-chair",
        "company": {
          "name": "Gates Foundation",
          "id": "160297",
          "url": "…",
          "logoUrl": "…"
        },
        "employmentType": null,
        "location": null,
        "description": null,
        "start": "2000-01",
        "end": null,
        "current": true
      }
    ],
    "education": [
      {
        "school": "Harvard University",
        "schoolId": "1646",
        "schoolUrl": "…",
        "logoUrl": "…",
        "degree": null,
        "fieldOfStudy": null,
        "grade": null,
        "description": null,
        "start": "1973",
        "end": "1975",
        "current": false
      }
    ],
    "skills": ["Go (Programming Language)", "…"],
    "certifications": [
      {
        "name": "…",
        "authority": "…",
        "licenseNumber": "…",
        "url": "…",
        "issuedOn": "2021-12",
        "expiresOn": null
      }
    ]
  },
  "debug": {
    "raw": "output/williamhgates.raw.json",
    "clean": "output/williamhgates.clean.json"
  }
}
```

Every call also writes both files to `output/` for debugging.

**Errors**

| HTTP | `code`                    | Meaning                                              |
| ---- | ------------------------- | ---------------------------------------------------- |
| 400  | `bad_request`             | Missing URL, or not a `linkedin.com/in/<slug>` URL   |
| 401  | `linkedin_auth_failed`    | `LI_COOKIE` is expired or was revoked — recapture it |
| 404  | `profile_not_found`       | No such profile, or not visible to your account      |
| 429  | `linkedin_throttled`      | LinkedIn throttled us — back off                     |
| 500  | `not_configured`          | `LI_COOKIE` not set                                  |
| 502  | `linkedin_upstream_error` | Anything else upstream                               |

**Health**

```
GET http://localhost:3000/health
```

Reports whether a session is loaded, which cookies the jar holds, and the rate-limit state.

## Notes

- **Requests are spaced 1–10s apart.** Callers wait; there is no 429 from us.
  Tune with `MIN_INTERVAL_MS` / `JITTER_MS`.
- **`skills` can be empty** for profiles outside your network. That's a
  LinkedIn visibility limit, not a bug.
- **Image URLs are signed and expire** (~30 days). Store the profile, re-fetch
  the images.
- **This uses LinkedIn's private API with your session cookie.** It violates
  their Terms of Service and can get your account restricted. Roughly 50
  profiles/day is the safe ceiling for this access pattern. Use an account you
  can afford to lose.

## Setup

```bash
npm install
cp .env.example .env
```

Then set `LI_COOKIE`:

1. Open any LinkedIn profile in Chrome → DevTools → **Network**
2. Click a request to `/voyager/api/...`
3. **Request Headers** → right-click the `cookie:` value → **Copy value**
4. Paste it verbatim on one line into `LI_COOKIE=` in `.env`

```bash
npm start
```

```bash
curl -X POST localhost:3000/api/profile \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.linkedin.com/in/williamhgates/"}'
```

The cookie lasts months — until you log out, change your password, or LinkedIn
revokes the session. Then repeat steps 1–4. Changing `LI_COOKIE` discards the
saved session state automatically.

**Test a few profiles:**

```bash
npm run test:profiles
```
