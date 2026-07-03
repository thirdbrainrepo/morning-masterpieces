// The full rotation, in chronological order. The daily index walks this list
// front to back, so each cycle is a miniature survey course: van Eyck (1434)
// through American Gothic (1930).

import { renaissance } from './seeds/01-renaissance.mjs';
import { baroque } from './seeds/02-baroque-rococo.mjs';
import { romantic } from './seeds/03-romantic-realism.mjs';
import { modern } from './seeds/04-impressionism-modern.mjs';

export const seeds = [...renaissance, ...baroque, ...romantic, ...modern];
