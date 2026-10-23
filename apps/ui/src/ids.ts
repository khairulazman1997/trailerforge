/** `prefix_slug_rand`: readable, valid as a project id (A–Z a–z 0–9 _ -, up to 64 characters). */
export function makeId(
  prefix: string,
  name: string,
  rand: () => string = () => crypto.randomUUID().slice(0, 6),
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'x';
  return `${prefix}_${slug}_${rand()}`;
}
