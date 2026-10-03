import { z } from 'zod';

/**
 * What Claude returns for one answer (MVP §6.4 step 2), in two forms that must stay in step:
 *
 *   EXTRACTION_JSON_SCHEMA   sent as `output_config.format`, so the API only returns JSON of this shape. The
 *                            structured-outputs subset has no numeric ranges or string lengths, so those are
 *                            checked by the zod schema below instead.
 *   extractionSchema         applied to every reply before anything is stored: a reply that doesn't fit is an
 *                            error for that answer, never a partial write.
 *
 * Changing either one changes what is extracted: bump PROMPT_VERSION (extraction-prompt.js), which re-runs the eval.
 */

export const ANSWER_TYPES = Object.freeze([
  'list',
  'single_recommendation',
  'comparison',
  'explanatory',
  'refusal',
]);
export const PROMINENCE = Object.freeze(['primary', 'secondary', 'passing']);
export const STANCES = Object.freeze(['recommended', 'neutral', 'cautioned', 'not_recommended']);
export const POLARITIES = Object.freeze(['positive', 'neutral', 'negative']);
export const SENTIMENTS = Object.freeze([-2, -1, 0, 1, 2]);

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

export const EXTRACTION_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answer_type', 'entities', 'citations'],
  properties: {
    answer_type: { type: 'string', enum: [...ANSWER_TYPES] },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'tracked_ref',
          'list_rank',
          'prominence',
          'stance',
          'sentiment',
          'excerpt',
          'claims',
        ],
        properties: {
          name: { type: 'string' },
          tracked_ref: nullable({ type: 'string' }),
          list_rank: nullable({ type: 'integer' }),
          prominence: { type: 'string', enum: [...PROMINENCE] },
          stance: { type: 'string', enum: [...STANCES] },
          sentiment: { type: 'integer', enum: [...SENTIMENTS] },
          excerpt: { type: 'string' },
          claims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['attribute', 'value', 'polarity'],
              properties: {
                attribute: { type: 'string' },
                value: { type: 'string' },
                polarity: { type: 'string', enum: [...POLARITIES] },
              },
            },
          },
        },
      },
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'supports'],
        properties: {
          source: { type: 'integer' },
          supports: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});

/** Limits the JSON schema can't express. Long strings are cut rather than rejected: they are still the reading. */
const clipped = (max) => z.string().transform((s) => s.trim().slice(0, max));

export const extractionSchema = z.object({
  answer_type: z.enum(ANSWER_TYPES),
  entities: z
    .array(
      z.object({
        name: clipped(255).pipe(z.string().min(1)),
        // A ref that isn't one of the answer's tracked entities is resolved by name instead (extraction.js).
        tracked_ref: z.string().max(16).nullable(),
        list_rank: z.number().int().min(1).max(255).nullable(),
        prominence: z.enum(PROMINENCE),
        stance: z.enum(STANCES),
        sentiment: z.number().int().min(-2).max(2),
        excerpt: clipped(300),
        claims: z
          .array(
            z.object({
              attribute: clipped(64).pipe(z.string().min(1)),
              value: clipped(500).pipe(z.string().min(1)),
              polarity: z.enum(POLARITIES),
            }),
          )
          .max(20),
      }),
    )
    .max(100),
  citations: z
    .array(
      z.object({
        source: z.number().int().min(1).max(1000),
        supports: z.array(clipped(255)).max(50),
      }),
    )
    .max(200),
});
