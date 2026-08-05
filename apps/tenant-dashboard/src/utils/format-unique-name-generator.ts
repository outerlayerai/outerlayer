export function fUniqueNameGenerator(str: string) {
  return str.replace(/ /g, '_').toLowerCase();
}