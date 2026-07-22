# Speaking Gap

Standalone speaking-practice app. Deploy this folder as a separate Netlify site instead of deploying it inside the existing Sentence Bank / listening app site.

## Netlify setup

1. Create a new Netlify site.
2. Set the base directory to `speaking-gap`.
3. Use the included `netlify.toml`.
4. Add the same environment variables used by the speaking API:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY` (optional; fallback responses work without it)
   - `OPENAI_SPEAKING_MODEL` (optional)
5. Apply `supabase/speaking_items.sql` to the target Supabase project.

The existing root app remains the listening app only.
