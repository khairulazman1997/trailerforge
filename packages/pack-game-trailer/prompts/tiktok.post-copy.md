Write the post text for a short vertical {{format}} video: the caption, hashtags, a comment to pin, and a title for the cover frame.

The concept:
{{concept}}

What the video shows, in order (shot titles):
{{shots}}

What the developer says (voiceover), in order:
{{voiceover}}

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Rules:

- "caption": what appears under the video. Start with the hook (the first line is all most people read). At most 300 characters. In the game's tone; no clickbait that the video does not deliver, no "link in bio" unless the brief says where to find the game.
- "hashtags": 3 to 8, without the "#", each one word (letters, digits, underscores). Mix a few broad ones (a genre, "indiedev", "gamedev") with specific ones (the game's own name, its mechanic). No banned or spammy tags.
- "pinnedComment": one friendly line that invites a reply or points to the wishlist/demo if the brief gives one; at most 150 characters.
- "coverTitle": 2 to 6 words that read at thumbnail size, different from the caption's first line.
- Use real places, characters, enemies and mechanics from the game facts; never invent features, dates or prices.

Return JSON: {"caption": "...", "hashtags": ["..."], "pinnedComment": "...", "coverTitle": "..."}
