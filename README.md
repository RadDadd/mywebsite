# RadDadd's Data Tree

The static page is published from the root of `main` with GitHub Pages. The chat API is a Vercel Function in `api/chat.mjs`. The OpenAI key must only be set as a Vercel environment variable, never in GitHub or browser code.

## Connect the chat

1. Merge the chat backend changes into `main`.
2. In Vercel, import the `RadDadd/mywebsite` GitHub repository as a project. Keep the project root at the repository root; Vercel will serve the function at `https://YOUR-VERCEL-PROJECT.vercel.app/api/chat`.
3. In Vercel project settings, add `OPENAI_API_KEY` as an environment variable for Production. Create the key in the OpenAI Platform and configure API billing there. Redeploy after adding the variable.
4. Replace `https://YOUR-VERCEL-PROJECT.vercel.app/api/chat` in `index.html` with the actual Vercel production URL, commit that change to `main`, and wait for GitHub Pages to update.
5. Test the chat at `https://raddadd.github.io/mywebsite/` in a browser. Check Vercel function logs if the request fails.

The function accepts requests from `https://raddadd.github.io` by default. For a future custom site domain, set `ALLOWED_ORIGIN` in Vercel to its exact origin (scheme and host, without a trailing slash) and redeploy. Update the frontend API URL if the Vercel domain changes.

This is a publicly reachable paid API proxy. The origin check, input size limit, and response token cap reduce accidental use but do not prevent scripted abuse. Before promoting the chat publicly, configure a per-IP rate limit in Vercel's firewall and an OpenAI project usage limit or alert. Monitor usage after launch.

For local function checks, run `node --test` with Node 20 or later. The tests mock the upstream API and do not require a real key.
