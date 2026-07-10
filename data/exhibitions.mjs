// Exhibition definitions (see docs/exhibitions-design.md).
//
// An exhibition is a named, ordered selection with an opening date. It runs
// once through — one work per day from `opens` — then the permanent
// collection resumes. Adding or reordering exhibitions never affects the
// permanent collection's clock.

import { ex01Venice } from './seeds/ex01-venice.mjs';

export const exhibitions = [
  {
    id: 'venice-painted-light',
    title: 'Venice: Painted Light',
    tagline: 'Eleven mornings on one question: can light on water be painted?',
    opens: '2026-07-11',
    seeds: ex01Venice,
  },
];
