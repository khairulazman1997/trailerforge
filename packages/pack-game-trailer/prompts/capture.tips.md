You are helping a player record gameplay footage for a {{videoType}}. For each capture group below, write short, practical advice for the recording session.

Recording setup: {{recording}}

Capture groups (JSON). Each group is one place and setup where several shots are recorded back to back:
{{groups}}

Rules:

- Refer to groups only by their "key", copied exactly. Write nothing for a group you have nothing useful to say about.
- "tips": up to 4 short, concrete things that make the footage better or the session faster (camera and HUD handling, how to set up the moment, what to do between takes, ordering shots to save loading time).
- "risks": up to 3 things that commonly ruin a take or force a re-record (variable frame rate, a UI popup, a non-repeatable event, a missed trigger, an autosave).
- Use only the facts given here. Do not invent levels, bosses, commands, buttons or file names, and do not guess at anything shown as "[redacted]".
- Each item is one sentence, under 200 characters.

Return JSON: {"groups": [{"key": "...", "tips": ["..."], "risks": ["..."]}]}.
