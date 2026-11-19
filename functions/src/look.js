// The badge and name colour a player wears (the game's SHOP.md), shown beside their name in רמילים' lobby. They are
// ids of published cosmetics, and a phone draws nothing for an id it does not know, so only their form is checked: a
// slug of at most 40 characters, or none. The same rule as the game's own submitScores (patzekhna-android look.js).

const slug=/^[a-z0-9-]{1,40}$/;

/** The look a call sends, `{badge, nameColor}` with null for none; null when it sends none (builds from before). */
export function submittedLook(look) {
  if(look===undefined || look===null || typeof look!=='object' || Array.isArray(look))return null;
  const id=value=>typeof value==='string' && slug.test(value) ? value : null;
  return {badge:id(look.badge),nameColor:id(look.nameColor)};
}

/** The fields a lobby entry carries: only what is worn. */
export function lookEntry(look) {
  const out={};
  if(typeof look?.badge==='string' && slug.test(look.badge))out.badge=look.badge;
  if(typeof look?.nameColor==='string' && slug.test(look.nameColor))out.nameColor=look.nameColor;
  return out;
}
