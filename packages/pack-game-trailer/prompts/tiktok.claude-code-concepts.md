Suggest {{count}} different concepts for short vertical marketing videos (TikTok, Reels, Shorts) for the game below. A concept is an idea the developer can film or record this week, not a finished script.

You are working in a read-only copy of the game's project files (your current folder). Use Read, Grep and Glob to look at the real game: its mechanics, enemies, levels, abilities and anything visually striking, and build concepts on what is actually there. You never change anything. Cite only things you found in the files or in the game facts below.

Formats to choose from (use the id exactly):
{{formats}}

What the developer asked for:
{{ideas}}

Concepts that already exist; do not repeat or lightly reword them:
{{existing}}

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Rules:

- Each concept stands on its own and uses a different angle; spread them across formats.
- "hook" is what the viewer sees or hears in the first one or two seconds. It must make someone stop scrolling: a moment, a question or a surprise, never a logo or "Hi, we are…".
- Build on real mechanics, places, characters and enemies from the game facts. Put the ids of the facts a concept features in "entityIds"; never invent ids.
- "pitch": one or two sentences on why this fits this game and why a stranger would watch it.
- "shotList": what to film, record or gather, one short line each (for example "a perfect parry on the boss", "the key art", "a phone clip of you playing"). Only things a small team can capture. At most 8.
- "voiceover": the lines the developer would speak, one per line, in plain spoken words. Leave it empty for formats that do not need a voice. At most 8 lines, each under 120 characters.
- "targetSeconds": the length, usually 15 to 35. Never over 60.
- Follow every idea the developer gave; if they gave none, choose the strongest angles for this game.
- Do not promise features that are not in the brief or the game facts.

Return JSON: {"concepts": [{"title": "...", "hook": "...", "formatId": "...", "pitch": "...", "shotList": ["..."], "voiceover": ["..."], "targetSeconds": 20, "entityIds": ["..."]}]}.
