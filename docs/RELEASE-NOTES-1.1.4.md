# FM-1 Emulator 1.1.4

## Highlights

- **One engine for every mode.** The emulator runs firmware on the unified engine with a CPU optimization that skips loops the second CPU core provably cannot leave. Across all 277 bundled packages the results are identical with the optimization on and off, in Default and under both flash chip models.
- **Flash chip compatibility box.** Default, Older chip (Puya P25Q80H) and Newer chip (UC25HQ80) modes. The chip modes keep nothing; only Default saves your patches.
- **Compare chips.** A plain verdict on whether the loaded firmware started and wrote to flash on each chip model, a code check for the chips' IDs, and a copyable report about that firmware only.
- The Firmware radar moved under Install firmware, and the desktop window opens maximized.

## Limits

- The optimization helps only firmware whose second core waits in a provable loop (about a quarter of the bundled packages). Heavy firmware that uses both cores, such as `386dx`, `duell` and `playa`, can still run below real time and underrun. See the README's known limitations.
- Some behaviour is not verified on a physical FM-1: the audio-clock (PLL0) values, the stock firmware's sound and UI, and listening on a real audio device.

## Tests before publish

```bash
npm test
npm run test:machine
```

Full details are in CHANGELOG.md.
