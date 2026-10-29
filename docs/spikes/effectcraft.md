# EffectCraft spike (M8 task 8.1), 2026-10-29

EffectCraft **v0.9.2** (tag `v0.9.2`, commit `470ea7a`), built from source in the cloud container (Linux x86_64, 4 cores, Rust 1.97, `cargo build --release -p effectcraft-cli`, 11 min, 84 MB binary). CPU renderer (headless default). Script: `docs/spikes/effectcraft-spike.sh`.

## Results

| Check                                              | Result                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author by commands (what an LLM does over CLI/MCP) | `comp.new`, `layer.newText`, `prop.addKey` ×4, `effect.apply` Glow: all ok, ~10 ms each; 681 commands, 306 effects                                                                                          |
| Project file                                       | `.ecproj` is readable JSON (32 KB for one text layer), headed by `savedBy: "0.9.2"` and `schema: 2`                                                                                                         |
| Hand-edited JSON (LLM writes the file)             | Text changed in the JSON renders the new text; a malformed file is refused with a clear message (`missing field settings`)                                                                                  |
| ProRes 4444 with alpha                             | `prores` profile 4444, `yuva444p12le`, 1920×1080, 30 fps, 90 frames; alpha 0 on the fully transparent first frame, non-zero where the text is                                                               |
| Determinism                                        | Two renders: identical sha256 (`02d25b45…`); 1 thread vs 4 threads: identical file and identical decoded frames                                                                                             |
| PNG output                                         | Transparent single frame (`rgba`) and a 90-frame PNG sequence                                                                                                                                               |
| Essential Graphics templates                       | `essential.addProperty` + `essential.exportTemplate` → `.ectemplate`; `render-frame --template T --values '{"Title":"SEASON ONE"}'` renders it (0.3 s); an unknown control is refused naming the valid ones |
| Speed (CPU, 4 cores)                               | 3 s title: 6.2–6.6 s; 10 s 1080p ProRes 4444: 14.2 s (≈ 0.7× real time; the text layer only covers the first 3 s)                                                                                           |
| Network                                            | `strace` during a render: 0 `connect()` calls                                                                                                                                                               |

![Template rendered with values](effectcraft-template.png)

## Not checked here

- Windows (README: Linux and Windows have known interaction bugs; the CLI path is what TrailerForge uses, the window is not needed). Run the script on the user's PC (Git Bash or WSL) with the MSI's `effectcraft-cli.exe`.
- Whether bytes match **across** OSes or versions (only same machine, same version tested). TrailerForge pins the version and records it in the plan hash, so cross-version equality is not required.
- Visual quality against the built-in renderer; a type error inside a property value (the test edit did not hit a typed field). Fonts: the default font was used; brand fonts need `list_fonts` / font import testing in 8.2.
- GPU renderer (`--gpu`) determinism; TrailerForge should use the CPU renderer.
- Licence of every dependency (workspace is MIT OR Apache-2.0; `cargo deny`/attribution check is in their CI, not rerun here).

## Decision

**Go.** Every blocking question for the plan is answered positively on Linux: headless, alpha, byte-identical (including across thread counts), no network, a readable JSON project, a command layer that validates input, and templates with a values file, which matches the "templates kept" plan directly (TrailerForge can pass `{ text, ... }` as `--values`). Plan adjustments for 8.2–8.4c:

1. Prefer authoring through **commands** (`effectcraft-cli run` / MCP `batch`) over writing raw `.ecproj` JSON: commands validate every parameter and reject unknown keys; the saved `.ecproj` is then stored in the project. Raw JSON edits are accepted only after EffectCraft reopens the file cleanly.
2. Templates are **`.ectemplate` files + values JSON**, rendered with `render --template`.
3. Pin `0.9.x`, CPU renderer only, version in the plan hash (`savedBy` and `schema` from the file are checked).
4. Windows verification of this script becomes part of 8.2's acceptance.
