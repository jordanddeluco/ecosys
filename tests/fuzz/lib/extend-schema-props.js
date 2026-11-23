// Runs in its own child process (it may pollute prototypes if the code under test is wrong):
// extendSchema()/extendSettingsSchema() must refuse collection or key names that are not their own
// entries, and must never write onto Object.prototype, Object or Function.prototype.
import { extendSchema, extendSettingsSchema } from '../../../shared/sanitize.js';
import { check } from './harness.js';
import { obj } from './json-gen.js';

const MARK = 'zzzFuzzPolluted';
const BUILTINS = [Object.prototype, Object, Function.prototype, Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf, Object.prototype.isPrototypeOf, Array.prototype];
const pollutedBuiltins = () => BUILTINS.filter((o) => Object.hasOwn(o, MARK));
const cleanUp = () => {
  for (const o of BUILTINS) if (Object.hasOwn(o, MARK)) delete o[MARK];
};

export const describeEnv = () => ({ process: 'isolated child' });
export const properties = [
  {
    name: 'extendSchema refuses prototype-named collections and never mutates built-in prototypes',
    test() {
      const problems = [];
      try {
        for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
          let threw = false;
          try {
            extendSchema(name, { [MARK]: () => 1 });
          } catch {
            threw = true;
          }
          const hit = pollutedBuiltins().map((o) => (o === Object.prototype ? 'Object.prototype' : o === Object ? 'Object' : typeof o === 'function' ? `${o.name || 'function'}()` : 'a prototype'));
          if (!threw || hit.length) problems.push(`extendSchema(${JSON.stringify(name)}, {${MARK}}) ${threw ? 'threw' : 'did not throw'}${hit.length ? ` and wrote "${MARK}" onto ${hit.join(', ')}` : ''}`);
          cleanUp();
        }
      } finally {
        cleanUp();
      }
      check(!problems.length, 'extendSchema', () => problems.join('; '));
    },
  },
  {
    name: 'extendSettingsSchema refuses own "__proto__"/"constructor"/"prototype" keys',
    test() {
      const problems = [];
      try {
        for (const k of ['__proto__', 'constructor', 'prototype']) {
          let threw = false;
          try {
            extendSettingsSchema(obj([[k, () => 1]]));
          } catch {
            threw = true;
          }
          if (!threw) problems.push(`key ${k} accepted`);
          if (pollutedBuiltins().length) problems.push(`key ${k} polluted a built-in`);
          cleanUp();
        }
      } finally {
        cleanUp();
      }
      check(!problems.length, 'extendSettingsSchema', () => problems.join('; '));
    },
  },
];
