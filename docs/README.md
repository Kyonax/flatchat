# Docs

Licence: CC BY 4.0 ([LICENSE](LICENSE)).

## Running FlatChat

- [`hosting.md`](hosting.md): running the core and a world on a home PC so friends on other networks can join: the Cloudflare Tunnel, the core's signalling relay, port mapping and TURN; inviting friends; the load test.
- [`updates.md`](updates.md): downloads and the self-update: the signed feed, the installer, the owner's release steps.
- [`policies.md`](policies.md): the rules and policies the core serves (drafts for the lawyer's review) and what each still needs.
- [`risk.md`](risk.md): the written risk document: illegal content, children, data protection.

## Making things

- [`world-format.md`](world-format.md): how a world is made: `world.toml`, glTF scenes and their markers (spawn points, seats, solids, sounds, portals, zones), the limits.
- [`world-looks.md`](world-looks.md): a world's sky, fog, light and screen effects.
- [`audio.md`](audio.md): 3D audio: walls that muffle, reverb zones.
- [`svg-plans.md`](svg-plans.md): buildings drawn as semantic SVG plans and built into worlds.
- [`avatars.md`](avatars.md), [`items.md`](items.md), [`animations.md`](animations.md): avatars, clothes and props, emotes and dances.
- [`effects.md`](effects.md), [`overlays.md`](overlays.md), [`shaders.md`](shaders.md): effects, screen overlays, creator shaders.
- [`plugins.md`](plugins.md): writing a plugin: `plugin.toml`, the hooks, the host interface and its permissions, what happens when one fails, and the entry rules that come with the world server.

## The client

- [`ui.md`](ui.md): the interface: the Kyonax HUD tokens with FlatChat's accent, the mark, the help, credits and keys pages.
- [`quality.md`](quality.md): quality presets, the frame-rate tuner, the stats panel.
- [`weak-laptop.md`](weak-laptop.md): the weak-laptop check with testers.

## The platform

- [`protocol.md`](protocol.md): the wire protocol every program speaks: messages, encoding, the connect token and the version handshake.
- [`spikes/`](spikes/README.md): Stage 0's measurement reports.
