# dawabit_substreams Substreams modules

This package was initialized via `substreams init`, using the `evm-events-calls-raw` template.

## Usage

```bash
substreams build
substreams auth
substreams gui       			  # Get streaming!
```

Optionally, you can publish your Substreams to the [Substreams Registry](https://substreams.dev).

```bash
substreams registry login         # Login to substreams.dev
substreams registry publish       # Publish your Substreams to substreams.dev
```

## Modules

All of these modules produce data filtered by these contracts:
- _relaunchfactory_ at **0x0e54a12db2d6b8f309269ef98f8b9c2764aa3a92**
- _relaunchtraderouter_ at **0x48acf9c62384a6c15cca80f6307cc29a5be2580b**
- _graduationrouter_ at **0x5ecc1ab2ca5e11629fce19495669dfbe0e78c3d4**
- _protocolliquidityvault_ at **0x4c693c74edf24520154d5ac0af35a8ab5530b663**
- _protocolfeevault_ at **0xbc3aa39470ae2a71df23af38ff98d26d44317332**
### `map_events_calls`

This module gets you events _and_ calls


### `map_events`

This module gets you only events that matched.



### `map_calls`

This module gets you only calls that matched.


