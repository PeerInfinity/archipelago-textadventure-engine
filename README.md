# archipelago-textadventure-engine

A small, dependency-free JavaScript text adventure engine. Renders rooms, accepts text commands, emits events on player actions.

This engine is intentionally Archipelago-naive — it knows nothing about regions, items-as-AP-checks, sidecars, or any other randomizer concept. It can be driven by [Archipelago-CC](https://github.com/PeerInfinity/Archipelago-CC)'s `textAdventureSubstrateWrapper` (which translates Archipelago state into engine API calls), or run entirely on its own.

## Quick start (standalone)

Serve the directory with any static-file server:

```
python -m http.server 8000
```

Then open `http://localhost:8000/standalone.html`. You'll see a world picker — choose one of the bundled sample worlds (or upload your own JSON) and start exploring.

## Quick start (programmatic)

```js
import { TextAdventureEngine } from './engine.js';

const container = document.getElementById('app');
const engine = new TextAdventureEngine(container, {
    // Defaults shown; all optional:
    managed: false,                  // true = wrapper drives state; false = engine auto-mutates
    discoveryMode: 'full',           // 'full' or 'discovered' (fog of war)
    messageHistoryLimit: 10,
    autoFocusCommandInput: true,     // refocus the command input after every action
    dataPath: './data',              // where the picker looks for manifest.json
});

// Either load a default world via the picker (auto-shown if no loadWorld
// is called in standalone mode), or load programmatically:
engine.loadWorld(myWorld);
```

## World format

```js
{
  startRoomId: 'some-room',
  rooms: {
    'some-room': {
      id: 'some-room',
      title: 'Forest Clearing',
      description: 'You are standing in a forest clearing...',
      exits: [
        // `side` is optional. When any exit in a room carries
        // `side: 'N'|'E'|'S'|'W'`, the room renders as a 3×3 compass
        // grid (exits without `side` go in the center cell). Without
        // `side`, exits render as a flat list.
        { id: 'north', label: 'north (to dark woods)', targetRoomId: 'dark-woods', side: 'N' },
      ],
      items: [
        { id: 'key', label: 'shiny brass key', description: 'A small brass key.' },
      ],
    },
    // ... more rooms
  },
}
```

See `data/meta-demo.json` for a working example. Add more presets by dropping a JSON file in `data/` and listing it in `data/manifest.json`.

## Engine API

### State mutation (typically called by a wrapper in managed mode)

```js
engine.setCurrentRoom(roomId);
engine.setRoomDiscovered(roomId, bool);
engine.setItemDiscovered(roomId, itemId, bool);
engine.setItemCollected(roomId, itemId, bool);
engine.setItemAccessible(roomId, itemId, bool);
engine.setExitAccessible(roomId, exitId, bool);
engine.setExitDiscovered(roomId, exitId, bool);
engine.setInventory(items);
engine.addInventoryItem(itemId, label, count?);
engine.removeInventoryItem(itemId, count?);
engine.displayMessage(text, kind?);  // kind: 'normal' | 'system' | 'error' | 'success'
engine.setDiscoveryMode(mode);       // 'full' | 'discovered'
engine.setOption(key, value);        // update one of the constructor options at runtime
engine.batchUpdate(fn);              // suppress intermediate renders
```

### Programmatic triggers (for bots / wrappers driving the engine)

```js
engine.triggerExit(roomId, exitId, { ignoreAccessibility? });
engine.triggerExamineItem(roomId, itemId, { ignoreAccessibility? });
engine.triggerExplore(roomId);
engine.simulateCommand('go north');
```

### Events emitted on user input

```js
engine.on('command:move',    ({ fromRoomId, exitId, targetRoomId }) => ...);
engine.on('command:examine', ({ roomId, itemId }) => ...);
engine.on('command:explore', ({ roomId }) => ...);
engine.on('command:custom',  ({ rawCommand }) => ...);  // unrecognized text
```

In standalone mode the engine auto-mutates state after emitting (e.g. moves the player on `command:move`). In managed mode (`{ managed: true }`) the engine only emits — the wrapper is expected to push state back via setters.

### Lifecycle

```js
engine.focus();    // focus the command input
engine.destroy();  // tear down DOM + listeners
```

## Discovery mode

When `discoveryMode: 'discovered'` is set, the engine renders fog of war:
- Undiscovered items show as italicized "an unfamiliar item" placeholders (click → explore).
- Exits whose target room isn't discovered show their name with "(unknown destination)" suffix.
- Exits not yet discovered show as "an unfamiliar passage" (click → explore).
- An `[x] explore` link appears in the actions area.

The wrapper is expected to push discovery flags via the setters above. Standalone mode auto-discovers as the player moves and examines.

## What the engine does NOT do

- No knowledge of Archipelago concepts (regions, locations, items as AP checks, reachability rules, sidecars). That's the wrapper's job.
- No template substitution (`{{vars}}`). Pre-template strings before passing them in.
- No playback controller / clock. A bot wrapping the engine owns its own clock and uses `triggerExit` etc. to advance.
- No animations. Strictly declarative.

## Used by

- [Archipelago-CC](https://github.com/PeerInfinity/Archipelago-CC) (`textAdventureSubstrateWrapper` mounts this engine in an iframe panel and bridges Archipelago state to it).

## License

Same as Archipelago-CC.
