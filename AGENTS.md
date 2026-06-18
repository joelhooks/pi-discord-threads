<!-- pi-notes-agent:start -->
## pi-notes Brain workflow

This repo uses pi-notes for durable project memory and local review surfaces.

- Read `BRAIN.md` and relevant `.brain/**/*.svx` notes before substantial planning, architecture claims, or code edits.
- Treat `.brain/` as source. Do not leave important decisions only in chat.
- Author Brain pages as MDSvX `.svx` files.
- Keep `.svx` readable: prose, links, short summaries, and component invocations.
- Put large structured data in `.brain/data/**`.
- Put reusable local renderers in `.brain/components/**/*.svelte`.
- Use the `brain-component-composition` skill before substantial `.brain`, component, or data-backed review work.
- Browser feedback should be handled as a Review Batch with a receipt, not as vague chat commentary.
- Commit regularly at logical inflection points. When live daemon work or overlapping dirty files make a normal commit risky, create a checkpoint patch first, then commit the smallest coherent slice as soon as it validates.
- Run `pi-notes brain check` after Brain changes and the normal project checks after code changes.
<!-- pi-notes-agent:end -->
