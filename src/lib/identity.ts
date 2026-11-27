// Shared animal-themed guest identity generator.
// Each adjective/animal combination is short enough for profiles.username (varchar(30)).
const adjectives = [
  "playful", "cosmic", "sleepy", "mighty", "curious", "jazzy", "swift",
  "gentle", "brave", "sunny", "tiny", "fuzzy", "clever", "bouncy",
  "dreamy", "happy", "silent", "lucky", "neon", "chill", "bold",
  "mellow", "sparkly", "quirky", "rapid", "cozy", "witty", "nimble",
  "cheerful", "mystic", "friendly", "groovy", "peppy", "calm",
];
const animals = [
  "rabbit", "fox", "panda", "wolf", "otter", "penguin", "tiger",
  "koala", "dolphin", "owl", "hamster", "badger", "falcon", "lynx",
  "raccoon", "swan", "gecko", "hedgehog", "leopard", "eagle",
  "meerkat", "parrot", "seal", "bison", "squirrel", "jaguar",
  "turtle", "whale", "ferret", "dragon",
];

export function generateGuestName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adjective}-${animal}`;
}
