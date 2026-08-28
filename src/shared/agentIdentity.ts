export const PERSON_NAMES = [
  'Alex',
  'Avery',
  'Bailey',
  'Blake',
  'Cameron',
  'Casey',
  'Charlie',
  'Dakota',
  'Drew',
  'Elliot',
  'Emery',
  'Finley',
  'Frankie',
  'Harper',
  'Hayden',
  'Jamie',
  'Jesse',
  'Jordan',
  'Jules',
  'Kai',
  'Kendall',
  'Lane',
  'Logan',
  'Marley',
  'Micah',
  'Morgan',
  'Nico',
  'Noel',
  'Parker',
  'Peyton',
  'Quinn',
  'Reese',
  'Remy',
  'Riley',
  'River',
  'Robin',
  'Rowan',
  'Sage',
  'Sam',
  'Sawyer',
  'Shiloh',
  'Sidney',
  'Skyler',
  'Tatum',
  'Taylor',
  'Terry',
  'Toby',
  'Val',
  'Wren',
  'Zion'
] as const;

export function personNameForSeed(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return PERSON_NAMES[(hash >>> 0) % PERSON_NAMES.length];
}
