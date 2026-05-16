function capFirst(str) {
  if (!str) return str;
  const c = str[0];
  if (c >= 'a' && c <= 'z') return c.toUpperCase() + str.slice(1);
  return str;
}

export function displayTag(riotTag) {
  if (!riotTag) return riotTag;
  const hash = riotTag.indexOf('#');
  if (hash < 0) return capFirst(riotTag);
  return capFirst(riotTag.slice(0, hash)) + riotTag.slice(hash);
}

export function displayName(riotTag) {
  if (!riotTag) return riotTag;
  const name = riotTag.split('#')[0];
  return capFirst(name);
}
