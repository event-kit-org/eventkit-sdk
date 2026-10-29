# Example: a club's event portal on @eventkit-sdk/client

The portal a club builds for its event (say machzero.vercel.app). Participants
have no accounts:

- `/register/{token}`: the team leader opens the registration link from the
  organiser and registers the whole team at once (with the payment receipt when
  the event takes payment at registration). Each member's participant ID, QR
  code and personal link are shown once, to save and share.
- `/me/{token}`: a member's personal link. It is swapped for a session and
  removed from the address bar; the page shows the status, the QR code and RSVP,
  and can replace a leaked link.
- `/`: the event.

```bash
cp .env.example .env    # API URL, event id, the event's API key
npm install
npm run dev
```

In the eventKit console, set the event's portal URL to this site
(`http://localhost:5173` while developing) so links point here.
