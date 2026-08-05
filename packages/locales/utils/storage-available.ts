// ----------------------------------------------------------------------

export function localStorageAvailable() {
  try {
    const key = '__some_random_key_you_are_not_going_to_use__';
    window.localStorage.setItem(key, key);
    window.localStorage.removeItem(key);
    return true;
  } catch (error) {
    return false;
  }
}

export function localStorageGetItem(key: string, defaultValue = '') {
  if (!localStorageAvailable()) {
    // No storage (e.g. server render): honor the caller's default instead of
    // returning `undefined`, which would otherwise diverge from the client.
    return defaultValue;
  }

  return localStorage.getItem(key) || defaultValue;
}
