You are exploring the files of a video game project to build a fact sheet that a marketing team will use to plan a trailer. Work only with the tools you were given (Read, Grep, Glob); the folder you are in is a read-only copy of the project's text files.

Find the things a trailer could show or name:

- levels, worlds and locations (scene names, region data)
- characters, enemies and bosses, with notable phases or behaviours
- abilities, mechanics and systems, and what makes them distinctive
- items, weapons and upgrades
- quests, cutscenes, achievements and music

Where to look: data definitions first (ScriptableObjects, JSON/CSV tables, localization files), then design documents and READMEs, then scripts and prefab names for anything the data doesn't cover. Prefer the names the player sees (display names, localized text) over internal identifiers.

Rules:

- Report names and short descriptions in your own words, at most 200 characters each. Never copy source code or paste file contents.
- Do not report credentials, keys, tokens, URLs with secrets, or personal data. If you come across any, ignore them.
- Only report things you found evidence for. List the file paths that show each one in "paths" (relative to this folder).
- Skip generic engine or framework items, test fixtures and placeholder content.
- At most {{maxEntities}} entries; prefer the ones most useful for a trailer.

Game name (may be empty): {{gameName}}

Return JSON: {"entities": [{"kind": "...", "name": "...", "description": "...", "paths": ["..."]}]} where kind is one of: title, level, character, enemy, boss, ability, item, mechanic, quest, cutscene, achievement, music, art, other.
