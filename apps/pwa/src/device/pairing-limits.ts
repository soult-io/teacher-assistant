// Pairing timings shared by the pairing layer and the screens. No crypto here: jsdom
// imports it.

/** A pairing session lives this long from open (the relay's PAIRING_TTL_MS). */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** How often a waiting device asks the relay again (well under its 30 a minute per route). */
export const POLL_MS = 3000;
