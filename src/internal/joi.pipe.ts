/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/unified-signatures */ // Unified signatures are harder to read

import {
  ArgumentMetadata,
  Inject,
  Injectable,
  Optional,
  PipeTransform,
  Scope,
  UnprocessableEntityException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import * as acceptLanguageParser from 'accept-language-parser';
import { FastifyRequest } from 'fastify';
import * as Joi from 'joi';
import { getTypeSchema, JoiValidationGroup } from 'joi-class-decorators';
import { get, hasIn, set } from 'lodash';

import { Constructor, JOIPIPE_OPTIONS, JoiValidationGroups } from './defs';
import { JoiPipeOptions } from './joi-pipe.module';

const DEFAULT_JOI_PIPE_OPTS: JoiPipeOptions = {
  pipeOpts: {
    group: undefined,
  },
  validationOpts: {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: false,
    errors: {
      label: undefined,
    },
  },
  message: 'Validation failed',
  transformErrors: errorItems => {
    const errorObjects: any = {};

    for (const errorItem of errorItems) {
      const path = errorItem.path;

      // Retrieves nested messages if object with given path already exists
      if (hasIn(errorObjects, [...path])) {
        const prevErrorObj = get(errorObjects, [...path]);

        set(errorObjects, path, {
          ...prevErrorObj,
          messages: [
            ...prevErrorObj.messages,
            {
              message: errorItem.message,
              type: errorItem.type,
            },
          ],
        });

        continue;
      }

      set(errorObjects, path, {
        messages: [
          {
            message: errorItem.message,
            type: errorItem.type,
          },
        ],
        key: errorItem.context?.key,
        label: errorItem.context?.label,
        value: errorItem.context?.value,
      });
    }

    return errorObjects;
  },
};

const JOI_PIPE_OPTS_KEYS = Object.keys({ ...DEFAULT_JOI_PIPE_OPTS, translations: {} });

const DEFAULT_JOI_VALIDATION_OPTS: Joi.ValidationOptions =
  DEFAULT_JOI_PIPE_OPTS.validationOpts as Joi.ValidationOptions;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isHttpRequest(req: any): req is { method: string } {
  return req && 'method' in req;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isGraphQlRequest(req: any): req is { req: { method: string } } {
  return req && 'req' in req && typeof req.req === 'object' && 'method' in req.req;
}

@Injectable({ scope: Scope.REQUEST })
export class JoiPipe implements PipeTransform {
  private readonly schema?: Joi.Schema;
  private readonly type?: Constructor;
  private readonly method?: string;
  private readonly options: JoiPipeOptions;

  constructor();
  constructor(options?: JoiPipeOptions);
  constructor(type: Constructor, options?: JoiPipeOptions);
  constructor(schema: Joi.Schema, options?: JoiPipeOptions);
  constructor(
    @Inject(REQUEST) private readonly arg?: unknown,
    @Optional() @Inject(JOIPIPE_OPTIONS) options?: JoiPipeOptions,
  ) {
    if (arg) {
      // Test for an actual request object, which indicates we're in "injected" mode.
      // This is the case that requires the most performant handling, which is why it
      // should be the first branch.
      if (isHttpRequest(arg)) {
        this.method = arg.method.toUpperCase();
      } else if (isGraphQlRequest(arg)) {
        // @nestjs/graphql, or rather apollo, only supports GET and POST.
        // To provide a consistent experience without hard to understand behavior
        // such as UPDATE group schemas being ignored, we will NOT set the method.
        // JoiPipe will work for this case, but ignore the method.
        // this.method = arg.req.method.toUpperCase();
      } else {
        // This is the "manually called constructor" case, where performance is
        // (ostensibly) not as big of a concern since manual JoiPipes will be
        // constructed only once at app initialization
        if (Joi.isSchema(arg)) {
          this.schema = arg as Joi.Schema;
        } else if (typeof arg === 'function') {
          this.type = arg as Constructor;
        } else {
          // Options passed as first parameter
          options = arg as JoiPipeOptions;
        }
      }
    } else {
      // Called without arguments, do nothing
    }

    this.options = this.parseOptions(options);
  }

  async transform(payload: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const req = this.arg as FastifyRequest;
    const language = acceptLanguageParser.parse(req.headers['accept-language'] || 'en')[0].code;
    const schema = this.getSchema(metadata);

    if (!schema) {
      // This happens when a metatype was passed by NestJS and it has no
      // validation decoration.
      return payload;
    }

    return this.validate(payload, schema, language /* metadata */);
  }

  // Called "validate" and NOT "transform", because that would make it match
  // the interface of a pipe INSTANCE and prevent NestJS from recognizing it as
  // a class constructor instead of an instance.
  private async validate<T>(
    payload: unknown,
    schema: Joi.Schema,
    language: string,
    /* istanbul ignore next */
    // metadata: ArgumentMetadata = { type: 'custom' },
  ): Promise<T> {
    try {
      const value = await schema.validateAsync(payload, {
        ...DEFAULT_JOI_VALIDATION_OPTS,
        // Allows overriding the default Joi schema validation options
        ...this.options.validationOpts,
        ...{
          errors: {
            ...DEFAULT_JOI_VALIDATION_OPTS.errors,
            language,
            ...this.options.validationOpts?.errors,
          },
        },
        messages: this.options.translations?.[language],
      });

      return value as T;
    } catch (error) {
      if (Joi.isError(error)) {
        const errObject = {
          statusCode: 422,
          message: this.options.message,
          errors:
            this.options.transformErrors?.(error.details) ||
            DEFAULT_JOI_PIPE_OPTS.transformErrors?.(error.details),
        };

        // console.error(errObject);

        throw new UnprocessableEntityException(errObject);
      } else {
        // If error is not a validation error, it is probably a custom error thrown by the schema.
        // Pass it through to allow it to be caught by custom error handlers.
        throw error;
      }
    }
  }

  /**
   * Efficient validation of pipeOpts
   *
   * @param options Pipe options as passed in the constructor
   * @returns Validated options with default values applied
   */
  private parseOptions(options?: JoiPipeOptions): JoiPipeOptions {
    // Pass type arguments to force type validation of the function arguments.
    options = Object.assign<JoiPipeOptions, JoiPipeOptions>(
      {
        ...DEFAULT_JOI_PIPE_OPTS,
      },
      options || {},
    );

    const errors: string[] = [];

    const unknownKeys = Object.keys(options).filter(k => !JOI_PIPE_OPTS_KEYS.includes(k));
    if (unknownKeys.length) {
      errors.push(`Unknown configuration keys: ${unknownKeys.join(', ')}`);
    }
    if (
      options.pipeOpts?.group &&
      !(typeof options.pipeOpts?.group === 'string' || typeof options.pipeOpts?.group === 'symbol')
    ) {
      errors.push(`'group' must be a string or symbol`);
    }

    if (errors.length) {
      throw new Error(`Invalid JoiPipeOptions:\n${errors.map(x => `- ${x}`).join('\n')}`);
    }

    return options as JoiPipeOptions;
  }

  /**
   * Determine what schema to return/construct based on the actual metadata
   * passed for this request.
   *
   * @param metadata
   */
  private getSchema(metadata: ArgumentMetadata): Joi.Schema | undefined {
    // If called in request scope mode, give preference to this mode.
    if (this.method && metadata.metatype) {
      let group: JoiValidationGroup | undefined;
      if (this.method === 'PUT' || this.method === 'PATCH') {
        group = JoiValidationGroups.UPDATE;
      } else if (this.method === 'POST') {
        group = JoiValidationGroups.CREATE;
      }

      return JoiPipe.getTypeSchema(metadata.metatype, { group });
    }

    // Prefer a static schema, if specified
    if (this.schema) {
      return this.schema;
    }

    // Prefer a static model, if specified
    if (this.type) {
      // Don't return "no schema" (undefined) if a type was explicitely specified
      return JoiPipe.getTypeSchema(this.type, {
        forced: true,
        group: this.options.pipeOpts?.group,
      });
    }

    // Determine the schema from the passed model
    if (metadata.metatype) {
      return JoiPipe.getTypeSchema(metadata.metatype, { group: this.options.pipeOpts?.group });
    }

    return undefined;
  }

  /**
   * Cache map for already constructed schemas
   */
  private static readonly typeSchemaMap = new Map<unknown, Map<string, Joi.Schema | undefined>>();

  /**
   * Obtain the type schema from getTypeSchema().
   * The result is cached for better performance, using the type and options to
   * construct a cache key.
   *
   * If no properties have been decorated in the whole chain, no schema
   * will be returned so as to not throw when inadvertently "validating" using
   * inbuilt types.
   * Returning a schema can be forced to cover cases when a type has been explicitely
   * passed to JoiPipe.
   *
   * @param type The type (decorated class constructor) to construct a schema from
   * @param options An optional options object
   * @param options.forced Force an empty schema to be returned even if no properties of the type have been decorated. (defaults to false)
   * @param options.group An optional JoiValidationGroup to use during schema construction
   */
  private static getTypeSchema(
    type: Constructor,
    /* istanbul ignore next */
    { forced, group }: { forced?: boolean; group?: JoiValidationGroup } = {},
  ): Joi.Schema | undefined {
    // Do not validate basic inbuilt types. This is fast enough that we don't need
    // to cache the result.
    if (type === String || type === Object || type === Number || type === Array) {
      return;
    }

    const cacheKey = 'forced' + (forced ? '1' : '0') + (group ? 'group' + String(group) : '');
    // Check cache.
    if (this.typeSchemaMap.has(type)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (this.typeSchemaMap.get(type)!.has(cacheKey)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.typeSchemaMap.get(type)!.get(cacheKey);
      }
    } else {
      this.typeSchemaMap.set(type, new Map());
    }

    const typeSchema = getTypeSchema(type, { group });

    // The default behavior when no properties have attached schemas is to not
    // validate, otherwise we'd get errors for types with no decorators not intended
    // to be validated when used as global pipe
    if ((!typeSchema || !Object.keys(typeSchema.describe().keys).length) && !forced) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.typeSchemaMap.get(type)!.set(cacheKey, undefined);
      return undefined;
    }

    // It is assumed that a validation schema was specified because the input value
    // as such is actually required, so we're calling required() here.
    // This might be subject to change if actual use cases are found.
    const finalSchema = typeSchema.required();

    // Cache value
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.typeSchemaMap.get(type)!.set(cacheKey, finalSchema);

    return finalSchema;
  }
}
