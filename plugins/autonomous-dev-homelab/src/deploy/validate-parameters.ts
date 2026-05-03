/**
 * `validateParameters` — minimal recogniser for `ParamSchema` records used
 * by the homelab deploy backends. Implements the subset of autonomous-dev
 * SPEC-023-1-01's validator that the four homelab backends rely on.
 *
 * Returns a NEW params object with defaults applied. Throws `DeployError`
 * with `code: 'INVALID_PARAMS'` on the first failure (message includes the
 * offending field name).
 */

import { DeployError } from './errors.js';
import type { DeployParameters, ParamSchema } from './types.js';

const IDENT_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;
const SHELL_SAFE_ARG_REGEX = /^[A-Za-z0-9_./@:+=,-]{1,512}$/;
const URL_REGEX = /^https?:\/\/[^\s]{1,2048}$/;
const ABS_PATH_REGEX = /^\/[\w./_-]{0,1024}$/;
const PATH_REGEX = /^[\w./_-]{1,1024}$/;

function checkFormat(name: string, value: string, format: ParamSchema['format']): void {
  switch (format) {
    case 'identifier':
      if (!IDENT_REGEX.test(value)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must match identifier pattern`,
        });
      }
      return;
    case 'shell-safe-arg':
      if (!SHELL_SAFE_ARG_REGEX.test(value)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' contains shell-unsafe characters`,
        });
      }
      return;
    case 'url':
      if (!URL_REGEX.test(value)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be an http(s) URL`,
        });
      }
      return;
    case 'absolute-path':
      if (!ABS_PATH_REGEX.test(value)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be an absolute path`,
        });
      }
      return;
    case 'path':
      if (!PATH_REGEX.test(value)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be a relative or absolute path`,
        });
      }
      return;
    default:
      return;
  }
}

function checkOne(name: string, raw: unknown, schema: ParamSchema): unknown {
  if (raw === undefined || raw === null) {
    if (schema.required === true && schema.default === undefined) {
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `required param '${name}' is missing`,
      });
    }
    return schema.default;
  }
  switch (schema.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be a string`,
        });
      }
      if (schema.enum !== undefined && !(schema.enum as ReadonlyArray<string>).includes(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be one of [${schema.enum.join(',')}]`,
        });
      }
      if (schema.regex !== undefined && !schema.regex.test(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' does not match required regex`,
        });
      }
      if (schema.format !== undefined) checkFormat(name, raw, schema.format);
      return raw;
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be a finite number`,
        });
      }
      if (schema.range !== undefined) {
        const [min, max] = schema.range;
        if (raw < min || raw > max) {
          throw new DeployError({
            code: 'INVALID_PARAMS',
            message: `param '${name}' must be in [${min},${max}]`,
          });
        }
      }
      if (schema.enum !== undefined && !(schema.enum as ReadonlyArray<number>).includes(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be one of [${schema.enum.join(',')}]`,
        });
      }
      return raw;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be a boolean`,
        });
      }
      return raw;
    }
    case 'array': {
      if (!Array.isArray(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be an array`,
        });
      }
      const items = schema.items;
      if (items !== undefined) {
        for (let i = 0; i < raw.length; i++) {
          const itemName = `${name}[${i}]`;
          if ('type' in items && items.type === 'string') {
            if (typeof raw[i] !== 'string') {
              throw new DeployError({
                code: 'INVALID_PARAMS',
                message: `param '${itemName}' must be a string`,
              });
            }
            const itemRegex = (items as { regex?: RegExp }).regex;
            if (itemRegex !== undefined && !itemRegex.test(raw[i] as string)) {
              throw new DeployError({
                code: 'INVALID_PARAMS',
                message: `param '${itemName}' does not match required regex`,
              });
            }
          } else if ('type' in items && items.type === 'object' && 'properties' in items) {
            const obj = raw[i];
            if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
              throw new DeployError({
                code: 'INVALID_PARAMS',
                message: `param '${itemName}' must be an object`,
              });
            }
            const props: Record<string, ParamSchema> = items.properties ?? {};
            for (const [propName, propSchema] of Object.entries(props)) {
              checkOne(`${itemName}.${propName}`, (obj as Record<string, unknown>)[propName], propSchema);
            }
          } else {
            checkOne(itemName, raw[i], items as ParamSchema);
          }
        }
      }
      return raw;
    }
    case 'object': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new DeployError({
          code: 'INVALID_PARAMS',
          message: `param '${name}' must be an object`,
        });
      }
      if (schema.additionalProperties !== undefined) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          checkOne(`${name}.${k}`, v, schema.additionalProperties);
        }
      }
      if (schema.properties !== undefined) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          checkOne(`${name}.${propName}`, (raw as Record<string, unknown>)[propName], propSchema);
        }
      }
      return raw;
    }
    default:
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `param '${name}' has unsupported schema type`,
      });
  }
}

export function validateParameters(
  params: DeployParameters,
  schema: Record<string, ParamSchema>,
): DeployParameters {
  const out: DeployParameters = {};
  // First pass: declared params.
  for (const [name, paramSchema] of Object.entries(schema)) {
    const checked = checkOne(name, params[name], paramSchema);
    if (checked !== undefined) {
      out[name] = checked;
    }
  }
  return out;
}
