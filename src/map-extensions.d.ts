// Augments Map with TC39 upsert proposal methods used by chrome-devtools-frontend.
// Remove once TypeScript's lib includes these natively.
interface Map<K, V> {
  getOrInsert(key: K, defaultValue: V): V;
  getOrInsertComputed(key: K, callbackFunction: (key: K) => V): V;
}
