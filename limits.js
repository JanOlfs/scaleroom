// Begrenzungen gegen Missbrauch der Räume: ohne sie könnte jemand Raumcodes
// durchprobieren (4 Zeichen) und fremde Spiele mitlesen, oder den Speicher mit
// Räumen füllen. Die Werte sind so großzügig, dass eine normale Party sie nie
// erreicht, auch nicht mit vielen Geräten hinter demselben WLAN (= eine IP).

/** Zählt Ereignisse je Schlüssel in einem gleitenden Zeitfenster. */
function createLimiter(max, windowMs) {
  const hits = new Map();
  const fresh = (key, now) => (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  return {
    /** Grenze erreicht? Zählt selbst nichts. */
    blocked(key, now = Date.now()) {
      return fresh(key, now).length >= max;
    },
    count(key, now = Date.now()) {
      hits.set(key, [...fresh(key, now), now]);
    },
    /** Abgelaufene Einträge verwerfen, sonst wächst die Map bis zum Neustart. */
    sweep(now = Date.now()) {
      for (const key of hits.keys()) {
        const left = fresh(key, now);
        if (left.length) hits.set(key, left);
        else hits.delete(key);
      }
    },
    get size() {
      return hits.size;
    },
  };
}

const num = (name, fallback) => Number(process.env[name]) || fallback;

// Neue Räume je IP und Stunde
const createLimiter_ = createLimiter(num('CREATE_LIMIT', 20), 60 * 60 * 1000);
// Fehlgeschlagene Beitritte je IP in 10 Minuten. Nach einem Server-Neustart
// versucht jeder Zuschauer es bis zu 7 Mal, bis der Host den Raum neu angelegt
// hat: 100 reichen dafür auch bei vielen Zuschauern im selben WLAN.
const joinFailLimiter = createLimiter(num('JOIN_FAIL_LIMIT', 100), 10 * 60 * 1000);

module.exports = { createLimiter, roomCreates: createLimiter_, joinFailures: joinFailLimiter };
