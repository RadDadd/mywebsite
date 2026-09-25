# RadDadd's Data Tree

The static page is published from the root of `main` with GitHub Pages. The chat API is a Vercel Function in `api/chat.mjs`. The Gemini key must only be set as a Vercel environment variable, never in GitHub or browser code.

## Connect the chat

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey). Use a project on the Free Tier and leave billing unlinked if you want to stay on the free allowance.
2. In the `mywebsite` Vercel project, open Settings → Environment Variables. Add `GEMINI_API_KEY` with the key as its value, scoped to Production. Do not add the key to GitHub or this README.
3. Upload the updated `api/chat.mjs`, `test/chat.test.mjs`, `index.html`, and `README.md` to the same paths in the GitHub repository's `main` branch. GitHub Pages and Vercel will redeploy from the commit. If you add the key after the Vercel deployment, redeploy the latest production deployment so it picks up the variable.
4. Test the chat at `https://raddadd.github.io/mywebsite/` in a browser. Check Vercel function logs if the request fails. The frontend calls `https://mywebsite-raddadd.vercel.app/api/chat`.

The function accepts requests from `https://raddadd.github.io` by default. For a future custom site domain, set `ALLOWED_ORIGIN` in Vercel to its exact origin (scheme and host, without a trailing slash) and redeploy. Update the frontend API URL if the Vercel domain changes.

This is a publicly reachable Gemini API proxy. The origin check, input size limit, and response token cap reduce accidental use but do not prevent scripted abuse. The Vercel firewall rule for `POST /api/chat` should remain enabled. Gemini Free Tier stops serving requests when its quota is exhausted. On the Free Tier, Google may use chat prompts and responses to improve its products; do not enter private information. Check usage in Google AI Studio.

For local function checks, run `node --test` with Node 20 or later. The tests mock the upstream API and do not require a real key.
