// Nielsen's 10 Usability Heuristics — the default guideline catalogue
// (GAP 1). Seeded once at boot by the composition root when
// `GuidelineRepo.hasDefaults()` returns false, so `GET /api/v1/guidelines`
// returns a populated catalogue on a fresh database.
//
// Source: Jakob Nielsen, "10 Usability Heuristics for User Interface
// Design" (Nielsen Norman Group). Each entry is marked `isDefault: true`.

import type { NewGuideline } from './Guideline.js';

export const DEFAULT_GUIDELINES: readonly NewGuideline[] = [
  {
    name: 'Visibility of system status',
    description:
      'The design should always keep users informed about what is going on, through appropriate feedback within a reasonable amount of time.',
    isDefault: true,
  },
  {
    name: 'Match between the system and the real world',
    description:
      'The design should speak the users\u2019 language. Use words, phrases, and concepts familiar to the user, rather than internal jargon. Follow real-world conventions, making information appear in a natural and logical order.',
    isDefault: true,
  },
  {
    name: 'User control and freedom',
    description:
      'Users often perform actions by mistake. They need a clearly marked "emergency exit" to leave the unwanted action without having to go through an extended process.',
    isDefault: true,
  },
  {
    name: 'Consistency and standards',
    description:
      'Users should not have to wonder whether different words, situations, or actions mean the same thing. Follow platform and industry conventions.',
    isDefault: true,
  },
  {
    name: 'Error prevention',
    description:
      'Good error messages are important, but the best designs carefully prevent problems from occurring in the first place. Either eliminate error-prone conditions or check for them and present users with a confirmation option before they commit to the action.',
    isDefault: true,
  },
  {
    name: 'Recognition rather than recall',
    description:
      'Minimize the user\u2019s memory load by making elements, actions, and options visible. The user should not have to remember information from one part of the interface to another.',
    isDefault: true,
  },
  {
    name: 'Flexibility and efficiency of use',
    description:
      'Shortcuts \u2014 hidden from novice users \u2014 may speed up the interaction for the expert user so that the design can cater to both inexperienced and experienced users. Allow users to tailor frequent actions.',
    isDefault: true,
  },
  {
    name: 'Aesthetic and minimalist design',
    description:
      'Interfaces should not contain information that is irrelevant or rarely needed. Every extra unit of information competes with the relevant units and diminishes their relative visibility.',
    isDefault: true,
  },
  {
    name: 'Help users recognize, diagnose, and recover from errors',
    description:
      'Error messages should be expressed in plain language (no error codes), precisely indicate the problem, and constructively suggest a solution.',
    isDefault: true,
  },
  {
    name: 'Help and documentation',
    description:
      'It\u2019s best if the system doesn\u2019t need any additional explanation. However, it may be necessary to provide documentation to help users understand how to complete their tasks.',
    isDefault: true,
  },
];
